'use client';
// Runs: each run with when, template, trigger, steps done/total, actual cost, time and status; rows
// open a wide run drawer (steps with version, cost, time, live or mock, errors, and a link to the proof). The one
// primary "Run again" runs the selected run's recipe again with the same inputs (a new run; steps with nothing new
// are cache hits). Text budget 30 words.
import { useEffect, useState } from 'react';
import type { RunView } from '@/lib/studio/postmaker/types';
import { formatWhenIn } from '@/lib/studio/time';
import { t } from '../copy/en';
import { More } from '../More';
import { Button, Chip, ChipRow, Drawer, Notice, Pill } from '../ui';
import { pmApi, type PostmakerHome } from './api';
import { useKeys } from './keys';
import { clock, money, runNeedsYou, runWord, stepTitle, type PmLocation } from './model';

type Filter = 'all' | 'needs-you' | 'failed';
type HomeRun = PostmakerHome['runs'][number];

export interface RunsProps {
  pid: string;
  data: PostmakerHome;
  runId: string | null;
  go: (l: Partial<PmLocation>, o?: { replace?: boolean }) => void;
  say: (text: string) => void;
  reload: () => void;
}

const elapsed = (r: HomeRun) => (r.finishedAt ? Math.max(0, (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) : null);

export function Runs({ pid, data, runId, go, say, reload }: RunsProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [template, setTemplate] = useState('');
  const [selected, setSelected] = useState<string | null>(runId ?? data.runs[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const nameOf = (r: HomeRun) => data.templates.find((x) => x.id === r.templateId || x.recipeId === r.recipeId)?.name ?? '—';
  const rows = data.runs.filter((r) => (filter === 'all' ? true : filter === 'failed' ? r.status === 'failed' : runNeedsYou(r) && r.status !== 'failed') && (!template || nameOf(r) === template));
  const names = [...new Set(data.runs.map(nameOf).filter((n) => n !== '—'))];
  const sel = data.runs.find((r) => r.id === selected) ?? null;

  const again = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const est = await pmApi.action<{ estimate: { token: string }; capUsd: number }>(pid, { action: 'estimate', recipeId: sel.recipeId, scope: { all: true } });
      await pmApi.action(pid, { action: 'run', recipeId: sel.recipeId, scope: { all: true }, capUsd: est.capUsd, estimateToken: est.estimate.token });
      say(t('pm.runs.againStarted'));
      reload();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (d: 1 | -1) => {
    const i = rows.findIndex((r) => r.id === selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    if (next) {
      setSelected(next.id);
      document.querySelector<HTMLElement>(`[data-run="${next.id}"]`)?.focus();
    }
  };
  useKeys({
    ArrowDown: () => move(1),
    ArrowUp: () => move(-1),
    Enter: () => selected && go({ view: 'runs', run: selected }),
    '⌘Enter': () => void again(),
  });

  return (
    <div className="pm-runs">
      <div className="pm-runs-filter">
        <ChipRow label={t('pm.runs.filter')}>
          {(['all', 'needs-you', 'failed'] as const).map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? t('pm.runs.all') : f === 'failed' ? t('pm.runs.failed') : t('pm.runs.needsYou')}
            </Chip>
          ))}
        </ChipRow>
        <select className="pm-input pm-select" aria-label={t('pm.runs.template')} value={template} onChange={(e) => setTemplate(e.target.value)}>
          <option value="">{t('pm.runs.all')}</option>
          {names.map((n) => (
            <option key={n} value={n} data-content>
              {n}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <Notice kind="empty" title={t('pm.runs.none')} />
      ) : (
        <table className="pm-table">
          <thead>
            <tr>
              <th scope="col">{t('pm.runs.when')}</th>
              <th scope="col">{t('pm.runs.template')}</th>
              <th scope="col">{t('pm.runs.trigger')}</th>
              <th scope="col">{t('pm.runs.steps')}</th>
              <th scope="col">{t('pm.runs.cost')}</th>
              <th scope="col">{t('pm.runs.time')}</th>
              <th scope="col">{t('pm.runs.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const secs = elapsed(r);
              return (
                <tr
                  key={r.id}
                  data-run={r.id}
                  tabIndex={0}
                  aria-selected={r.id === selected}
                  className={r.id === selected ? 'is-selected' : undefined}
                  onClick={() => setSelected(r.id)}
                  onDoubleClick={() => go({ view: 'runs', run: r.id })}
                  onFocus={() => setSelected(r.id)}
                >
                  <td data-content>{formatWhenIn(data.timeZone, r.startedAt)}</td>
                  <td data-content>{nameOf(r)}</td>
                  <td data-content>{t(`pm.trigger.${r.trigger}`)}</td>
                  <td data-content>
                    {r.stepsDone}/{r.stepsTotal}
                  </td>
                  <td data-content>{money(r.spentUsd)}</td>
                  <td data-content>{secs === null ? '–' : clock(secs)}</td>
                  <td>
                    <Pill status={runWord(r.status)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="pm-foot">
        <Button level="primary" busy={busy} disabled={!sel} reason={t('pm.runs.selectFirst')} onClick={() => void again()}>
          {t('pm.runs.again')}
        </Button>
      </div>
      {runId ? <RunDrawer pid={pid} runId={runId} timeZone={data.timeZone} onClose={() => go({ view: 'runs' })} onProof={(recipeId) => go({ r: recipeId, s: 'proof' })} /> : null}
    </div>
  );
}

function RunDrawer({ pid, runId, timeZone, onClose, onProof }: { pid: string; runId: string; timeZone: string | null; onClose: () => void; onProof: (recipeId: string) => void }) {
  const [v, setV] = useState<RunView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    pmApi
      .run(pid, runId)
      .then((x) => alive && setV(x))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [pid, runId]);
  const run = v?.run;
  return (
    <Drawer
      open
      width="wide"
      title={run ? t('pm.runs.drawer', { when: formatWhenIn(timeZone, run.startedAt) }) : t('pm.runs.drawer', { when: '' })}
      status={run ? <Pill status={runWord(run.status)} /> : undefined}
      onClose={onClose}
      secondary={
        run ? (
          <Button level="secondary" onClick={() => onProof(run.recipeId)}>
            {t('pm.runs.openProof')}
          </Button>
        ) : undefined
      }
    >
      {error ? <Notice kind="error" title={t('pm.couldNotLoad')} details={error} /> : null}
      {run ? (
        <ul className="pm-run-steps">
          {run.steps.map((s) => (
            <li key={s.nodeId} className="pm-run-step">
              <span data-content>{stepTitle(s.nodeId)}</span>
              <span className="xs pm-muted" data-content>
                v{s.version ?? '–'} · {money(s.usd)} · {clock(s.seconds)} · {t(`pm.runs.provider.${s.mode}`)}
              </span>
              {/* The server's own words stay behind Details. */}
              {s.error ? (
                <More label={t('notice.details')}>
                  <p className="xs pm-muted" data-content>
                    {s.error}
                  </p>
                </More>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}
