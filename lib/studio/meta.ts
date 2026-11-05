// Server-only: Instagram API client.
// Preferred: Instagram API with Unified Login — a per-account Business Integration System User
// token from ./ig-unified.ts, on graph.facebook.com/<version>, sent as an Authorization header.
// Legacy fallback: Instagram API with Instagram Login (graph.instagram.com):
// One long-lived token per Instagram account, entered in .env.local as
// INSTAGRAM_TOKEN_<PROJECT_ID> (e.g. INSTAGRAM_TOKEN_MY_BRAND). Tokens never leave this process,
// are never logged and are stripped from every error message.
// Endpoints (developers.facebook.com/docs/instagram-platform, checked 2026-11-04):
//   GET  /me?fields=user_id,username,account_type,followers_count,media_count
//   POST /{ig-user-id}/media            (container: image_url | video_url, media_type, children, caption, is_ai_generated)
//   GET  /{container-id}?fields=status_code,status
//   POST /{ig-user-id}/media_publish    (creation_id)
//   GET  /{ig-user-id}/content_publishing_limit?fields=quota_usage,config
//   GET  /{ig-user-id}/media?fields=…   and GET /{media-id}?fields=…
//   GET  /{media-id}/insights?metric=views,reach,likes,comments,saved,shares,total_interactions
//   GET  /{media-id}/comments, POST /{comment-id}/replies, POST /{comment-id} (hide), DELETE /{comment-id}
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { currentProject, type Project } from './projects';
import { FB_GRAPH, SCOPES, getConnection, graphVersion, redactSecrets, unifiedLoginAllowed } from './ig-unified';

type Fetch = typeof fetch;
export const IG_BASE = 'https://graph.instagram.com';

export class MetaError extends Error {
  constructor(public status: number, message: string, public code?: number) {
    super(message);
  }
}

export const tokenEnvName = (p: Pick<Project, 'id'>) => `INSTAGRAM_TOKEN_${p.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
const tokenFor = (p: Project = currentProject()) => process.env[tokenEnvName(p)] ?? '';

export interface IgContext { mode: 'unified' | 'instagram-login'; base: string; token: string; igUserId: string | null; scopes: string[] | null }

/** How the current project talks to Instagram: a Unified Login connection when there is a valid one, else a legacy env token. */
export async function igContext(p: Project = currentProject(), now = Date.now()): Promise<IgContext | { error: string }> {
  if ((await unifiedLoginAllowed()).enabled) {
    const c = await getConnection(p.id);
    if (c) {
      if (c.expiresAt && Date.parse(c.expiresAt) <= now) return { error: `The Instagram connection for @${c.username} expired. Connect it again on the Connections screen.` };
      if (`@${c.username}`.toLowerCase() !== p.handle.toLowerCase()) return { error: `The stored connection is for @${c.username}, not ${p.handle}. Connect again.` };
      return { mode: 'unified', base: `${FB_GRAPH}/${graphVersion()}`, token: c.token, igUserId: c.igUserId, scopes: c.scopes };
    }
  }
  const legacy = tokenFor(p);
  if (legacy) {
    const version = (process.env.INSTAGRAM_API_VERSION ?? '').trim();
    return { mode: 'instagram-login', base: `${IG_BASE}${version ? `/${version.replace(/[^v0-9.]/g, '')}` : ''}`, token: legacy, igUserId: null, scopes: null };
  }
  return { error: `${p.handle} is not connected. Connect it with Meta on the Connections screen.` };
}

/** Instagram API is usable for the current project: the switch is on and the account is connected. */
export async function instagramApiAllowed(p: Project = currentProject()): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('instagramApi'))) return { enabled: false, reason: featureOffReason('instagramApi') };
  const ctx = await igContext(p);
  if ('error' in ctx) return { enabled: false, reason: ctx.error };
  return { enabled: true, reason: '' };
}

/** A feature works only when the connection was granted its permission (legacy tokens: assumed). */
export async function igFeature(feature: 'publish' | 'comments' | 'insights', p: Project = currentProject()): Promise<{ enabled: boolean; reason: string }> {
  const base = await instagramApiAllowed(p);
  if (!base.enabled) return base;
  const ctx = (await igContext(p)) as IgContext;
  if (ctx.mode === 'instagram-login' || !ctx.scopes) return { enabled: true, reason: '' };
  const need = SCOPES[feature];
  return ctx.scopes.includes(need) ? { enabled: true, reason: '' } : { enabled: false, reason: `The Meta login configuration did not grant ${need}. Add it to the configuration and connect again to use ${feature}.` };
}

/** Signal's own scheduler (sends due posts while the app is running). */
export async function schedulerAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('scheduler'))) return { enabled: false, reason: featureOffReason('scheduler') };
  return { enabled: true, reason: '' };
}

/** Removes any token from text that may be shown or stored. */
export function redactToken(text: string): string {
  let t = String(text ?? '');
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('INSTAGRAM_TOKEN_') && v && v.length > 8) t = t.split(v).join('[token]');
  return redactSecrets(t.replace(/access_token=[^&\s"]+/gi, 'access_token=[token]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [token]'));
}

export interface Call { status: number; json: Record<string, unknown> | null }

/** One API call. Network failures throw MetaError(502); HTTP errors are returned for the caller to classify. */
export async function igCall(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean | undefined> = {}, f: Fetch = fetch, timeoutMs = 30_000): Promise<Call> {
  const ctx = await igContext();
  if ('error' in ctx) throw new MetaError(403, ctx.error);
  const base = ctx.base;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  // Unified Login: token in the Authorization header (never in URLs). Legacy Instagram Login: access_token parameter.
  const auth: Record<string, string> = ctx.mode === 'unified' ? { Authorization: `Bearer ${ctx.token}` } : {};
  if (ctx.mode !== 'unified') qs.set('access_token', ctx.token);
  const q = qs.toString();
  let r: Response;
  try {
    r =
      method === 'GET' || method === 'DELETE'
        ? await f(`${base}${path}${q ? `?${q}` : ''}`, { method, headers: { Accept: 'application/json', ...auth }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
        : await f(`${base}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...auth }, body: q, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch {
    throw new MetaError(502, 'Instagram did not answer.');
  }
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

export function errorText(c: Call): string {
  const e = (c.json?.error ?? {}) as { message?: string; error_user_msg?: string; code?: number };
  return redactToken(e.error_user_msg ?? e.message ?? `HTTP ${c.status}`);
}
const ok = (c: Call) => c.status >= 200 && c.status < 300 && !c.json?.error;
function must(c: Call, what: string): Record<string, unknown> {
  if (!ok(c) || !c.json) throw new MetaError(c.status >= 400 ? c.status : 502, `${what}: ${errorText(c)}`, (c.json?.error as { code?: number } | undefined)?.code);
  return c.json;
}

export interface IgAccount { userId: string; username: string; accountType: string | null; followers: number | null; mediaCount: number | null }
export async function getAccount(f: Fetch = fetch): Promise<IgAccount> {
  const ctx = await igContext();
  if (!('error' in ctx) && ctx.mode === 'unified' && ctx.igUserId) {
    // Under Unified Login /me is the business system user, so read the Instagram account by its ID.
    const u = must(await igCall('GET', `/${ctx.igUserId}`, { fields: 'id,username,followers_count,media_count' }, f), 'Could not read the Instagram account');
    return { userId: ctx.igUserId, username: String(u.username ?? ''), accountType: 'BUSINESS', followers: typeof u.followers_count === 'number' ? u.followers_count : null, mediaCount: typeof u.media_count === 'number' ? u.media_count : null };
  }
  const j = must(await igCall('GET', '/me', { fields: 'user_id,username,account_type,followers_count,media_count' }, f), 'Could not read the Instagram account');
  return {
    userId: String(j.user_id ?? j.id ?? ''),
    username: String(j.username ?? ''),
    accountType: j.account_type ? String(j.account_type) : null,
    followers: typeof j.followers_count === 'number' ? j.followers_count : null,
    mediaCount: typeof j.media_count === 'number' ? j.media_count : null,
  };
}

export async function publishingQuota(userId: string, f: Fetch = fetch): Promise<{ used: number; total: number } | null> {
  const c = await igCall('GET', `/${userId}/content_publishing_limit`, { fields: 'quota_usage,config' }, f);
  if (!ok(c)) return null;
  const row = ((c.json?.data as Record<string, unknown>[] | undefined) ?? [])[0];
  if (!row) return null;
  const cfg = (row.config ?? {}) as { quota_total?: number };
  return { used: Number(row.quota_usage ?? 0), total: Number(cfg.quota_total ?? 50) };
}

export type ContainerInput =
  | { kind: 'image'; url: string; caption?: string; carouselItem?: boolean; aiLabel?: boolean }
  | { kind: 'video'; url: string; caption?: string; carouselItem?: boolean; aiLabel?: boolean }
  | { kind: 'reel'; url: string; caption: string; coverUrl?: string; aiLabel: boolean }
  | { kind: 'carousel'; children: string[]; caption: string; aiLabel: boolean };

/** Creates a media container. Creating one never publishes anything. */
export async function createContainer(userId: string, c: ContainerInput, f: Fetch = fetch): Promise<string> {
  const p: Record<string, string | boolean | undefined> = {};
  if (c.kind === 'image') Object.assign(p, { image_url: c.url, is_carousel_item: c.carouselItem || undefined, caption: c.carouselItem ? undefined : c.caption, is_ai_generated: c.carouselItem ? undefined : c.aiLabel || undefined });
  if (c.kind === 'video') Object.assign(p, { media_type: 'VIDEO', video_url: c.url, is_carousel_item: c.carouselItem || undefined });
  if (c.kind === 'reel') Object.assign(p, { media_type: 'REELS', video_url: c.url, caption: c.caption, cover_url: c.coverUrl, share_to_feed: true, is_ai_generated: c.aiLabel || undefined });
  // For carousels the AI label goes on the carousel container only (Meta changelog, 2026-06-22).
  if (c.kind === 'carousel') Object.assign(p, { media_type: 'CAROUSEL', children: c.children.join(','), caption: c.caption, is_ai_generated: c.aiLabel || undefined });
  const j = must(await igCall('POST', `/${userId}/media`, p, f, 60_000), 'Instagram did not accept the media');
  if (!j.id) throw new MetaError(502, 'Instagram did not return a container id.');
  return String(j.id);
}

export type ContainerState = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'UNKNOWN';
export async function containerStatus(containerId: string, f: Fetch = fetch): Promise<{ state: ContainerState; detail: string }> {
  const j = must(await igCall('GET', `/${containerId}`, { fields: 'status_code,status' }, f), 'Could not read the media status');
  const s = String(j.status_code ?? 'UNKNOWN').toUpperCase();
  return { state: (['FINISHED', 'IN_PROGRESS', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(s) ? s : 'UNKNOWN') as ContainerState, detail: redactToken(String(j.status ?? '')) };
}

/** Publishes a finished container. The caller treats any non-definite answer as "uncertain". */
export async function publishContainer(userId: string, containerId: string, f: Fetch = fetch): Promise<Call> {
  return igCall('POST', `/${userId}/media_publish`, { creation_id: containerId }, f, 60_000);
}

export interface IgMedia { id: string; permalink: string | null; timestamp: string | null; caption: string; mediaType: string | null; likes: number | null; comments: number | null; aiLabel: boolean | null; thumb: string | null }
const MEDIA_FIELDS = 'id,permalink,timestamp,caption,media_type,like_count,comments_count,is_ai_generated,thumbnail_url,media_url';
function toMedia(j: Record<string, unknown>): IgMedia {
  return {
    id: String(j.id ?? ''),
    permalink: typeof j.permalink === 'string' ? j.permalink : null,
    timestamp: typeof j.timestamp === 'string' ? j.timestamp : null,
    caption: typeof j.caption === 'string' ? j.caption : '',
    mediaType: typeof j.media_type === 'string' ? j.media_type : null,
    likes: typeof j.like_count === 'number' ? j.like_count : null,
    comments: typeof j.comments_count === 'number' ? j.comments_count : null,
    aiLabel: typeof j.is_ai_generated === 'boolean' ? j.is_ai_generated : null,
    thumb: typeof j.thumbnail_url === 'string' ? j.thumbnail_url : typeof j.media_url === 'string' && j.media_type !== 'VIDEO' ? j.media_url : null,
  };
}
export async function getMedia(mediaId: string, f: Fetch = fetch): Promise<IgMedia> {
  return toMedia(must(await igCall('GET', `/${mediaId}`, { fields: MEDIA_FIELDS }, f), 'Could not read the post'));
}
export async function listMedia(userId: string, limit = 25, f: Fetch = fetch): Promise<IgMedia[]> {
  const j = must(await igCall('GET', `/${userId}/media`, { fields: MEDIA_FIELDS, limit: Math.min(limit, 50) }, f), 'Could not list posts');
  return ((j.data as Record<string, unknown>[] | undefined) ?? []).map(toMedia);
}

export const shortcode = (url: string | null | undefined) => url?.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

export interface IgMetrics { views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null }
export async function mediaInsights(mediaId: string, f: Fetch = fetch): Promise<IgMetrics> {
  const c = await igCall('GET', `/${mediaId}/insights`, { metric: 'views,reach,likes,comments,saved,shares' }, f);
  const j = must(c, 'Instagram has no numbers for this post yet');
  const v: Record<string, number> = {};
  for (const row of (j.data as { name?: string; values?: { value?: number }[]; total_value?: { value?: number } }[] | undefined) ?? []) {
    const val = row.values?.[0]?.value ?? row.total_value?.value;
    if (row.name && typeof val === 'number') v[row.name] = val;
  }
  const n = (k: string) => (k in v ? v[k]! : null);
  return { views: n('views'), reach: n('reach'), impressions: null, likes: n('likes'), comments: n('comments'), saves: n('saved'), shares: n('shares') };
}

export interface IgComment { id: string; text: string; username: string; timestamp: string | null; hidden: boolean; likes: number | null; replies: IgComment[] }
function toComment(j: Record<string, unknown>): IgComment {
  const rep = ((j.replies as { data?: Record<string, unknown>[] } | undefined)?.data ?? []).map(toComment);
  return { id: String(j.id ?? ''), text: String(j.text ?? ''), username: String(j.username ?? (j.from as { username?: string } | undefined)?.username ?? ''), timestamp: typeof j.timestamp === 'string' ? j.timestamp : null, hidden: j.hidden === true, likes: typeof j.like_count === 'number' ? j.like_count : null, replies: rep };
}
export async function listComments(mediaId: string, f: Fetch = fetch): Promise<IgComment[]> {
  const j = must(await igCall('GET', `/${mediaId}/comments`, { fields: 'id,text,username,timestamp,hidden,like_count,replies{id,text,username,timestamp,hidden,like_count}', limit: 50 }, f), 'Could not read comments');
  return ((j.data as Record<string, unknown>[] | undefined) ?? []).map(toComment);
}
export async function replyToComment(commentId: string, message: string, f: Fetch = fetch): Promise<string> {
  const text = message.trim();
  if (!text || text.length > 2200) throw new MetaError(400, 'A reply must be 1–2200 characters.');
  const j = must(await igCall('POST', `/${commentId}/replies`, { message: text }, f), 'Instagram did not post the reply');
  return String(j.id ?? '');
}
export async function hideComment(commentId: string, hide: boolean, f: Fetch = fetch): Promise<void> {
  must(await igCall('POST', `/${commentId}`, { hide }, f), hide ? 'Could not hide the comment' : 'Could not show the comment');
}
export async function deleteComment(commentId: string, f: Fetch = fetch): Promise<void> {
  must(await igCall('DELETE', `/${commentId}`, {}, f), 'Could not delete the comment');
}
