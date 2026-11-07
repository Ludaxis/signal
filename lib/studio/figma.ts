// Server-only: Figma through your own personal access token (read-only REST API).
//
// - You paste a token from Figma → Settings → Security → Personal access tokens (scope:
//   file_content:read). It is stored encrypted (./secret-box.ts) and never sent to the browser.
// - Per project you link Figma files by URL; Signal lists their pages and frames and can export
//   frames as PNG into the project's brand folder (<brand>/figma/), where you can use them.
// - Only api.figma.com and the image links it returns are fetched. Nothing is written to Figma.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dataDir } from './local-data';
import { brandDir } from './brand';
import type { Project } from './projects';
import { deleteSecret, getSecret, putSecret, tokenKey } from './secret-box';

const API = 'https://api.figma.com/v1';
const STORE = 'figma';
type Fetch = typeof fetch;

export class FigmaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface FigmaFile { key: string; name: string; url: string; thumbnail: string | null; addedAt: string }
export interface FigmaFrame { id: string; name: string; page: string; type: string }
export interface FigmaImport { file: string; frame: string; name: string; at: string; width: number; height: number }

/** File key from a Figma link (file, design, proto, board, slides; branch links use the branch key). Exported for tests. */
export function parseFigmaUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return /^[A-Za-z0-9]{10,64}$/.test(input.trim()) ? input.trim() : null;
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (!['file', 'design', 'proto', 'board', 'slides'].includes(parts[0] ?? '')) return null;
  const key = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  return key && /^[A-Za-z0-9]{10,64}$/.test(key) ? key : null;
}

async function api<T>(f: Fetch, token: string, p: string): Promise<T> {
  let r: Response;
  try {
    r = await f(`${API}${p}`, { headers: { 'X-Figma-Token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000), cache: 'no-store', redirect: 'error' });
  } catch {
    throw new FigmaError(502, 'Figma did not answer.');
  }
  const j = (await r.json().catch(() => null)) as (T & { err?: string; message?: string }) | null;
  if (r.status === 403 || r.status === 401) throw new FigmaError(401, 'Figma refused the token. Check it has file_content:read and is not expired.');
  if (r.status === 404) throw new FigmaError(404, 'Figma has no file with that link, or your token cannot open it.');
  if (r.status === 429) throw new FigmaError(429, 'Figma rate limit. Try again in a minute.');
  if (!r.ok || !j) throw new FigmaError(502, `Figma error: ${(j?.err || j?.message || `HTTP ${r.status}`).toString().slice(0, 160)}`);
  return j;
}

// ---- token -----------------------------------------------------------------------------------------
export async function figmaStatus(): Promise<{ ready: boolean; reason: string; connected: boolean; user: string | null }> {
  const k = tokenKey();
  if (!k.ok) return { ready: false, reason: k.reason, connected: false, user: null };
  const meta = await readMeta();
  const token = await getSecret(STORE, 'token');
  return { ready: true, reason: '', connected: Boolean(token), user: token ? meta.user : null };
}

export async function connectFigma(token: string, f: Fetch = fetch): Promise<string> {
  const t = String(token ?? '').trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new FigmaError(400, 'That does not look like a Figma personal access token.');
  const me = await api<{ handle?: string; email?: string }>(f, t, '/me');
  await putSecret(STORE, 'token', t);
  const user = me.handle || me.email || 'Figma user';
  await writeMeta({ ...(await readMeta()), user });
  return user;
}

/** The saved token's account name through GET /v1/me (free, read-only), or null when no token is saved. */
export async function figmaWhoAmI(f: Fetch = fetch): Promise<string | null> {
  const token = await getSecret(STORE, 'token');
  if (!token) return null;
  const me = await api<{ handle?: string; email?: string }>(f, token, '/me');
  return me.handle || me.email || 'Figma user';
}

export async function disconnectFigma(): Promise<void> {
  await deleteSecret(STORE, 'token');
  await writeMeta({ ...(await readMeta()), user: null });
}

async function token(): Promise<string> {
  const t = await getSecret(STORE, 'token');
  if (!t) throw new FigmaError(409, 'Connect Figma first (Connections → Figma).');
  return t;
}

// ---- linked files (no secrets) ----------------------------------------------------------------------
interface Meta { v: 1; user: string | null; files: Record<string, FigmaFile[]> }
const metaFile = () => path.join(dataDir(), 'figma.json');
async function readMeta(): Promise<Meta> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ metaFile(), 'utf8')) as Meta;
    return j?.v === 1 ? { v: 1, user: j.user ?? null, files: j.files ?? {} } : { v: 1, user: null, files: {} };
  } catch {
    return { v: 1, user: null, files: {} };
  }
}
async function writeMeta(m: Meta): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dataDir(), { recursive: true });
  const tmp = `${metaFile()}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(m, null, 2) + '\n');
  await fs.rename(tmp, metaFile());
}

export async function listFigmaFiles(projectId: string): Promise<FigmaFile[]> {
  return (await readMeta()).files[projectId] ?? [];
}

export async function linkFigmaFile(projectId: string, url: string, f: Fetch = fetch): Promise<FigmaFile> {
  const key = parseFigmaUrl(url);
  if (!key) throw new FigmaError(400, 'Paste a Figma file link, like https://www.figma.com/design/…');
  const j = await api<{ name: string; thumbnailUrl?: string }>(f, await token(), `/files/${key}?depth=1`);
  const m = await readMeta();
  const list = (m.files[projectId] ?? []).filter((x) => x.key !== key);
  const file: FigmaFile = { key, name: String(j.name ?? 'Figma file').slice(0, 120), url: `https://www.figma.com/design/${key}`, thumbnail: typeof j.thumbnailUrl === 'string' ? j.thumbnailUrl : null, addedAt: new Date().toISOString() };
  m.files[projectId] = [...list, file].slice(-20);
  await writeMeta(m);
  return file;
}

export async function unlinkFigmaFile(projectId: string, key: string): Promise<boolean> {
  const m = await readMeta();
  const list = m.files[projectId] ?? [];
  if (!list.some((x) => x.key === key)) return false;
  m.files[projectId] = list.filter((x) => x.key !== key);
  await writeMeta(m);
  return true;
}

interface Node { id: string; name: string; type: string; children?: Node[] }
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'GROUP', 'INSTANCE']);

/** Pages and their top-level frames. */
export async function listFrames(projectId: string, key: string, f: Fetch = fetch): Promise<FigmaFrame[]> {
  if (!(await listFigmaFiles(projectId)).some((x) => x.key === key)) throw new FigmaError(404, 'That Figma file is not linked to this project.');
  const j = await api<{ document: Node }>(f, await token(), `/files/${key}?depth=2`);
  const frames: FigmaFrame[] = [];
  for (const page of j.document?.children ?? []) for (const n of page.children ?? []) if (FRAME_TYPES.has(n.type)) frames.push({ id: n.id, name: n.name.slice(0, 120), page: page.name.slice(0, 80), type: n.type });
  return frames.slice(0, 400);
}

export const importsDir = (p: Project) => path.join(brandDir(p), 'figma');
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'frame';

/** Exports frames as PNG (2x, max 2400 px) into the project's brand folder. */
export async function importFrames(p: Project, key: string, ids: string[], f: Fetch = fetch): Promise<FigmaImport[]> {
  const want = [...new Set(ids.filter((id) => /^[0-9A-Za-z:;_-]{1,64}$/.test(id)))].slice(0, 12);
  if (!want.length) throw new FigmaError(400, 'Pick at least one frame.');
  const frames = await listFrames(p.id, key, f);
  const byId = new Map(frames.map((x) => [x.id, x]));
  const t = await token();
  const j = await api<{ images: Record<string, string | null> }>(f, t, `/images/${key}?ids=${encodeURIComponent(want.join(','))}&format=png&scale=2`);
  const dir = importsDir(p);
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true });
  const out: FigmaImport[] = [];
  for (const id of want) {
    const url = j.images?.[id];
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    const r = await f(u, { signal: AbortSignal.timeout(60_000), cache: 'no-store' }).catch(() => null);
    if (!r?.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 40_000_000) continue;
    const png = await sharp(buf).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(png).metadata();
    const name = `${safeName(byId.get(id)?.name ?? id)}-${safeName(id)}.png`;
    await fs.writeFile(/* turbopackIgnore: true */ path.join(dir, name), png);
    out.push({ file: key, frame: id, name, at: new Date().toISOString(), width: meta.width ?? 0, height: meta.height ?? 0 });
  }
  if (!out.length) throw new FigmaError(502, 'Figma did not return any images for those frames.');
  return out;
}

/** PNGs already exported for this project, newest first. */
export async function listImports(p: Project): Promise<{ name: string; size: number; at: string }[]> {
  try {
    const dir = importsDir(p);
    const names = (await fs.readdir(/* turbopackIgnore: true */ dir)).filter((n) => /\.png$/i.test(n) && !n.startsWith('.'));
    const rows = await Promise.all(names.map(async (n) => ({ n, st: await fs.stat(/* turbopackIgnore: true */ path.join(dir, n)) })));
    return rows.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).map((r) => ({ name: r.n, size: r.st.size, at: r.st.mtime.toISOString() }));
  } catch {
    return [];
  }
}

export async function readImport(p: Project, name: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9._-]{1,140}\.png$/.test(name) || name.startsWith('.')) throw new FigmaError(400, 'Bad file name.');
  try {
    return await fs.readFile(/* turbopackIgnore: true */ path.join(importsDir(p), name));
  } catch {
    throw new FigmaError(404, 'Not found.');
  }
}
