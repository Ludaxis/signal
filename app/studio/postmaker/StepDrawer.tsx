'use client';
// Step drawer: the wide drawer of one lane with tabs Instructions, Output and, for a
// gated node (`narration-text:fa` text gate, `voice:fa` listening gate), Sign-off. Saving an output makes version
// n+1 "Edited by you" (dependents become out of date); a sign-off is bound to the version hash the person sees, so an
// edit or a regenerate after it leaves the new version unsigned. Persian content renders through FaText.
import { useEffect, useMemo, useState } from 'react';
import type { RecipeView, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Drawer, FaText, Pill } from '../ui';
import { pmApi } from './api';
import { laneModifiers, laneTitle, laneWord, signerOf, textOf } from './model';

export type StepTab = 'instructions' | 'output' | 'review';

export interface StepDrawerProps {
  pid: string;
  view: RecipeView;
  node: RecipeViewNode;
  tab: StepTab;
  onTab: (tab: StepTab) => void;
  onClose: () => void;
  /** After a save or a sign-off: reload the recipe view and say `message`. */
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}

export function StepDrawer({ pid, view, node, tab, onTab, onClose, onChanged, onError }: StepDrawerProps) {
  const gated = !!node.gate && node.gate.id !== 'proof';
  const tabs: StepTab[] = gated ? ['output', 'instructions', 'review'] : ['output', 'instructions'];
  const active = tabs.includes(tab) ? tab : 'output';
  const cur = node.current;
  const ports = useMemo(() => cur?.outputs.filter((o) => o.kind === 'json') ?? [], [cur]);
  const [json, setJson] = useState<Record<string, string> | null>(null);
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState(node.instructions);
  const [name, setName] = useState('');
  const [verdict, setVerdict] = useState<'pass' | 'fail'>('pass');
  const [busy, setBusy] = useState(false);
  const signer = signerOf(view, node.id);
  const lastForVersion = view.signoffs.filter((s) => s.nodeId === node.id && s.version === cur?.n && s.hash === cur?.hash).at(-1) ?? null;

  useEffect(() => {
    let alive = true;
    void Promise.all(ports.map(async (p) => [p.port, JSON.stringify(await pmApi.json(pid, view.recipe.id, p.sha256).catch(() => null), null, 2)] as const)).then((pairs) => {
      if (!alive) return;
      const o = Object.fromEntries(pairs);
      setJson(o);
      setOriginal(o);
    });
    return () => {
      alive = false;
    };
  }, [pid, view.recipe.id, ports]);

  const dirty = (json && Object.keys(json).some((k) => json[k] !== original[k])) || instructions !== node.instructions;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      onChanged(await fn());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveOutput = () =>
    run(async () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(json ?? {})) {
        if (v === original[k]) continue;
        try {
          out[k] = JSON.parse(v);
        } catch {
          throw new Error(t('pm.step.badJson'));
        }
      }
      const r = await pmApi.action<{ version: { n: number } | null }>(pid, { action: 'step.edit', recipeId: view.recipe.id, nodeId: node.id, baseVersion: node.head.current ?? 1, output: { json: out } });
      setOriginal(json ?? {});
      return t('pm.step.saved', { n: r.version?.n ?? node.head.current ?? 0 });
    });
  const saveInstructions = () =>
    run(async () => {
      await pmApi.action(pid, { action: 'step.edit', recipeId: view.recipe.id, nodeId: node.id, baseVersion: node.head.current ?? 1, output: {}, instructions });
      return t('pm.step.instrSaved');
    });
  const sign = () =>
    run(async () => {
      if (!node.gate || !cur) throw new Error(t('pm.step.notSigned'));
      await pmApi.action(pid, { action: 'gate.sign-off', recipeId: view.recipe.id, nodeId: node.id, version: cur.n, gate: node.gate.id, name: name.trim(), verdict });
      return t('pm.step.signed', { name: name.trim() });
    });

  const fa = node.lang === 'fa';
  const preview = json ? textOf(Object.values(json).map((v) => (v ? (JSON.parse(v) as unknown) : null))).slice(0, 2000) : '';
  const locked = node.head.locked;
  const primary =
    active === 'output' ? (
      <Button level="primary" busy={busy} disabled={locked || !ports.length || !json} reason={locked ? t('pm.step.locked') : t('pm.step.noJson')} onClick={() => void saveOutput()}>
        {t('pm.step.save')}
      </Button>
    ) : active === 'instructions' ? (
      <Button level="primary" busy={busy} disabled={instructions === node.instructions} reason={t('pm.step.unchanged')} onClick={() => void saveInstructions()}>
        {t('pm.step.save')}
      </Button>
    ) : (
      <Button level="primary" busy={busy} disabled={name.trim().length < 2 || !cur} reason={t('pm.step.nameFirst')} onClick={() => void sign()}>
        {t('pm.step.sign')}
      </Button>
    );

  return (
    <Drawer
      open
      width="wide"
      title={laneTitle(node)}
      status={
        <span className="pm-card-pills">
          <Pill status={laneWord(node)} />
          {laneModifiers(node).map((m) => (
            <Pill key={m} status={m} />
          ))}
        </span>
      }
      dirty={!!dirty}
      onClose={onClose}
      primary={primary}
    >
      <div className="pm-tabs" role="tablist" aria-label={t('pm.step.tabs')}>
        {tabs.map((x) => (
          <button key={x} type="button" role="tab" className="pm-tab" aria-selected={x === active} onClick={() => onTab(x)}>
            {x === 'output' ? t('pm.step.output') : x === 'instructions' ? t('pm.step.instructions') : t('pm.step.review')}
          </button>
        ))}
      </div>
      {active === 'output' ? (
        <div className="pm-step-body" role="tabpanel">
          {preview ? fa ? <FaText variant="md" className="pm-preview-text">{preview}</FaText> : <p className="pm-preview-text" data-content>{preview}</p> : null}
          {ports.length === 0 ? <p className="xs pm-muted">{t('pm.step.noJson')}</p> : null}
          {json
            ? ports.map((p) => (
                <label key={p.port} className="pm-field">
                  <span className="pm-label" data-content>
                    {p.name}
                  </span>
                  <textarea className="pm-input pm-code" dir="auto" rows={8} value={json[p.port] ?? ''} readOnly={locked} onChange={(e) => setJson({ ...json, [p.port]: e.target.value })} />
                </label>
              ))
            : null}
        </div>
      ) : null}
      {active === 'instructions' ? (
        <div className="pm-step-body" role="tabpanel">
          <label className="pm-field">
            <span className="pm-label">{t('pm.step.instructions')}</span>
            <textarea className="pm-input" dir="auto" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        </div>
      ) : null}
      {active === 'review' && node.gate ? (
        <div className="pm-step-body" role="tabpanel">
          <p className="pm-sign-state" data-testid="sign-state">
            {signer ? t('pm.step.signedBy', { name: signer.name }) : lastForVersion?.verdict === 'fail' ? t('pm.step.signedFail', { name: lastForVersion.name }) : t('pm.step.notSigned')}
          </p>
          <p className="xs pm-muted">{node.kind === 'voice' ? t('pm.step.signVoice') : t('pm.step.signText')}</p>
          <label className="pm-field">
            <span className="pm-label">{t('pm.step.signName')}</span>
            <input className="pm-input" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="pm-radio-row" role="radiogroup" aria-label={t('pm.step.review')}>
            <label className="pm-check">
              <input type="radio" name="pm-verdict" checked={verdict === 'pass'} onChange={() => setVerdict('pass')} />
              <span>{t('pm.step.pass')}</span>
            </label>
            <label className="pm-check">
              <input type="radio" name="pm-verdict" checked={verdict === 'fail'} onChange={() => setVerdict('fail')} />
              <span>{t('pm.step.fail')}</span>
            </label>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
