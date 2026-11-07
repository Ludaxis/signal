// Step uploads (`step.edit` with `output.replaceFile {port, uploadId}`, "Replace file"): a file
// the person drops on a step's output is streamed in exactly like a reference (references.ts `receiveFile`: running
// byte count, typed by magic bytes, never by name or Content-Type), probed in this process, and kept under
// `postmaker/uploads/<up-…>/` (content folder, outside the repository) until an edit uses it. Accepted: MP4/MOV video
// ≤ 500 MB and ≤ 300 s, PNG/JPG/WebP images ≤ 20 MB, WAV sound ≤ 100 MB. The edit checks the port type (an image port
// takes an image, and so on) and stores the bytes as an object; nothing is ever deleted here (deletion is gated).
// The route takes the same raw body (or a small multipart form) as the reference route; which one the API keeps is
// the Product Lead's open ruling (raw body vs multipart).
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PostmakerError } from './errors';
import { IMAGE_MAX_BYTES, probeFile, sniff, VIDEO_MAX_BYTES, type Sniffed } from './media-probe';
import { receiveFile } from './references';
import { ensureDir, pretty, readJsonFile, writeOnce } from './store/fs';
import { sha256OfFile } from './store/objects';
import { openStore } from './store/recipes';
import type { ArtifactRef } from './types';

export const UPLOAD_ID_RE = /^up-[0-9a-f]{8,32}$/;
export const AUDIO_MAX_BYTES = 100 * 1024 * 1024;

export type UploadType = Sniffed | { kind: 'audio'; ext: 'wav'; mime: 'audio/wav' };

export interface StepUpload {
  schema: 'signal.pm.upload/1';
  id: string;
  kind: 'image' | 'video' | 'audio';
  mime: UploadType['mime'];
  ext: UploadType['ext'];
  file: string;
  bytes: number;
  sha256: string;
  meta: NonNullable<ArtifactRef['meta']>;
  addedAt: string;
  addedBy: string;
}

const ascii = (b: Uint8Array, at: number, n: number) => Buffer.from(b.subarray(at, at + n)).toString('latin1');

/** The reference types plus WAV sound (RIFF … WAVE). */
export function sniffUpload(head: Uint8Array): UploadType | null {
  const s = sniff(head);
  if (s) return s;
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
  return null;
}

const unreadableUpload = () => new PostmakerError(400, 'validation', 'This file could not be read. Use an MP4 or MOV video, a PNG, JPG or WebP image, or a WAV sound.');

const limitOf = (t: UploadType) => (t.kind === 'video' ? VIDEO_MAX_BYTES : t.kind === 'audio' ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES);
const tooBig = (limit: number) => new PostmakerError(400, 'validation', limit === IMAGE_MAX_BYTES ? 'Images can be up to 20 MB.' : limit === AUDIO_MAX_BYTES ? 'Sounds can be up to 100 MB.' : 'Files can be up to 500 MB.');

/** WAV header: the `fmt ` chunk (sample rate, bytes per second) and the `data` chunk size; refused when absent. */
export async function probeWav(file: string): Promise<{ sampleRate: number; durationMs: number }> {
  const fh = await fs.open(/* turbopackIgnore: true */ file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let at = 12;
    let sampleRate = 0;
    let byteRate = 0;
    while (at + 8 <= bytesRead) {
      const id = buf.toString('latin1', at, at + 4);
      const size = buf.readUInt32LE(at + 4);
      if (id === 'fmt ' && at + 8 + 16 <= bytesRead) {
        sampleRate = buf.readUInt32LE(at + 12);
        byteRate = buf.readUInt32LE(at + 16);
      }
      if (id === 'data') {
        if (!(sampleRate > 0) || !(byteRate > 0) || size === 0) break;
        return { sampleRate, durationMs: Math.round((size / byteRate) * 1000) };
      }
      at += 8 + size + (size % 2);
    }
  } finally {
    await fh.close();
  }
  throw unreadableUpload();
}

const uploadsDir = (root: string) => path.join(root, 'uploads');
const uploadDir = (root: string, id: string) => {
  if (!UPLOAD_ID_RE.test(id)) throw new PostmakerError(400, 'validation', 'Unknown upload.');
  return path.join(uploadsDir(root), id);
};

/** Streams `body` into a new upload (see the header). `declaredBytes` (Content-Length) is checked first. */
export async function addUpload(root: string, body: ReadableStream<Uint8Array> | null, o: { declaredBytes?: number | null; by: string; now?: number }): Promise<StepUpload> {
  if (!body) throw new PostmakerError(400, 'validation', 'Drop a video, an image or a sound.');
  if (o.declaredBytes != null && o.declaredBytes > VIDEO_MAX_BYTES) throw tooBig(VIDEO_MAX_BYTES);
  await openStore(root);
  const { tmp, type, total } = await receiveFile(path.join(uploadsDir(root), '.incoming'), body, { sniff: sniffUpload, limitOf, maxBytes: VIDEO_MAX_BYTES, tooBig, unreadable: unreadableUpload });
  try {
    let meta: StepUpload['meta'];
    if (type.kind === 'audio') meta = await probeWav(tmp);
    else {
      const p = await probeFile(tmp, type);
      meta = { width: p.width, height: p.height, ...(type.kind === 'video' ? { durationMs: p.durationMs } : {}) };
    }
    const sha256 = await sha256OfFile(tmp);
    const id = `up-${randomBytes(8).toString('hex')}`;
    const dir = uploadDir(root, id);
    await ensureDir(dir);
    const file = `source.${type.ext}`;
    await fs.rename(/* turbopackIgnore: true */ tmp, path.join(dir, file));
    const up: StepUpload = { schema: 'signal.pm.upload/1', id, kind: type.kind, mime: type.mime, ext: type.ext, file, bytes: total, sha256, meta, addedAt: new Date(o.now ?? Date.now()).toISOString(), addedBy: o.by };
    await writeOnce(path.join(dir, 'upload.json'), pretty(up));
    return up;
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
  }
}

/** An upload and the absolute path of its file; 404 when it is unknown, or when its file no longer matches. */
export async function readUpload(root: string, id: string): Promise<{ upload: StepUpload; path: string }> {
  const dir = uploadDir(root, id);
  const up = await readJsonFile<StepUpload>(path.join(dir, 'upload.json')).catch(() => null);
  if (!up || up.id !== id || !/^source\.(mp4|mov|png|jpg|webp|wav)$/.test(up.file)) throw new PostmakerError(404, 'not_found', 'Unknown upload.');
  const file = path.join(dir, up.file);
  const sha = await sha256OfFile(file).catch(() => null);
  if (sha !== up.sha256) throw new PostmakerError(404, 'not_found', 'Unknown upload.');
  return { upload: up, path: file };
}
