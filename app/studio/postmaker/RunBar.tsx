'use client';
// Run bar: under the stepper while a run is going or paused. "Step k of n · ‹step› · $spent of
// $cap [Stop]"; a pause shows its dictionary line with its one way on: "Continue run" after an edit, a sign-off or Pause,
// "Raise cap" and "Stop" at the cap. Gone when the run is done, stopped, failed or waiting at Proof.
import { useState, type CSSProperties } from 'react';
import type { Run } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Dialog } from '../ui';
import { money } from './model';

/** The bar shows for a queued or running run, and for a pause that is not Proof. */
export const runBarShown = (run: Pick<Run, 'status' | 'pausedFor'> | null): boolean => !!run && (run.status === 'running' || run.status === 'queued' || (run.status === 'needs-you' && run.pausedFor !== 'check' && run.pausedFor !== null));

export interface RunBarProps {
  run: Run;
  /** Node id → card title, for "Voice". */
  titleOf: (nodeId: string) => string;
  onStop: () => void;
  onContinue: () => void;
  onRaise: (capUsd: number) => void;
  busy?: boolean;
}

export function RunBar({ run, titleOf, onStop, onContinue, onRaise, busy = false }: RunBarProps) {
  const [raising, setRaising] = useState(false);
  const [cap, setCap] = useState(String(Math.max(run.capUsd * 2, run.capUsd + 1).toFixed(2)));
  if (!runBarShown(run)) return null;
  const total = run.steps.length || run.scope.nodes.length;
  const done = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const current = run.steps.find((s) => s.status === 'running') ?? run.steps.find((s) => s.status === 'queued') ?? null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const paused = run.status === 'needs-you' && run.pausedFor && run.pausedFor !== 'check' ? run.pausedFor : null;
  return (
    <div className="pm-runbar" role="status" aria-label={t('pm.runbar.label')}>
      <div className="pm-runbar-track" aria-hidden="true">
        <i className="pm-runbar-fill" style={{ '--progress': `${pct}%` } as CSSProperties} />
      </div>
      <span className="pm-runbar-text">
        {paused ? (
          <span className="pm-runbar-paused">{t(`pm.pause.${paused}`)}</span>
        ) : run.status === 'queued' ? (
          t('pm.runbar.queued')
        ) : (
          <>
            {t('pm.runbar.step', { n: Math.min(done + 1, total), total })}
            {current ? <span data-content> · {titleOf(current.nodeId)}</span> : null}
          </>
        )}
        <span data-content> · {t('pm.runbar.spent', { spent: money(run.spentUsd), cap: money(run.capUsd) })}</span>
      </span>
      <span className="pm-runbar-actions">
        {paused === 'edit' || paused === 'gate' || paused === 'attended' || paused === 'paused' ? (
          <Button dense level="secondary" busy={busy} onClick={onContinue}>
            {t('pm.runbar.continue')}
          </Button>
        ) : null}
        {paused === 'cap' || paused === 'day-ceiling' ? (
          <Button dense level="secondary" onClick={() => setRaising(true)}>
            {t('pm.runbar.raise')}
          </Button>
        ) : null}
        <Button dense level="tertiary" onClick={onStop}>
          {t('pm.runbar.stop')}
        </Button>
      </span>
      <Dialog
        open={raising}
        role="dialog"
        title={t('pm.runbar.raiseTitle')}
        confirmLabel={t('pm.runbar.raiseConfirm')}
        onCancel={() => setRaising(false)}
        onConfirm={() => {
          setRaising(false);
          const n = Number(cap);
          if (Number.isFinite(n) && n > 0) onRaise(Math.round(n * 100) / 100);
        }}
      >
        <label className="pm-field">
          <span className="pm-label">{t('pm.runbar.newCap')}</span>
          <input className="pm-input" type="number" min={0} step={0.5} value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
      </Dialog>
    </div>
  );
}
