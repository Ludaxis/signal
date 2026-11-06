// Server-only: brand kits. Import from a website (public pages only) and/or a local project folder,
// review and edit in the Brand screen, and use the kit in every template (colours, font, logo).
// Also finds the website's articles/pages for the "Website post" format.
import { lookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { currentProject, type Project } from './projects';

export interface BrandKit {
  name: string;
  tagline: string;
  website: string | null;
  colors: { primary: string; background: string; text: string; accent: string };
  palette: string[];
  fonts: string[];
  fontFile: string | null; // file name inside the brand folder (ttf/otf/woff)
  logo: string | null; // file name inside the brand folder (png)
  ogImage: string | null;
  voice: string[];
  copy: string[]; // sample headings/sentences from the source
  instagram: string | null;
  sources: { type: 'website' | 'folder'; value: string; at: string }[];
  updatedAt: string;
}
export interface Article { url: string; title: string; summary: string; image: string | null }

export class BrandError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const brandDir = (p: Project = currentProject()) => path.join(path.dirname(p.contentDir), 'brand');
const kitFile = (p?: Project) => path.join(brandDir(p), 'brand.json');

export async function loadBrand(p?: Project): Promise<BrandKit | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ kitFile(p), 'utf8')) as BrandKit;
  } catch {
    return null;
  }
}
async function saveBrand(kit: BrandKit, p?: Project): Promise<BrandKit> {
  await fs.mkdir(/* turbopackIgnore: true */ brandDir(p), { recursive: true });
  const k = { ...kit, updatedAt: new Date().toISOString() };
  await fs.writeFile(/* turbopackIgnore: true */ kitFile(p), JSON.stringify(k, null, 2) + '\n');
  return k;
}

// ---- safe fetching of public pages ---------------------------------------------------------
// Every hop is checked: redirects are followed by hand (at most MAX_REDIRECTS), and each new host is
// resolved and refused when any address is private. The body is streamed and stopped at the byte cap.
// Residual gap: fetch resolves the host again, so a DNS answer that changes between the check and the
// connection (rebinding) is not caught; pinning the address needs a custom dispatcher.
export const MAX_REDIRECTS = 3;
const PRIVATE_V4 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE_V4.addSubnet(a, p, 'ipv4');
const PRIVATE_V6 = new net.BlockList();
for (const [a, p] of [['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['100::', 64], ['2001:db8::', 32]] as const) PRIVATE_V6.addSubnet(a, p, 'ipv6');

/** The eight 16-bit groups of a valid IPv6 address (zone id dropped, dotted IPv4 tail expanded). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (v4) {
    const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const n = groups.map((x) => parseInt(x, 16));
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? n : null;
}

/**
 * Loopback, private, link-local, CGNAT, multicast and reserved ranges, including IPv4 inside IPv6
 * (::ffff:a.b.c.d, ::a.b.c.d, NAT64 64:ff9b::/96). Anything that is not an address counts as private.
 * Exported for tests.
 */
export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (zeros(0, 5) && g[5] === 0xffff) return PRIVATE_V4.check(v4(), 'ipv4'); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return PRIVATE_V4.check(v4(), 'ipv4'); // NAT64
  return PRIVATE_V6.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

/** App store pages are the store's own chrome (colours, fonts), not the app's or brand's own. */
const APP_STORE_HOSTS = new Set(['play.google.com', 'apps.apple.com', 'itunes.apple.com']);
export function assertBrandSource(u: URL): void {
  if (APP_STORE_HOSTS.has(u.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new BrandError(400, 'That is an app store page, not the brand’s own website: its colours and fonts are the store’s. Import the brand’s or app’s website instead, or link your project folder.');
  }
}

export type Resolve = (host: string) => Promise<{ address: string }[]>;
const dnsResolve: Resolve = (host) => lookup(host, { all: true });

async function assertPublicHost(u: URL, resolve: Resolve): Promise<void> {
  if (process.env.SIGNAL_ALLOW_PRIVATE_FETCH === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await resolve(host).catch(() => []);
  if (!addrs.length) throw new BrandError(400, `Can't find ${u.hostname}.`);
  if (addrs.some((a) => privateIp(a.address))) throw new BrandError(400, 'That address is on a private network; only public websites can be imported.');
}

async function readCapped(r: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new BrandError(413, 'That page is too large to import.');
  const declared = Number(r.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export function normaliseUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new BrandError(400, 'Enter a website address, like example.com.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new BrandError(400, 'Only http(s) websites can be imported.');
  return u;
}

type Fetch = typeof fetch;
/** GET a public http(s) page: per-hop host checks, manual redirects, streamed byte cap. Exported for tests. */
export async function getPublic(url: string, f: Fetch, maxBytes: number, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5', resolve: Resolve = dnsResolve): Promise<{ ok: boolean; status: number; type: string; body: Buffer; url: string }> {
  let u = normaliseUrl(url);
  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(u, resolve);
    const r = await f(u.toString(), { headers: { Accept: accept, 'User-Agent': 'SignalStudio/1.0 (brand import)' }, redirect: 'manual', signal, cache: 'no-store' });
    const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (location) {
      await r.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new BrandError(502, 'That website redirects too many times.');
      let next: URL;
      try {
        next = new URL(location, u);
      } catch {
        throw new BrandError(502, 'That website redirects to an address that is not valid.');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new BrandError(400, 'Only http(s) websites can be imported.');
      u = next;
      continue;
    }
    const body = await readCapped(r, maxBytes);
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') ?? '', body, url: u.toString() };
  }
}

// ---- parsing helpers -----------------------------------------------------------------------
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? decode(c) : null;
}
const stripTags = (s: string) => decode(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

export function hexColors(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (h: string) => counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1]!.toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    add(`#${h}`);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    add(`#${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`);
  }
  return counts;
}
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const sat = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

export function pickColors(counts: Map<string, number>): { colors: BrandKit['colors']; palette: string[] } {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  const palette = ranked.slice(0, 8);
  const light = ranked.find((h) => lum(h) > 0.9) ?? '#ffffff';
  const dark = ranked.find((h) => lum(h) < 0.18) ?? '#111111';
  const vivid = ranked.filter((h) => sat(h) > 0.35 && lum(h) > 0.12 && lum(h) < 0.85);
  const primary = vivid[0] ?? dark;
  const accent = vivid[1] ?? primary;
  return { colors: { primary, background: light, text: dark, accent }, palette };
}

export function fontFamilies(css: string): string[] {
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'inherit', 'initial', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'arial', 'helvetica neue', 'apple color emoji', 'segoe ui emoji', 'noto color emoji', 'var(--font-sans)', 'cursive']);
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    for (const raw of m[1]!.split(',')) {
      const n = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\s*!important$/, '');
      if (!n || n.startsWith('var(') || generic.has(n.toLowerCase()) || n.length > 40) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 4);
}

async function saveImage(buf: Buffer, file: string, p?: Project): Promise<string | null> {
  try {
    const out = await sharp(buf).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    await fs.mkdir(/* turbopackIgnore: true */ brandDir(p), { recursive: true });
    await fs.writeFile(/* turbopackIgnore: true */ path.join(brandDir(p), file), out);
    return file;
  } catch {
    return null;
  }
}

// ---- import --------------------------------------------------------------------------------
export async function importWebsite(input: string, f: Fetch = fetch): Promise<BrandKit> {
  const p = currentProject();
  assertBrandSource(normaliseUrl(input));
  const page = await getPublic(input, f, 3_000_000);
  assertBrandSource(new URL(page.url)); // a short link or a redirect to a store page
  if (!page.ok) throw new BrandError(502, `The website answered HTTP ${page.status}.`);
  const html = page.body.toString('utf8');
  const base = new URL(page.url);
  const abs = (href: string) => {
    try {
      return new URL(decode(href), base).toString();
    } catch {
      return null;
    }
  };
  let css = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? []).join('\n') + '\n' + (html.match(/style=["'][^"']*["']/gi) ?? []).join('\n');
  const sheets = [...html.matchAll(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)].map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1]).filter((x): x is string => Boolean(x));
  for (const href of sheets.slice(0, 5)) {
    const u = abs(href);
    if (!u || new URL(u).hostname !== base.hostname) continue;
    try {
      const r = await getPublic(u, f, 1_500_000, 'text/css,*/*;q=0.1');
      if (r.ok) css += '\n' + r.body.toString('utf8');
    } catch {
      /* skip stylesheet */
    }
  }
  const theme = meta(html, 'theme-color');
  const counts = hexColors(css);
  if (theme && /^#[0-9a-f]{6}$/i.test(theme)) counts.set(theme.toLowerCase(), (counts.get(theme.toLowerCase()) ?? 0) + 50);
  const picked = pickColors(counts);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const siteName = meta(html, 'og:site_name') ?? title.split(/[|–—·-]/)[0]?.trim() ?? p.name;
  const tagline = meta(html, 'og:description') ?? meta(html, 'description') ?? '';
  const copy = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => stripTags(m[1]!)).filter((t) => t.length > 3 && t.length < 120).slice(0, 8);
  const insta = html.match(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?/i)?.[1] ?? null;
  // Images: og:image as hero, apple-touch-icon / icon as logo.
  let ogImage: string | null = null;
  const og = meta(html, 'og:image');
  if (og) {
    const u = abs(og);
    if (u) {
      try {
        const r = await getPublic(u, f, 8_000_000, 'image/*');
        if (r.ok && /^image\//.test(r.type)) ogImage = await saveImage(r.body, 'og.png', p);
      } catch {
        /* no hero */
      }
    }
  }
  let logo: string | null = null;
  const icons = [...html.matchAll(/<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]*>/gi)].map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1]).filter((x): x is string => Boolean(x));
  for (const href of [...icons.reverse(), '/apple-touch-icon.png']) {
    const u = abs(href);
    if (!u) continue;
    try {
      const r = await getPublic(u, f, 3_000_000, 'image/*');
      if (r.ok && /^image\/(png|jpeg|webp|svg\+xml|gif)/.test(r.type)) {
        logo = await saveImage(r.body, 'logo.png', p);
        if (logo) break;
      }
    } catch {
      /* next */
    }
  }
  const old = await loadBrand(p);
  const kit: BrandKit = {
    name: siteName || old?.name || p.name,
    tagline: tagline || old?.tagline || '',
    website: base.origin,
    colors: old?.colors && old.sources.length ? old.colors : picked.colors,
    palette: picked.palette.length ? picked.palette : (old?.palette ?? []),
    fonts: fontFamilies(css).length ? fontFamilies(css) : (old?.fonts ?? []),
    fontFile: old?.fontFile ?? null,
    logo: logo ?? old?.logo ?? null,
    ogImage: ogImage ?? old?.ogImage ?? null,
    voice: old?.voice?.length ? old.voice : guessVoice(tagline, copy),
    copy: copy.length ? copy : (old?.copy ?? []),
    instagram: insta ? `@${insta}` : (old?.instagram ?? null),
    sources: [...(old?.sources ?? []).filter((s) => s.type !== 'website'), { type: 'website', value: base.origin, at: new Date().toISOString() }],
    updatedAt: '',
  };
  if (!old?.sources.length) kit.colors = picked.colors;
  return saveBrand(kit, p);
}

function guessVoice(tagline: string, copy: string[]): string[] {
  const text = [tagline, ...copy].join(' ');
  const words: string[] = [];
  if (!/[!]{1}/.test(text)) words.push('calm');
  if (/clear|transparen|published|simple|plain/i.test(text)) words.push('clear');
  if (text.split(/\s+/).length / Math.max(1, copy.length + 1) < 9) words.push('concise');
  if (!/[\u{1F300}-\u{1FAFF}]/u.test(text)) words.push('no emojis');
  return words.slice(0, 4);
}

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'Library', 'Temp', 'out', '.turbo', 'coverage']);
async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length > 4000) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.storybook') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(p, depth - 1, out);
    } else out.push(p);
  }
}

export async function importFolder(dirIn: string): Promise<BrandKit> {
  const p = currentProject();
  const dir = path.resolve(dirIn.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  try {
    if (!(await fs.stat(/* turbopackIgnore: true */ dir)).isDirectory()) throw new Error();
  } catch {
    throw new BrandError(400, 'That folder was not found on this machine.');
  }
  const files: string[] = [];
  await walk(dir, 5, files);
  let css = '';
  for (const f of files.filter((x) => /(tailwind\.config\.(c|m)?(j|t)s|\.css|tokens?\.json|theme\.(j|t)s)$/i.test(x)).slice(0, 40)) {
    try {
      const st = await fs.stat(/* turbopackIgnore: true */ f);
      if (st.size < 600_000) css += '\n' + (await fs.readFile(/* turbopackIgnore: true */ f, 'utf8'));
    } catch {
      /* skip */
    }
  }
  const counts = hexColors(css);
  const picked = pickColors(counts);
  const fontFiles = files.filter((x) => /\.(ttf|otf|woff)$/i.test(x) && !/icon|emoji|awesome|material/i.test(x));
  let fontFile: string | null = null;
  if (fontFiles[0]) {
    const pref = fontFiles.find((x) => /bold|semibold|600|700/i.test(x)) ?? fontFiles[0];
    fontFile = `font${path.extname(pref).toLowerCase()}`;
    await fs.mkdir(/* turbopackIgnore: true */ brandDir(p), { recursive: true });
    await fs.copyFile(/* turbopackIgnore: true */ pref, path.join(brandDir(p), fontFile));
  }
  let logo: string | null = null;
  const logos = files.filter((x) => /(^|\/)(logo|brand|icon|apple-touch-icon)[^/]*\.(png|svg|jpe?g|webp)$/i.test(x)).sort((a, b) => (/logo/i.test(b) ? 1 : 0) - (/logo/i.test(a) ? 1 : 0));
  for (const l of logos.slice(0, 5)) {
    logo = await saveImage(await fs.readFile(/* turbopackIgnore: true */ l), 'logo.png', p);
    if (logo) break;
  }
  const old = await loadBrand(p);
  const kit: BrandKit = {
    name: old?.name ?? p.name,
    tagline: old?.tagline ?? '',
    website: old?.website ?? null,
    colors: counts.size ? picked.colors : (old?.colors ?? { primary: '#3c24c0', background: '#ffffff', text: '#111111', accent: '#02bf7d' }),
    palette: counts.size ? picked.palette : (old?.palette ?? []),
    fonts: fontFamilies(css).length ? fontFamilies(css) : (old?.fonts ?? []),
    fontFile: fontFile ?? old?.fontFile ?? null,
    logo: logo ?? old?.logo ?? null,
    ogImage: old?.ogImage ?? null,
    voice: old?.voice ?? [],
    copy: old?.copy ?? [],
    instagram: old?.instagram ?? null,
    sources: [...(old?.sources ?? []).filter((s) => !(s.type === 'folder' && s.value === dir)), { type: 'folder', value: dir, at: new Date().toISOString() }],
    updatedAt: '',
  };
  return saveBrand(kit, p);
}

const HEX = /^#[0-9a-f]{6}$/i;
export async function updateBrand(patch: Partial<Pick<BrandKit, 'name' | 'tagline' | 'colors' | 'voice'>>): Promise<BrandKit> {
  const p = currentProject();
  const old = await loadBrand(p);
  const base: BrandKit = old ?? {
    name: p.name,
    tagline: '',
    website: null,
    colors: { primary: '#3c24c0', background: '#ffffff', text: '#111111', accent: '#02bf7d' },
    palette: [],
    fonts: [],
    fontFile: null,
    logo: null,
    ogImage: null,
    voice: [],
    copy: [],
    instagram: null,
    sources: [],
    updatedAt: '',
  };
  const colors = { ...base.colors };
  for (const k of ['primary', 'background', 'text', 'accent'] as const) if (patch.colors?.[k] && HEX.test(patch.colors[k])) colors[k] = patch.colors[k].toLowerCase();
  return saveBrand(
    {
      ...base,
      name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 60) : base.name,
      tagline: typeof patch.tagline === 'string' ? patch.tagline.trim().slice(0, 240) : base.tagline,
      colors,
      voice: Array.isArray(patch.voice) ? patch.voice.map((v) => String(v).trim().slice(0, 30)).filter(Boolean).slice(0, 6) : base.voice,
    },
    p,
  );
}

export async function brandFile(name: string): Promise<Buffer> {
  if (!/^(logo|og|font)\.(png|ttf|otf|woff)$/.test(name)) throw new BrandError(404, 'Not found.');
  return fs.readFile(/* turbopackIgnore: true */ path.join(brandDir(), name));
}

// ---- website articles ----------------------------------------------------------------------
const ARTICLE_PATH = /\/(blog|journal|notes|field-notes|articles?|news|stories|posts?|competitions?|open-calls?|calls?|guides?|resources)\//i;

export async function discoverArticles(f: Fetch = fetch, limit = 40): Promise<string[]> {
  const kit = await loadBrand();
  if (!kit?.website) throw new BrandError(400, 'Import the website on the Brand screen first.');
  const origin = kit.website;
  const urls = new Set<string>();
  const readSitemap = async (u: string, depth: number) => {
    try {
      const r = await getPublic(u, f, 4_000_000, 'application/xml,text/xml,*/*;q=0.5');
      if (!r.ok) return;
      const x = r.body.toString('utf8');
      const locs = [...x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
      if (/<sitemapindex/i.test(x) && depth > 0) for (const s of locs.slice(0, 6)) await readSitemap(s, depth - 1);
      else for (const l of locs) if (l.startsWith(origin)) urls.add(l);
    } catch {
      /* ignore */
    }
  };
  await readSitemap(`${origin}/sitemap.xml`, 1);
  if (urls.size === 0) {
    for (const feed of ['/rss.xml', '/feed', '/feed.xml', '/atom.xml', '/blog/rss.xml']) {
      try {
        const r = await getPublic(`${origin}${feed}`, f, 3_000_000, 'application/rss+xml,application/atom+xml,application/xml,*/*;q=0.5');
        if (!r.ok) continue;
        const x = r.body.toString('utf8');
        for (const m of x.matchAll(/<link>\s*([^<\s]+)\s*<\/link>|<link[^>]+href=["']([^"']+)["']/gi)) {
          const l = decode(m[1] ?? m[2] ?? '');
          if (l.startsWith(origin) && l !== origin && l !== `${origin}/`) urls.add(l);
        }
        if (urls.size) break;
      } catch {
        /* next */
      }
    }
  }
  const list = [...urls].filter((u) => ARTICLE_PATH.test(new URL(u).pathname + '/'));
  return (list.length ? list : [...urls]).slice(0, limit);
}

export async function readArticle(url: string, f: Fetch = fetch): Promise<Article> {
  const kit = await loadBrand();
  if (!kit?.website || !url.startsWith(kit.website)) throw new BrandError(400, 'Only pages on the project’s own website can be used.');
  const r = await getPublic(url, f, 3_000_000);
  if (!r.ok) throw new BrandError(502, `The page answered HTTP ${r.status}.`);
  const html = r.body.toString('utf8');
  const title = meta(html, 'og:title') || stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const firstP = stripTags(html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
  const summary = meta(html, 'og:description') || meta(html, 'description') || firstP;
  const img = meta(html, 'og:image');
  return { url, title: title.slice(0, 140), summary: summary.slice(0, 400), image: img ? new URL(img, url).toString() : null };
}

export async function fetchImage(url: string, f: Fetch = fetch): Promise<Buffer | null> {
  try {
    const r = await getPublic(url, f, 10_000_000, 'image/*');
    return r.ok && /^image\//.test(r.type) ? r.body : null;
  } catch {
    return null;
  }
}
