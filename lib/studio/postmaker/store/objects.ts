// Content-addressed objects: every artifact is stored once at objects/sha256/<first 2 hex>/<full hex>,
// mode 0600, written to a temp name and linked into place, never modified. JSON is canonicalised with RFC 8785
// (JSON Canonicalization Scheme, implemented here) and the canonical bytes are what is stored and hashed, so the
// same value always has the same object id whatever its key order.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PostmakerError } from '../errors';
import { ensureDir, exists, FILE_MODE } from './fs';
import { objectPath, SHA_RE } from './paths';

// ---- RFC 8785 ------------------------------------------------------------------------------------------------------

/** Lone UTF-16 surrogates are not valid I-JSON (RFC 7493), which RFC 8785 requires. */
function assertWellFormed(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      throw new PostmakerError(400, 'jcs', 'Text contains a broken character (lone surrogate).');
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new PostmakerError(400, 'jcs', 'Text contains a broken character (lone surrogate).');
  }
}

/**
 * RFC 8785: strings are serialised as ECMAScript JSON.stringify does: `"` and `\` escaped, U+0008, U+0009,
 * U+000A, U+000C, U+000D as \b \t \n \f \r, other controls below U+0020 as lower-case \u00xx, everything else literal.
 */
function serialiseString(s: string): string {
  assertWellFormed(s);
  return JSON.stringify(s);
}

/** RFC 8785: numbers use the ECMAScript Number-to-String algorithm; NaN and ±Infinity are errors; -0 is "0". */
function serialiseNumber(n: number): string {
  if (!Number.isFinite(n)) throw new PostmakerError(400, 'jcs', 'Numbers must be finite.');
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/** UTF-16 code unit order (RFC 8785); JavaScript's `<` on strings compares code units. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function serialise(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serialiseNumber(value);
    case 'string':
      return serialiseString(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined; // dropped from objects, null in arrays (as JSON.stringify)
    case 'bigint':
      throw new PostmakerError(400, 'jcs', 'BigInt values cannot be canonicalised.');
  }
  const obj = value as object & { toJSON?: () => unknown };
  if (typeof obj.toJSON === 'function') return serialise(obj.toJSON(), seen);
  if (seen.has(obj)) throw new PostmakerError(400, 'jcs', 'Circular value.');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => serialise(v, seen) ?? 'null').join(',')}]`;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort(byCodeUnits)) {
      const v = serialise((obj as Record<string, unknown>)[k], seen);
      if (v !== undefined) parts.push(`${serialiseString(k)}:${v}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** RFC 8785 canonical JSON text of `value`. */
export function canonicalize(value: unknown): string {
  const out = serialise(value, new Set());
  if (out === undefined) throw new PostmakerError(400, 'jcs', 'Nothing to canonicalise.');
  return out;
}

/** The canonical UTF-8 bytes (RFC 8785). */
export const canonicalBytes = (value: unknown): Buffer => Buffer.from(canonicalize(value), 'utf8');

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** sha256 of the canonical JSON of `value`: the hash of every JSON record in Post maker. */
export const hashJson = (value: unknown): string => sha256Hex(canonicalBytes(value));

export async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(/* turbopackIgnore: true */ file), h);
  return h.digest('hex');
}

// ---- object store ----------------------------------------------------------------------------------------------

export interface PutResult {
  sha256: string;
  bytes: number;
  existed: boolean;
}

/** Links a finished temp file to its content address; an existing object is kept (same hash = same bytes). */
async function commitTemp(root: string, tmp: string, sha: string): Promise<boolean> {
  const dest = objectPath(root, sha);
  await ensureDir(path.dirname(dest));
  try {
    if (await exists(dest)) return true;
    try {
      await fs.link(/* turbopackIgnore: true */ tmp, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return true;
      if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw e;
      // No hard links on this volume: rename is still atomic, and identical bytes make a race harmless.
      await fs.rename(/* turbopackIgnore: true */ tmp, dest);
    }
    return false;
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
  }
}

const tmpIn = async (root: string) => {
  const dir = path.join(root, 'objects', 'tmp');
  await ensureDir(dir);
  return path.join(dir, `${process.pid}.${randomBytes(6).toString('hex')}`);
};

export async function putBytes(root: string, data: Uint8Array | string): Promise<PutResult> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const sha = sha256Hex(buf);
  if (await exists(objectPath(root, sha))) return { sha256: sha, bytes: buf.length, existed: true };
  const tmp = await tmpIn(root);
  await fs.writeFile(/* turbopackIgnore: true */ tmp, buf, { flag: 'wx', mode: FILE_MODE });
  const existed = await commitTemp(root, tmp, sha);
  return { sha256: sha, bytes: buf.length, existed };
}

/** Stores the canonical bytes of `value`; the object id is `hashJson(value)`. */
export const putJson = (root: string, value: unknown): Promise<PutResult> => putBytes(root, canonicalBytes(value));

/** Copies a produced media file in (hashing as it streams); the source file is left untouched. */
export async function putFile(root: string, source: string): Promise<PutResult> {
  const tmp = await tmpIn(root);
  const h = createHash('sha256');
  await fs.copyFile(/* turbopackIgnore: true */ source, tmp);
  await fs.chmod(/* turbopackIgnore: true */ tmp, FILE_MODE);
  await pipeline(createReadStream(/* turbopackIgnore: true */ tmp), h);
  const sha = h.digest('hex');
  const { size } = await fs.stat(/* turbopackIgnore: true */ tmp);
  const existed = await commitTemp(root, tmp, sha);
  return { sha256: sha, bytes: size, existed };
}

export async function hasObject(root: string, sha: string): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false;
  return exists(objectPath(root, sha));
}

/** Reads an object; `verify` re-hashes it and refuses a file whose bytes no longer match its name. */
export async function getBytes(root: string, sha: string, o: { verify?: boolean } = {}): Promise<Buffer> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(/* turbopackIgnore: true */ objectPath(root, sha));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new PostmakerError(404, 'object-missing', 'A saved file is missing.');
    throw e;
  }
  if (o.verify && sha256Hex(buf) !== sha) throw new PostmakerError(409, 'object-changed', 'A saved file has changed on disk.');
  return buf;
}

export async function getJson<T = unknown>(root: string, sha: string, o: { verify?: boolean } = {}): Promise<T> {
  const buf = await getBytes(root, sha, o);
  return JSON.parse(buf.toString('utf8')) as T;
}
