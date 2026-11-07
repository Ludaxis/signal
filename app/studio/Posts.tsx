'use client';
// Posts: one screen for everything a post goes through.
//   To approve  →  Approved  →  Posted   +  Rejected
// The Board is a Trello-style board: drag a card to another column (or use its Move menu) and the move IS the
// action, through the same server actions as the drawer; posts-rules.ts decides what a move means and what is
// refused. Approving needs the reviewer's two checks, so a move to Approved opens the post's drawer; Approve then
// needs no confirmation and offers Undo for 8 s. Reject asks once in the shared Dialog. The Gallery
// (Library merged in) is a grid of every post except rejected ones. Statuses are status-dictionary words only.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AutopilotMarkView } from './Autopilot';
import { MAKE_SECONDS, MAKE_STEPS } from './Campaigns';
import { LazyImage, LoadMoreSentinel, ScreenSkeleton, TaskProgress, useProgressiveList } from './loaders';
import { getProjectId, useProjectId } from './Projects';
import { COLUMNS, OVERDUE_TEXT, columnOf, galleryOrder, isOverdue, moveCapabilities, originLine, partialText, planMove, postStatusWord, sortForColumn, type Column, type MoveCapabilities, type MoveStep } from './posts-rules';
import { PackageActions, PackageMedia, approveKey, postAction, quickAction, rejectRequest, thumbUrl, usePackageAct, useRealPosts, type Live, type RealPackage, type Say } from './RealPosts';
import { notifyChanged, useOnChanged } from './sync';
import { formatDateLabel } from '@/lib/time';
import { formatWhenIn } from '@/lib/studio/time';
import { comparePackageIds, packageIdOk } from '@/lib/studio/package-id';
import { More } from './More';
import { t } from './copy/en';
import { Button, Chip, ChipRow, Drawer, IconButton, Notice, Pill, useConfirm, type ConfirmFn, type StatusWord } from './ui';
import { useApproving } from './approve-undo';
import { navigateTo, useUrlParam } from './url-state';

export type PostsTab = 'board' | 'gallery' | Column;
const TABS: { id: PostsTab; label: string }[] = [
  { id: 'board', label: t('posts.tab.board') },
  { id: 'gallery', label: t('posts.tab.gallery') },
  ...COLUMNS.map((c) => ({ id: c.id, label: c.title })),
];
const isTab = (v: string | null): v is PostsTab => TABS.some((x) => x.id === v);
/** The ?view= word of each view: the tab's own words, not the internal column ids. */
const VIEW_SLUG: Record<PostsTab, string> = { board: 'board', gallery: 'gallery', planned: 'to-approve', review: 'approved', posted: 'posted', rejected: 'rejected' };
/** The view a ?view= value names; the older column ids (planned, review) still open their view. */
export function postsViewFromSlug(v: string | null): PostsTab | null {
  const hit = (Object.keys(VIEW_SLUG) as PostsTab[]).find((k) => VIEW_SLUG[k] === v);
  return hit ?? (isTab(v) ? v : null);
}
/** The URL params of a view (the Board is the default and has none). */
export const postsViewParams = (tab: PostsTab): Record<string, string> => (tab === 'board' ? {} : { view: VIEW_SLUG[tab] });
const FORMAT_TEXT: Record<RealPackage['format'], string> = { carousel: 'Carousel', image: 'Image', reel: 'Reel' };
/** The word a column implies: a card only adds a pill when its own word differs (fewer repeated words). */
const COLUMN_WORD: Record<Column, StatusWord> = { planned: 'To approve', review: 'Approved', posted: 'Posted', rejected: 'Rejected' };
const EMPTY: Record<Column, string> = {
  planned: t('posts.empty.planned'),
  review: t('posts.empty.review'),
  posted: t('posts.empty.posted'),
  rejected: t('posts.empty.rejected'),
};

// ---- small hooks ----------------------------------------------------------------------------

/** True on touch-first devices, where drag and drop is replaced by the Move menu. */
function useCoarsePointer(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    mq?.addEventListener('change', cb);
    return () => mq?.removeEventListener('change', cb);
  }, []);
  return useSyncExternalStore(subscribe, () => window.matchMedia?.('(pointer: coarse)').matches ?? false, () => false);
}

/** Campaign slots that are planned but not made yet: they appear in To approve with a Make button. */
interface OpenSlot { campaignId: string; campaignName: string; id: string; at: string; date: string; time: string; format: string; formatName: string; hook: string }
function useOpenSlots() {
  const pid = useProjectId();
  const [slots, setSlots] = useState<OpenSlot[] | null>(null);
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/campaigns?project=${encodeURIComponent(pid)}`, { cache: 'no-store' });
      if (!r.ok) {
        setSlots([]);
        return;
      }
      const j = (await r.json()) as { campaigns: { id: string; name: string; status: string }[]; plans: Record<string, { slots: { id: string; date: string; time: string; at: string; format: string; hook: string; status: string }[] }>; formats: { id: string; name: string }[] };
      const fname = (id: string) => j.formats.find((f) => f.id === id)?.name ?? id.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      const out: OpenSlot[] = [];
      for (const c of j.campaigns) {
        if (c.status === 'done') continue;
        for (const s of j.plans[c.id]?.slots ?? []) if (s.status === 'planned') out.push({ campaignId: c.id, campaignName: c.name, id: s.id, at: s.at, date: s.date, time: s.time, format: s.format, formatName: fname(s.format), hook: s.hook });
      }
      setSlots(out.sort((a, b) => a.at.localeCompare(b.at)));
    } catch {
      setSlots([]);
    }
  }, [pid]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);
  useOnChanged(['campaigns', 'content'], load);
  return { slots: slots ?? [], reload: load };
}

/** To approve column: made posts and not-yet-made campaign slots, in time order (no time last). */
type PlannedItem = { kind: 'post'; pkg: RealPackage; when: string | null } | { kind: 'slot'; slot: OpenSlot; when: string };
function mergePlanned(posts: RealPackage[], slots: OpenSlot[]): PlannedItem[] {
  const items: PlannedItem[] = [...posts.map((pkg) => ({ kind: 'post' as const, pkg, when: pkg.scheduled?.scheduled_for ?? pkg.plannedFor })), ...slots.map((slot) => ({ kind: 'slot' as const, slot, when: slot.at }))];
  if (slots.length === 0) return items; // other columns keep sortForColumn's order
  return items.sort((x, y) => {
    if (x.when && y.when && x.when !== y.when) return x.when.localeCompare(y.when);
    if (x.when && !y.when) return -1;
    if (!x.when && y.when) return 1;
    if (x.kind === 'post' && y.kind === 'post') return comparePackageIds(x.pkg.id, y.pkg.id);
    return (x.kind === 'post' ? x.pkg.id : x.slot.id).localeCompare(y.kind === 'post' ? y.pkg.id : y.slot.id);
  });
}

// ---- the screen ------------------------------------------------------------------------------

export function Posts({ say, onMake, initialTab = 'board' }: { say: Say; onMake?: () => void; initialTab?: PostsTab }) {
  const { data, error, reload, setData } = useRealPosts();
  const { slots, reload: reloadSlots } = useOpenSlots();
  const urlView = useUrlParam('view');
  const urlPost = useUrlParam('post');
  const [tab, setTabState] = useState<PostsTab>(postsViewFromSlug(urlView) ?? initialTab);
  const [openId, setOpenId] = useState<string | null>(packageIdOk(urlPost) ? urlPost : null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const confirmBox = useConfirm();
  const coarse = useCoarsePointer();
  const tz = data?.project?.timeZone ?? null;

  const setTab = useCallback((next: PostsTab) => {
    setTabState(next);
    // The view is part of the URL, without a history entry per click.
    navigateTo('posts', { replace: true, params: postsViewParams(next) });
  }, []);
  const replace = useCallback(
    (pkg: RealPackage) => setData((d) => (d ? { ...d, packages: d.packages.some((p) => p.id === pkg.id) ? d.packages.map((p) => (p.id === pkg.id ? pkg : p)) : [...d.packages, pkg] } : d)),
    [setData],
  );
  // Scheduling counts only while one-click posting is on: otherwise "approve and schedule" would approve, then fail.
  const caps: MoveCapabilities = useMemo(() => moveCapabilities(data?.live, data?.scheduling), [data]);
  const byColumn = useMemo(() => {
    const out: Record<Column, RealPackage[]> = { planned: [], review: [], posted: [], rejected: [] };
    for (const p of data?.packages ?? []) out[columnOf(p.status)].push(p);
    for (const c of COLUMNS) out[c.id] = sortForColumn(c.id, out[c.id]);
    return out;
  }, [data]);
  const gallery = (data?.packages ?? []).filter((p) => p.status !== 'discarded');
  const counts: Record<PostsTab, number> = {
    board: (data?.packages.length ?? 0) + slots.length,
    gallery: gallery.length,
    planned: byColumn.planned.length + slots.length,
    review: byColumn.review.length,
    posted: byColumn.posted.length,
    rejected: byColumn.rejected.length,
  };

  /** Runs a move's steps in order; stops (and says why) at the first one the server refuses. */
  const runSteps = useCallback(
    async (pkg: RealPackage, steps: MoveStep[], done: string) => {
      for (const [i, s] of steps.entries()) {
        try {
          replace(await postAction(pkg.id, { ...s }));
        } catch (e) {
          say(i > 0 ? partialText(pkg.id, steps[0]!, s, (e as Error).message) : (e as Error).message);
          await reload();
          notifyChanged('content', 'calendar');
          return;
        }
      }
      notifyChanged('content', 'calendar', 'campaigns');
      await reload();
      say(done);
    },
    [replace, reload, say],
  );

  /** Decide what a move means: refuse with a plain reason, open the drawer, or confirm once and run it. */
  const requestMove = useCallback(
    async (pkg: RealPackage, to: Column) => {
      const plan = planMove(columnOf(pkg.status), to, pkg, caps);
      if (plan.kind === 'none') return;
      if (plan.kind === 'refuse') return say(plan.message);
      // Approving (also "approve, then post") needs the two checks, and recording a hand-made post needs its
      // link: both live in the drawer.
      if (plan.kind === 'approve' || plan.kind === 'record' || (plan.kind === 'send' && plan.approveFirst)) return setOpenId(pkg.id);
      if (plan.kind === 'send') {
        if (await confirmBox.confirm({ title: t('post.sendTitle', { id: pkg.id, handle: pkg.destination }), body: t('post.sendBody'), confirmLabel: t('post.sendNow') })) await runSteps(pkg, plan.steps, t('post.sent', { id: pkg.id }));
        return;
      }
      if (await confirmBox.confirm(rejectRequest(pkg.id))) await runSteps(pkg, plan.steps, t('post.rejected', { id: pkg.id }));
    },
    [caps, say, confirmBox, runSteps],
  );
  const onMove = useCallback((pkg: RealPackage, to: Column) => void requestMove(pkg, to), [requestMove]);
  const closeDrawer = useCallback(() => {
    setOpenId(null);
    if (urlPost) navigateTo('posts', { replace: true, params: postsViewParams(tab) });
  }, [urlPost, tab]);
  const open = openId ? (data?.packages.find((p) => p.id === openId) ?? null) : null;

  if (error && !data) return <Notice kind="error" title={t('posts.couldNotLoad')} details={error} onRetry={() => void reload()} />;
  if (!data) return <ScreenSkeleton variant="cards" count={3} label={t('posts.loading')} />;

  const live: Live = data.live;
  const h: CardHandlers = { live, tz, onOpen: setOpenId, onMove, onChange: replace, reload, reloadSlots, say, onMake };
  return (
    <div className="st-stack posts-screen">
      <div className={`posts-live st-small ${live.enabled ? 'on' : ''}`}>
        <span>{live.enabled ? t('posts.posting.auto') : t('posts.posting.hand')}</span>
        {live.reason ? (
          <More label={t('posts.why')}>
            <span>{live.reason}</span>
          </More>
        ) : null}
      </div>

      {error ? <Notice kind="error" title={t('posts.staleData')} details={error} onRetry={() => void reload()} /> : null}

      <Tabs tab={tab} counts={counts} onChange={setTab} />

      {tab === 'board' ? (
        <Board byColumn={byColumn} slots={slots} coarse={coarse} draggingId={draggingId} setDraggingId={setDraggingId} caps={caps} {...h} />
      ) : tab === 'gallery' ? (
        <Gallery items={gallery} tz={tz} onOpen={setOpenId} />
      ) : (
        <ColumnList col={tab} items={byColumn[tab]} slots={tab === 'planned' ? slots : []} {...h} />
      )}

      {open ? <PostDrawer pkg={open} live={live} scheduling={data.scheduling} handle={data.project?.handle ?? data.account.destination} tz={tz} say={say} onClose={closeDrawer} onChange={replace} reload={reload} confirm={confirmBox.confirm} /> : null}
      {confirmBox.node}
    </div>
  );
}

// ---- tabs ------------------------------------------------------------------------------------

function Tabs({ tab, counts, onChange }: { tab: PostsTab; counts: Record<PostsTab, number>; onChange: (t: PostsTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((x) => x.id === tab);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = -1;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (i + 1) % TABS.length;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    onChange(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="pb-tabs" role="tablist" aria-label={t('posts.tabs')}>
      {TABS.map((x) => (
        <button
          key={x.id}
          ref={(el) => {
            refs.current[x.id] = el;
          }}
          type="button"
          role="tab"
          id={`pb-tab-${x.id}`}
          className="pb-tab"
          aria-selected={tab === x.id}
          aria-controls={`pb-panel-${x.id}`}
          tabIndex={tab === x.id ? 0 : -1}
          onClick={() => onChange(x.id)}
          onKeyDown={onKey}
        >
          {x.label}
          <span className="pb-count" data-content>
            {counts[x.id]}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---- board -----------------------------------------------------------------------------------

interface CardHandlers {
  live: Live;
  tz: string | null;
  onOpen: (id: string) => void;
  onMove: (pkg: RealPackage, to: Column) => void;
  onChange: (p: RealPackage) => void;
  reload: () => Promise<void>;
  reloadSlots: () => Promise<void>;
  say: Say;
  onMake?: () => void;
}

function EmptyColumn({ col, onMake }: { col: Column; onMake?: () => void }) {
  return (
    <div className="pb-empty">
      <p className="xs st-muted">{EMPTY[col]}</p>
      {col === 'planned' && onMake ? (
        <Button level="primary" dense onClick={onMake}>
          {t('shell.makePost')}
        </Button>
      ) : null}
    </div>
  );
}

function Board({ byColumn, slots, coarse, draggingId, setDraggingId, caps, ...h }: { byColumn: Record<Column, RealPackage[]>; slots: OpenSlot[]; coarse: boolean; draggingId: string | null; setDraggingId: (id: string | null) => void; caps: MoveCapabilities } & CardHandlers) {
  const [over, setOver] = useState<Column | null>(null);
  const dragged = draggingId ? (Object.values(byColumn).flat().find((p) => p.id === draggingId) ?? null) : null;
  const canDropOn = (col: Column) => {
    if (!dragged) return null;
    const plan = planMove(columnOf(dragged.status), col, dragged, caps);
    return plan.kind === 'none' ? null : plan.kind !== 'refuse';
  };
  return (
    <div className="pb-board" role="tabpanel" id="pb-panel-board" aria-labelledby="pb-tab-board">
      {COLUMNS.map((c) => {
        const ok = canDropOn(c.id);
        return (
          <section
            key={c.id}
            className={`pb-col pb-col-${c.id} ${over === c.id && ok ? 'is-over' : ''} ${dragged && ok === false ? 'is-nodrop' : ''}`}
            aria-label={c.title}
            onDragOver={(e) => {
              if (!dragged) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = ok ? 'move' : 'none';
              setOver(c.id);
            }}
            onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/plain') || draggingId;
              setDraggingId(null);
              const pkg = Object.values(byColumn).flat().find((p) => p.id === id);
              if (pkg) h.onMove(pkg, c.id);
            }}
          >
            <header className="pb-col-head">
              <h2 className="pb-col-title">
                {c.title}
                <span className="pb-count" data-content>
                  {byColumn[c.id].length + (c.id === 'planned' ? slots.length : 0)}
                </span>
              </h2>
            </header>
            <div className="pb-col-body">
              {mergePlanned(byColumn[c.id], c.id === 'planned' ? slots : []).map((it) =>
                it.kind === 'slot' ? (
                  <SlotCard key={`slot/${it.slot.campaignId}/${it.slot.id}`} slot={it.slot} variant="board" {...h} />
                ) : (
                  <PostCard
                    key={it.pkg.id}
                    pkg={it.pkg}
                    variant="board"
                    draggable={!coarse}
                    dragging={draggingId === it.pkg.id}
                    onDragStart={() => setDraggingId(it.pkg.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setOver(null);
                    }}
                    {...h}
                  />
                ),
              )}
              {byColumn[c.id].length === 0 && !(c.id === 'planned' && slots.length) ? <EmptyColumn col={c.id} onMake={h.onMake} /> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ColumnList({ col, items, slots, ...h }: { col: Column; items: RealPackage[]; slots: OpenSlot[] } & CardHandlers) {
  return (
    <div className="st-stack pb-list" role="tabpanel" id={`pb-panel-${col}`} aria-labelledby={`pb-tab-${col}`}>
      {mergePlanned(items, slots).map((it) =>
        it.kind === 'slot' ? <SlotCard key={`slot/${it.slot.campaignId}/${it.slot.id}`} slot={it.slot} variant="list" {...h} /> : <PostCard key={it.pkg.id} pkg={it.pkg} variant="list" draggable={false} dragging={false} {...h} />,
      )}
      {items.length === 0 && slots.length === 0 ? <EmptyColumn col={col} onMake={h.onMake} /> : null}
    </div>
  );
}

// ---- gallery (Library merged in) -------------------------------------------------------------

function Gallery({ items, tz, onOpen }: { items: RealPackage[]; tz: string | null; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<'posted' | 'all'>('posted');
  const shown = useMemo(() => galleryOrder(items.filter((p) => filter === 'all' || p.status === 'posted')), [items, filter]);
  const list = useProgressiveList(shown, 12, 12);
  return (
    <div className="st-stack gal" role="tabpanel" id="pb-panel-gallery" aria-labelledby="pb-tab-gallery">
      <ChipRow label={t('posts.filter')}>
        <Chip selected={filter === 'posted'} onClick={() => setFilter('posted')}>
          {t('posts.filter.posted')}
        </Chip>
        <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
          {t('posts.filter.all')}
        </Chip>
      </ChipRow>
      {shown.length === 0 ? <p className="st-small st-muted">{t('posts.empty.gallery')}</p> : null}
      <div className="lib-grid">
        {list.visible.map((p) => {
          const thumb = thumbUrl(p);
          const when = p.posted?.posted_at ?? p.scheduled?.scheduled_for ?? p.plannedFor;
          const views = p.metrics?.metrics?.views;
          return (
            <button key={p.id} type="button" className="st-card lib-card gal-card" onClick={() => onOpen(p.id)} aria-label={t('posts.open', { id: p.id })}>
              {thumb ? <LazyImage className="lib-thumb" src={thumb} alt="" /> : <span className="lib-empty" />}
              <span className="st-stack gal-text">
                <span className="gal-title" data-content>
                  {p.title}
                </span>
                <span className="gal-line">
                  <Pill status={postStatusWord(p.status)} />
                  {when ? (
                    <span className="xs st-muted" data-content>
                      {formatWhenIn(tz, when)}
                    </span>
                  ) : null}
                </span>
                {typeof views === 'number' ? (
                  <span className="xs lib-nums">
                    <b data-content>{views}</b> {t('posts.views')}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <LoadMoreSentinel hasMore={list.hasMore} sentinel={list.sentinel} more={list.more} />
    </div>
  );
}

// ---- cards -----------------------------------------------------------------------------------

/** The time a card shows, in the project zone: posted, scheduled or planned. */
function cardWhen(pkg: RealPackage): string | null {
  return pkg.posted?.posted_at ?? pkg.scheduled?.scheduled_for ?? pkg.plannedFor;
}

/** Origin as a label and the user's own name, so the name counts as content, not interface copy. */
function Origin({ pkg }: { pkg: RealPackage }) {
  const line = originLine(pkg);
  const i = line.indexOf(' · ');
  if (i < 0 || pkg.postmaker) return <span className="xs st-muted pb-origin">{line}</span>;
  return (
    <span className="xs st-muted pb-origin">
      {line.slice(0, i + 3)}
      <span data-content>{line.slice(i + 3)}</span>
    </span>
  );
}

function PostCard({ pkg, variant, draggable, dragging, onDragStart, onDragEnd, tz, onOpen, onMove, onChange, reload, say }: { pkg: RealPackage; variant: 'board' | 'list'; draggable: boolean; dragging: boolean; onDragStart?: () => void; onDragEnd?: () => void } & CardHandlers) {
  const { act, busy, err } = usePackageAct(pkg.id, { onChange, reload, say });
  const approving = useApproving().has(approveKey(pkg.id));
  const quick = quickAction(pkg);
  const thumb = thumbUrl(pkg);
  const col = columnOf(pkg.status);
  const word = postStatusWord(pkg.status);
  const late = isOverdue(pkg);
  const when = cardWhen(pkg);
  return (
    <article
      className={`pb-card pb-card-${variant} s-${pkg.status} ${late ? 'is-overdue' : ''} ${dragging ? 'is-dragging' : ''} ${busy ? 'is-working' : ''}`}
      aria-label={t('post.title', { id: pkg.id })}
      aria-busy={busy || undefined}
      draggable={draggable}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', pkg.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="pb-open" onClick={() => onOpen(pkg.id)} aria-label={t('posts.open', { id: pkg.id })}>
        {thumb ? <LazyImage className="pb-thumb" src={thumb} alt="" /> : <span className="pb-thumb pb-thumb-empty" aria-hidden="true" />}
        <span className="pb-text">
          <span className="pb-title" data-content>
            {pkg.title}
          </span>
          <Origin pkg={pkg} />
          <span className="pb-when">
            {approving ? <span>{t('posts.approving')}</span> : variant === 'list' || word !== COLUMN_WORD[col] ? <Pill status={word} /> : null}
            {late ? <span className="t-bad">{OVERDUE_TEXT}</span> : when ? <span data-content>{formatWhenIn(tz, when)}</span> : null}
          </span>
        </span>
      </button>
      <div className="pb-actions">
        {quick === 'label' ? (
          <Button level="secondary" dense busy={busy} disabled={busy} reason={t('post.busyReason')} onClick={() => void act({ action: 'label' }, t('post.labelConfirmed'))}>
            {t('post.labelConfirm')}
          </Button>
        ) : null}
        {quick === 'check' ? (
          <Button level="secondary" dense busy={busy} disabled={busy} reason={t('post.busyReason')} onClick={() => void act({ action: 'check' }, t('post.statusChecked'))}>
            {t('post.checkStatus')}
          </Button>
        ) : null}
        {col !== 'posted' && col !== 'rejected' && !approving ? <MoveMenu pkg={pkg} onMove={onMove} disabled={busy} /> : null}
      </div>
      {err ? (
        <p className="real-error xs" role="alert">
          {err}
        </p>
      ) : null}
    </article>
  );
}

function SlotCard({ slot, variant, reload, reloadSlots, say }: { slot: OpenSlot; variant: 'board' | 'list' } & CardHandlers) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const make = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/studio/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: getProjectId(), action: 'make-post', id: slot.campaignId, slotId: slot.id }) });
      const j = (await r.json().catch(() => ({}))) as { packageId?: string; error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t('post.couldNotAct'));
      notifyChanged('content', 'calendar', 'campaigns');
      await Promise.all([reload(), reloadSlots()]);
      say(j.packageId ? t('posts.slot.made', { id: j.packageId }) : t('posts.slot.madeNoId'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`pb-card pb-card-${variant} pb-slot ${busy ? 'is-working' : ''}`} aria-label={`${slot.campaignName}, ${formatDateLabel(slot.date)} ${slot.time}`}>
      <div className="pb-open pb-open-static">
        <span className="pb-thumb pb-thumb-slot" aria-hidden="true">
          <span>{slot.formatName}</span>
        </span>
        <span className="pb-text">
          <span className="pb-title" data-content>
            {slot.hook || slot.formatName}
          </span>
          <span className="xs st-muted pb-origin">
            {t('posts.origin.campaign', { name: '' })}
            <span data-content>{slot.campaignName}</span>
          </span>
          <span className="pb-when">
            <span>{t('posts.slot.notMade')}</span>
            <span data-content>
              {formatDateLabel(slot.date)}, {slot.time}
            </span>
          </span>
        </span>
      </div>
      <div className="pb-actions">
        {/* Secondary: a board can hold several slots, and a screen has at most one primary. */}
        <Button level="secondary" dense busy={busy} disabled={busy} reason={t('post.busyReason')} onClick={() => void make()}>
          {busy ? t('posts.slot.making') : t('posts.slot.make')}
        </Button>
      </div>
      {busy ? <TaskProgress active title={slot.formatName} steps={MAKE_STEPS[slot.format] ?? MAKE_STEPS.default!} expectedSeconds={MAKE_SECONDS[slot.format] ?? 15} /> : null}
      {err ? (
        <p className="real-error xs" role="alert">
          {err}
        </p>
      ) : null}
    </article>
  );
}

const MoreIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

/** The Move menu for keyboard and touch: the same moves as dragging. An icon button, so it adds no words per card. */
function MoveMenu({ pkg, onMove, disabled }: { pkg: RealPackage; onMove: (pkg: RealPackage, to: Column) => void; disabled?: boolean }) {
  // A fixed-position popover (portaled to the Studio root) so a scrolling column never clips it; it opens below
  // the button, or above it when there is no room, aligned to the button's inline start in either direction.
  const [open, setOpen] = useState<{ start: number; top?: number; bottom?: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const from = columnOf(pkg.status);
  const targets = COLUMNS.filter((c) => c.id !== from);
  const toggle = () => {
    if (open) {
      setOpen(null);
      return;
    }
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const rtl = getComputedStyle(btn.current!).direction === 'rtl';
    const below = window.innerHeight - r.bottom > 190;
    const start = Math.max(8, Math.min(rtl ? window.innerWidth - r.right : r.left, window.innerWidth - 228));
    setOpen(below ? { start, top: r.bottom + 6 } : { start, bottom: window.innerHeight - r.top + 6 });
  };
  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus({ preventScroll: true });
    const onDoc = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !btn.current?.contains(target)) setOpen(null);
    };
    const onAway = () => setOpen(null);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    window.addEventListener('resize', onAway);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      window.removeEventListener('resize', onAway);
    };
  }, [open]);
  const onKey = (e: ReactKeyboardEvent) => {
    const i = items.current.findIndex((b) => b === document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
      btn.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items.current[(i + 1) % targets.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items.current[(i - 1 + targets.length) % targets.length]?.focus();
    }
  };
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  const list = open ? (
    <ul
      className="pb-menu"
      role="menu"
      id={id}
      aria-label={t('posts.moveLabel', { id: pkg.id })}
      ref={menu}
      style={{ '--menu-start': `${open.start}px`, '--menu-top': open.top !== undefined ? `${open.top}px` : 'auto', '--menu-bottom': open.bottom !== undefined ? `${open.bottom}px` : 'auto' } as CSSProperties}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (!menu.current?.contains(e.relatedTarget as Node | null)) setOpen(null);
      }}
    >
      {targets.map((c, i) => (
        <li key={c.id} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            ref={(el) => {
              items.current[i] = el;
            }}
            onClick={() => {
              setOpen(null);
              onMove(pkg, c.id);
            }}
          >
            <b>{c.title}</b>
          </button>
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <div className="pb-move">
      <IconButton ref={btn} aria-label={t('posts.moveTo', { id: pkg.id })} icon={MoreIcon} aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? id : undefined} disabled={disabled} onClick={toggle} />
      {list && host ? createPortal(list, host) : list}
    </div>
  );
}

// ---- the side drawer (shared Drawer) -----------------------------------------------------

function PostDrawer({ pkg, live, scheduling, handle, tz, say, onClose, onChange, reload, confirm }: { pkg: RealPackage; live: Live; scheduling?: Live; handle: string; tz: string | null; say: Say; onClose: () => void; onChange: (p: RealPackage) => void; reload: () => Promise<void>; confirm: ConfirmFn }) {
  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(pkg.caption);
      say(t('post.copied'));
    } catch {
      say(t('post.copyFailed'));
    }
  };
  const steps: { label: string; at: string | null; state: 'done' | 'active' | 'pending' | 'off' }[] = [
    { label: t('post.step.made'), at: pkg.autopilot?.madeAt ?? null, state: 'done' },
    { label: t('post.step.approved'), at: pkg.approval?.approved_at ?? null, state: pkg.approval ? 'done' : pkg.status === 'discarded' ? 'off' : 'active' },
    { label: t('post.step.scheduled'), at: pkg.scheduled?.scheduled_for ?? null, state: pkg.scheduled ? 'done' : pkg.posted ? 'off' : 'pending' },
    { label: t('post.step.posted'), at: pkg.posted?.posted_at ?? null, state: pkg.posted ? 'done' : ['sending', 'submitted', 'uncertain'].includes(pkg.status) ? 'active' : 'pending' },
  ];
  if (pkg.status === 'discarded') steps.push({ label: t('post.step.rejected'), at: null, state: 'done' });

  // PackageActions places its parts: the status's one primary and Reject go in the sticky footer.
  return (
    <PackageActions
      pkg={pkg}
      live={live}
      scheduling={scheduling}
      say={say}
      onChange={onChange}
      reload={reload}
      confirm={confirm}
      timeZone={tz}
      layout={({ body, primary, secondary }) => (
        <Drawer open title={t('post.title', { id: pkg.id })} status={<Pill status={postStatusWord(pkg.status)} />} onClose={onClose} primary={primary} secondary={secondary}>
          <div className="st-stack pb-drawer">
            <PackageMedia pkg={pkg} />
            <div className="st-stack pb-drawer-head">
              <span className="pb-drawer-title" data-content>
                {pkg.title}
              </span>
              <span className="st-small st-muted">
                <span data-content>{handle}</span> · {FORMAT_TEXT[pkg.format]} · <Origin pkg={pkg} />
              </span>
              {pkg.posted?.url ? (
                <a className="real-link st-small" href={pkg.posted.url} target="_blank" rel="noreferrer">
                  {t('post.viewLive')}
                </a>
              ) : null}
            </div>

            <ol className="pb-timeline" aria-label={t('post.timeline')}>
              {steps.map((s) => (
                <li key={s.label} className={`pb-tl-${s.state}`}>
                  <span className="pb-tl-dot" aria-hidden="true" />
                  <span className="pb-tl-label">{s.label}</span>
                  <span className="xs st-muted" data-content>
                    {s.at ? formatWhenIn(tz, s.at) : '—'}
                  </span>
                </li>
              ))}
            </ol>

            {pkg.autopilot ? <AutopilotMarkView packageId={pkg.id} mark={pkg.autopilot} live={!pkg.posted && ['approved', 'scheduled', 'changed'].includes(pkg.status)} say={say} onPulled={reload} tz={tz} /> : null}

            <div className="st-stack pb-caption">
              <div className="pb-caption-head">
                <span className="label">{t('post.caption')}</span>
                <Button level="tertiary" dense onClick={() => void copyCaption()}>
                  {t('post.copyCaption')}
                </Button>
              </div>
              <pre className="real-caption" dir="auto" data-content>
                {pkg.caption}
              </pre>
            </div>

            {body}
          </div>
        </Drawer>
      )}
    />
  );
}

// The confirm dialog is the shared Studio Dialog (ui/Dialog.tsx); re-exported for older imports.
export { useConfirm };
