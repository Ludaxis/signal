// Server-only: Upload-Post profile management for the project wizard.
// Endpoints (docs.upload-post.com, checked 2026-11-04): the profile ("user") collection under
// /api/uploadposts: list, read one by username, create, and generate-jwt (hosted connect page; not on every plan).
// Allowed only when the "uploadPostProfiles" switch is on in signal.config.json.
// The API key stays in process.env and never reaches the browser.
// Monthly upload quota: Upload-Post answers carry usage{count,limit,last_reset}. The last value seen
// is kept per Upload-Post account in <data dir>/upload-post-usage.json, keyed by a short one-way
// fingerprint of the key (never the key).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { listPackages } from './content';
import { dataDir } from './local-data';
import { listProjects, withProject } from './projects';

export const UP_BASE = 'https://api.upload-post.com';
export const UP_DASHBOARD = 'https://app.upload-post.com/';
/** The profile collection path (Upload-Post calls profiles "users"). */
export const UP_PROFILES_PATH = '/api/uploadposts/' + 'users';
export const upProfileUrl = (username: string) => `${UP_BASE}${UP_PROFILES_PATH}/${encodeURIComponent(username)}`;
type Fetch = typeof fetch;

export class UploadPostError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface UpProfile {
  username: string;
  displayName: string | null;
  instagram: { handle: string | null; name: string | null; reauth: boolean } | null;
}

export async function profileManagementAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('uploadPostProfiles'))) return { enabled: false, reason: `${featureOffReason('uploadPostProfiles')} Until then, type the profile username.` };
  if (!process.env.UPLOAD_POST_API_KEY) return { enabled: false, reason: 'Add your Upload-Post API key in Connections (Upload-Post → Manage).' };
  return { enabled: true, reason: '' };
}

async function call(f: Fetch, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const allowed = await profileManagementAllowed();
  if (!allowed.enabled) throw new UploadPostError(403, allowed.reason);
  let r: Response;
  try {
    r = await f(`${UP_BASE}${path}`, {
      method,
      headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch {
    throw new UploadPostError(502, 'Upload-Post did not answer. Try again.');
  }
  const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  await noteUsage(json);
  return { status: r.status, json };
}

function toProfile(p: Record<string, unknown>): UpProfile {
  const social = (p.social_accounts ?? {}) as Record<string, unknown>;
  const ig = social.instagram;
  const igObj = ig && typeof ig === 'object' ? (ig as Record<string, unknown>) : null;
  // `handle` is the public @name; `username` is Instagram's opaque account id, so never show it as a handle.
  const handle = igObj && igObj.handle ? String(igObj.handle).replace(/^@/, '') || null : null;
  return {
    username: String(p.username ?? ''),
    displayName: p.display_name ? String(p.display_name) : null,
    instagram: igObj ? { handle: handle ? `@${handle}` : null, name: igObj.display_name ? String(igObj.display_name) : null, reauth: igObj.reauth_required === true } : null,
  };
}

export async function listUpProfiles(f: Fetch = fetch): Promise<{ plan: string | null; limit: number | null; profiles: UpProfile[] }> {
  const r = await call(f, 'GET', UP_PROFILES_PATH);
  if (r.status !== 200 || !r.json) throw new UploadPostError(r.status, `Upload-Post answered HTTP ${r.status}.`);
  const list = Array.isArray(r.json.profiles) ? (r.json.profiles as Record<string, unknown>[]) : [];
  return { plan: r.json.plan ? String(r.json.plan) : null, limit: typeof r.json.limit === 'number' ? r.json.limit : null, profiles: list.map(toProfile) };
}

export async function getUpProfile(username: string, f: Fetch = fetch): Promise<UpProfile | null> {
  const r = await call(f, 'GET', `${UP_PROFILES_PATH}/${encodeURIComponent(username)}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.json?.profile) throw new UploadPostError(r.status, `Upload-Post answered HTTP ${r.status}.`);
  return toProfile(r.json.profile as Record<string, unknown>);
}

export const UP_USERNAME_RE = /^[A-Za-z0-9_@-]{2,40}$/;

export async function createUpProfile(username: string, displayName: string, f: Fetch = fetch): Promise<UpProfile> {
  if (!UP_USERNAME_RE.test(username)) throw new UploadPostError(400, 'Profile username: 2–40 letters, numbers, _, @ or -.');
  const r = await call(f, 'POST', UP_PROFILES_PATH, { username, display_name: displayName.slice(0, 100) });
  if (r.status === 409) throw new UploadPostError(409, `A profile named “${username}” already exists. Pick it from the list instead.`);
  if (r.status === 403) throw new UploadPostError(403, 'Your Upload-Post plan has no free profile slot (Free allows 2). Remove one in Upload-Post or upgrade.');
  if (r.status !== 201 && r.status !== 200) throw new UploadPostError(r.status, `Upload-Post could not create the profile (HTTP ${r.status}).`);
  return toProfile(((r.json?.profile as Record<string, unknown>) ?? { username }) as Record<string, unknown>);
}

/** Hosted connect page for Instagram. Falls back to the Upload-Post dashboard when the plan has no hosted page. */
export async function connectLink(username: string, redirectUrl: string | null, f: Fetch = fetch): Promise<{ url: string; hosted: boolean; note: string }> {
  const r = await call(f, 'POST', `${UP_PROFILES_PATH}/generate-jwt`, {
    username,
    platforms: ['instagram'],
    connect_title: 'Connect Instagram to Signal',
    show_calendar: false,
    ...(redirectUrl ? { redirect_url: redirectUrl, redirect_button_text: 'Back to Signal' } : {}),
  });
  const url = r.json?.access_url;
  if (r.status === 200 && typeof url === 'string' && url.startsWith('https://')) return { url, hosted: true, note: 'Log in to Instagram on the page that opens. The link works for 48 hours.' };
  return {
    url: UP_DASHBOARD,
    hosted: false,
    note: `Your plan has no hosted connect page${r.status ? ` (HTTP ${r.status})` : ''}. In Upload-Post open Manage Users → “${username}” → connect Instagram, then come back and press Check.`,
  };
}

// ---- monthly upload quota ----------------------------------------------------------------------
export interface UpUsage { count: number; limit: number; last_reset: string | null; seen_at: string }
/** used = last seen count (0 once the month has turned) + Upload-Post schedules still waiting to go out. */
export interface UpQuota { used: number; limit: number; resetsAt: string | null; count: number; scheduled: number; seenAt: string; stale: boolean }
interface UsageStore { v: 1; accounts: Record<string, UpUsage> }

const usageFile = () => path.join(dataDir(), 'upload-post-usage.json');
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** A provider time (ISO text, or Unix seconds/milliseconds) as ISO, or null. */
export function providerTime(v: unknown): string | null {
  const n = finite(v);
  if (n !== null) return n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : null;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Reads usage{count,limit,last_reset} from an Upload-Post answer. */
export function parseUsage(body: unknown): Omit<UpUsage, 'seen_at'> | null {
  const u = body && typeof body === 'object' ? (body as Record<string, unknown>).usage : null;
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const count = finite(o.count);
  const limit = finite(o.limit);
  if (count === null || limit === null || count < 0 || limit <= 0) return null;
  return { count, limit, last_reset: providerTime(o.last_reset) };
}

function accountKey(): string | null {
  const k = process.env.UPLOAD_POST_API_KEY;
  return k ? `key-${createHash('sha256').update(k).digest('hex').slice(0, 12)}` : null;
}

async function readStore(): Promise<UsageStore> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ usageFile(), 'utf8')) as UsageStore;
    return j?.v === 1 && j.accounts && typeof j.accounts === 'object' ? j : { v: 1, accounts: {} };
  } catch {
    return { v: 1, accounts: {} };
  }
}

/** Remembers the usage an Upload-Post answer carried. Never throws: a send never fails because of this. */
export async function noteUsage(body: unknown, now = Date.now()): Promise<void> {
  try {
    const u = parseUsage(body);
    const key = accountKey();
    if (!u || !key) return;
    const s = await readStore();
    s.accounts[key] = { ...u, seen_at: new Date(now).toISOString() };
    await fs.mkdir(/* turbopackIgnore: true */ dataDir(), { recursive: true });
    const tmp = `${usageFile()}.${process.pid}.tmp`;
    await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, usageFile());
  } catch {
    /* best effort */
  }
}

export async function lastUsage(): Promise<UpUsage | null> {
  const key = accountKey();
  return key ? ((await readStore()).accounts[key] ?? null) : null;
}

function nextMonth(iso: string): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Upload-Post schedules (every project on this key) that had not gone out when the usage was seen. */
async function waitingSchedules(since: number): Promise<number> {
  let n = 0;
  for (const p of await listProjects().catch(() => [])) {
    if (!p.uploadPostProfile) continue;
    const pkgs = await withProject(p, () => listPackages()).catch(() => []);
    n += pkgs.filter((k) => k.status === 'scheduled' && k.scheduled && k.scheduled.provider !== 'signal' && !(Date.parse(k.scheduled.scheduled_for) <= since)).length;
  }
  return n;
}

/**
 * The monthly upload quota as last seen, or null before any Upload-Post answer carried it.
 * Assumption: the count resets one calendar month after last_reset (Upload-Post plans are monthly);
 * after that the old count is not used ("stale") until a new answer arrives.
 */
export async function uploadQuota(now = Date.now()): Promise<UpQuota | null> {
  const u = await lastUsage();
  if (!u) return null;
  const resetsAt = u.last_reset ? nextMonth(u.last_reset) : null;
  const stale = resetsAt !== null && now >= Date.parse(resetsAt);
  const scheduled = await waitingSchedules(Date.parse(u.seen_at));
  return { used: (stale ? 0 : u.count) + scheduled, limit: u.limit, resetsAt, count: u.count, scheduled, seenAt: u.seen_at, stale };
}
