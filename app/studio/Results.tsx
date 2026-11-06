'use client';
// Results: real Instagram numbers per post (Instagram's API, or Upload-Post analytics), and what works best.
import { useState } from 'react';
import { notifyChanged } from './sync';
import { getProjectId } from './Projects';
import type { Payload, RealPackage } from './RealPosts';
import type { MetricsFile } from '@/lib/studio/analytics';
import { TIMEZONE, formatDateTime } from '@/lib/time';
import { LazyImage, Reveal, ScreenSkeleton } from './loaders';
import { More } from './More';

const FORMAT_NAMES: Record<string, string> = {
  'codex-post': 'Codex image post',
  'website-card': 'Website post',
  'higgsfield-image': 'Higgsfield image',
  'higgsfield-reel': 'Higgsfield Reel',
  other: 'Hand-made',
};
const n = (v: number | null | undefined) => (v == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString());
/** "Numbers from <fetched_at>, post age <age_hours> h"; old files without age_hours omit the age. */
const freshness = (f: MetricsFile) => `Numbers from ${formatDateTime(f.fetched_at)}${typeof f.age_hours === 'number' ? `, post age ${f.age_hours} h` : ''}${f.source ? ` (${f.source === 'instagram' ? 'Meta' : 'Upload-Post'})` : ''}${f.complete === false ? ', incomplete' : ''}`;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

export function Results({ data, reload, say }: { data: Payload | null; reload: () => Promise<void>; say: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!data) return <ScreenSkeleton variant="stats" label="Loading results" />;
  const ins = data.insights;
  const posted = data.packages.filter((p) => p.posted).sort((a, b) => (a.posted!.posted_at < b.posted!.posted_at ? 1 : -1));
  const projectId = data.project?.id ?? '';
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/studio/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: getProjectId(), force: true }) });
      const j = (await r.json()) as { refreshed?: number; errors?: string[]; error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? 'Could not refresh.');
      say(j.errors?.length ? `Updated ${j.refreshed ?? 0} posts · ${j.errors[0]}` : `Updated ${j.refreshed ?? 0} posts`);
      await reload();
      notifyChanged('content');
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const thumb = (p: RealPackage) => {
    const f = p.files.find((x) => x.role === 'cover') ?? p.files.find((x) => x.role === 'slide');
    return f ? `/api/studio/content/${p.id}/file/${encodeURIComponent(f.name)}?project=${encodeURIComponent(projectId)}` : null;
  };

  return (
    <section className="screen st-stack" style={{ gap: 20 }} aria-label="Results">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="st-small st-muted">
          {data.analytics?.enabled ? `From ${data.analytics.source === 'instagram' ? 'Meta' : 'Upload-Post'} · ${ins?.measured ?? 0} of ${ins?.posts ?? 0} posts measured` : data.analytics?.reason}
        </span>
        <button type="button" className="st-btn st-btn-dark st-btn-sm" aria-busy={busy} disabled={busy || !data.analytics?.enabled} onClick={() => void refresh()}>
          {busy ? 'Updating' : 'Update numbers'}
        </button>
      </div>

      <div className="grid4">
        <div className="st-card stat">
          <span className="label">Views</span>
          <span className="stat-num">{n(ins?.totals.views)}</span>
          <span className="st-small st-muted">measured posts</span>
        </div>
        <div className="st-card stat">
          <span className="label">Reach</span>
          <span className="stat-num">{n(ins?.totals.reach)}</span>
          <span className="st-small st-muted">accounts reached</span>
        </div>
        <div className="st-card stat">
          <span className="label">Engagement</span>
          <span className="stat-num">{n(ins?.totals.engagement)}</span>
          <span className="st-small st-muted">likes, comments, saves, shares</span>
        </div>
        <div className="st-card stat">
          <span className="label">Best time</span>
          <span className="stat-num" style={{ fontSize: 26 }}>
            {ins?.bestWeekday ?? '—'}
          </span>
          <span className="st-small st-muted">{ins?.bestHour != null ? `around ${String(ins.bestHour).padStart(2, '0')}:00 ${TIMEZONE}` : (ins?.bestTimeReason ?? 'needs 3+ posts')}</span>
          <span className="xs st-muted">based on {ins?.bestTimeSample ?? ins?.measured ?? 0} measured post{(ins?.bestTimeSample ?? ins?.measured ?? 0) === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
        <span className="label">What works · by format</span>
        {ins?.byFormat.length ? (
          <table className="res-table">
            <thead>
              <tr>
                <th>Format</th>
                <th>Posts</th>
                <th>Avg views</th>
                <th>Engagement rate</th>
              </tr>
            </thead>
            <tbody>
              {ins.byFormat.map((f, i) => (
                <tr key={f.format} className={i === 0 ? 'best' : ''}>
                  <td>
                    {FORMAT_NAMES[f.format] ?? f.format}
                    {i === 0 && ins.byFormat.length > 1 ? <span className="res-best">best</span> : null}
                  </td>
                  <td>{f.posts}</td>
                  <td>{n(f.avgViews)}</td>
                  <td>{pct(f.avgRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="st-small st-muted">No numbers yet.</span>
        )}
        <More label="How this works">
          <span>Numbers arrive a few hours after a post goes out; press Update numbers to fetch them. Best time needs 3 measured posts and says how many it used. Numbers are never refreshed on their own.</span>
        </More>
      </div>

      <div className="st-stack" style={{ gap: 10 }}>
        <span className="label">Every post</span>
        {posted.length === 0 ? <span className="st-small st-muted">No posts yet.</span> : null}
        {posted.map((p, i) => {
          const m = p.metrics?.metrics;
          return (
            <Reveal key={p.id} index={i}>
            <div className={`st-card res-row ${busy ? 'is-working' : ''}`}>
              {thumb(p) ? <LazyImage className="real-thumb" src={thumb(p)!} alt="" /> : null}
              <div className="st-stack" style={{ gap: 2, flex: '1 1 200px', minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>
                  {p.id} · {p.title}
                </span>
                <span className="xs st-muted">
                  {formatDateTime(p.posted!.posted_at)}
                  {p.metrics?.metrics ? ` · ${freshness(p.metrics as MetricsFile)}` : p.metrics ? ` · checked ${formatDateTime(p.metrics.fetched_at)}` : ''}
                  {p.metrics?.error ? ` · ${p.metrics.error}` : ''}
                </span>
              </div>
              <div className="res-nums">
                <span>
                  <b>{n(m?.views)}</b> views
                </span>
                <span>
                  <b>{n(m?.reach)}</b> reach
                </span>
                <span>
                  <b>{n(m?.likes)}</b> likes
                </span>
                <span>
                  <b>{n(m?.saves)}</b> saves
                </span>
                <span>
                  <b>{n(m?.comments)}</b> comments
                </span>
              </div>
              {p.posted!.url ? (
                <a className="st-btn st-btn-ghost st-btn-sm" href={p.posted!.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : null}
            </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
