'use client';
// Pipeline: the ordered step cards (one per kind, language lanes inside) and a
// right rail with the selected step's preview, Uses and Feeds. One primary: "Run ‹n› steps" (n counts nodes; "(m
// mock)" when some run as mock), or "Go to proof" with nothing to run. Card actions: Edit (drawer), Regenerate (dialog),
// Regenerate from here, Versions, Lock, Skip. Text budget 50 words of chrome; each card at most 18.
import { useEffect, useState } from 'react';
import type { RecipeView, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, FaText } from '../ui';
import { pmApi } from './api';
import { useKeys } from './keys';
import { cardsOf, descendants, duration, laneTitle, money, runCount, textOf, usesOf } from './model';
import { RegenerateDialog } from './RegenerateDialog';
import { StepCard } from './StepCard';
import { StepDrawer, type StepTab } from './StepDrawer';
import { VersionsDrawer } from './VersionsDrawer';

export interface PipelineProps {
  pid: string;
  view: RecipeView;
  /** A run of this recipe is going. */
  running: boolean;
  /** Node id of the open step drawer (from the URL), and how to open or close it. */
  stepId: string | null;
  stepTab: StepTab;
  onStepTab: (tab: StepTab) => void;
  openStep: (nodeId: string, tab?: StepTab) => void;
  closeStep: () => void;
  onStarted: (runId: string) => void;
  goProof: () => void;
  openConnections: (connector: string | null) => void;
  reload: () => void;
  say: (text: string) => void;
  /** A Proof note asked for this regenerate ("Fix this step"). */
  regenRequest: { nodeId: string; note: string } | null;
  clearRegenRequest: () => void;
}

export function Pipeline(p: PipelineProps) {
  const { pid, view, running, say, reload } = p;
  const cards = cardsOf(view.nodes, view.recipe.languages);
  const [selected, setSelected] = useState<string | null>(p.stepId ?? view.nodes[0]?.id ?? null);
  const [versions, setVersions] = useState<string | null>(null);
  const [regen, setRegen] = useState<{ nodeId: string; fromHere: boolean; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const count = runCount(view);
  const node = (id: string | null) => view.nodes.find((n) => n.id === id) ?? null;
  const sel = node(selected);
  const regenOpen = regen ?? (p.regenRequest ? { nodeId: p.regenRequest.nodeId, fromHere: false, note: p.regenRequest.note } : null);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) say(done);
      reload();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const run = () =>
    act(async () => {
      if (count.n === 0) return p.goProof();
      const est = await pmApi.action<{ estimate: { token: string }; capUsd: number }>(pid, { action: 'estimate', recipeId: view.recipe.id, scope: { all: true } });
      const r = await pmApi.action<{ runId: string }>(pid, { action: 'run', recipeId: view.recipe.id, scope: { all: true }, capUsd: Math.max(est.capUsd, view.recipe.capUsd), estimateToken: est.estimate.token });
      p.onStarted(r.runId);
      say(t('pm.pipe.started'));
    });
  const lock = (n: RecipeViewNode) => act(() => pmApi.action(pid, { action: n.head.locked ? 'step.unlock' : 'step.lock', recipeId: view.recipe.id, nodeId: n.id }));
  const skip = (n: RecipeViewNode) => act(() => pmApi.action(pid, { action: n.head.skipped ? 'step.unskip' : 'step.skip', recipeId: view.recipe.id, nodeId: n.id }));
  const reorder = (n: RecipeViewNode, d: -1 | 1) =>
    act(async () => {
      const ids = view.pipeline.nodes.map((x) => x.id);
      const i = ids.indexOf(n.id);
      const target = d === -1 ? ids[i - 2] : ids[i + 1];
      if (!target) return;
      await pmApi.action(pid, { action: 'pipeline.edit', recipeId: view.recipe.id, baseVersion: view.pipeline.version, ops: [{ op: 'move', nodeId: n.id, after: target }] });
    });
  const regenerate = (n: RecipeViewNode, fromHere: boolean) => {
    if (n.head.locked) return say(t('pm.card.unlockFirst'));
    setRegen({ nodeId: n.id, fromHere });
  };
  const move = (d: 1 | -1) => {
    const ids = cards.map((c) => (c.lanes.some((l) => l.id === selected) ? selected! : c.lanes[0]!.id));
    const i = Math.max(0, ids.indexOf(selected ?? ''));
    const next = ids[Math.min(ids.length - 1, Math.max(0, i + d))]!;
    setSelected(next);
    document.querySelector<HTMLElement>(`.pm-card-select[data-node="${next}"]`)?.focus();
  };
  useKeys({
    ArrowDown: () => move(1),
    ArrowUp: () => move(-1),
    Enter: () => sel && p.openStep(sel.id),
    E: () => sel && p.openStep(sel.id, 'output'),
    R: () => sel && regenerate(sel, false),
    '⇧R': () => sel && regenerate(sel, true),
    L: () => sel && void lock(sel),
    V: () => sel && setVersions(sel.id),
    '⌥ArrowUp': () => sel && void reorder(sel, -1),
    '⌥ArrowDown': () => sel && void reorder(sel, 1),
    '⌘Enter': () => void run(),
  });

  const open = node(p.stepId);
  const vnode = node(versions);
  const rnode = node(regenOpen?.nodeId ?? null);
  const feeds = sel ? descendants(view, sel.id).filter((id) => view.pipeline.edges.some((e) => e.from === sel.id && e.to === id)) : [];
  const label = count.n === 0 ? t('pm.pipe.goProof') : count.mock ? t('pm.pipe.runMock', { n: count.n, m: count.mock }) : t('pm.pipe.run', { n: count.n });

  return (
    <div className="pm-pipe">
      <section className="pm-pipe-list" aria-labelledby="pm-steps-h">
        <div className="pm-pipe-head">
          <h3 id="pm-steps-h" className="pm-h">
            {t('pm.pipe.steps', { count: cards.length })}
          </h3>
          <span className="xs pm-muted" data-content>
            {t('pm.pipe.total', { usd: money(view.estimate.usdHigh), time: duration(view.estimate.seconds) })}
          </span>
        </div>
        <ol className="pm-cards">
          {cards.map((c, i) => (
            <li key={c.kind}>
              <StepCard
                card={c}
                index={i}
                view={view}
                selectedId={selected}
                busy={busy}
                onSelect={(n) => setSelected(n.id)}
                onOpen={(n, tab) => p.openStep(n.id, tab)}
                onRegenerate={regenerate}
                onVersions={(n) => setVersions(n.id)}
                onLock={(n) => void lock(n)}
                onSkip={(n) => void skip(n)}
                onConnections={(n) => p.openConnections(n.connectorChain.find((x) => x !== 'mock') ?? null)}
              />
            </li>
          ))}
        </ol>
      </section>
      <aside className="pm-rail" aria-label={t('pm.pipe.preview')}>
        {sel ? <Preview pid={pid} view={view} node={sel} /> : <p className="xs pm-muted">{t('pm.pipe.select')}</p>}
        {sel ? (
          <dl className="pm-dl">
            <div className="pm-dl-row">
              <dt>{t('pm.pipe.uses')}</dt>
              <dd data-content>{usesOf(view, sel).map((u) => `${u.title} v${u.version ?? '–'}`).join(', ') || '—'}</dd>
            </div>
            <div className="pm-dl-row">
              <dt>{t('pm.pipe.feeds')}</dt>
              <dd data-content>{feeds.map((id) => laneTitle(node(id)!)).join(', ') || '—'}</dd>
            </div>
          </dl>
        ) : null}
        <div className="pm-foot pm-rail-foot">
          <span className="xs pm-muted" data-content>
            {count.n ? t('pm.pipe.hint', { usd: money(count.usd), time: duration(count.seconds) }) : ''}
          </span>
          <Button level="primary" busy={busy} disabled={running} reason={t('pm.pipe.running')} title={count.n ? t('pm.pipe.hint', { usd: money(count.usd), time: duration(count.seconds) }) : undefined} onClick={() => void run()}>
            {label}
          </Button>
        </div>
      </aside>

      {open ? <StepDrawer key={open.id} pid={pid} view={view} node={open} tab={p.stepTab} onTab={p.onStepTab} onClose={p.closeStep} onChanged={(m) => (say(m), reload())} onError={say} /> : null}
      {vnode ? <VersionsDrawer pid={pid} recipeId={view.recipe.id} node={vnode} timeZone={view.timeZone} busy={busy} onClose={() => setVersions(null)} onUse={(n) => void act(() => pmApi.action(pid, { action: 'step.use-version', recipeId: view.recipe.id, nodeId: vnode.id, version: n }), t('pm.ver.used', { n }))} /> : null}
      {rnode && regenOpen ? (
        <RegenerateDialog
          pid={pid}
          view={view}
          node={rnode}
          fromHere={regenOpen.fromHere}
          note={regenOpen.note}
          onCancel={() => (setRegen(null), p.clearRegenRequest())}
          onError={(m) => (say(m), setRegen(null), p.clearRegenRequest())}
          onStarted={(runId) => {
            setRegen(null);
            p.clearRegenRequest();
            say(t('pm.regen.started', { step: laneTitle(rnode) }));
            p.onStarted(runId);
          }}
        />
      ) : null}
    </div>
  );
}

/** The right rail preview: a player for video and audio, an image, or the text of a JSON output (lang and dir). */
function Preview({ pid, view, node }: { pid: string; view: RecipeView; node: RecipeViewNode }) {
  const outs = node.current?.outputs ?? [];
  const video = outs.find((o) => o.kind === 'video');
  const audio = outs.find((o) => o.kind === 'audio');
  const image = outs.find((o) => o.kind === 'image');
  const url = (sha: string) => pmApi.mediaUrl(pid, view.recipe.id, sha);
  const json = video || audio || image ? null : (outs.find((o) => o.kind === 'json') ?? null);
  const [text, setText] = useState<{ sha: string; text: string } | null>(null);
  useEffect(() => {
    if (!json) return;
    let alive = true;
    void pmApi
      .json(pid, view.recipe.id, json.sha256)
      .then((d) => alive && setText({ sha: json.sha256, text: textOf(d).slice(0, 600) }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, view.recipe.id, json]);
  const shown = json && text?.sha === json.sha256 ? text.text : '';
  return (
    <div className="pm-preview">
      <p className="pm-h" data-content>
        {laneTitle(node)} {node.head.current ? `v${node.head.current}` : ''}
      </p>
      {video ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- the proof's captions are burned into the video.
        <video className="pm-preview-video" src={url(video.sha256)} controls preload="metadata" aria-label={laneTitle(node)} />
      ) : audio ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- generated narration; its text is the narration-text step.
        <audio className="pm-preview-audio" src={url(audio.sha256)} controls preload="metadata" aria-label={laneTitle(node)} />
      ) : image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a stored object served by the media route.
        <img className="pm-preview-img" src={url(image.sha256)} alt="" />
      ) : shown && node.lang === 'fa' ? (
        <FaText variant="sm" className="pm-preview-text">
          {shown}
        </FaText>
      ) : shown ? (
        <p className="pm-preview-text xs" dir="auto" data-content>
          {shown}
        </p>
      ) : null}
    </div>
  );
}
