// References: a file the owner drops, or a public page link.
// Files: the body is streamed to a temp file with a running byte count (the upload stops at the limit, nothing is
// buffered whole), typed by magic bytes, probed in-process, then moved into refs/<id>/source.<ext> with ref.json and
// probe.json. Limits: MP4/MOV ≤ 500 MB and ≤ 300 s; PNG/JPG/WebP ≤ 20 MB. Page links are fetched only through
// `getPublic` (public hosts only, per-hop checks, byte cap); social-platform links are never downloaded ("Download it
// and drop the file"). Everything stays in the content folder outside the repository.
import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { getPublic } from '../brand';
import { PostmakerError } from './errors';
import { IMAGE_MAX_BYTES, probeFile, sniff, unreadable, VIDEO_MAX_BYTES, type Sniffed } from './media-probe';
import { ensureDir, FILE_MODE, pretty, readJsonFile, writeOnce, writeReplace } from './store/fs';
import { sha256Hex, sha256OfFile } from './store/objects';
import { newReferenceId, refDir, refFile } from './store/paths';
import { openStore } from './store/recipes';
import type { ProjectLike, Reference } from './types';

/** Hosts whose video links are never downloaded (platform terms, T). */
const SOCIAL_HOSTS = ['instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'threads.net', 'snapchat.com', 'pinterest.com', 'vimeo.com', 'twitch.tv', 'reddit.com', 'linkedin.com'];
export const SOCIAL_LINK_TEXT = 'Download it and drop the file';
const PAGE_MAX_BYTES = 3_000_000;

export function isSocialLink(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export async function readReference(root: string, id: string): Promise<Reference> {
  const r = await readJsonFile<Reference>(refFile(root, id));
  if (!r || r.id !== id) throw new PostmakerError(404, 'not_found', 'Unknown reference.');
  return r;
}

type Rights = Reference['rights'];

/** The stored reference file of a dropped video or image (absolute path), or null for links and pages. */
export const referenceSource = (root: string, ref: Pick<Reference, 'id' | 'file'>): string | null => (ref.file && /^source\.[a-z0-9]+$/.test(ref.file) ? path.join(refDir(root, ref.id), ref.file) : null);

export const DETECTED_TEXT_FILE = 'detected-text.json';

/**
 * the text the deconstructor read on the reference is stored beside the reference (postmaker/refs/<id>/, in the
 * content folder outside the repository) and never in the recipe. Each analyse replaces the previous list; `note`
 * says how the reference was read when that was not the agent (vision still waiting for its security review).
 */
export async function saveDetectedText(root: string, id: string, lines: string[], now = Date.now(), note: string | null = null): Promise<void> {
  await readReference(root, id);
  await writeReplace(path.join(refDir(root, id), DETECTED_TEXT_FILE), pretty({ schema: 'signal.pm.detected-text/1', referenceId: id, lines, at: new Date(now).toISOString(), ...(note ? { note } : {}) }));
}

async function saveRecord(root: string, ref: Reference): Promise<Reference> {
  await writeOnce(refFile(root, ref.id), pretty(ref));
  return ref;
}

/** How `receiveFile` types and limits a stream (references and step uploads share it). */
export interface ReceiveRules<T> {
  /** The type from the first 16 bytes (magic bytes), or null for a file that is none of the accepted types. */
  sniff: (head: Buffer) => T | null;
  /** The byte limit of a sniffed type. */
  limitOf: (t: T) => number;
  /** The limit before the type is known (the largest accepted type). */
  maxBytes: number;
  /** The refusal over a limit. */
  tooBig: (limit: number) => PostmakerError;
  /** The refusal of a file whose type is none of the accepted ones. */
  unreadable: () => PostmakerError;
}

/**
 * Streams `body` into a new temp file in `incoming` with a running byte count (the upload stops at the limit, nothing
 * is buffered whole) and types it by magic bytes. Answers the temp file; the caller moves or removes it. On any error
 * the temp file is removed here.
 */
export async function receiveFile<T>(incoming: string, body: ReadableStream<Uint8Array>, rules: ReceiveRules<T>): Promise<{ tmp: string; type: T; total: number }> {
  await ensureDir(incoming);
  const tmp = path.join(incoming, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const out = createWriteStream(/* turbopackIgnore: true */ tmp, { flags: 'wx', mode: FILE_MODE });
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  // A write error (disk full, I/O) can arrive while the loop waits on the body or on 'drain': keep it handled here
  // and make every wait end with it, so the request answers and the temp file is removed.
  done.catch(() => undefined);
  const stopIfFailed = () => {
    if (out.errored || out.destroyed) throw out.errored ?? new Error('The upload file was closed.');
  };
  let total = 0;
  let head = Buffer.alloc(0);
  let type: T | null = null;
  let limit = rules.maxBytes;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      stopIfFailed();
      if (!value?.length) continue;
      total += value.length;
      if (!type) {
        head = Buffer.concat([head, Buffer.from(value.subarray(0, 16))]).subarray(0, 16);
        if (head.length >= 16 || total >= 16) {
          type = rules.sniff(head);
          if (!type) throw rules.unreadable();
          limit = rules.limitOf(type);
        }
      }
      if (total > limit) throw rules.tooBig(limit);
      if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once('drain', r)), done]);
      stopIfFailed();
    }
    out.end();
    await done;
    if (!type) type = rules.sniff(head);
    if (!type || total === 0) throw rules.unreadable();
    return { tmp, type, total };
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    out.destroy();
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
    throw e;
  }
}

/** The reference rules: MP4/MOV ≤ 500 MB, PNG/JPG/WebP ≤ 20 MB. */
const REFERENCE_RULES: ReceiveRules<Sniffed> = {
  sniff,
  limitOf: (t) => (t.kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES),
  maxBytes: VIDEO_MAX_BYTES,
  tooBig: (limit) => new PostmakerError(400, 'validation', limit === IMAGE_MAX_BYTES ? 'Images can be up to 20 MB.' : 'Files can be up to 500 MB.'),
  unreadable,
};

/**
 * Streams `body` into a new reference. `declaredBytes` (Content-Length) is checked first when present; the running
 * count is the real limit (a client that lies about its length is cut off at the limit).
 */
export async function addReferenceFile(
  root: string,
  project: Pick<ProjectLike, 'timeZone'>,
  body: ReadableStream<Uint8Array> | null,
  o: { declaredBytes?: number | null; rights?: Rights; by: string; now?: number },
): Promise<Reference> {
  if (!body) throw new PostmakerError(400, 'validation', 'Drop a video or an image.');
  if (o.declaredBytes != null && o.declaredBytes > VIDEO_MAX_BYTES) throw new PostmakerError(400, 'validation', 'Files can be up to 500 MB.');
  await openStore(root);
  const { tmp, type } = await receiveFile(path.join(root, 'refs', '.incoming'), body, REFERENCE_RULES);
  try {
    const probe = await probeFile(tmp, type);
    const sha = await sha256OfFile(tmp);
    const now = o.now ?? Date.now();
    const id = newReferenceId(project, now);
    const dir = refDir(root, id);
    await ensureDir(dir);
    const file = `source.${type.ext}`;
    await fs.rename(/* turbopackIgnore: true */ tmp, path.join(dir, file));
    await writeOnce(path.join(dir, 'probe.json'), pretty(probe));
    return await saveRecord(root, { schema: 'signal.pm.reference/1', id, kind: type.kind, file, sha256: sha, url: null, probe, rights: o.rights ?? 'third-party-structure-only', addedAt: new Date(now).toISOString(), addedBy: o.by });
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
  }
}

export interface PageDeps {
  fetch?: typeof fetch;
  resolve?: Parameters<typeof getPublic>[4];
}

/** A page link: refused for social platforms; otherwise fetched once through getPublic and kept as page.html. */
export async function addReferenceLink(root: string, project: Pick<ProjectLike, 'timeZone'>, rawUrl: string, o: { rights?: Rights; by: string; now?: number; deps?: PageDeps }): Promise<Reference> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new PostmakerError(400, 'validation', 'Paste a full link, like https://example.com/page.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new PostmakerError(400, 'validation', 'Only http(s) links can be added.');
  if (url.username || url.password) throw new PostmakerError(400, 'validation', 'Links with a password cannot be added.');
  if (isSocialLink(url)) throw new PostmakerError(400, 'validation', SOCIAL_LINK_TEXT);
  let page: Awaited<ReturnType<typeof getPublic>>;
  try {
    page = await getPublic(url.toString(), o.deps?.fetch ?? fetch, PAGE_MAX_BYTES, undefined, o.deps?.resolve);
  } catch (e) {
    const status = (e as { status?: number }).status;
    throw new PostmakerError(status && status < 500 ? 400 : 502, status && status < 500 ? 'validation' : 'unreachable', status && status < 500 ? (e as Error).message : 'That page could not be read.');
  }
  if (!page.ok) throw new PostmakerError(502, 'unreachable', 'That page could not be read.');
  if (/^(video|audio)\//i.test(page.type)) throw new PostmakerError(400, 'validation', SOCIAL_LINK_TEXT);
  const finalUrl = new URL(page.url);
  if (isSocialLink(finalUrl)) throw new PostmakerError(400, 'validation', SOCIAL_LINK_TEXT);
  await openStore(root);
  const now = o.now ?? Date.now();
  const id = newReferenceId(project, now);
  const dir = refDir(root, id);
  await ensureDir(dir);
  await writeOnce(path.join(dir, 'page.html'), page.body);
  return saveRecord(root, { schema: 'signal.pm.reference/1', id, kind: 'page', file: 'page.html', sha256: sha256Hex(page.body), url: finalUrl.toString(), probe: null, rights: o.rights ?? 'third-party-structure-only', addedAt: new Date(now).toISOString(), addedBy: o.by });
}
