// Server-only: small encrypted store for tokens you paste into Signal (Figma today).
//
// AES-256-GCM with a key derived from SIGNAL_TOKEN_KEY (32 random bytes, base64). The Mac app
// creates that key once and keeps it in macOS Keychain; on a server you set it in .env.local.
// The file lives in SIGNAL_SECRETS_DIR (default ~/.signal), mode 0600. Values never reach the browser.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { secretsDir } from './local-data';

interface Box { iv: string; tag: string; data: string }
interface StoreFile { v: 1; items: Record<string, Box> }

export function tokenKey(): { ok: true; key: Buffer } | { ok: false; reason: string } {
  const raw = (process.env.SIGNAL_TOKEN_KEY ?? '').trim();
  if (!raw) return { ok: false, reason: 'Set SIGNAL_TOKEN_KEY in .env.local (openssl rand -base64 32). The Mac app sets it for you.' };
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) return { ok: false, reason: 'SIGNAL_TOKEN_KEY must be 32 random bytes in base64 (openssl rand -base64 32).' };
  return { ok: true, key };
}

const derive = (key: Buffer, name: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `signal-secret:${name}`, 32));
const file = (store: string) => path.join(secretsDir(), `${store}.json`);

async function read(store: string): Promise<StoreFile> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file(store), 'utf8')) as StoreFile;
    return j?.v === 1 && j.items ? j : { v: 1, items: {} };
  } catch {
    return { v: 1, items: {} };
  }
}
async function write(store: string, s: StoreFile): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ secretsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(store)}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file(store));
}

export async function putSecret(store: string, name: string, value: string): Promise<void> {
  const k = tokenKey();
  if (!k.ok) throw new Error(k.reason);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive(k.key, `${store}/${name}`), iv);
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  const s = await read(store);
  s.items[name] = { iv: iv.toString('base64url'), tag: c.getAuthTag().toString('base64url'), data: data.toString('base64url') };
  await write(store, s);
}

export async function getSecret(store: string, name: string): Promise<string | null> {
  const k = tokenKey();
  if (!k.ok) return null;
  const box = (await read(store)).items[name];
  if (!box) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', derive(k.key, `${store}/${name}`), Buffer.from(box.iv, 'base64url'));
    d.setAuthTag(Buffer.from(box.tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key or tampered
  }
}

export async function deleteSecret(store: string, name: string): Promise<boolean> {
  const s = await read(store);
  if (!s.items[name]) return false;
  delete s.items[name];
  await write(store, s);
  return true;
}

/** Names saved in a store (never the values). */
export async function listSecretNames(store: string): Promise<string[]> {
  return Object.keys((await read(store)).items);
}
