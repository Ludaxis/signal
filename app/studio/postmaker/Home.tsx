'use client';
// Post maker home: a segmented control Drafts · Proven · Runs and the one primary "Make a post". Drafts are
// recipes not yet accepted, with how far they got, when they changed and a status pill; Proven lists the template
// cards; Runs is the table. Text budget 40 words. A template card (at most 40 words) shows the
// cover, the name (a link to the Proven screen), the pills, "‹n› steps · ~$ · ~min", the campaign and a secondary
// "Make a post" that opens the Make a post dialog; a card has no other button. Retired templates move under a
// "Retired (n)" filter, hidden by default, so the Proven list shows only templates that can still make posts.
// While pipelines are left to move, one row "Move my
// pipelines (n)" opens a dialog (they pause until Repeat is on; a backup is kept and Undo restores it exactly;
// pipelines using a template stay) → `postmaker.migrate`, then a toast with Undo (non-destructive undo). The
// Proven view keeps "Undo the move" while a move can be undone. Moved templates show "Moved" and no Make a post.
import { useEffect, useState } from 'react';
import type { TemplateSummary } from '@/lib/studio/postmaker/types';
import { formatWhenIn } from '@/lib/studio/time';
import { pmApi, studioApi, type MakeItAnswer, type PostmakerHome } from './api';
import { t } from '../copy/en';
import { Button, Chip, Dialog, Notice, Pill } from '../ui';
import { notifyChanged } from '../sync';
import { MakePostDialog } from './MakePost';
import { atProof, duration, furthest, isMoved, langName, money, templatePills, type HomeView, type PmLocation } from './model';
import { Runs } from './Runs';

export interface HomeProps {
  pid: string;
  data: PostmakerHome;
  view: HomeView;
  runId: string | null;
  go: (l: Partial<PmLocation>, o?: { replace?: boolean }) => void;
  /** The Studio toast; `onUndo` adds its Undo button. */
  say: (text: string, opts?: { onUndo?: () => void }) => void;
  reload: () => void;
  /** A post started from a card's Make a post: the screen follows its run to Proof. */
  onMade?: (a: MakeItAnswer) => void;
}

export function Home({ pid, data, view, runId, go, say, reload, onMade }: HomeProps) {
  const [making, setMaking] = useState<TemplateSummary | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [retiredOnly, setRetiredOnly] = useState(false);
  const [moving, setMoving] = useState<'ask' | 'busy' | 'undo' | 'undoing' | null>(null);
  const [moveError, setMoveError] = useState('');
  const pending = data.migration?.pending ?? 0;
  const undoId = data.migration?.undo ?? null;
  // The move changes the nav (Pipelines), Proven, the Calendar and the pipelines list: every screen reloads.
  const changed = () => {
    reload();
    notifyChanged('content', 'pipelines', 'calendar');
  };
  const undoMove = async (migrationId: string | null) => {
    try {
      await pmApi.action(pid, { action: 'postmaker.migrate.undo', ...(migrationId ? { migrationId } : {}) });
      say(t('pm.move.undone'));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      changed();
    }
  };
  const move = async () => {
    setMoving('busy');
    setMoveError('');
    try {
      const r = await pmApi.action<{ migrationId: string | null; moved: unknown[] }>(pid, { action: 'postmaker.migrate' });
      setMoving(null);
      const n = r.moved.length;
      const id = r.migrationId;
      if (n && id) say(t('pm.move.done', { n }), { onUndo: () => void undoMove(id) });
      else say(t('pm.move.nothing'));
      changed();
      if (n) go({ view: 'proven' });
    } catch (e) {
      setMoving('ask');
      setMoveError(e instanceof Error ? e.message : String(e));
    }
  };
  const confirmUndo = async () => {
    setMoving('undoing');
    await undoMove(undoId);
    setMoving(null);
  };
  const attachedAny = data.templates.some((x) => x.campaignIds.length > 0);
  useEffect(() => {
    if (view !== 'proven' || !attachedAny) return;
    let alive = true;
    studioApi
      .campaigns(pid)
      .then((c) => alive && setNames(Object.fromEntries(c.campaigns.map((x) => [x.id, x.name]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, view, attachedAny]);
  const accepted = new Set(data.templates.map((x) => x.recipeId));
  const drafts = data.recipes.filter((r) => !accepted.has(r.id));
  const make = (
    // On the Runs view "Run again" is the screen's one primary, so Make a post steps down.
    <Button level={view === 'runs' ? 'secondary' : 'primary'} onClick={() => go({ s: 'reference' })}>
      {t('pm.home.make')}
    </Button>
  );
  // An empty Drafts or Proven view carries Make a post inside its empty notice, so the head
  // row does not repeat it: one primary on the screen.
  const retired = data.templates.filter((x) => x.status === 'retired');
  const showingRetired = retiredOnly && retired.length > 0;
  const cards = showingRetired ? retired : data.templates.filter((x) => x.status !== 'retired');
  const empty = (view === 'drafts' && drafts.length === 0) || (view === 'proven' && cards.length === 0);
  return (
    <div className="pm-home">
      {pending > 0 ? (
        <p className="pm-move-row st-small" role="note">
          <span>{t('pm.move.line')}</span>
          <Button level="secondary" dense onClick={() => (setMoveError(''), setMoving('ask'))}>
            {t('pm.move.open', { n: pending })}
          </Button>
        </p>
      ) : null}
      <div className="pm-home-head">
        <div className="pm-seg" role="tablist" aria-label={t('pm.home.views')}>
          {(['drafts', 'proven', 'runs'] as const).map((v) => (
            <button key={v} type="button" role="tab" className="pm-seg-item" aria-selected={view === v} onClick={() => go({ view: v })}>
              {t(`pm.home.${v}`)}
            </button>
          ))}
        </div>
        {empty ? null : make}
      </div>
      {view === 'drafts' ? (
        drafts.length === 0 ? (
          <Notice kind="empty" title={t('pm.home.noDrafts')} action={make} />
        ) : (
          <ul className="pm-rows">
            {drafts.map((r) => {
              const s = furthest(r, data.runs);
              const run = data.runs.find((x) => x.recipeId === r.id) ?? null;
              const word = run ? (atProof(run) ? 'Needs you' : run.status === 'failed' ? 'Failed' : run.status === 'running' || run.status === 'queued' ? 'Running' : 'Draft') : 'Draft';
              return (
                <li key={r.id}>
                  <button type="button" className="pm-row" onClick={() => go({ r: r.id, s })}>
                    <span className="pm-row-text">
                      <span className="pm-row-title" data-content>
                        {t('pm.home.draftName', { langs: r.languages.map(langName).join(' + '), length: duration(r.lengthSec) })}
                      </span>
                      <span className="xs pm-muted" data-content>
                        {t('pm.home.at', { screen: t(`pm.screen.${s}`) })} · {formatWhenIn(data.timeZone, r.updatedAt)}
                      </span>
                    </span>
                    <Pill status={word} />
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {view === 'proven' && (retired.length > 0 || undoId) ? (
        <div className="pm-tfilter">
          {retired.length > 0 ? (
            <Chip selected={showingRetired} onClick={() => setRetiredOnly(!showingRetired)}>
              {t('pm.home.retiredFilter', { n: retired.length })}
            </Chip>
          ) : null}
          {undoId ? (
            <Button level="tertiary" dense onClick={() => setMoving('undo')}>
              {t('pm.move.undo')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {view === 'proven' ? (
        cards.length === 0 ? (
          <Notice kind="empty" title={data.templates.length === 0 ? t('pm.home.noTemplates') : t('pm.home.allRetired')} action={make} />
        ) : (
          <ul className="pm-tcards">
            {cards.map((x) => {
              const c = data.templateCards?.[x.id] ?? null;
              // A moved pipeline has no Post maker steps (it makes posts with the v1 generator): its fact is its schedule.
              const meta = isMoved(x)
                ? x.repeat?.enabled
                  ? t('pm.proven.repeatOn', { n: x.repeat.perWeek })
                  : ''
                : [t('pm.tcard.steps', { n: c?.steps ?? 0 }), c?.usd != null ? `~${money(c.usd)}` : null, c?.seconds != null ? `~${duration(c.seconds)}` : null].filter(Boolean).join(' · ');
              const campaign = x.campaignIds.map((id) => names[id]).filter(Boolean)[0] ?? null;
              return (
                <li key={x.id} className="pm-tcard" data-template={x.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local media route, not an optimisable asset */}
                  {c?.cover ? <img className="pm-cover" src={pmApi.mediaUrl(pid, c.cover.recipeId, c.cover.sha256)} alt={t('pm.tcard.cover', { name: x.name })} /> : <span className="pm-cover is-empty" aria-hidden="true" />}
                  <span className="pm-tcard-text">
                    <button type="button" className="pm-row-link pm-row-title" aria-label={t('pm.tcard.open', { name: x.name })} onClick={() => go({ t: x.id })}>
                      <span data-content>{x.name}</span>
                    </button>
                    <span className="pm-pills">
                      {templatePills(x).map((w) => (
                        <Pill key={w} status={w} />
                      ))}
                    </span>
                    {meta ? (
                      <span className="xs pm-muted" data-content>
                        {meta}
                      </span>
                    ) : null}
                    {campaign ? (
                      <span className="xs pm-muted" data-content>
                        {campaign}
                      </span>
                    ) : null}
                  </span>
                  {x.status !== 'retired' && !isMoved(x) ? (
                    <Button dense onClick={() => setMaking(x)}>
                      {t('pm.tcard.make')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {view === 'runs' ? <Runs pid={pid} data={data} runId={runId} go={go} say={say} reload={reload} /> : null}
      {moving === 'ask' || moving === 'busy' ? (
        <Dialog
          open
          title={t('pm.move.title')}
          body={t('pm.move.pause')}
          confirmLabel={t('pm.move.confirm')}
          busy={moving === 'busy'}
          onConfirm={() => void move()}
          onCancel={() => moving !== 'busy' && setMoving(null)}
        >
          <ul className="pm-move-facts">
            <li>{t('pm.move.backup')}</li>
            <li>{t('pm.move.kept')}</li>
          </ul>
          {moving === 'busy' ? <p className="visually-hidden" role="status">{t('pm.move.moving')}</p> : null}
          {moveError ? <Notice kind="error" title={t('pm.move.couldNot')} details={moveError} /> : null}
        </Dialog>
      ) : null}
      {moving === 'undo' || moving === 'undoing' ? (
        <Dialog open title={t('pm.move.undoTitle')} body={t('pm.move.undoBody')} confirmLabel={t('pm.move.undo')} busy={moving === 'undoing'} onConfirm={() => void confirmUndo()} onCancel={() => moving !== 'undoing' && setMoving(null)} />
      ) : null}
      {making ? (
        <MakePostDialog
          pid={pid}
          template={making}
          usd={data.templateCards?.[making.id]?.usd ?? null}
          timeZone={data.timeZone}
          onMade={(a) => {
            setMaking(null);
            onMade?.(a);
          }}
          onClose={() => setMaking(null)}
        />
      ) : null}
    </div>
  );
}
