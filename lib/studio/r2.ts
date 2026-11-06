// Server-only: short-lived public media links on Cloudflare R2.
// Instagram's API downloads each image or video from a public URL, so Signal puts the approved
// bytes in the owner's R2 bucket just before publishing and deletes them once Instagram has them.
// S3-compatible API with AWS Signature V4 (no SDK). Keys stay in process.env and are never logged.
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE (the bucket's public URL or a custom domain).
import { createHash, createHmac, randomUUID } from 'node:crypto';

type Fetch = typeof fetch;

export class MediaHostError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function r2Config(): { ok: true; account: string; keyId: string; secret: string; bucket: string; publicBase: string } | { ok: false; reason: string } {
  const account = process.env.R2_ACCOUNT_ID ?? '';
  const keyId = process.env.R2_ACCESS_KEY_ID ?? '';
  const secret = process.env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = process.env.R2_BUCKET ?? '';
  const publicBase = (process.env.R2_PUBLIC_BASE ?? '').replace(/\/+$/, '');
  const missing = [!account && 'R2_ACCOUNT_ID', !keyId && 'R2_ACCESS_KEY_ID', !secret && 'R2_SECRET_ACCESS_KEY', !bucket && 'R2_BUCKET', !publicBase && 'R2_PUBLIC_BASE'].filter(Boolean);
  if (missing.length) return { ok: false, reason: 'Add the media bucket keys in Connections → Keys.' };
  if (!/^https:\/\//.test(publicBase)) return { ok: false, reason: 'R2_PUBLIC_BASE must be an https:// address.' };
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) return { ok: false, reason: 'R2_BUCKET is not a valid bucket name.' };
  return { ok: true, account, keyId, secret, bucket, publicBase };
}

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS SigV4 headers for one request (path-style, region "auto", service "s3"). Exported for tests. */
export function signV4(o: { method: string; host: string; path: string; body: Buffer; contentType?: string; keyId: string; secret: string; now: Date }): Record<string, string> {
  const amzDate = o.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(o.body);
  const headers: Record<string, string> = { host: o.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (o.contentType) headers['content-type'] = o.contentType;
  const names = Object.keys(headers).sort();
  const canonical = [o.method, o.path.split('/').map(enc).join('/'), '', names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), 'auto'), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(toSign).digest('hex');
  const out: Record<string, string> = { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${o.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
  delete out.host;
  return out;
}

async function r2Request(f: Fetch, method: 'PUT' | 'DELETE', key: string, body: Buffer, contentType?: string): Promise<number> {
  const c = r2Config();
  if (!c.ok) throw new MediaHostError(403, c.reason);
  const host = `${c.account}.r2.cloudflarestorage.com`;
  const path = `/${c.bucket}/${key}`;
  const headers = signV4({ method, host, path, body, contentType, keyId: c.keyId, secret: c.secret, now: new Date() });
  try {
    const r = await f(`https://${host}${path.split('/').map(enc).join('/')}`, {
      method,
      headers,
      body: method === 'PUT' ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(60_000),
      cache: 'no-store',
    });
    return r.status;
  } catch {
    throw new MediaHostError(502, 'The media bucket did not answer.');
  }
}

export interface HostedFile { key: string; url: string }

/** Puts files at unguessable keys and returns their public URLs. */
export async function hostFiles(prefix: string, files: { name: string; body: Buffer; type: string }[], f: Fetch = fetch): Promise<HostedFile[]> {
  const c = r2Config();
  if (!c.ok) throw new MediaHostError(403, c.reason);
  const safePrefix = prefix.replace(/[^a-z0-9/-]/gi, '-');
  const out: HostedFile[] = [];
  try {
    for (const file of files) {
      const key = `signal/${safePrefix}/${randomUUID()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
      const st = await r2Request(f, 'PUT', key, file.body, file.type);
      if (st < 200 || st >= 300) throw new MediaHostError(502, `The media bucket refused the upload (HTTP ${st}). Check the R2 keys and bucket.`);
      out.push({ key, url: `${c.publicBase}/${key.split('/').map(enc).join('/')}` });
    }
  } catch (e) {
    await removeFiles(out.map((x) => x.key), f);
    throw e;
  }
  return out;
}

/** Best effort: deletes hosted files; failures are ignored (the files are unlisted and unguessable). */
export async function removeFiles(keys: string[], f: Fetch = fetch): Promise<number> {
  let n = 0;
  for (const key of keys) {
    try {
      const st = await r2Request(f, 'DELETE', key, Buffer.alloc(0));
      if (st >= 200 && st < 300) n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}
