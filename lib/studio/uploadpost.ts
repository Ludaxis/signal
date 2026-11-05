// Server-only: Upload-Post profile management for the project wizard.
// Endpoints (docs.upload-post.com, checked 2026-11-04): the profile ("user") collection under
// /api/uploadposts: list, read one by username, create, and generate-jwt (hosted connect page; not on every plan).
// Allowed only when the "uploadPostProfiles" switch is on in signal.config.json.
// The API key stays in process.env and never reaches the browser.
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';

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
  if (!process.env.UPLOAD_POST_API_KEY) return { enabled: false, reason: 'UPLOAD_POST_API_KEY is not set in .env.local.' };
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
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
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
