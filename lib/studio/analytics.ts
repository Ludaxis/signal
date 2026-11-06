// Server-only: post results from Instagram's API or Upload-Post (read-only).
// GET /api/uploadposts/post-analytics/{request_id}?platform=instagram (docs checked 2026-11-04).
// Results are cached per package in metrics.json and refreshed at most every 3 hours.
import { promises as fs } from 'node:fs';
import { TIMEZONE } from '@/lib/time';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { listPackages, pkgPath, writeJsonReplace, type PackageView } from './content';
import { getAccount, igFeature, listMedia, mediaInsights, shortcode } from './meta';

export const UP_BASE = 'https://api.upload-post.com';
const MAX_AGE_MS = 3 * 3600_000;
type Fetch = typeof fetch;
/** onSnapshot is called once per package written, so the caller can put the numbers on the Memory timeline. */
export interface RefreshOpts { force?: boolean; fetch?: Fetch; now?: number; onSnapshot?: (id: string, file: MetricsFile) => void }

export interface Metrics { views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null }
export type MetricsSource = 'upload-post' | 'instagram';
/** metrics.json. Files written before provenance existed lack source, age_hours and complete: readers must tolerate that. */
export interface MetricsFile {
  fetched_at: string;
  metrics: Metrics | null;
  error?: string;
  source?: MetricsSource;
  /** Post age in hours when the numbers were fetched (null when the post time is unknown). */
  age_hours?: number | null;
  /** True when every expected field (views, reach, likes, comments, saves, shares) came back. Impressions is not expected: the Instagram path never has it. */
  complete?: boolean;
}

const EXPECTED: (keyof Metrics)[] = ['views', 'reach', 'likes', 'comments', 'saves', 'shares'];
export const metricsComplete = (m: Metrics | null): boolean => !!m && EXPECTED.every((k) => m[k] != null);
const ageHours = (postedAt: string | undefined, now: number): number | null => {
  const t = Date.parse(postedAt ?? '');
  return Number.isFinite(t) ? Math.round(Math.max(0, now - t) / 360_000) / 10 : null;
};
/** A metrics.json with provenance. `prev` is kept (numbers and time) when this fetch failed, so stale numbers never look fresh. */
export function buildMetricsFile(a: { source: MetricsSource; now: number; postedAt?: string; metrics: Metrics | null; error?: string; prev?: MetricsFile | null }): MetricsFile {
  if (a.error && a.metrics == null && a.prev?.metrics) return { ...a.prev, error: a.error };
  const at = new Date(a.now).toISOString();
  return { fetched_at: at, metrics: a.metrics, ...(a.error ? { error: a.error } : {}), source: a.source, age_hours: ageHours(a.postedAt, a.now), complete: metricsComplete(a.metrics) };
}

const HISTORY = 'metrics-history.jsonl';
/** Writes metrics.json and, for a successful fetch, appends the snapshot to metrics-history.jsonl (append-only, never rewritten). */
export async function writeMetrics(id: string, file: MetricsFile, fresh: boolean): Promise<void> {
  await writeJsonReplace(pkgPath(id, 'metrics.json'), file);
  if (fresh && file.metrics) await fs.appendFile(/* turbopackIgnore: true */ pkgPath(id, HISTORY), JSON.stringify(file) + '\n', { mode: 0o600 });
}
/** The series of snapshots for one package, oldest first. Torn or foreign lines are skipped. */
export async function readMetricsHistory(id: string): Promise<MetricsFile[]> {
  let raw = '';
  try {
    raw = await fs.readFile(/* turbopackIgnore: true */ pkgPath(id, HISTORY), 'utf8');
  } catch {
    return [];
  }
  const out: MetricsFile[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line) as MetricsFile;
      if (f && typeof f.fetched_at === 'string' && 'metrics' in f) out.push(f);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export async function analyticsAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('uploadPostResults'))) return { enabled: false, reason: featureOffReason('uploadPostResults') };
  if (!process.env.UPLOAD_POST_API_KEY) return { enabled: false, reason: 'Add your Upload-Post API key in Connections (Upload-Post → Manage).' };
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
  // Reach 0 (or missing) with views > 0 is an incomplete read, not a zero audience: fall back to views.
  const base = m.reach != null && m.reach > 0 ? m.reach : m.views;
  return base && base > 0 ? engagement(m) / base : null;
}

/** Results straight from Instagram: works for every posted package with a link or media id. */
async function refreshFromInstagram(opts: RefreshOpts): Promise<{ refreshed: number; errors: string[] }> {
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
    const base = { source: 'instagram' as const, now, postedAt: p.posted!.posted_at, prev: p.metrics };
    let file: MetricsFile;
    if (!mediaId) file = buildMetricsFile({ ...base, metrics: null, error: 'Not found among the latest 50 Instagram posts' });
    else {
      try {
        file = buildMetricsFile({ ...base, metrics: await mediaInsights(mediaId, doFetch) });
      } catch (e) {
        file = buildMetricsFile({ ...base, metrics: null, error: (e as Error).message.slice(0, 160) });
      }
    }
    if (file.error) errors.push(`Post ${p.id}: ${file.error}`);
    await writeMetrics(p.id, file, !file.error);
    opts.onSnapshot?.(p.id, file);
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

export async function refreshMetrics(opts: RefreshOpts = {}): Promise<{ refreshed: number; errors: string[] }> {
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
    const base = { source: 'upload-post' as const, now, postedAt: p.posted!.posted_at, prev: p.metrics };
    try {
      const r = await doFetch(`${UP_BASE}/api/uploadposts/post-analytics/${encodeURIComponent(p.posted!.request_id!)}?platform=instagram`, {
        headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      });
      const body = (await r.json().catch(() => null)) as { platforms?: { instagram?: { post_metrics_error?: string } } } | null;
      const metrics = r.ok ? parseMetrics(body) : null;
      const err = !r.ok ? `HTTP ${r.status}` : metrics ? undefined : (body?.platforms?.instagram?.post_metrics_error ?? 'No Instagram metrics yet');
      file = buildMetricsFile({ ...base, metrics, ...(err ? { error: String(err).slice(0, 160) } : {}) });
    } catch {
      file = buildMetricsFile({ ...base, metrics: null, error: 'Upload-Post did not answer' });
    }
    if (file.error) errors.push(`Post ${p.id}: ${file.error}`);
    await writeMetrics(p.id, file, !file.error);
    opts.onSnapshot?.(p.id, file);
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
  /** Why bestWeekday/bestHour are empty (null when they are set). */
  bestTimeReason: string | null;
  /** Posts that went into bestWeekday/bestHour (measured posts with a rate). */
  bestTimeSample: number;
  top: { id: string; title: string; views: number | null; rate: number | null }[];
}

/** Fewer measured posts than this say nothing about the best day or hour. */
export const MIN_BEST_TIME_POSTS = 3;
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
  const enough = measured.length >= MIN_BEST_TIME_POSTS;
  const d = enough ? best('day') : null;
  const sample = measured.filter((p) => rate(p.metrics!.metrics) != null).length;
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
    bestHour: enough ? best('hour') : null,
    bestTimeReason: enough ? null : `Needs ${MIN_BEST_TIME_POSTS}+ measured posts (have ${measured.length}).`,
    bestTimeSample: sample,
    top: [...measured]
      .sort((a, b) => (rate(b.metrics!.metrics) ?? 0) - (rate(a.metrics!.metrics) ?? 0))
      .slice(0, 3)
      .map((p) => ({ id: p.id, title: p.title, views: p.metrics!.metrics!.views, rate: rate(p.metrics!.metrics) })),
  };
}
