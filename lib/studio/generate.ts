// Server-only: automatic content packages. Every package ends in Review like any other package:
// nothing is approved or posted automatically. Generators:
//   website-card     a 2-slide post from a page on the project's own website (brand import)
//   codex-post       one illustration from a written brief, drawn by your own Codex CLI
//   higgsfield-image one image from a brief through the Higgsfield API (paid per request)
//   higgsfield-reel  a short vertical video from a brief through the Higgsfield API (paid per request)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ContentError, contentDir, isPackageId, listPackages, type HiggsfieldSource, type PackageFile, type PackageSpec } from './content';
import { loadBrandKit, renderOverlay, wrap, backgroundSvg, brandLayers, textLayer, type Kit } from './render';
import { brandDir, discoverArticles, fetchImage, loadBrand, readArticle } from './brand';
import sharp from 'sharp';
import { normaliseReel } from './reel';
import { currentProject, type Project } from './projects';
import { nextPackageIdAfter, PACKAGE_IDS_USED_UP } from './package-id';
import { codexImage } from './codex';
import { estimateImageCostUsd, estimateVideoCostUsd, HF_IMAGE_MODEL, HF_VIDEO_MODEL, higgsfieldAllowed, higgsfieldClient, HiggsfieldError, type HfClient } from './higgsfield';

export { ANY_PROJECT_FORMATS, BRIEF_FORMATS, FORMAT_LABEL, FORMATS, HEADLINE_FORMATS, HIGGSFIELD_FORMATS, type Format } from './formats';
import { FORMAT_LABEL, FORMATS, type Format } from './formats';

export interface Brief { prompt: string; headline?: string; caption?: string }

export interface PackageSource {
  generator: 'signal-template-v1' | 'signal-codex-image-v1' | 'signal-higgsfield-v1';
  format: Format;
  codex?: { cli: string; seconds: number; prompt: string };
  higgsfield?: HiggsfieldSource;
  /** The page URL (website-card) or the headline / brief excerpt (brief formats). */
  category: string;
  items: string[];
  distractors: { category: string; itemId: string }[];
  levels: number[];
  seed: string;
}

export { hashtag } from './formats';
import { hashtag } from './formats';

export async function nextPackageId(): Promise<string> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/* turbopackIgnore: true */ contentDir())).filter(isPackageId);
  } catch {
    names = [];
  }
  const next = nextPackageIdAfter(names);
  if (!next) throw new ContentError(409, PACKAGE_IDS_USED_UP);
  return next;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const clean = (t: unknown, max: number) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const NO_TEXT_RULE = 'No written words, letters, numbers, logos, watermarks or UI. No real people’s likenesses, no third-party brands.';

async function projectKit(project: Project): Promise<Kit> {
  return loadBrandKit(brandDir(project), await loadBrand(project), project.name);
}

async function writePackage(id: string, files: { name: string; body: Buffer }[], spec: PackageSpec, manifest: string): Promise<void> {
  const dir = path.join(contentDir(), id);
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: false });
  for (const f of files) await fs.writeFile(/* turbopackIgnore: true */ path.join(dir, f.name), f.body);
  await fs.writeFile(/* turbopackIgnore: true */ path.join(dir, 'package.json'), JSON.stringify(spec, null, 2) + '\n');
  await fs.writeFile(/* turbopackIgnore: true */ path.join(dir, 'manifest.md'), manifest);
}

const filesTable = (spec: PackageSpec) => `## Files
| File | Role | SHA-256 |
| --- | --- | --- |
${spec.files.map((f) => `| ${f.name} | ${f.role} | \`${f.sha256}\` |`).join('\n')}`;

/** captionLead: an opening line from a campaign plan, put above the generated caption.
 *  higgsfield: an injectable client for the Higgsfield formats (tests); the real client is used otherwise. */
export async function generatePackage(opts: { format?: Format; seed?: string; now?: number; brief?: Brief; articleUrl?: string; captionLead?: string; higgsfield?: HfClient } = {}): Promise<{ id: string; spec: PackageSpec }> {
  const now = opts.now ?? Date.now();
  if (!opts.format || !FORMATS.includes(opts.format)) throw new ContentError(400, 'Pick a post type.');
  if (opts.format === 'codex-post') return generateCodexPost(opts.brief, opts.seed, now, opts.captionLead);
  if (opts.format === 'website-card') return generateWebsiteCard(opts.seed, now, opts.articleUrl, opts.captionLead);
  return generateHiggsfield(opts.format, opts.brief, opts.seed, now, opts.higgsfield, opts.captionLead);
}

function withLead(caption: string, lead: string | undefined): string {
  const l = (lead ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return l && !caption.startsWith(l) ? `${l}\n\n${caption}` : caption;
}

/** One Codex illustration from the brief, with the project's name, headline and labels. */
async function generateCodexPost(brief: Brief | undefined, seedIn: string | undefined, now: number, lead?: string): Promise<{ id: string; spec: PackageSpec }> {
  const project = currentProject();
  const prompt = clean(brief?.prompt, 800);
  if (prompt.length < 10) throw new ContentError(400, 'Describe the image in a sentence or two.');
  const headline = clean(brief?.headline, 70);
  const captionIn = typeof brief?.caption === 'string' ? brief.caption.trim().slice(0, 1900) : '';
  const kit = await projectKit(project);
  const W = 1080;
  const H = 1350;
  const full = [
    `Create an Instagram post image for ${project.name} (${project.handle}), portrait 4:5, 1080x1350.`,
    prompt,
    headline ? 'Leave the top 30% calm and uncluttered for a headline added later.' : '',
    `Polished, on-brand, high quality. ${NO_TEXT_RULE}`,
  ]
    .filter(Boolean)
    .join(' ');
  const img = await codexImage(full, W, H);
  const slide = await renderOverlay(kit, img.png, W, H, headline ? [{ text: headline, y: 190, size: 84, maxWidth: W - 140 }] : [], { topShade: Boolean(headline) });
  const tag = hashtag(project.name);
  const caption = withLead((captionIn || headline || prompt).trim() + (captionIn.includes(tag) ? '' : `\n\n${tag}`), lead);
  const id = await nextPackageId();
  const files = [
    { name: 'slide-1.png', role: 'slide' as const, body: slide },
    { name: 'caption.txt', role: 'caption' as const, body: Buffer.from(caption) },
  ];
  const source: PackageSource = {
    generator: 'signal-codex-image-v1',
    format: 'codex-post',
    category: headline || prompt.slice(0, 60),
    items: [],
    distractors: [],
    levels: [],
    seed: seedIn ?? `${id}-codex-post-${now}`,
    codex: { cli: img.cliVersion, seconds: img.seconds, prompt: full },
  };
  const spec: PackageSpec = {
    id,
    title: `${FORMAT_LABEL['codex-post']} · ${source.category}`,
    format: 'image',
    destination: project.handle,
    files: files.map((f) => ({ name: f.name, role: f.role, sha256: sha(f.body) })),
    notes: [`Image generated by your own Codex CLI ($imagegen, ${img.cliVersion}, ${img.seconds}s) from your brief.`, 'On-image "AI-generated content" label; the Instagram AI label is requested when posting.'],
    source,
  };
  await writePackage(
    id,
    files,
    spec,
    `# Post ${id} — ${spec.title}

Generated from your brief with your own Codex CLI. Destination: \`${project.handle}\` · Format: image
Status: **awaiting your approval in the Studio (Review).** \`package.json\` holds the fingerprints.

${filesTable(spec)}

## Rights / provenance
- Image: AI illustration by Codex ($imagegen, ${img.cliVersion}) from this prompt: “${full.replace(/[`|]/g, "'")}”. Check that your OpenAI/Codex plan permits commercial use.
- Headline and label font: the brand font when imported, else Instrument Sans (SIL Open Font License).

## Check before approving
- [ ] The image shows nothing misleading about ${project.name}, no real people, no other brands.
- [ ] Caption claims are true.
- [x] On-image "AI-generated content" label; Instagram AI label requested on posting.

## Caption
\`\`\`
${caption}
\`\`\`
`,
  );
  return { id, spec };
}

/**
 * One Higgsfield image (Soul, 3:4 → fitted to 1080x1350) or Reel (Soul 9:16 still → Wan 2.6 image-to-video,
 * 5 s, re-encoded to 1080x1920 H.264/AAC) from the brief. Paid per request; needs the "higgsfield" switch.
 */
async function generateHiggsfield(format: 'higgsfield-image' | 'higgsfield-reel', brief: Brief | undefined, seedIn: string | undefined, now: number, client?: HfClient, lead?: string): Promise<{ id: string; spec: PackageSpec }> {
  const allowed = await higgsfieldAllowed();
  if (!allowed.enabled) throw new ContentError(403, allowed.reason);
  const project = currentProject();
  const prompt = clean(brief?.prompt, 800);
  if (prompt.length < 10) throw new ContentError(400, 'Describe the image in a sentence or two.');
  const headline = clean(brief?.headline, 70);
  const captionIn = typeof brief?.caption === 'string' ? brief.caption.trim().slice(0, 1900) : '';
  const kit = await projectKit(project);
  const isReel = format === 'higgsfield-reel';
  const W = 1080;
  const H = isReel ? 1920 : 1350;
  const VIDEO_SECONDS = 5 as const;
  const imagePrompt = [
    `${isReel ? 'Vertical 9:16 opening frame for an Instagram Reel' : 'Instagram post image, portrait'} for ${project.name} (${project.handle}).`,
    prompt,
    headline && !isReel ? 'Leave the top 30% calm and uncluttered for a headline added later.' : '',
    `Polished, on-brand, high quality. ${NO_TEXT_RULE}`,
  ]
    .filter(Boolean)
    .join(' ');
  const videoPrompt = isReel ? `${prompt} Gentle, natural motion that keeps the composition of the start frame: slow camera drift, subtle movement in the scene. ${NO_TEXT_RULE}` : null;

  const hf = client ?? higgsfieldClient();
  const started = Date.now();
  let imageRequestId = '';
  let videoRequestId: string | null = null;
  let still: Buffer;
  let mp4: Buffer | null = null;
  try {
    const imgReq = await hf.submitImage({ prompt: imagePrompt, aspectRatio: isReel ? '9:16' : '3:4', resolution: '1080p' });
    imageRequestId = imgReq.requestId;
    const img = await hf.waitFor(imgReq);
    still = await hf.download(img.url, 'image');
    if (isReel) {
      // Wan takes a public image URL: the Higgsfield-hosted still (kept ~7 days) is used directly.
      const vidReq = await hf.submitVideo({ prompt: videoPrompt!, imageUrl: img.url, duration: VIDEO_SECONDS, resolution: '720p' });
      videoRequestId = vidReq.requestId;
      const vid = await hf.waitFor(vidReq);
      mp4 = await hf.download(vid.url, 'video');
    }
  } catch (e) {
    if (e instanceof HiggsfieldError) throw new ContentError(e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
    throw e;
  }
  const meta = await sharp(still).metadata();
  if (!meta.width || !meta.height || meta.width < 600 || meta.height < 600) throw new ContentError(502, 'Higgsfield returned an image that is too small.');

  const files: { name: string; role: PackageFile['role']; body: Buffer }[] = [];
  if (isReel) {
    let reel: Awaited<ReturnType<typeof normaliseReel>>;
    try {
      reel = await normaliseReel(mp4!);
    } catch (e) {
      throw new ContentError(502, `The Higgsfield video could not be converted for Instagram: ${String((e as Error).message).slice(0, 200)}`);
    }
    const coverPng = await renderOverlay(kit, still, W, H, headline ? [{ text: headline, y: 420, size: 96, maxWidth: W - 140 }] : [], { topShade: Boolean(headline) });
    const cover = await sharp(coverPng).jpeg({ quality: 90 }).toBuffer();
    files.push({ name: 'reel.mp4', role: 'video', body: reel.video }, { name: 'cover.jpg', role: 'cover', body: cover });
  } else {
    const slide = await renderOverlay(kit, still, W, H, headline ? [{ text: headline, y: 190, size: 84, maxWidth: W - 140 }] : [], { topShade: Boolean(headline) });
    files.push({ name: 'slide-1.png', role: 'slide', body: slide });
  }
  const tag = hashtag(project.name);
  const caption = withLead((captionIn || headline || prompt).trim() + (captionIn.includes(tag) ? '' : `\n\n${tag}`), lead);
  files.push({ name: 'caption.txt', role: 'caption', body: Buffer.from(caption) });

  const seconds = Math.round((Date.now() - started) / 1000);
  const estimatedCostUsd = Math.round((estimateImageCostUsd(1) + (isReel ? estimateVideoCostUsd(VIDEO_SECONDS) : 0)) * 10_000) / 10_000;
  const higgsfield: HiggsfieldSource = {
    imageModel: HF_IMAGE_MODEL,
    videoModel: isReel ? HF_VIDEO_MODEL : null,
    imageRequestId,
    videoRequestId,
    prompt: imagePrompt,
    videoPrompt,
    videoSeconds: isReel ? VIDEO_SECONDS : null,
    seconds,
    estimatedCostUsd,
  };
  const id = await nextPackageId();
  const source: PackageSource = {
    generator: 'signal-higgsfield-v1',
    format,
    category: headline || prompt.slice(0, 60),
    items: [],
    distractors: [],
    levels: [],
    seed: seedIn ?? `${id}-${format}-${now}`,
    higgsfield,
  };
  const spec: PackageSpec = {
    id,
    title: `${FORMAT_LABEL[format]} · ${source.category}`,
    format: isReel ? 'reel' : 'image',
    destination: project.handle,
    files: files.map((f) => ({ name: f.name, role: f.role, sha256: sha(f.body) })),
    notes: [
      isReel
        ? `Still by Higgsfield ${HF_IMAGE_MODEL} (request ${imageRequestId}), animated by ${HF_VIDEO_MODEL} (request ${videoRequestId}, ${VIDEO_SECONDS}s), re-encoded to 1080x1920 H.264/AAC for Instagram. ${seconds}s in all.`
        : `Image by Higgsfield ${HF_IMAGE_MODEL} (request ${imageRequestId}, ${seconds}s) from your brief, fitted to 1080x1350.`,
      `Estimated Higgsfield spend: $${estimatedCostUsd.toFixed(4)} (image list price${isReel ? '; video priced with a placeholder estimate per second, see source.higgsfield' : ''}).`,
      'On-image "AI-generated content" label; the Instagram AI label is requested when posting.',
    ],
    source,
  };
  await writePackage(
    id,
    files,
    spec,
    `# Post ${id} — ${spec.title}

Generated from your brief with the Higgsfield API (paid). Destination: \`${project.handle}\` · Format: ${spec.format}
Status: **awaiting your approval in the Studio (Review).** \`package.json\` holds the fingerprints.

${filesTable(spec)}

## Rights / provenance
- ${isReel ? 'Still' : 'Image'}: Higgsfield \`${HF_IMAGE_MODEL}\`, request \`${imageRequestId}\`, prompt: “${imagePrompt.replace(/[`|]/g, "'")}”.
${isReel ? `- Video: Higgsfield \`${HF_VIDEO_MODEL}\`, request \`${videoRequestId}\`, ${VIDEO_SECONDS}s, prompt: “${videoPrompt!.replace(/[`|]/g, "'")}”. Audio: the model's own track when it delivers one, else silent.\n` : ''}- Estimated spend: $${estimatedCostUsd.toFixed(4)}${isReel ? ' (video part is an estimate; check the Higgsfield billing page)' : ''}.
- Headline and label font: the brand font when imported, else Instrument Sans (SIL Open Font License). Check that your Higgsfield plan permits commercial use.

## Check before approving
- [ ] The ${isReel ? 'video' : 'image'} shows nothing misleading about ${project.name}, no real people, no other brands.
- [ ] Caption claims are true.
- [x] On-image "AI-generated content" label; Instagram AI label requested on posting.

## Caption
\`\`\`
${caption}
\`\`\`
`,
  );
  return { id, spec };
}

/** A 2-slide post from a page on the project's own website (articles, open calls, news). */
async function generateWebsiteCard(seedIn: string | undefined, now: number, articleUrl?: string, lead?: string): Promise<{ id: string; spec: PackageSpec }> {
  const project = currentProject();
  const brand = await loadBrand(project);
  if (!brand?.website) throw new ContentError(400, 'Import the website on the Brand screen first.');
  const existing = await listPackages();
  const used = new Set(existing.map((p) => p.source?.category).filter(Boolean));
  let url = articleUrl;
  if (!url) {
    const candidates = await discoverArticles();
    url = candidates.find((u) => !used.has(u));
    if (!url) throw new ContentError(409, candidates.length ? 'Every page found on the website has a post already.' : 'No articles or pages were found on the website (no sitemap or feed).');
  }
  const art = await readArticle(url);
  const kit = await loadBrandKit(brandDir(project), brand, project.name);
  const W = 1080;
  const H = 1350;
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const heroBuf = art.image ? await fetchImage(art.image) : null;
  const hero = heroBuf
    ? await sharp(heroBuf).resize(W, H, { fit: 'cover', position: 'attention' }).png().toBuffer()
    : await sharp(Buffer.from(backgroundSvg(W, H, kit.colors))).png().toBuffer();
  const titleLines = wrap(kit, art.title, 76, W - 140, 3);
  const titleTop = H - 260 - titleLines.length * 92;
  const shadeSvg = `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.82"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#b)"/>`;
  const s1 = await sharp(hero)
    .composite([
      textLayer(kit, W, H, [{ text: domain.toUpperCase(), y: titleTop - 40, size: 30, color: '#e8e8ea', stroke: 0 }, ...titleLines.map((t, i) => ({ text: t, y: titleTop + 50 + i * 92, size: 76 }))], shadeSvg),
      ...(await brandLayers(kit, W, H)),
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const sumLines = wrap(kit, art.summary || art.title, 52, W - 180, 8);
  const sumTop = Math.round(H / 2 - (sumLines.length * 70) / 2);
  const s2 = await sharp(Buffer.from(backgroundSvg(W, H, kit.colors)))
    .composite([
      textLayer(kit, W, H, [...sumLines.map((t, i) => ({ text: t, y: sumTop + i * 70, size: 52, stroke: 0 })), { text: `Read it on ${domain} · link in bio`, y: sumTop + sumLines.length * 70 + 70, size: 34, color: '#d9d9de', stroke: 0 }]),
      ...(await brandLayers(kit, W, H)),
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const caption = withLead(`${art.title}\n\n${art.summary}\n\nRead it on ${domain} (link in bio).\n\n${hashtag(brand.name || project.name)}`, lead).slice(0, 2200);
  const id = await nextPackageId();
  const files = [
    { name: 'slide-1.png', role: 'slide' as const, body: s1 },
    { name: 'slide-2.png', role: 'slide' as const, body: s2 },
    { name: 'caption.txt', role: 'caption' as const, body: Buffer.from(caption) },
  ];
  const source: PackageSource = { generator: 'signal-template-v1', format: 'website-card', category: url, items: [], distractors: [], levels: [], seed: seedIn ?? `${id}-website-${now}` };
  const spec: PackageSpec = {
    id,
    title: `${FORMAT_LABEL['website-card']} · ${art.title.slice(0, 60)}`,
    format: 'carousel',
    destination: project.handle,
    files: files.map((f) => ({ name: f.name, role: f.role, sha256: sha(f.body) })),
    notes: [`Made from ${url}.`, heroBuf ? `Cover image from the page (${art.image}).` : 'No page image; brand background used.'],
    source,
  };
  await writePackage(
    id,
    files,
    spec,
    `# Post ${id} — ${spec.title}

Made automatically from a page on the project's own website. Destination: \`${project.handle}\` · Format: carousel
Status: **awaiting your approval in the Studio (Review).**

## Source
- Page: ${url}
- Cover image: ${heroBuf ? art.image : 'none (brand background)'}

## Check before approving
- [ ] The cover image is owned by ${brand.name || project.name} or cleared for social use. Photographers' work needs the licence and credit terms that allow it, and the photographer's credit in the caption.
- [ ] Title and summary are accurate and current (dates, prizes, deadlines).
- [x] On-image "AI-generated content" label; Instagram AI label requested on posting.

${filesTable(spec)}

## Caption
\`\`\`
${caption}
\`\`\`
`,
  );
  return { id, spec };
}
