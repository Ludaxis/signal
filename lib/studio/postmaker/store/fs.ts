// File primitives of the Post maker store. Every file is mode 0600 and every folder 0700 (the content folder holds
// unreleased art and drafts). Writes go to a unique temp name first; write-once files are then hard-linked into
// place, which fails atomically when the target exists (no truncated file can block a retry, and no second writer
// can win), and replaceable files are renamed over the target (the content.ts writeJsonReplace pattern).
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { PostmakerError } from '../errors';

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: DIR_MODE });
}

const tempName = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);

/** Writes `data` once. A second write of the same path fails with 409 `exists`, whatever the content. */
export async function writeOnce(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = tempName(file);
  await fs.writeFile(/* turbopackIgnore: true */ tmp, data, { flag: 'wx', mode: FILE_MODE });
  try {
    try {
      await fs.link(/* turbopackIgnore: true */ tmp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Volumes without hard links (exFAT, some network shares): an exclusive copy keeps write-once semantics.
      if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw e;
      await fs.copyFile(/* turbopackIgnore: true */ tmp, file, fsConstants.COPYFILE_EXCL);
      await fs.chmod(/* turbopackIgnore: true */ file, FILE_MODE);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PostmakerError(409, 'exists', 'This is already saved and cannot be changed.');
    throw e;
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
  }
}

/** Replaces `file` atomically (temp file, then rename). Only for the few mutable files (heads, indexes, run.json). */
export async function writeReplace(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = tempName(file);
  try {
    await fs.writeFile(/* turbopackIgnore: true */ tmp, data, { flag: 'wx', mode: FILE_MODE });
    await fs.rename(/* turbopackIgnore: true */ tmp, file);
  } catch (e) {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
    throw e;
  }
}

/** Appends one line; repairs a torn last line (a crash mid-append) by starting on a fresh line. */
export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file));
  let prefix = '';
  try {
    const fh = await fs.open(/* turbopackIgnore: true */ file, 'r');
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) prefix = '\n';
      }
    } finally {
      await fh.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.appendFile(/* turbopackIgnore: true */ file, `${prefix}${line}\n`, { mode: FILE_MODE });
}

export const pretty = (data: unknown) => JSON.stringify(data, null, 2) + '\n';

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(/* turbopackIgnore: true */ file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PostmakerError(422, 'unreadable', `${path.basename(file)} could not be read.`);
  }
}

/** Parses a JSON-lines file, skipping blank and torn lines. */
export async function readJsonLines<T>(file: string): Promise<T[]> {
  const text = await readText(file);
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line from a crash mid-append: ignored, the next append starts on a fresh line.
    }
  }
  return out;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(/* turbopackIgnore: true */ file);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(/* turbopackIgnore: true */ dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

// ---- schema tags -----------------------------------------------------------------------------------------

const SCHEMA_RE = /^signal\.pm\.([a-z][a-z-]*)\/(\d+)$/;

/** Accepts the current major of `entity`; refuses a newer major with "Made by a newer Signal". */
export function checkSchema(value: unknown, entity: string, major: number): void {
  const tag = value && typeof value === 'object' ? (value as { schema?: unknown }).schema : undefined;
  const m = typeof tag === 'string' ? SCHEMA_RE.exec(tag) : null;
  if (!m || m[1] !== entity) throw new PostmakerError(422, 'schema', `This is not a ${entity} file.`);
  const found = Number(m[2]);
  if (found > major) throw new PostmakerError(409, 'schema-newer', 'Made by a newer Signal');
  if (found !== major) throw new PostmakerError(422, 'schema-older', `This ${entity} file is from an older Signal.`);
}
