'use client';
// Calendar: a week of every project's posts (Studio time zone). Drag a package onto a day to plan
// it, move planned ones between days, or open one to set the exact time. Planning never posts:
// a planned package still needs your approval on the Posts board, and Today shows it when it is due.
import { useRouter } from 'next/navigation';
import { notifyChanged, useOnChanged } from './sync';
import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { setProjectId, useProjectId, useScrollLock } from './Projects';
import { Skeleton } from './loaders';
import {
  TIMEZONE,
  addDays,
  zonedParts,
  zonedToUtc,
  describeDstChange,
  dstChanges,
  formatDateLabel,
  formatTime,
  formatWeekRange,
  startOfWeek,
  todayInZone,
  weekDates,
} from '@/lib/time';

export interface CalItem {
  project: string;
  id: string;
  title: string;
  status: string;
  format: string;
  when: string | null;
  kind: 'posted' | 'planned' | 'unplanned';
  thumb: string | null;
  url: string | null;
}
interface CalData { timezone: string; projects: { id: string; name: string; handle: string }[]; items: CalItem[]; unplanned: CalItem[] }

export function useCalendarRange(from: string, to: string, project?: string | null) {
  const [data, setData] = useState<CalData | null>(null);
  const [error, setError] = useState('');
  const router = useRouter();
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/studio/calendar?from=${from}&to=${to}${project ? `&project=${encodeURIComponent(project)}` : ''}`, { cache: 'no-store' });
      if (r.status === 401) {
        router.push('/login?next=%2Fstudio');
        return;
      }
      const j = (await r.json()) as CalData & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? 'Could not load the calendar.');
      setData(j);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [from, to, project, router]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);
  useOnChanged(['content', 'calendar'], load, 60_000);
  return { data, error, reload: load };
}

const DEFAULT_TIME = '18:00';
const LOCKED = ['posted', 'sending', 'submitted', 'uncertain'];
const STATUS_TEXT: Record<string, string> = {
  posted: 'Posted',
  ready: 'Needs approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  sending: 'Sending',
  submitted: 'Publishing',
  uncertain: 'Check status',
  failed: 'Not posted',
  changed: 'Files changed',
};

async function plan(item: CalItem, iso: string | null): Promise<void> {
  const r = await fetch(`/api/studio/content/${item.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'plan', project: item.project, plannedFor: iso }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: { message: string } } | null;
    throw new Error(j?.error?.message ?? 'Could not plan the post.');
  }
  notifyChanged('content', 'calendar', 'campaigns');
}

export function Calendar({ say, onOpenPosts }: { say: (t: string) => void; onOpenPosts: () => void }) {
  const today = todayInZone();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today));
  const days = weekDates(weekStart);
  const pid = useProjectId();
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const cal = useCalendarRange(days[0]!, days[6]!, scope === 'project' ? pid : null);
  const [open, setOpen] = useState<CalItem | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const changes = dstChanges(days);

  const key = (i: CalItem) => `${i.project}/${i.id}`;
  const all = [...(cal.data?.items ?? []), ...(cal.data?.unplanned ?? [])];
  const find = (k: string | null) => all.find((i) => key(i) === k) ?? null;

  const dropOn = async (project: string, date: string) => {
    const it = find(drag);
    setDrag(null);
    setOver(null);
    if (!it) return;
    if (it.project !== project) {
      say('A post can only move within its own account.');
      return;
    }
    const time = it.when ? zonedParts(it.when).time : DEFAULT_TIME;
    const r = zonedToUtc(date, time);
    if (!r.ok) {
      say(r.message);
      return;
    }
    try {
      await plan(it, r.iso);
      say(`Post ${it.id} planned for ${formatDateLabel(date)}, ${time}`);
      await cal.reload();
    } catch (e) {
      say((e as Error).message);
    }
  };

  const chip = (i: CalItem) => {
    const locked = LOCKED.includes(i.status);
    return (
      <button
        key={key(i)}
        type="button"
        className={`cal2-item k-${i.kind} s-${i.status}`}
        draggable={!locked}
        onDragStart={(e: DragEvent) => {
          e.dataTransfer.setData('text/plain', key(i));
          e.dataTransfer.effectAllowed = 'move';
          setDrag(key(i));
        }}
        onDragEnd={() => {
          setDrag(null);
          setOver(null);
        }}
        onClick={() => setOpen(i)}
        aria-label={`${i.title}, ${STATUS_TEXT[i.status] ?? i.status}${i.when ? `, ${formatTime(i.when)}` : ''}`}
      >
        {i.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={i.thumb} alt="" />
        ) : (
          <span className="cal2-noimg" />
        )}
        <span className="cal2-meta">
          <span className="cal2-time">{i.when ? formatTime(i.when) : `#${i.id}`}</span>
          <span className="cal2-title">{i.title.replace(/^.*?·\s*/, '')}</span>
          <span className="cal2-status">{STATUS_TEXT[i.status] ?? i.status}</span>
        </span>
      </button>
    );
  };

  const projects = cal.data?.projects ?? [];
  const cell = (project: string, date: string) => (cal.data?.items ?? []).filter((i) => i.project === project && i.when && zonedParts(i.when).date === date);

  return (
    <div className="st-stack" style={{ gap: 16 }}>
      <div className="row-wrap" style={{ gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="st-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{formatWeekRange(weekStart)}</span>
          <span className="xs st-muted">All times {TIMEZONE} · drag a post onto a day to plan it</span>
        </div>
        <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <div className="st-chip-row" role="group" aria-label="Accounts shown">
          <button type="button" className="st-chip" aria-pressed={scope === 'project'} onClick={() => setScope('project')}>
            This account
          </button>
          <button type="button" className="st-chip" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All accounts
          </button>
        </div>
        <div className="row-wrap" style={{ gap: 6 }} role="group" aria-label="Change week">
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            ← Previous
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-pressed={weekStart === startOfWeek(today)} onClick={() => setWeekStart(startOfWeek(today))}>
            This week
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            Next →
          </button>
        </div>
        </div>
      </div>

      {changes.map((c) => (
        <div key={c.date} className="cal2-dst st-small">
          <strong>Daylight-saving change this week.</strong> {describeDstChange(c)} Posts keep their local clock time.
        </div>
      ))}

      {cal.error ? <p className="real-error st-small">{cal.error}</p> : null}
      {!cal.data ? (
        <div className="st-card ld-card" role="status" aria-busy="true" aria-label="Loading the calendar">
          <span className="st-vh">Loading the calendar…</span>
          <div className="ld-cal">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={`h${i}`} h={14} w={i === 0 ? '70%' : '55%'} />
            ))}
            {Array.from({ length: 16 }, (_, i) => (
              <Skeleton key={`c${i}`} h={i % 8 === 0 ? 36 : 84} r={10} style={{ opacity: i % 3 === 1 ? 1 : 0.55 }} />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="cal2-scroll">
            <div className="cal2-grid" style={{ gridTemplateColumns: `170px repeat(7, minmax(120px, 1fr))` }} role="table" aria-label={`Week of ${formatWeekRange(weekStart)}`}>
              <div className="cal2-corner" role="columnheader">
                Account
              </div>
              {days.map((d) => (
                <div key={d} className={`cal2-head ${d === today ? 'today' : ''}`} role="columnheader" aria-current={d === today ? 'date' : undefined}>
                  {formatDateLabel(d)}
                  {d === today ? <span className="cal2-todaydot">Today</span> : null}
                </div>
              ))}
              {projects.map((p) => (
                <div key={p.id} role="row" style={{ display: 'contents' }}>
                  <div className="cal2-account" role="rowheader">
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span className="xs st-muted">{p.handle}</span>
                  </div>
                  {days.map((d) => {
                    const items = cell(p.id, d);
                    const id = `${p.id}|${d}`;
                    const past = d < today;
                    const dragged = find(drag);
                    const canDrop = Boolean(dragged && dragged.project === p.id && !past);
                    return (
                      <div
                        key={d}
                        role="cell"
                        className={`cal2-cell ${past ? 'past' : ''} ${over === id && canDrop ? 'over' : ''} ${dragged && !canDrop ? 'nodrop' : ''}`}
                        onDragOver={(e) => {
                          if (!canDrop) return;
                          e.preventDefault();
                          setOver(id);
                        }}
                        onDragLeave={() => setOver((o) => (o === id ? null : o))}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (canDrop) void dropOn(p.id, d);
                        }}
                      >
                        {items.map(chip)}
                        {items.filter((i) => i.kind !== 'unplanned').length > 1 ? <span className="cal2-warn">More than one post this day</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="st-card st-stack" style={{ padding: 16, gap: 10 }}>
            <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span className="label">Not planned yet</span>
              <span className="xs st-muted">Drag onto a day in the same account’s row</span>
            </div>
            {cal.data.unplanned.length ? (
              <div className="cal2-tray">
                {cal.data.unplanned.map((i) => (
                  <div key={key(i)} className="st-stack" style={{ gap: 4 }}>
                    {scope === 'all' ? <span className="xs st-muted">{projects.find((p) => p.id === i.project)?.handle}</span> : null}
                    {chip(i)}
                  </div>
                ))}
              </div>
            ) : (
              <span className="st-small st-muted">Everything is planned. Make new posts on the Posts screen.</span>
            )}
          </div>

          {/* Mobile list */}
          <div className="cal2-list">
            {days.map((d) => {
              const items = (cal.data?.items ?? []).filter((i) => i.when && zonedParts(i.when).date === d);
              return (
                <section key={d} className="st-stack" style={{ gap: 6 }} aria-label={formatDateLabel(d, true)}>
                  <span style={{ fontWeight: 600 }}>
                    {formatDateLabel(d)}
                    {d === today ? <span className="st-muted"> · today</span> : null}
                  </span>
                  {items.length ? items.map(chip) : <span className="xs st-muted">Nothing planned</span>}
                </section>
              );
            })}
          </div>
        </>
      )}

      {open ? (
        <PlanDrawer
          item={open}
          handle={projects.find((p) => p.id === open.project)?.handle ?? ''}
          onClose={() => setOpen(null)}
          onSaved={async (msg) => {
            setOpen(null);
            say(msg);
            await cal.reload();
          }}
          onReview={() => {
            setProjectId(open.project);
            setOpen(null);
            onOpenPosts();
          }}
        />
      ) : null}
    </div>
  );
}

function PlanDrawer({ item, handle, onClose, onSaved, onReview }: { item: CalItem; handle: string; onClose: () => void; onSaved: (m: string) => Promise<void>; onReview: () => void }) {
  const p = item.when ? zonedParts(item.when) : null;
  const [date, setDate] = useState(p?.date ?? todayInZone());
  const [time, setTime] = useState(p?.time ?? DEFAULT_TIME);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = LOCKED.includes(item.status);
  useScrollLock();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async (clear: boolean) => {
    setErr('');
    let iso: string | null = null;
    if (!clear) {
      const r = zonedToUtc(date, time);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      iso = r.iso;
    }
    setBusy(true);
    try {
      await plan(item, iso);
      await onSaved(clear ? `Post ${item.id} is no longer planned` : `Post ${item.id} planned for ${formatDateLabel(date)}, ${time}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Portal to the Studio root: animated screens create their own containing block for position: fixed.
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  const node = (
    <div className="proj-overlay" role="dialog" aria-modal="true" aria-label={`Post ${item.id}`}>
      <div className="proj-panel st-stack" style={{ gap: 14, width: 'min(440px, 100%)' }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 17 }}>Post {item.id}</span>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {item.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="cal2-preview" src={item.thumb} alt="" />
        ) : null}
        <span style={{ fontWeight: 600 }}>{item.title}</span>
        <span className="st-small st-muted">
          {handle} · {STATUS_TEXT[item.status] ?? item.status}
        </span>
        {locked ? (
          <span className="st-small">
            {item.kind === 'posted' ? `Posted ${formatDateLabel(zonedParts(item.when!).date)} at ${formatTime(item.when)}.` : 'This post is being sent; its time can’t change.'}{' '}
            {item.url ? (
              <a className="real-link" href={item.url} target="_blank" rel="noreferrer">
                View on Instagram
              </a>
            ) : null}
          </span>
        ) : (
          <>
            <div className="row-wrap" style={{ gap: 10 }}>
              <label className="wiz-field">
                Day
                <input className="st-input" type="date" value={date} min={todayInZone()} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="wiz-field">
                Time ({TIMEZONE})
                <input className="st-input" type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>
            <span className="xs st-muted">Planning doesn’t post. When it’s due, Today reminds you; you still approve and post it on the Posts board.</span>
            <div className="row-wrap" style={{ gap: 8 }}>
              <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy} onClick={() => void save(false)}>
                {item.when ? 'Save time' : 'Plan'}
              </button>
              {item.when ? (
                <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={() => void save(true)}>
                  Remove from calendar
                </button>
              ) : null}
            </div>
          </>
        )}
        {err ? (
          <p className="real-error st-small" role="alert">
            {err}
          </p>
        ) : null}
        <div>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onReview}>
            Open in Posts
          </button>
        </div>
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}
