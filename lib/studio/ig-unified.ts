// Server-only: Instagram API with Unified Login (Meta, checked 2026-11-04).
// developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login
//
// Flow (attended, on your button press only):
//   1. startConnect()  — random `state`, bound to an httpOnly, HMAC-signed, 10-minute cookie;
//                        returns the Meta login URL (www.facebook.com/dialog/oauth with config_id).
//   2. finishConnect() — checks state against the cookie (single use), exchanges the code with the
//                        App Secret on graph.facebook.com, inspects the token (debug_token: validity,
//                        expiry, scopes), finds the assigned Instagram accounts
//                        (/me/assigned_instagram_accounts) and keeps only those that match a Studio
//                        project's handle.
//   3. Tokens (Business Integration System User tokens) are stored encrypted (AES-256-GCM, key from
//      SIGNAL_TOKEN_KEY) outside the repo in SIGNAL_SECRETS_DIR (default ~/.signal), mode 0600.
//      Tokens never reach the browser or Git. Meta documents sensitive query parameters for the
//      code exchange and token inspection; see the runbook's transport/logging limitations.
//      Disconnect deletes stored tokens locally.
// Off unless the "unifiedLogin" switch is on in signal.config.json.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { featureEnabled, featureOffReason, secretsDir } from '@/lib/server/signalConfig';
import { listProjects, type Project } from './projects';

type Fetch = typeof fetch;
export const FB_GRAPH = 'https://graph.facebook.com';
export const FB_DIALOG = 'https://www.facebook.com/dialog/oauth';
export const STATE_COOKIE = 'signal_ig_oauth';
export const STATE_TTL_MS = 10 * 60_000;

/** Permissions Signal can use under Unified Login, and the Studio feature each one unlocks. */
export const SCOPES = {
  basic: 'instagram_basic',
  publish: 'instagram_content_publish',
  comments: 'instagram_manage_comments',
  insights: 'instagram_manage_insights',
} as const;

export class UnifiedLoginError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const graphVersion = () => {
  const v = (process.env.META_GRAPH_VERSION ?? 'v26.0').trim();
  return /^v\d{1,3}\.\d$/.test(v) ? v : 'v26.0';
};

export interface UnifiedConfig { appId: string; appSecret: string; configId: string; redirectUri: string; key: Buffer }
export function unifiedConfig(): { ok: true; cfg: UnifiedConfig } | { ok: false; reason: string } {
  const appId = (process.env.META_APP_ID ?? '').trim();
  const appSecret = (process.env.META_APP_SECRET ?? '').trim();
  const configId = (process.env.META_LOGIN_CONFIG_ID ?? '').trim();
  const redirectUri = (process.env.META_REDIRECT_URI ?? '').trim();
  const keyRaw = (process.env.SIGNAL_TOKEN_KEY ?? '').trim();
  const missing = [!appId && 'META_APP_ID', !appSecret && 'META_APP_SECRET', !configId && 'META_LOGIN_CONFIG_ID', !redirectUri && 'META_REDIRECT_URI', !keyRaw && 'SIGNAL_TOKEN_KEY'].filter(Boolean);
  if (missing.length) return { ok: false, reason: missing.length === 1 && missing[0] === 'SIGNAL_TOKEN_KEY' ? 'Set SIGNAL_TOKEN_KEY in .env.local (see docs/instagram-unified-login.md). The Mac app sets it for you.' : 'Add the Meta app settings in Connections (Instagram (Meta) → Set up).' };
  if (!/^\d{5,20}$/.test(appId)) return { ok: false, reason: 'META_APP_ID must be the numeric Meta app ID.' };
  if (!/^\d{5,25}$/.test(configId)) return { ok: false, reason: 'META_LOGIN_CONFIG_ID must be the numeric configuration ID from the Unified Login setup.' };
  if (/^[0-9]{5,20}$/.test(appSecret) || appSecret.length < 16) return { ok: false, reason: 'META_APP_SECRET does not look like an App Secret.' };
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return { ok: false, reason: 'META_REDIRECT_URI is not a valid URL.' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'META_REDIRECT_URI must be https:// (Meta requires an HTTPS redirect URL).' };
  if (u.pathname !== '/api/studio/instagram/callback' || u.search || u.hash) return { ok: false, reason: 'META_REDIRECT_URI must end with /api/studio/instagram/callback and have no query.' };
  const key = Buffer.from(keyRaw, 'base64');
  if (key.length !== 32) return { ok: false, reason: 'SIGNAL_TOKEN_KEY must be 32 random bytes in base64 (openssl rand -base64 32).' };
  return { ok: true, cfg: { appId, appSecret, configId, redirectUri, key } };
}

export async function unifiedLoginAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('unifiedLogin'))) return { enabled: false, reason: featureOffReason('unifiedLogin') };
  const c = unifiedConfig();
  return c.ok ? { enabled: true, reason: '' } : { enabled: false, reason: c.reason };
}

// ---- secrets: never in messages ------------------------------------------------------------------
export function redactSecrets(text: string, sensitiveValues: readonly string[] = []): string {
  let t = String(text ?? '');
  // Provider errors can echo opaque codes/tokens without a recognizable prefix or query key.
  // Remove both raw and URL-encoded values before returning any upstream message to the browser.
  const secrets = new Set([process.env.META_APP_SECRET ?? '', ...sensitiveValues].filter(Boolean));
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    t = t.split(encodeURIComponent(secret)).join('[secret]').split(secret).join('[secret]');
  }
  return t
    .replace(/(access_token|client_secret|input_token|code)=[^&\s"']+/gi, '$1=[redacted]')
    .replace(/\bEA[A-Za-z0-9]{20,}\b/g, '[token]')
    .replace(/\bIG[A-Za-z0-9]{20,}\b/g, '[token]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

// ---- OAuth state (CSRF) ----------------------------------------------------------------------------
const hkdf = (key: Buffer, label: string) => createHmac('sha256', key).update(`signal:${label}`).digest();
const b64u = (b: Buffer) => b.toString('base64url');

export interface StatePayload { n: string; p: string; u: string; e: number }

/** Creates the state value and the signed cookie that must come back with it. */
export function makeState(project: string, userEmail: string, key: Buffer, now = Date.now()): { state: string; cookie: string } {
  const n = b64u(randomBytes(24));
  const payload: StatePayload = { n, p: project, u: createHash('sha256').update(userEmail).digest('hex').slice(0, 32), e: now + STATE_TTL_MS };
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(createHmac('sha256', hkdf(key, 'oauth-state')).update(body).digest());
  return { state: n, cookie: `${body}.${sig}` };
}

/** Verifies the callback's state against the cookie: signature, expiry, nonce, same signed-in user. */
export function checkState(state: string | null, cookie: string | null | undefined, userEmail: string, key: Buffer, now = Date.now()): StatePayload {
  if (!state || !cookie) throw new UnifiedLoginError(400, 'The login session is missing or expired. Start Connect again from Signal.');
  const [body, sig] = cookie.split('.');
  if (!body || !sig) throw new UnifiedLoginError(400, 'The login session is invalid. Start Connect again.');
  const want = createHmac('sha256', hkdf(key, 'oauth-state')).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new UnifiedLoginError(400, 'The login session is invalid. Start Connect again.');
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new UnifiedLoginError(400, 'The login session is invalid. Start Connect again.');
  }
  if (typeof p.e !== 'number' || now > p.e) throw new UnifiedLoginError(400, 'The login took longer than 10 minutes. Start Connect again.');
  const a = Buffer.from(String(p.n));
  const b = Buffer.from(String(state));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnifiedLoginError(400, 'The login answer does not match this browser session (state mismatch). Nothing was saved.');
  if (p.u !== createHash('sha256').update(userEmail).digest('hex').slice(0, 32)) throw new UnifiedLoginError(403, 'The login was started from another Signal session.');
  return p;
}

export function loginUrl(cfg: UnifiedConfig, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.appId, config_id: cfg.configId, redirect_uri: cfg.redirectUri, response_type: 'code', state, prompt: 'login' });
  return `${FB_DIALOG}?${q.toString()}`;
}

// ---- encrypted connection store ----------------------------------------------------------------
export interface Connection {
  project: string;
  igUserId: string;
  username: string;
  clientBusinessId: string | null;
  scopes: string[];
  expiresAt: string | null; // null = does not expire (per the login configuration)
  connectedAt: string;
  connectedBy: string;
  token: string; // decrypted only in memory
}
interface StoreFile { v: 1; connections: Record<string, { iv: string; tag: string; data: string }> }

export { secretsDir };
const storeFile = () => path.join(secretsDir(), 'instagram-connections.json');

function seal(key: Buffer, value: unknown): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', hkdf(key, 'token-store'), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { iv: b64u(iv), tag: b64u(c.getAuthTag()), data: b64u(data) };
}
function open<T>(key: Buffer, box: { iv: string; tag: string; data: string }): T {
  const d = createDecipheriv('aes-256-gcm', hkdf(key, 'token-store'), Buffer.from(box.iv, 'base64url'));
  d.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64url')), d.final()]).toString('utf8')) as T;
}

async function readStore(): Promise<StoreFile> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ storeFile(), 'utf8')) as StoreFile;
    return j?.v === 1 && j.connections ? j : { v: 1, connections: {} };
  } catch {
    return { v: 1, connections: {} };
  }
}
async function writeStore(s: StoreFile): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ secretsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, storeFile());
}

export async function getConnection(projectId: string): Promise<Connection | null> {
  const c = unifiedConfig();
  if (!c.ok) return null;
  const box = (await readStore()).connections[projectId];
  if (!box) return null;
  try {
    return open<Connection>(c.cfg.key, box);
  } catch {
    return null; // wrong key or tampered: treat as not connected
  }
}

/** Public view of a connection (no token). */
export function describe(c: Connection | null, now = Date.now()) {
  if (!c) return null;
  const exp = c.expiresAt ? Date.parse(c.expiresAt) : null;
  return {
    username: c.username,
    igUserId: c.igUserId,
    scopes: c.scopes,
    expiresAt: c.expiresAt,
    expired: exp != null && exp <= now,
    daysLeft: exp == null ? null : Math.max(0, Math.floor((exp - now) / 86_400_000)),
    connectedAt: c.connectedAt,
    connectedBy: c.connectedBy,
    features: { publish: c.scopes.includes(SCOPES.publish), comments: c.scopes.includes(SCOPES.comments), insights: c.scopes.includes(SCOPES.insights) },
  };
}

export async function disconnect(projectId: string): Promise<boolean> {
  const s = await readStore();
  if (!s.connections[projectId]) return false;
  delete s.connections[projectId];
  await writeStore(s);
  return true;
}

// ---- Graph calls -----------------------------------------------------------------------------------
async function graphGet(f: Fetch, pathAndQuery: string, bearer?: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let r: Response;
  try {
    r = await f(`${FB_GRAPH}/${graphVersion()}${pathAndQuery}`, { headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, signal: AbortSignal.timeout(20_000), cache: 'no-store', redirect: 'error' });
  } catch {
    throw new UnifiedLoginError(502, 'Meta did not answer.');
  }
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}
const errText = (j: Record<string, unknown> | null, status: number, sensitiveValues: readonly string[] = []) => redactSecrets(String((j?.error as { message?: string } | undefined)?.message ?? `HTTP ${status}`), sensitiveValues);

export interface FinishResult { connected: { project: string; username: string; scopes: string[]; expiresAt: string | null }[]; ignored: string[]; missingScopes: string[] }

/** Callback: exchange the code, inspect the token, map accounts to projects and store them. */
export async function finishConnect(o: { code: string; statePayload: StatePayload; by: string; fetch?: Fetch; now?: number; projects?: Project[] }): Promise<FinishResult> {
  const c = unifiedConfig();
  if (!c.ok) throw new UnifiedLoginError(403, c.reason);
  const { cfg } = c;
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now();
  if (!/^[A-Za-z0-9_\-#.]{10,2000}$/.test(o.code)) throw new UnifiedLoginError(400, 'Meta returned an unexpected code.');

  // 1. Meta's Unified Login guide documents GET with client_secret/code query parameters.
  // Keep that supported shape server-side; Next dev request/fetch logging is disabled in
  // next.config.ts. Do not add request/response tracing here (see the runbook).
  const q = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code: o.code });
  const ex = await graphGet(f, `/oauth/access_token?${q.toString()}`);
  const token = typeof ex.json?.access_token === 'string' ? ex.json.access_token : '';
  if (ex.status !== 200 || !token) throw new UnifiedLoginError(502, `Meta did not issue a token: ${errText(ex.json, ex.status, [o.code, token])}`);

  // 2. Inspect: valid, for this app, scopes, expiry.
  // The inspected token remains the documented input_token parameter. Authenticate the
  // request with a Bearer header so the app credential is not duplicated in the debug URL.
  const dq = new URLSearchParams({ input_token: token });
  const dbg = await graphGet(f, `/debug_token?${dq.toString()}`, `${cfg.appId}|${cfg.appSecret}`);
  const d = (dbg.json?.data ?? {}) as { app_id?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[]; type?: string };
  if (dbg.status !== 200 || d.is_valid !== true) throw new UnifiedLoginError(502, `Meta says the new token is not valid: ${errText(dbg.json, dbg.status, [o.code, token])}`);
  if (String(d.app_id) !== cfg.appId) throw new UnifiedLoginError(403, 'The token was issued for another Meta app. Nothing was saved.');
  const scopes = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
  const expiresAt = typeof d.expires_at === 'number' && d.expires_at > 0 ? new Date(d.expires_at * 1000).toISOString() : null;
  const missingScopes = [SCOPES.basic, SCOPES.publish].filter((s) => !scopes.includes(s));

  // 3. Business and Instagram accounts assigned to this system user (/me is the system user, not Instagram).
  const biz = await graphGet(f, '/me?fields=client_business_id', token);
  const clientBusinessId = typeof biz.json?.client_business_id === 'string' ? biz.json.client_business_id : null;
  const acc = await graphGet(f, '/me/assigned_instagram_accounts?fields=id,username', token);
  if (acc.status !== 200) throw new UnifiedLoginError(502, `Could not list the connected Instagram accounts: ${errText(acc.json, acc.status, [o.code, token])}`);
  const rows = ((acc.json?.data as { id?: string; username?: string }[] | undefined) ?? []).filter((r) => r.id && r.username);

  // 4. Keep only accounts that match a Studio project's handle. Others are ignored, not stored.
  const projects = o.projects ?? (await listProjects());
  const byHandle = new Map(projects.map((p) => [p.handle.replace(/^@/, '').toLowerCase(), p]));
  const store = await readStore();
  const connected: FinishResult['connected'] = [];
  const ignored: string[] = [];
  for (const r of rows) {
    const p = byHandle.get(String(r.username).toLowerCase());
    if (!p) {
      ignored.push(`@${r.username}`);
      continue;
    }
    const conn: Connection = { project: p.id, igUserId: String(r.id), username: String(r.username), clientBusinessId, scopes, expiresAt, connectedAt: new Date(now).toISOString(), connectedBy: o.by, token };
    store.connections[p.id] = seal(cfg.key, conn);
    connected.push({ project: p.id, username: conn.username, scopes, expiresAt });
  }
  if (connected.length) await writeStore(store);
  return { connected, ignored, missingScopes };
}
