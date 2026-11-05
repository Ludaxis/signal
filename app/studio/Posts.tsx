'use client';
// Posts: one screen for everything a post goes through, left to right.
//   Planned (made, waiting for you)  →  Review (OK to post)  →  Posted (on Instagram)   +  Rejected
// The Board tab is a Trello-style board: drag a card to the next column (or use Move to…) and the
// move IS the action: to Review approves, to Posted posts now, to Rejected rejects. Every move is
// confirmed first and runs the same server actions as the buttons; posts-rules.ts decides what a
// move means and what is refused. The other tabs show each column as a list. Clicking a card opens
// the side drawer (like the Calendar's) with the full preview and every action valid right now.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AutopilotMarkView } from './Autopilot';
import { MAKE_SECONDS, MAKE_STEPS } from './Campaigns';
import { LazyImage, ScreenSkeleton, TaskProgress } from './loaders';
import { getProjectId, useProjectId, useScrollLock } from './Projects';
import { COLUMNS, COLUMN_TITLE, columnOf, planMove, sortForColumn, type Column, type MoveCapabilities, type MovePlan, type MoveStep } from './posts-rules';
import { GenerateBar, PackageActions, PackageMedia, STATUS_LABEL, quickAction, thumbUrl, usePackageAct, useRealPosts, type Live, type RealPackage } from './RealPosts';
import { notifyChanged, useOnChanged } from './sync';
import { formatDateLabel, formatDateTime } from '@/lib/time';

export type PostsTab = 'board' | Column;
const TABS: { id: PostsTab; label: string }[] = [{ id: 'board', label: 'Board' }, ...COLUMNS.map((c) => ({ id: c.id, label: c.title }))];
const FORMAT_TEXT: Record<RealPackage['format'], string> = { carousel: 'Carousel', image: 'Image', reel: 'Reel' };

// ---- small hooks ----------------------------------------------------------------------------

/** True on touch-first devices, where drag and drop is replaced by the Move to… menu. */
function useCoarsePointer(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    mq?.addEventListener('change', cb);
    return () => mq?.removeEventListener('change', cb);
  }, []);
  return useSyncExternalStore(subscribe, () => window.matchMedia?.('(pointer: coarse)').matches ?? false, () => false);
}

/** Open overlays, innermost last: Escape closes only the top one, and focus falls back to the one below. */
const traps: HTMLElement[] = [];

/** Keeps keyboard focus inside `ref` while mounted, closes on Escape, and gives focus back afterwards. */
function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    traps.push(el);
    const before = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null || x === el);
    const first = focusables()[0];
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (traps[traps.length - 1] !== el) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const a = f[0]!;
      const z = f[f.length - 1]!;
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === a || !inside)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (document.activeElement === z || !inside)) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      traps.splice(traps.indexOf(el), 1);
      const under = traps[traps.length - 1];
      if (before?.isConnected && (!under || under.contains(before))) before.focus({ preventScroll: true });
      else if (under) under.focus({ preventScroll: true });
      else if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref]);
}

/** Campaign slots that are planned but not made yet: they appear in Planned with a Make button. */
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

/** Planned column: made posts and not-yet-made campaign slots, in time order (no time last). */
type PlannedItem = { kind: 'post'; pkg: RealPackage; when: string | null } | { kind: 'slot'; slot: OpenSlot; when: string };
function mergePlanned(posts: RealPackage[], slots: OpenSlot[]): PlannedItem[] {
  const items: PlannedItem[] = [...posts.map((pkg) => ({ kind: 'post' as const, pkg, when: pkg.scheduled?.scheduled_for ?? pkg.plannedFor })), ...slots.map((slot) => ({ kind: 'slot' as const, slot, when: slot.at }))];
  if (slots.length === 0) return items; // other columns keep sortForColumn's order
  return items.sort((x, y) => {
    if (x.when && y.when && x.when !== y.when) return x.when.localeCompare(y.when);
    if (x.when && !y.when) return -1;
    if (!x.when && y.when) return 1;
    return (x.kind === 'post' ? x.pkg.id : x.slot.id).localeCompare(y.kind === 'post' ? y.pkg.id : y.slot.id);
  });
}

// ---- the screen ------------------------------------------------------------------------------

export function Posts({ say, initialTab = 'board' }: { say: (t: string) => void; initialTab?: PostsTab }) {
  const { data, error, reload, setData } = useRealPosts();
  const { slots, reload: reloadSlots } = useOpenSlots();
  const [tab, setTab] = useState<PostsTab>(initialTab);
  const [openId, setOpenId] = useState<string | null>(null);
  const [move, setMove] = useState<{ pkg: RealPackage; to: Column; plan: Exclude<MovePlan, { kind: 'none' } | { kind: 'refuse' }> } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const confirmBox = useConfirm();
  const coarse = useCoarsePointer();

  const replace = useCallback(
    (pkg: RealPackage) => setData((d) => (d ? { ...d, packages: d.packages.some((p) => p.id === pkg.id) ? d.packages.map((p) => (p.id === pkg.id ? pkg : p)) : [...d.packages, pkg] } : d)),
    [setData],
  );
  const caps: MoveCapabilities = useMemo(() => ({ live: Boolean(data?.live.enabled), scheduling: Boolean(data?.scheduling?.enabled) }), [data]);
  const byColumn = useMemo(() => {
    const out: Record<Column, RealPackage[]> = { planned: [], review: [], posted: [], rejected: [] };
    for (const p of data?.packages ?? []) out[columnOf(p.status)].push(p);
    for (const c of COLUMNS) out[c.id] = sortForColumn(c.id, out[c.id]);
    return out;
  }, [data]);
  const counts: Record<PostsTab, number> = { board: (data?.packages.length ?? 0) + slots.length, planned: byColumn.planned.length + slots.length, review: byColumn.review.length, posted: byColumn.posted.length, rejected: byColumn.rejected.length };

  /** Decide what a move means; refuse with a plain reason, or open the confirm dialog. */
  const requestMove = useCallback(
    (pkg: RealPackage, to: Column) => {
      const plan = planMove(columnOf(pkg.status), to, pkg, caps);
      if (plan.kind === 'none') return;
      if (plan.kind === 'refuse') {
        say(plan.message);
        return;
      }
      setMove({ pkg, to, plan });
    },
    [caps, say],
  );
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const closeMove = useCallback(() => setMove(null), []);
  const open = openId ? (data?.packages.find((p) => p.id === openId) ?? null) : null;

  if (error) return <div className="st-card real-card st-small">Posts: {error}</div>;
  if (!data) return <ScreenSkeleton variant="cards" count={3} label="Loading posts" />;

  const live: Live = data.live;
  return (
    <div className="st-stack" style={{ gap: 16 }}>
      <details className="pb-make" open={data.packages.length === 0}>
        <summary>
          <span className="st-btn st-btn-primary st-btn-sm">Make a post</span>
          <span className="st-small st-muted">Signal makes the next post for you; it lands in Planned, waiting for your OK.</span>
        </summary>
        <GenerateBar key={data.project?.id ?? 'p'} codex={data.codex} higgsfield={data.higgsfield} say={say} onMade={replace} />
      </details>
      <div className={`real-live st-small ${live.enabled ? 'on' : ''}`}>
        <strong>{live.enabled ? `Automatic posting is on (${live.provider === 'meta' ? 'Instagram API' : 'Upload-Post'}).` : 'Posting by hand.'}</strong> {live.reason}
        {' · '}
        {data.account.posted}/{data.account.maxPosts} posted on {data.account.destination}
      </div>

      <Tabs tab={tab} counts={counts} onChange={setTab} />

      {tab === 'board' ? (
        <Board byColumn={byColumn} slots={slots} live={live} coarse={coarse} draggingId={draggingId} setDraggingId={setDraggingId} caps={caps} onOpen={setOpenId} onMove={requestMove} onChange={replace} reload={reload} reloadSlots={reloadSlots} say={say} />
      ) : (
        <ColumnList col={tab} items={byColumn[tab]} slots={tab === 'planned' ? slots : []} live={live} onOpen={setOpenId} onMove={requestMove} onChange={replace} reload={reload} reloadSlots={reloadSlots} say={say} />
      )}

      {open ? <PostDrawer pkg={open} live={live} scheduling={data.scheduling} handle={data.project?.handle ?? data.account.destination} say={say} onClose={closeDrawer} onChange={replace} reload={reload} confirm={confirmBox.confirm} onMove={requestMove} /> : null}
      {move ? <MoveDialog pkg={move.pkg} to={move.to} plan={move.plan} live={live} scheduling={data.scheduling} say={say} onChange={replace} reload={reload} onClose={closeMove} /> : null}
      {confirmBox.node}
    </div>
  );
}

// ---- tabs ------------------------------------------------------------------------------------

function Tabs({ tab, counts, onChange }: { tab: PostsTab; counts: Record<PostsTab, number>; onChange: (t: PostsTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    onChange(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="pb-tabs" role="tablist" aria-label="Posts">
      {TABS.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={`pb-tab-${t.id}`}
          className="pb-tab"
          aria-selected={tab === t.id}
          aria-controls={`pb-panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={onKey}
        >
          {t.label}
          <span className="pb-count">{counts[t.id]}</span>
        </button>
      ))}
    </div>
  );
}

// ---- board -----------------------------------------------------------------------------------

interface CardHandlers {
  live: Live;
  onOpen: (id: string) => void;
  onMove: (pkg: RealPackage, to: Column) => void;
  onChange: (p: RealPackage) => void;
  reload: () => Promise<void>;
  reloadSlots: () => Promise<void>;
  say: (t: string) => void;
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
            aria-label={`${c.title}: ${c.hint}`}
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
              <span className="pb-col-title">
                {c.title}
                <span className="pb-count">{byColumn[c.id].length + (c.id === 'planned' ? slots.length : 0)}</span>
              </span>
              <span className="xs st-muted">{c.hint}</span>
            </header>
            <div className="pb-col-body">
              {mergePlanned(byColumn[c.id], c.id === 'planned' ? slots : []).map((it) =>
                it.kind === 'slot' ? (
                  <SlotCard key={`slot/${it.slot.campaignId}/${it.slot.id}`} slot={it.slot} variant="board" {...h} />
                ) : (
                  <PostCard key={it.pkg.id} pkg={it.pkg} variant="board" draggable={!coarse} dragging={draggingId === it.pkg.id} onDragStart={() => setDraggingId(it.pkg.id)} onDragEnd={() => { setDraggingId(null); setOver(null); }} {...h} />
                ),
              )}
              {byColumn[c.id].length === 0 && !(c.id === 'planned' && slots.length) ? <p className="pb-empty xs st-muted">{EMPTY[c.id]}</p> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
const EMPTY: Record<Column, string> = {
  planned: 'Nothing waiting. Make a post above, or plan a campaign.',
  review: 'Nothing is OK to post yet. Move a post here from Planned.',
  posted: 'Nothing posted yet.',
  rejected: 'Nothing rejected.',
};

function ColumnList({ col, items, slots, ...h }: { col: Column; items: RealPackage[]; slots: OpenSlot[] } & CardHandlers) {
  const c = COLUMNS.find((x) => x.id === col)!;
  return (
    <div className="st-stack" style={{ gap: 10 }} role="tabpanel" id={`pb-panel-${col}`} aria-labelledby={`pb-tab-${col}`}>
      <span className="st-small st-muted">{c.hint}</span>
      {mergePlanned(items, slots).map((it) =>
        it.kind === 'slot' ? <SlotCard key={`slot/${it.slot.campaignId}/${it.slot.id}`} slot={it.slot} variant="list" {...h} /> : <PostCard key={it.pkg.id} pkg={it.pkg} variant="list" draggable={false} dragging={false} {...h} />,
      )}
      {items.length === 0 && slots.length === 0 ? <p className="st-small st-muted">{EMPTY[col]}</p> : null}
    </div>
  );
}

// ---- cards -----------------------------------------------------------------------------------

/** One line that says where the post stands, in plain words. */
function whenText(pkg: RealPackage, live: Live, variant: 'board' | 'list'): { text: string; tone?: 'warn' | 'bad' | 'good' | 'busy' } {
  switch (pkg.status) {
    case 'ready':
      return pkg.plannedFor ? { text: `Planned for ${formatDateTime(pkg.plannedFor)}` } : { text: 'No day yet. Plan it in the Calendar, or post it when you like.' };
    case 'changed':
      return { text: 'Files changed since it was made. Make a new one.', tone: 'bad' };
    case 'invalid':
      return { text: pkg.problems[0] ?? 'Something is wrong with this package.', tone: 'bad' };
    case 'approved':
      if (pkg.missedAt) return { text: `Missed its time (${formatDateTime(pkg.plannedFor)}). Post it now or re-plan it.`, tone: 'warn' };
      if (pkg.plannedFor) return { text: `Planned for ${formatDateTime(pkg.plannedFor)} · not scheduled yet`, tone: 'warn' };
      return { text: variant === 'board' ? `Not scheduled — move to Posted to ${live.enabled ? 'post now' : 'record it'}` : `Not scheduled. Move it to Posted to ${live.enabled ? 'post now' : 'record it'}.`, tone: 'warn' };
    case 'scheduled':
      return { text: `Goes out ${formatDateTime(pkg.scheduled?.scheduled_for ?? pkg.plannedFor)}${pkg.scheduled?.provider === 'signal' ? ' from Signal' : ' via Upload-Post'}`, tone: 'good' };
    case 'sending':
    case 'submitted':
      return { text: 'On its way to Instagram…', tone: 'busy' };
    case 'uncertain':
      return { text: 'Unclear: Instagram did not say if it went out. Check it.', tone: 'warn' };
    case 'failed':
      return { text: pkg.outcome?.message ? `Did not go through: ${pkg.outcome.message}` : 'Did not go through.', tone: 'bad' };
    case 'posted':
      return { text: `Posted ${formatDateTime(pkg.posted?.posted_at)}`, tone: 'good' };
    case 'discarded':
      return { text: 'Rejected. Files stay on disk.' };
  }
}

function PostCard({ pkg, variant, draggable, dragging, onDragStart, onDragEnd, live, onOpen, onMove, onChange, reload, say }: { pkg: RealPackage; variant: 'board' | 'list'; draggable: boolean; dragging: boolean; onDragStart?: () => void; onDragEnd?: () => void } & CardHandlers) {
  const { act, busy, err } = usePackageAct(pkg.id, { onChange, reload, say });
  const w = whenText(pkg, live, variant);
  const quick = quickAction(pkg);
  const thumb = thumbUrl(pkg);
  const col = columnOf(pkg.status);
  return (
    <article
      className={`pb-card pb-card-${variant} s-${pkg.status} ${dragging ? 'is-dragging' : ''} ${busy ? 'is-working' : ''}`}
      aria-label={`Post ${pkg.id}: ${pkg.title}`}
      aria-busy={busy || undefined}
      draggable={draggable}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', pkg.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="pb-open" onClick={() => onOpen(pkg.id)} aria-label={`Open post ${pkg.id}, ${pkg.title}`}>
        {thumb ? <LazyImage className="pb-thumb" src={thumb} alt="" /> : <span className="pb-thumb pb-thumb-empty" aria-hidden="true" />}
        <span className="pb-text">
          <span className="pb-title">{pkg.title}</span>
          <span className="xs st-muted">
            #{pkg.id} · {FORMAT_TEXT[pkg.format]}
            {pkg.campaign ? ` · ${pkg.campaign.name}` : ''}
            {pkg.autopilot ? ' · autopilot' : ''}
          </span>
          <span className={`pb-when ${w.tone ? `t-${w.tone}` : ''}`}>{w.text}</span>
          {variant === 'list' ? <span className={`pill real-status real-${pkg.status}`}>{STATUS_LABEL[pkg.status]}</span> : null}
        </span>
      </button>
      <div className="pb-actions">
        {pkg.status === 'posted' && pkg.posted?.url ? (
          <a className="st-btn st-btn-ghost st-btn-sm" href={pkg.posted.url} target="_blank" rel="noreferrer">
            View on Instagram
          </a>
        ) : null}
        {quick === 'label' ? (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy} disabled={busy} onClick={() => void act({ action: 'label' }, 'AI label confirmed')}>
            Confirm AI label
          </button>
        ) : null}
        {quick === 'check' ? (
          <button type="button" className="st-btn st-btn-dark st-btn-sm" aria-busy={busy} disabled={busy} onClick={() => void act({ action: 'check' }, 'Status checked')}>
            Check
          </button>
        ) : null}
        {quick === 'resolve' ? (
          <button type="button" className="st-btn st-btn-dark st-btn-sm" onClick={() => onOpen(pkg.id)}>
            Resolve
          </button>
        ) : null}
        {col !== 'posted' && col !== 'rejected' ? <MoveMenu pkg={pkg} onMove={onMove} disabled={busy} /> : null}
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
      if (!r.ok) throw new Error(j.error?.message ?? `Could not make the post (${r.status}).`);
      notifyChanged('content', 'calendar', 'campaigns');
      await Promise.all([reload(), reloadSlots()]);
      say(j.packageId ? `Post ${j.packageId} made. It is in Planned, waiting for your OK.` : 'Post made.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`pb-card pb-card-${variant} pb-slot ${busy ? 'is-working' : ''}`} aria-label={`Planned slot: ${slot.campaignName}, ${formatDateLabel(slot.date)} ${slot.time}`}>
      <div className="pb-open pb-open-static">
        <span className="pb-thumb pb-thumb-slot" aria-hidden="true">
          <span>{slot.formatName}</span>
        </span>
        <span className="pb-text">
          <span className="pb-title">{slot.hook || slot.formatName}</span>
          <span className="xs st-muted">{slot.campaignName} · not made yet</span>
          <span className="pb-when">
            {formatDateLabel(slot.date)}, {slot.time}
          </span>
        </span>
      </div>
      <div className="pb-actions">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy} disabled={busy} onClick={() => void make()}>
          {busy ? 'Making' : 'Make'}
        </button>
      </div>
      {busy ? <TaskProgress active title={`Making the ${slot.formatName.toLowerCase()} for ${formatDateLabel(slot.date)}`} steps={MAKE_STEPS[slot.format] ?? MAKE_STEPS.default!} expectedSeconds={MAKE_SECONDS[slot.format] ?? 15} /> : null}
      {err ? (
        <p className="real-error xs" role="alert">
          {err}
        </p>
      ) : null}
    </article>
  );
}

/** "Move to…" for keyboard and touch: the same moves as dragging, as a menu. */
function MoveMenu({ pkg, onMove, disabled }: { pkg: RealPackage; onMove: (pkg: RealPackage, to: Column) => void; disabled?: boolean }) {
  // The menu is a fixed-position popover (portaled to the Studio root) so it is never clipped by a
  // scrolling column; it opens below the button, or above it when there is no room.
  const [open, setOpen] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
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
    const below = window.innerHeight - r.bottom > 190;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 228));
    setOpen(below ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  };
  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus({ preventScroll: true });
    const onDoc = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(null);
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
      aria-label={`Move post ${pkg.id} to`}
      ref={menu}
      style={{ left: open.left, top: open.top, bottom: open.bottom }}
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
            <span className="xs st-muted">{MOVE_HINT[c.id]}</span>
          </button>
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <div className="pb-move">
      <button type="button" className="st-btn st-btn-ghost st-btn-sm" ref={btn} aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? id : undefined} disabled={disabled} onClick={toggle}>
        Move to…
      </button>
      {list && host ? createPortal(list, host) : list}
    </div>
  );
}
const MOVE_HINT: Record<Column, string> = { planned: 'Back to waiting', review: 'Approve: OK to post', posted: 'Post it now', rejected: 'Do not post it' };

// ---- the move confirm dialog -------------------------------------------------------------------

function MoveDialog({ pkg, to, plan, live, scheduling, say, onChange, reload, onClose }: { pkg: RealPackage; to: Column; plan: Exclude<MovePlan, { kind: 'none' } | { kind: 'refuse' }>; live: Live; scheduling?: Live; say: (t: string) => void; onChange: (p: RealPackage) => void; reload: () => Promise<void>; onClose: () => void }) {
  const { act, busy, err, setErr } = usePackageAct(pkg.id, { onChange, reload, say });
  const [checks, setChecks] = useState({ look: false, claims: false });
  const [url, setUrl] = useState('');
  const [aiLabel, setAiLabel] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);
  useFocusTrap(box, close);
  useScrollLock();

  const needsChecks = plan.kind === 'approve' || (plan.kind !== 'discard' && plan.approveFirst);
  const checksOk = !needsChecks || (checks.look && checks.claims);
  const handle = pkg.destination;

  /** Runs the steps in order; stops (and says why) at the first one the server refuses. */
  const run = async (steps: MoveStep[], done: string) => {
    setErr('');
    for (const s of steps) {
      const ok = await act({ ...s }, '');
      if (!ok) {
        await reload();
        notifyChanged('content', 'calendar');
        return;
      }
    }
    notifyChanged('content', 'calendar');
    await reload();
    say(done);
    onClose();
  };

  let title = '';
  let body: ReactNode = null;
  let buttons: ReactNode = null;
  if (plan.kind === 'approve') {
    title = `Approve post ${pkg.id}?`;
    body = <p className="st-small">It moves to Review as OK to post, exactly as shown, for {handle}. Any later change needs a new approval.</p>;
    buttons = (
      <>
        {plan.scheduleAt ? (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !checksOk} aria-busy={busy} onClick={() => void run([{ action: 'approve' }, { action: 'schedule' }], `Post ${pkg.id} approved and scheduled for ${formatDateTime(plan.scheduleAt)}`)}>
            Approve and schedule for {formatDateTime(plan.scheduleAt)}
          </button>
        ) : null}
        <button type="button" className={`st-btn st-btn-sm ${plan.scheduleAt ? 'st-btn-ghost' : 'st-btn-primary'}`} disabled={busy || !checksOk} aria-busy={busy} onClick={() => void run(plan.steps, `Post ${pkg.id} approved. It is OK to post.`)}>
          {plan.scheduleAt ? 'Approve, keep unscheduled' : 'Approve'}
        </button>
      </>
    );
  } else if (plan.kind === 'send') {
    title = `Post this to ${handle} now?`;
    body = (
      <p className="st-small">
        {plan.approveFirst ? 'It is approved first, then sent. ' : ''}This publishes publicly on Instagram with the AI label, through {live.provider === 'meta' ? "Instagram's API" : 'Upload-Post'}. It is sent once and cannot be undone from here.
      </p>
    );
    buttons = (
      <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !checksOk} aria-busy={busy} onClick={() => void run(plan.steps, `Post ${pkg.id} sent to ${live.provider === 'meta' ? 'Instagram' : 'Upload-Post'}`)}>
        {plan.approveFirst ? 'Approve and post now' : 'Post now'}
      </button>
    );
  } else if (plan.kind === 'record') {
    title = `Record post ${pkg.id} as posted`;
    body = (
      <div className="st-stack" style={{ gap: 8 }}>
        <p className="st-small">Automatic posting is off for {handle}, so Signal cannot post this for you. {plan.approveFirst ? 'It is approved first. ' : ''}Post it in Instagram yourself (the files are in the post’s side panel), then paste its link here.</p>
        <input className="st-input" type="url" inputMode="url" placeholder="https://www.instagram.com/p/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Instagram post link" />
        <label className="real-check">
          <input type="checkbox" checked={aiLabel} onChange={(e) => setAiLabel(e.target.checked)} /> Instagram’s AI label is on for this post.
        </label>
      </div>
    );
    buttons = (
      <button
        type="button"
        className="st-btn st-btn-primary st-btn-sm"
        disabled={busy || !checksOk || !url || !aiLabel}
        aria-busy={busy}
        onClick={() => void run([...(plan.approveFirst ? [{ action: 'approve' } as const] : []), { action: 'posted', url, aiLabel }], `Post ${pkg.id} recorded as posted`)}
      >
        {plan.approveFirst ? 'Approve and record as posted' : 'Record as posted'}
      </button>
    );
  } else {
    title = `Reject post ${pkg.id}?`;
    body = <p className="st-small">{pkg.status === 'scheduled' ? 'Its schedule is cancelled and it ' : 'It '}moves to Rejected and will not be posted. The files stay on disk.</p>;
    buttons = (
      <button type="button" className="st-btn st-btn-dark st-btn-sm" disabled={busy} aria-busy={busy} onClick={() => void run(plan.steps, `Post ${pkg.id} rejected`)}>
        Reject
      </button>
    );
  }

  const node = (
    <div className="proj-overlay pb-overlay" role="presentation">
      <div className="pb-dialog st-stack" role="dialog" aria-modal="true" aria-labelledby="pb-move-title" ref={box} tabIndex={-1}>
        <span className="xs st-muted">
          {COLUMN_TITLE[columnOf(pkg.status)]} → {COLUMN_TITLE[to]}
        </span>
        <h2 id="pb-move-title" className="section-title" style={{ fontSize: 17 }}>
          {title}
        </h2>
        <span className="st-small">
          <b>{pkg.title}</b> · #{pkg.id} · {FORMAT_TEXT[pkg.format]}
        </span>
        {body}
        {needsChecks ? (
          <div className="st-stack" style={{ gap: 8 }}>
            <label className="real-check">
              <input type="checkbox" checked={checks.look} onChange={(e) => setChecks({ ...checks, look: e.target.checked })} /> I looked at every slide and the caption, and the “AI-generated content” label is visible.
            </label>
            <label className="real-check">
              <input type="checkbox" checked={checks.claims} onChange={(e) => setChecks({ ...checks, claims: e.target.checked })} /> {pkg.source?.format === 'website-card' ? 'The text matches the page, and the rights notes in the manifest are fine.' : 'The claims are true and the rights notes in the manifest are fine.'}
            </label>
          </div>
        ) : null}
        {plan.kind === 'approve' && pkg.plannedFor && !plan.scheduleAt && !scheduling?.enabled ? <span className="xs st-muted">Planned for {formatDateTime(pkg.plannedFor)}. {scheduling?.reason || 'Scheduling is not available, so you post it yourself when the time comes.'}</span> : null}
        {err ? (
          <p className="real-error st-small" role="alert">
            {err}
          </p>
        ) : null}
        <div className="row-wrap" style={{ gap: 8 }}>
          {buttons}
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  return host ? createPortal(node, host) : node;
}

/** A yes/no box in the Studio's look, as a promise (replaces window.confirm inside the drawer). */
function useConfirm() {
  const [req, setReq] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback((message: string) => new Promise<boolean>((resolve) => setReq({ message, resolve })), []);
  const answer = useCallback(
    (ok: boolean) => {
      setReq((r) => {
        r?.resolve(ok);
        return null;
      });
    },
    [],
  );
  const node = req ? <ConfirmBox message={req.message} onAnswer={answer} /> : null;
  return { confirm, node };
}
function ConfirmBox({ message, onAnswer }: { message: string; onAnswer: (ok: boolean) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const no = useCallback(() => onAnswer(false), [onAnswer]);
  useFocusTrap(box, no);
  const node = (
    <div className="proj-overlay pb-overlay pb-overlay-top" role="presentation">
      <div className="pb-dialog st-stack" role="alertdialog" aria-modal="true" aria-describedby="pb-confirm-text" ref={box} tabIndex={-1}>
        <p id="pb-confirm-text" className="st-small">
          {message}
        </p>
        <div className="row-wrap" style={{ gap: 8 }}>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => onAnswer(true)}>
            Yes
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={no}>
            No
          </button>
        </div>
      </div>
    </div>
  );
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  return host ? createPortal(node, host) : node;
}

// ---- the side drawer ---------------------------------------------------------------------------

function PostDrawer({ pkg, live, scheduling, handle, say, onClose, onChange, reload, confirm, onMove }: { pkg: RealPackage; live: Live; scheduling?: Live; handle: string; say: (t: string) => void; onClose: () => void; onChange: (p: RealPackage) => void; reload: () => Promise<void>; confirm: (m: string) => Promise<boolean>; onMove: (pkg: RealPackage, to: Column) => void }) {
  const panel = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panel, onClose);
  useScrollLock();
  const col = columnOf(pkg.status);
  const w = whenText(pkg, live, 'list');
  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(pkg.caption);
      say('Caption copied');
    } catch {
      say('Select the caption and copy it');
    }
  };
  const steps: { label: string; at: string | null; state: 'done' | 'active' | 'pending' | 'off' }[] = [
    { label: 'Made', at: pkg.autopilot?.madeAt ?? null, state: 'done' },
    { label: 'Approved', at: pkg.approval?.approved_at ?? null, state: pkg.approval ? 'done' : pkg.status === 'discarded' ? 'off' : 'active' },
    { label: 'Scheduled', at: pkg.scheduled?.scheduled_for ?? null, state: pkg.scheduled ? 'done' : pkg.posted ? 'off' : 'pending' },
    { label: 'Posted', at: pkg.posted?.posted_at ?? null, state: pkg.posted ? 'done' : ['sending', 'submitted', 'uncertain'].includes(pkg.status) ? 'active' : 'pending' },
  ];
  if (pkg.status === 'discarded') steps.push({ label: 'Rejected', at: null, state: 'done' });

  const node = (
    <div className="proj-overlay" role="presentation">
      <div className="proj-panel st-stack pb-drawer" style={{ gap: 14, width: 'min(520px, 100%)' }} role="dialog" aria-modal="true" aria-label={`Post ${pkg.id}: ${pkg.title}`} ref={panel} tabIndex={-1}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 17 }}>Post {pkg.id}</span>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <PackageMedia pkg={pkg} />
        <div className="st-stack" style={{ gap: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{pkg.title}</span>
          <span className="st-small st-muted">
            {handle} · {FORMAT_TEXT[pkg.format]}
            {pkg.campaign ? ` · ${pkg.campaign.name} (slot ${pkg.campaign.slot})` : ''}
          </span>
          <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`pill real-status real-${pkg.status}`}>{STATUS_LABEL[pkg.status]}</span>
            <span className="xs st-muted">in {COLUMN_TITLE[col]}</span>
          </div>
          <span className={`st-small pb-when ${w.tone ? `t-${w.tone}` : ''}`}>{w.text}</span>
          {pkg.posted?.url ? (
            <a className="real-link st-small" href={pkg.posted.url} target="_blank" rel="noreferrer">
              View on Instagram
            </a>
          ) : null}
        </div>

        <ol className="pb-timeline" aria-label="Where this post stands">
          {steps.map((s) => (
            <li key={s.label} className={`pb-tl-${s.state}`}>
              <span className="pb-tl-dot" aria-hidden="true" />
              <span className="pb-tl-label">{s.label}</span>
              <span className="xs st-muted">{s.at ? formatDateTime(s.at) : s.state === 'done' ? '' : s.state === 'active' ? 'now' : s.state === 'off' ? '—' : 'not yet'}</span>
            </li>
          ))}
        </ol>

        {pkg.autopilot ? <AutopilotMarkView packageId={pkg.id} mark={pkg.autopilot} live={!pkg.posted && ['approved', 'scheduled', 'changed'].includes(pkg.status)} say={say} onPulled={reload} /> : null}

        <div className="st-stack" style={{ gap: 6 }}>
          <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span className="label">Caption</span>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => void copyCaption()}>
              Copy caption
            </button>
          </div>
          <pre className="real-caption">{pkg.caption}</pre>
        </div>

        <div className="st-stack" style={{ gap: 6 }}>
          <span className="label">What you can do</span>
          <PackageActions pkg={pkg} live={live} scheduling={scheduling} say={say} onChange={onChange} reload={reload} confirm={confirm} />
          {col === 'planned' || col === 'review' ? (
            <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
              <span className="xs st-muted">Or move it on the board:</span>
              <MoveMenu pkg={pkg} onMove={(p, to) => { onClose(); onMove(p, to); }} />
            </div>
          ) : null}
        </div>

        <details>
          <summary className="st-small st-muted">Fingerprints (SHA-256), checked on every approve</summary>
          <ul className="real-hashes">
            {pkg.files.map((f) => (
              <li key={f.name}>
                <span aria-label={f.ok ? 'matches' : 'changed'}>{f.ok ? '✓' : '✕'}</span> {f.name} <code>{f.sha256.slice(0, 16)}…</code>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  return host ? createPortal(node, host) : node;
}
