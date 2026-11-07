'use client';
// Results: real numbers per post (Instagram's API, or Upload-Post analytics), and which templates work.
// "By template" rows come from GET /api/studio/results: Post maker template records first, then the project
// pack's format labels; the core never supplies a format label here. Empty: one line and one
// disclosure.
import { useCallback, useEffect, useState } from 'react';
import { notifyChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import type { Payload, RealPackage } from './RealPosts';
import { formatIn } from '@/lib/studio/time';
import { compactCount } from '@/lib/studio/format';
import { postedNewestFirst } from './posts-rules';
import { LazyImage, Reveal, ScreenSkeleton } from './loaders';
import { More } from './More';
import { t } from './copy/en';
import { Button, Notice } from './ui';
import { navigateTo } from './url-state';

export interface TemplateRow { key: string; name: string | null; posts: number; avgViews: number | null; avgRate: number | null }

const n = compactCount;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** The By template rows of the open project (null until loaded; [] when the request fails). */
function useByTemplate(): { rows: TemplateRow[] | null; reload: () => Promise<void> } {
  const pid = useProjectId();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const reload = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/results?project=${encodeURIComponent(pid)}`, { cache: 'no-store' });
      const j = (await r.json().catch(() => ({}))) as { byTemplate?: TemplateRow[] };
      setRows(r.ok && Array.isArray(j.byTemplate) ? j.byTemplate : []);
    } catch {
      setRows([]);
    }
  }, [pid]);
  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);
  return { rows, reload };
}

export function Results({ data, reload, say }: { data: Payload | null; reload: () => Promise<void>; say: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const templates = useByTemplate();
  if (!data) return <ScreenSkeleton variant="stats" label={t('results.loading')} />;
  const ins = data.insights as (Payload['insights'] & { bestTimeReason?: string | null; bestTimeSample?: number }) | undefined;
  const posted = postedNewestFirst(data.packages);
  const projectId = data.project?.id ?? '';
  const tz = data.project?.timeZone;
  const measured = ins?.measured ?? 0;
  const enabled = Boolean(data.analytics?.enabled);
  const refresh = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/studio/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: getProjectId(), force: true }) });
      const j = (await r.json().catch(() => ({}))) as { refreshed?: number; errors?: string[]; error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      say(t('results.updated', { count: j.refreshed ?? 0 }));
      if (j.errors?.length) setErr(j.errors.join(' · '));
      await Promise.all([reload(), templates.reload()]);
      notifyChanged('content');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const thumb = (p: RealPackage) => {
    const f = p.files.find((x) => x.role === 'cover') ?? p.files.find((x) => x.role === 'slide');
    return f ? `/api/studio/content/${p.id}/file/${encodeURIComponent(f.name)}?project=${encodeURIComponent(projectId)}` : null;
  };
  const rows = templates.rows ?? [];

  return (
    <section className="screen u-stack u-gap-5" aria-label="Results">
      <div className="u-between u-gap-3">
        <span className="st-small st-muted">{enabled ? t('results.from', { measured, posts: ins?.posts ?? 0 }) : null}</span>
        {enabled ? (
          <Button dense busy={busy} disabled={busy} reason={t('common.busy')} onClick={() => void refresh()}>
            {busy ? t('results.updating') : t('results.update')}
          </Button>
        ) : null}
      </div>
      {!enabled ? <Notice kind="off" title={t('results.off')} action={<Button dense onClick={() => navigateTo('connections')}>{t('notice.openConnections')}</Button>} /> : null}
      {err ? <Notice kind="error" title={t('results.couldNotUpdate')} details={err} /> : null}

      {measured === 0 ? (
        <div className="notice notice-empty res-empty">
          <p className="notice-title">{t('results.empty')}</p>
          <More label={t('results.how')}>
            <span>{t('results.howText')}</span>
          </More>
        </div>
      ) : (
        <>
          <div className="grid4">
            <div className="st-card stat">
              <span className="label">{t('results.views')}</span>
              <span className="stat-num" data-content>{n(ins?.totals.views)}</span>
            </div>
            <div className="st-card stat">
              <span className="label">{t('results.reach')}</span>
              <span className="stat-num" data-content>{n(ins?.totals.reach)}</span>
            </div>
            <div className="st-card stat">
              <span className="label">{t('results.engagement')}</span>
              <span className="stat-num" data-content>{n(ins?.totals.engagement)}</span>
            </div>
            <div className="st-card stat">
              <span className="label">{t('results.bestTime')}</span>
              <span className="stat-num res-best-time" data-content>{ins?.bestWeekday ?? '—'}</span>
              {ins?.bestHour != null ? (
                <span className="st-small st-muted" data-content>
                  {t('results.bestHour', { hour: String(ins.bestHour).padStart(2, '0') })}
                </span>
              ) : null}
            </div>
          </div>

          <section className="card" aria-label={t('results.byTemplate')}>
            <h2 className="card-title">{t('results.byTemplate')}</h2>
            {templates.rows === null ? (
              <Notice kind="loading" title={t('notice.loading', { thing: t('results.byTemplate').toLowerCase() })} lines={2} />
            ) : rows.length ? (
              <table className="res-table">
                <thead>
                  <tr>
                    <th scope="col">{t('results.template')}</th>
                    <th scope="col">{t('results.posts')}</th>
                    <th scope="col">{t('results.avgViews')}</th>
                    <th scope="col">{t('results.rate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.key} className={i === 0 && r.name ? 'best' : ''} data-template={r.key}>
                      <td>
                        {r.name ? <span data-content>{r.name}</span> : t('results.noTemplate')}
                        {i === 0 && r.name && rows.length > 1 ? <span className="res-best">{t('results.best')}</span> : null}
                      </td>
                      <td data-content>{r.posts}</td>
                      <td data-content>{n(r.avgViews)}</td>
                      <td data-content>{pct(r.avgRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        </>
      )}

      {posted.length ? (
        <div className="u-stack u-gap-3">
          <h2 className="label u-m0">{t('results.every')}</h2>
          {posted.map((p, i) => {
            const m = p.metrics?.metrics;
            return (
              <Reveal key={p.id} index={i}>
                <div className={`st-card res-row ${busy ? 'is-working' : ''}`}>
                  {thumb(p) ? <LazyImage className="real-thumb" src={thumb(p)!} alt="" /> : null}
                  <div className="res-row-text">
                    <span className="res-title" data-content>
                      {p.id} · {p.title}
                    </span>
                    <span className="xs st-muted" data-content>
                      {formatIn(tz, p.posted!.posted_at)}
                    </span>
                  </div>
                  <div className="res-nums">
                    <span>
                      <b data-content>{n(m?.views)}</b> {t('results.n.views')}
                    </span>
                    <span>
                      <b data-content>{n(m?.likes)}</b> {t('results.n.likes')}
                    </span>
                    <span>
                      <b data-content>{n(m?.saves)}</b> {t('results.n.saves')}
                    </span>
                  </div>
                  {p.posted!.url ? (
                    <a className="btn btn-secondary btn-dense" href={p.posted!.url} target="_blank" rel="noreferrer">
                      {t('common.open')}
                    </a>
                  ) : null}
                </div>
              </Reveal>
            );
          })}
        </div>
      ) : measured === 0 ? null : <span className="st-small st-muted">{t('results.noPosts')}</span>}
    </section>
  );
}
