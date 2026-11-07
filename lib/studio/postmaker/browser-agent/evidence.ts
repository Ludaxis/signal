// Screenshot and action evidence for a browser task (rule 3): every screenshot is a content-addressed object
// (sha256) in the Post maker store, listed in `actions.jsonl` (`{seq, at, kind, text, screenshot}`) under
// runs/<runId>/browser/; the finished log is itself stored as an object. Downloads are hashed and checked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PostmakerError } from '../errors';
import { appendLine, ensureDir } from '../store/fs';
import { putBytes, sha256Hex } from '../store/objects';
import type { BrowserEvent } from './driver';

export interface ActionLine {
  seq: number;
  at: string;
  kind: BrowserEvent['kind'] | 'start' | 'end' | 'stop';
  text: string;
  screenshot: string | null;
}

export interface Evidence {
  /** Stores a screenshot as an object and returns its hash. */
  shot(png: Buffer): Promise<string>;
  action(line: ActionLine): Promise<void>;
  lines(): ActionLine[];
  /** Hashes a downloaded file inside the download folder and checks its type and size. */
  download(file: string, o: { downloadDir: string; mime: string; maxBytes: number }): Promise<{ file: string; sha256: string; mime: string; bytes: number }>;
  /** Stores actions.jsonl as an object; returns its hash. */
  seal(): Promise<string>;
}

const MIME_BY_EXT: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };

export const mimeMatches = (pattern: string, mime: string) => (pattern.endsWith('/*') ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern);

const at = (b: Buffer, offset: number, ascii: string) => b.length >= offset + ascii.length && b.subarray(offset, offset + ascii.length).toString('latin1') === ascii;

/** True when the file's first bytes are what its extension claims (the extension alone is never trusted). */
export function bytesMatchMime(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'audio/mpeg':
      return at(head, 0, 'ID3') || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
    case 'audio/wav':
      return at(head, 0, 'RIFF') && at(head, 8, 'WAVE');
    case 'audio/mp4':
    case 'video/mp4':
      return at(head, 4, 'ftyp');
    case 'audio/ogg':
      return at(head, 0, 'OggS');
    case 'audio/flac':
      return at(head, 0, 'fLaC');
    case 'image/png':
      return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    default:
      return false;
  }
}

/** `objectsRoot` is the Post maker store root; `dir` is runs/<runId>/browser. */
export async function createEvidence(o: { objectsRoot: string; dir: string }): Promise<Evidence> {
  await ensureDir(o.dir);
  const log = path.join(o.dir, 'actions.jsonl');
  const kept: ActionLine[] = [];
  return {
    async shot(png) {
      return (await putBytes(o.objectsRoot, png)).sha256;
    },
    async action(line) {
      kept.push(line);
      await appendLine(log, JSON.stringify(line));
    },
    lines: () => [...kept],
    async download(file, d) {
      const outside = () => new PostmakerError(400, 'validation', 'A download landed outside its folder.');
      const missing = () => new PostmakerError(502, 'download', 'A download is missing.');
      if (!path.resolve(file).startsWith(path.resolve(d.downloadDir) + path.sep)) throw outside();
      // Symlinks are followed on both sides, so a link inside the folder cannot point at a file elsewhere.
      const root = await fs.realpath(/* turbopackIgnore: true */ d.downloadDir).catch(() => null);
      const abs = await fs.realpath(/* turbopackIgnore: true */ file).catch(() => null);
      if (!root || !abs) throw missing();
      if (!abs.startsWith(root + path.sep)) throw outside();
      const st = await fs.stat(/* turbopackIgnore: true */ abs).catch(() => null);
      if (!st?.isFile() || st.size === 0) throw missing();
      if (st.size > d.maxBytes) throw new PostmakerError(502, 'download', 'A download is too large.');
      const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      if (!mimeMatches(d.mime, mime)) throw new PostmakerError(502, 'download', 'A download has the wrong type.');
      const bytes = await fs.readFile(/* turbopackIgnore: true */ abs);
      if (!bytesMatchMime(mime, bytes.subarray(0, 16))) throw new PostmakerError(502, 'download', 'A download has the wrong type.');
      return { file: abs, sha256: sha256Hex(bytes), mime, bytes: bytes.length };
    },
    async seal() {
      return (await putBytes(o.objectsRoot, kept.map((l) => JSON.stringify(l)).join('\n') + '\n')).sha256;
    },
  };
}
