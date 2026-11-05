// Server-only: post results from Instagram's API or Upload-Post (read-only).
// GET /api/uploadposts/post-analytics/{request_id}?platform=instagram (docs checked 2026-11-04).
// Results are cached per package in metrics.json and refreshed at most every 3 hours.
import { TIMEZONE } from '@/lib/time';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { listPackages, pkgPath, writeJsonReplace, type PackageView } from './content';
import { getAccount, igFeature, listMedia, mediaInsights, shortcode } from './meta';

export const UP_BASE = 'https://api.upload-post.com';
const MAX_AGE_MS = 3 * 3600_000;
type Fetch = typeof fetch;

export interface Metrics { views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null }
export interface MetricsFile { fetched_at: string; metrics: Metrics | null; error?: string }

export async function analyticsAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('uploadPostResults'))) return { enabled: false, reason: featureOffReason('uploadPostResults') };
  if (!process.env.UPLOAD_POST_API_KEY) return { enabled: false, reason: 'UPLOAD_POST_API_KEY is not set.' };
  return { enabled: true, reason: '' };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseMetrics(body: unknown): Metrics | null {
  const b = body as { platforms?: Record<string, { post_metrics?: Record<string, unknown> }> } | null;
  const m = b?.platforms?.instagram?.post_metrics;
  if (!m) return null;
  return { views: num(m.views), reach: num(m.reach), impressions: num(m.impressions), likes: num(m.likes), comments: num(m.comments), saves: num(m.saves), shares: num(m.shares) };
}

/** Engagement = likes + comments + saves + shares. */
export const engagement = (m: Metrics | null) => (m ? (m.likes ?? 0) + (m.comments ?? 0) + (m.saves ?? 0) + (m.shares ?? 0) : 0);
/** Engagement rate per reach (or views when reach is missing). */
export function rate(m: Metrics | null): number | null {
  if (!m) return null;
  const base = m.reach ?? m.views;
  return base && base > 0 ? engagement(m) / base : null;
}

/** Results straight from Instagram: works for every posted package with a link or media id. */
async function refreshFromInstagram(opts: { force?: boolean; fetch?: Fetch; now?: number }): Promise<{ refreshed: number; errors: string[] }> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const posted = (await listPackages()).filter((p) => p.posted && (p.posted.media_id || p.posted.url)).slice(-30);
  const errors: string[] = [];
  let refreshed = 0;
  let byCode: Map<string, string> | null = null;
  for (const p of posted) {
    if (!opts.force && p.metrics && now - Date.parse(p.metrics.fetched_at) < MAX_AGE_MS) continue;
    let mediaId = p.posted!.media_id ?? null;
    if (!mediaId) {
      if (!byCode) {
        try {
          const acct = await getAccount(doFetch);
          byCode = new Map((await listMedia(acct.userId, 50, doFetch)).map((m) => [shortcode(m.permalink) ?? '', m.id]));
        } catch (e) {
          return { refreshed, errors: [...errors, (e as Error).message] };
        }
      }
      mediaId = byCode.get(shortcode(p.posted!.url) ?? '\u0000') ?? null;
    }
    let file: MetricsFile;
    if (!mediaId) file = { fetched_at: new Date(now).toISOString(), metrics: null, error: 'Not found among the latest 50 Instagram posts' };
    else {
      try {
        file = { fetched_at: new Date(now).toISOString(), metrics: await mediaInsights(mediaId, doFetch) };
      } catch (e) {
        file = { fetched_at: new Date(now).toISOString(), metrics: p.metrics?.metrics ?? null, error: (e as Error).message.slice(0, 160) };
      }
    }
    if (file.error) errors.push(`Post ${p.id}: ${file.error}`);
    await writeJsonReplace(pkgPath(p.id, 'metrics.json'), file);
    refreshed++;
  }
  return { refreshed, errors };
}

/** Where Results come from for the current project: Instagram's API first, then Upload-Post. */
export async function resultsSource(): Promise<{ enabled: boolean; reason: string; source: 'instagram' | 'upload-post' | null }> {
  if ((await igFeature('insights')).enabled) return { enabled: true, reason: '', source: 'instagram' };
  const up = await analyticsAllowed();
  return { ...up, source: up.enabled ? 'upload-post' : null };
}

export async function refreshMetrics(opts: { force?: boolean; fetch?: Fetch; now?: number } = {}): Promise<{ refreshed: number; errors: string[] }> {
  if ((await igFeature('insights')).enabled) return refreshFromInstagram(opts);
  const allowed = await analyticsAllowed();
  if (!allowed.enabled) return { refreshed: 0, errors: [allowed.reason] };
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const posted = (await listPackages()).filter((p) => p.posted?.request_id);
  let refreshed = 0;
  const errors: string[] = [];
  for (const p of posted.slice(-30)) {
    if (!opts.force && p.metrics && now - Date.parse(p.metrics.fetched_at) < MAX_AGE_MS) continue;
    let file: MetricsFile;
    try {
      const r = await doFetch(`${UP_BASE}/api/uploadposts/post-analytics/${encodeURIComponent(p.posted!.request_id!)}?platform=instagram`, {
        headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      });
      const body = (await r.json().catch(() => null)) as { platforms?: { instagram?: { post_metrics_error?: string } } } | null;
      const metrics = r.ok ? parseMetrics(body) : null;
      const err = !r.ok ? `HTTP ${r.status}` : metrics ? undefined : (body?.platforms?.instagram?.post_metrics_error ?? 'No Instagram metrics yet');
      file = { fetched_at: new Date(now).toISOString(), metrics, ...(err ? { error: String(err).slice(0, 160) } : {}) };
    } catch {
      file = { fetched_at: new Date(now).toISOString(), metrics: p.metrics?.metrics ?? null, error: 'Upload-Post did not answer' };
    }
    if (file.error) errors.push(`Post ${p.id}: ${file.error}`);
    await writeJsonReplace(pkgPath(p.id, 'metrics.json'), file);
    refreshed++;
  }
  return { refreshed, errors };
}

export interface Insights {
  posts: number;
  measured: number;
  totals: { views: number; reach: number; engagement: number };
  byFormat: { format: string; posts: number; avgViews: number | null; avgRate: number | null }[];
  bestWeekday: string | null;
  bestHour: number | null;
  top: { id: string; title: string; views: number | null; rate: number | null }[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function zonedDayHour(iso: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const wd = parts.find((x) => x.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((x) => x.type === 'hour')?.value ?? 0) % 24;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

export function insights(pkgs: PackageView[]): Insights {
  const posted = pkgs.filter((p) => p.posted);
  const measured = posted.filter((p) => p.metrics?.metrics);
  const fmt = (p: PackageView) => p.source?.format ?? 'other';
  const groups = new Map<string, PackageView[]>();
  for (const p of measured) groups.set(fmt(p), [...(groups.get(fmt(p)) ?? []), p]);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const byFormat = [...groups.entries()]
    .map(([format, ps]) => ({ format, posts: ps.length, avgViews: avg(ps.map((p) => p.metrics!.metrics!.views)), avgRate: avg(ps.map((p) => rate(p.metrics!.metrics))) }))
    .sort((a, b) => (b.avgRate ?? -1) - (a.avgRate ?? -1));
  const best = (key: 'day' | 'hour') => {
    const m = new Map<number, number[]>();
    for (const p of measured) {
      const k = zonedDayHour(p.posted!.posted_at)[key];
      const r = rate(p.metrics!.metrics);
      if (r != null) m.set(k, [...(m.get(k) ?? []), r]);
    }
    let bestK: number | null = null;
    let bestV = -1;
    for (const [k, v] of m) {
      const a = v.reduce((x, y) => x + y, 0) / v.length;
      if (a > bestV) [bestK, bestV] = [k, a];
    }
    return bestK;
  };
  const d = best('day');
  return {
    posts: posted.length,
    measured: measured.length,
    totals: {
      views: measured.reduce((a, p) => a + (p.metrics!.metrics!.views ?? 0), 0),
      reach: measured.reduce((a, p) => a + (p.metrics!.metrics!.reach ?? 0), 0),
      engagement: measured.reduce((a, p) => a + engagement(p.metrics!.metrics), 0),
    },
    byFormat,
    bestWeekday: d == null ? null : WEEKDAYS[d]!,
    bestHour: measured.length >= 3 ? best('hour') : null,
    top: [...measured]
      .sort((a, b) => (rate(b.metrics!.metrics) ?? 0) - (rate(a.metrics!.metrics) ?? 0))
      .slice(0, 3)
      .map((p) => ({ id: p.id, title: p.title, views: p.metrics!.metrics!.views, rate: rate(p.metrics!.metrics) })),
  };
}
