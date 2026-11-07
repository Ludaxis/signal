'use client';
// Step card: one card per step kind; with two languages the language nodes are lanes
// (tabs "Persian · English"), each with its own status, version, cost and actions. The card's interface copy stays
// within 18 words; step names, providers, versions, prices and times are content.
import { useId, useState } from 'react';
import type { RecipeView, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, IconButton, Pill } from '../ui';
import { duration, langName, laneModifiers, laneWord, money, providerLine, usesOf, type StepCardModel } from './model';

const LockIcon = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d={open ? 'M8 11V8a4 4 0 0 1 7.5-2' : 'M8 11V8a4 4 0 0 1 8 0v3'} />
  </svg>
);

export interface StepActions {
  onSelect: (node: RecipeViewNode) => void;
  onOpen: (node: RecipeViewNode, tab?: 'instructions' | 'output' | 'review') => void;
  onRegenerate: (node: RecipeViewNode, fromHere: boolean) => void;
  onVersions: (node: RecipeViewNode) => void;
  onLock: (node: RecipeViewNode) => void;
  onSkip: (node: RecipeViewNode) => void;
  onConnections: (node: RecipeViewNode) => void;
}

export interface StepCardProps extends StepActions {
  card: StepCardModel;
  index: number;
  /** The nodes (Uses), and the connector rows whose titles name the provider (labels, never ids). */
  view: Pick<RecipeView, 'nodes'> & Partial<Pick<RecipeView, 'connectors'>>;
  /** The selected node (a lane of this card or another card). */
  selectedId: string | null;
  busy: boolean;
}

const dotClass = (n: RecipeViewNode) => (n.status === 'done' && !n.outOfDate ? 'is-done' : n.status === 'running' ? 'is-running' : n.status === 'needs-you' || n.outOfDate ? 'is-needs' : '');

export function StepCard({ card, index, view, selectedId, busy, ...a }: StepCardProps) {
  const lanes = card.lanes;
  const active = lanes.find((l) => l.id === selectedId) ?? lanes[0]!;
  const selected = lanes.some((l) => l.id === selectedId);
  const tabsId = useId();
  const [menu, setMenu] = useState(false);
  const locked = active.head.locked;
  const uses = usesOf(view, active);
  const cur = active.current;
  const outs = cur?.outputs.map((o) => o.name).join(', ') ?? '';
  const cost = cur ? `${money(cur.cost.actualUsd ?? 0)} · ${duration(cur.seconds)}` : `~${money(active.estimate.usd)} · ~${duration(active.estimate.seconds)}`;
  const title = card.title;
  const gate = active.gateState;
  const provider = providerLine(active, view.connectors);
  return (
    <article className={`pm-card ${selected ? 'is-selected' : ''}`} data-kind={card.kind} aria-current={selected ? 'true' : undefined}>
      <header className="pm-card-head">
        <span className={`pm-dot ${dotClass(active)}`} aria-hidden="true">
          {index + 1}
        </span>
        <h3 className="pm-card-title">
          <button type="button" className="pm-card-select" data-node={active.id} aria-label={t('pm.card.open', { step: title })} onClick={() => a.onSelect(active)} onFocus={() => !selected && a.onSelect(active)} onDoubleClick={() => a.onOpen(active)}>
            <span data-content>{title}</span>
          </button>
        </h3>
        <span className="pm-card-pills">
          <Pill status={laneWord(active)} />
          {laneModifiers(active).map((m) => (
            <Pill key={m} status={m} />
          ))}
        </span>
        <button type="button" className="pm-ver" onClick={() => a.onVersions(active)} aria-label={t('pm.card.versions', { step: title })} data-content>
          {active.head.current ? t('pm.card.version', { n: active.head.current }) : '–'}
        </button>
        <IconButton aria-label={locked ? t('pm.card.unlock', { step: title }) : t('pm.card.lock', { step: title })} aria-pressed={locked} icon={<LockIcon open={!locked} />} onClick={() => a.onLock(active)} />
      </header>
      {lanes.length > 1 ? (
        <div className="pm-lanes" role="tablist" aria-label={t('pm.card.lanes')}>
          {lanes.map((l) => (
            <button key={l.id} type="button" role="tab" id={`${tabsId}-${l.id}`} aria-selected={l.id === active.id} className="pm-lane" onClick={() => a.onSelect(l)}>
              {l.lang ? langName(l.lang) : l.id}
            </button>
          ))}
        </div>
      ) : null}
      {provider ? (
        <p className="pm-card-line xs" data-content>
          {provider}
        </p>
      ) : null}
      <p className="pm-card-io xs">
        <span className="pm-io-label">{t('pm.card.in')}</span> <span data-content>{uses.length ? uses.map((u) => `${u.title} v${u.version ?? '–'}`).join(', ') : '—'}</span>{' '}
        <span className="pm-io-label">{t('pm.card.out')}</span> <span data-content>{outs || '—'}</span>
        <span data-content> · {cost}</span>
      </p>
      {active.lockedButChanged ? <p className="pm-card-note xs">{t('pm.card.lockedChanged')}</p> : null}
      {gate && gate.kind !== 'needs-sign-off' ? (
        <p className="pm-card-note xs">
          <span data-content>{gate.reason}</span>
          {gate.fix === 'connections' ? (
            <Button dense level="tertiary" onClick={() => a.onConnections(active)}>
              {t('pm.card.openConnections')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {gate?.kind === 'needs-sign-off' ? (
        <p className="pm-card-note xs">
          <button type="button" className="pm-link" onClick={() => a.onOpen(active, 'review')}>
            {t('pm.card.needsSignOff')}
          </button>
        </p>
      ) : null}
      <footer className="pm-card-actions">
        <Button dense level="secondary" disabled={locked} reason={t('pm.step.locked')} onClick={() => a.onOpen(active, 'output')}>
          {t('pm.card.edit')}
        </Button>
        <Button dense level="secondary" disabled={locked} reason={t('pm.card.unlockFirst')} onClick={() => a.onRegenerate(active, false)}>
          {t('pm.card.regenerate')}
        </Button>
        <span className="pm-menu-wrap">
          <Button dense level="tertiary" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>
            {t('pm.card.more')}
          </Button>
          {menu ? (
            <span className="pm-menu" role="menu" tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
              <button type="button" role="menuitem" className="pm-menu-item" disabled={busy} onClick={() => (setMenu(false), a.onRegenerate(active, true))}>
                {t('pm.card.fromHere')}
              </button>
              <button type="button" role="menuitem" className="pm-menu-item" onClick={() => (setMenu(false), a.onVersions(active))}>
                {t('pm.card.versionsItem')}
              </button>
              <button type="button" role="menuitem" className="pm-menu-item" disabled={busy} onClick={() => (setMenu(false), a.onSkip(active))}>
                {active.head.skipped ? t('pm.card.unskip') : t('pm.card.skip')}
              </button>
            </span>
          ) : null}
        </span>
      </footer>
    </article>
  );
}
