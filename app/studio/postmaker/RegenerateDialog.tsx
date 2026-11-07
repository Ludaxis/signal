'use client';
// Regenerate dialog: one dialog, three modes. "Keeps" lists the inputs as fixed
// chips (they cannot be unchecked); "Later steps expect" lists the downstream `expects` as checked chips that can be
// unchecked (that key becomes allow-breaks, with the warning line); the switch "Allow changes to later steps" is
// allow-breaks for every key; opened from "Regenerate from here" it is from-here. The knock-on line names the cost and
// the steps that become out of date before the click.
import { useEffect, useState } from 'react';
import type { Estimate, RecipeView, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Dialog } from '../ui';
import { pmApi, PmError } from './api';
import { descendants, duration, expectsOn, laneTitle, money, usesOf } from './model';

export interface RegenerateDialogProps {
  pid: string;
  view: RecipeView;
  node: RecipeViewNode;
  fromHere: boolean;
  /** Prefilled from a Proof note ("Fix this step"). */
  note?: string;
  onCancel: () => void;
  onStarted: (runId: string) => void;
  onError: (message: string) => void;
}

export function RegenerateDialog({ pid, view, node, fromHere, note: initialNote = '', onCancel, onStarted, onError }: RegenerateDialogProps) {
  const [note, setNote] = useState(initialNote);
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const [allow, setAllow] = useState(false);
  const [est, setEst] = useState<{ estimate: Estimate; capUsd: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const recipeId = view.recipe.id;
  const title = laneTitle(node);
  const keeps = usesOf(view, node);
  const expects = expectsOn(view, node.id);
  const after = descendants(view, node.id);
  const titleOf = (id: string) => {
    const n = view.nodes.find((x) => x.id === id);
    return n ? laneTitle(n) : id;
  };

  useEffect(() => {
    let alive = true;
    pmApi
      .action<{ estimate: Estimate; capUsd: number }>(pid, { action: 'estimate', recipeId, nodeId: node.id, ...(fromHere ? { fromHere: true } : { exact: true }) })
      .then((r) => alive && setEst(r))
      .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [pid, recipeId, node.id, fromHere, onError]);

  const count = fromHere ? 1 + after.filter((id) => !view.nodes.find((n) => n.id === id)?.head.locked).length : 1;
  const confirm = async () => {
    if (!est) return;
    setBusy(true);
    try {
      const text = note.trim() || undefined;
      const r = fromHere
        ? await pmApi.action<{ runId: string }>(pid, { action: 'step.regenerate-from-here', recipeId, nodeId: node.id, note: text, overwriteEdit: true, capUsd: Math.max(est.capUsd, view.recipe.capUsd), estimateToken: est.estimate.token })
        : await pmApi.action<{ runId: string }>(pid, {
            action: 'step.regenerate',
            recipeId,
            nodeId: node.id,
            mode: allow || unchecked.length ? 'allow-breaks' : 'keep-contracts',
            note: text,
            uncheckedExpects: allow ? expects.map((x) => x.id) : unchecked.length ? unchecked : undefined,
            overwriteEdit: true,
            estimateToken: est.estimate.token,
          });
      onStarted(r.runId);
    } catch (e) {
      setBusy(false);
      onError(e instanceof PmError || e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open role="dialog" title={fromHere ? t('pm.regen.titleFromHere', { step: title }) : t('pm.regen.title', { step: title })} confirmLabel={t('pm.regen.confirm')} busy={busy || !est} onCancel={onCancel} onConfirm={() => void confirm()}>
      <div className="pm-regen">
        <label className="pm-field">
          <span className="pm-label">{t('pm.regen.note')}</span>
          <textarea className="pm-input" dir="auto" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="pm-field" role="group" aria-label={t('pm.regen.keeps')}>
          <span className="pm-label">{t('pm.regen.keeps')}</span>
          <span className="chip-row">
            {keeps.map((k) => (
              <span key={k.nodeId} className="chip pm-chip-fixed" aria-disabled="true" data-content>
                ✓ {k.title} v{k.version ?? '–'}
              </span>
            ))}
          </span>
        </div>
        {!fromHere && expects.length ? (
          <div className="pm-field" role="group" aria-label={t('pm.regen.expects')}>
            <span className="pm-label">{t('pm.regen.expects')}</span>
            <span className="chip-row">
              {expects.map((x) => {
                const on = !allow && !unchecked.includes(x.id);
                return (
                  <button
                    key={x.id}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    disabled={allow}
                    data-expect={x.id}
                    onClick={() => setUnchecked((u) => (u.includes(x.id) ? u.filter((y) => y !== x.id) : [...u, x.id]))}
                  >
                    <span data-content>
                      {on ? '✓ ' : ''}
                      {x.title}: {x.label}
                    </span>
                  </button>
                );
              })}
            </span>
            {(allow ? expects : expects.filter((x) => unchecked.includes(x.id))).map((x) => (
              <p key={x.id} className="pm-warn xs" role="note">
                {t('pm.regen.warn', { step: x.title })}
              </p>
            ))}
          </div>
        ) : null}
        {!fromHere ? (
          <label className="pm-check">
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            <span>{t('pm.regen.allow')}</span>
          </label>
        ) : null}
        <p className="pm-knock xs">
          <span className="pm-label">{t('pm.regen.runs')}</span>{' '}
          <span data-content>{est ? t('pm.regen.cost', { n: count, usd: money(est.estimate.usdHigh), time: duration(est.estimate.seconds) }) : t('pm.regen.estimating')}</span>
        </p>
        {!fromHere && after.length ? (
          <p className="pm-knock xs" data-content>
            {t('pm.regen.then', { steps: after.map(titleOf).join(', ') })}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
