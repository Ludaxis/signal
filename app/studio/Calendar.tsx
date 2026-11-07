'use client';
// Calendar: a week of posts in the project's time zone. Drag a post onto a day to
// plan it, move planned ones between days, or open one to set the exact time. Planning never posts: a planned
// post still needs approval on Posts. A scheduled post really goes out at its time, so moving or unscheduling it
// asks first (shared Dialog). "All accounts" counts days in the default zone and labels
// each project's chips in that project's own zone. Times are 24-hour HH:MM; the zone is named once per screen.
import { useRouter } from 'next/navigation';
import { notifyChanged, useOnChanged } from './sync';
import { navigateTo, useUrlParam } from './url-state';
import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { setProjectId, useProjectId } from './Projects';
import { Skeleton } from './loaders';
import { t } from './copy/en';
import { Button, Chip, ChipRow, Drawer, IconButton, Notice, Pill, useConfirm, type ConfirmFn } from './ui';
import { OVERDUE_TEXT, isOverdue, postStatusWord, type PostStatus } from './posts-rules';
import { addDays, formatDateLabel, formatTime, formatWeekRange, startOfWeek, weekDates, type DstChange } from '@/lib/time';
import { DEFAULT_TIME_ZONE, dstChangesIn, formatWhenIn, partsIn, projectTimeZone, timeZoneLabel, todayIn, wallToUtcIn } from '@/lib/studio/time';

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
  /** The campaign the post was made for (the `?campaign=<id>` filter). */
  campaign?: { id: string; name: string } | null;
}
interface CalProject {
  id: string;
  name: string;
  handle: string;
  timeZone?: string;
}
interface CalData {
  timezone: string;
  timeZoneLabel?: string;
  projects: CalProject[];
  items: CalItem[];
  unplanned: CalItem[];
  /** Campaign names of the shown projects (the filter chip names one even in a week without its posts). */
  campaigns?: { id: string; project: string; name: string }[];
}

/** Calendar data for a range: one project (`project`), or every account (`project` null; `all` asks for the default-zone grid). */
export function useCalendarRange(from: string, to: string, project?: string | null, all = false) {
  const [data, setData] = useState<CalData | null>(null);
  const [error, setError] = useState('');
  const router = useRouter();
  const load = useCallback(async () => {
    try {
      const scope = project ? `&project=${encodeURIComponent(project)}` : all ? '&scope=all' : '';
      const r = await fetch(`/api/studio/calendar?from=${from}&to=${to}${scope}`, { cache: 'no-store' });
      if (r.status === 401) {
        router.push('/login?next=%2Fstudio');
        return;
      }
      const j = (await r.json()) as CalData & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t('calendar.couldNotLoad'));
      setData(j);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [from, to, project, all, router]);
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
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** How far ahead the day picker reaches. */
const DAYS_AHEAD = 120;

/** A planned (not scheduled) approved post whose time has passed: nothing posts it by itself. */
const overdue = (i: CalItem, now = Date.now()) => i.kind === 'planned' && isOverdue({ status: i.status, plannedFor: i.when }, now);
/** The status-dictionary word for a chip (the Calendar shows no raw status either). */
const statusWord = (i: CalItem) => postStatusWord(i.status as PostStatus) ?? postStatusWord('ready');

/** The clock-change notice for a week: one line naming the day and the shift. */
export function clockChangeText(c: DstChange): string {
  const day = formatDateLabel(c.date);
  return c.direction === 'back' ? t('calendar.clocksBack', { day }) : t('calendar.clocksForward', { day });
}

/** The confirm before a real schedule moves (a question naming the object, one consequence line). */
export function moveScheduleRequest(item: CalItem, when: string) {
  return { title: t('calendar.moveTitle', { id: item.id, when }), body: t('calendar.moveBody'), confirmLabel: t('calendar.moveConfirm') };
}
/** The confirm before a real schedule is cancelled. */
export function unscheduleRequest(item: CalItem, tz?: string) {
  return {
    title: t('calendar.unscheduleTitle', { id: item.id }),
    body: t('calendar.unscheduleBody', { when: item.when ? formatWhenIn(projectTimeZone(tz), item.when) : '—' }),
    confirmLabel: t('calendar.unscheduleConfirm'),
  };
}

async function plan(item: CalItem, iso: string | null): Promise<void> {
  const r = await fetch(`/api/studio/content/${item.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'plan', project: item.project, plannedFor: iso }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: { message: string } } | null;
    throw new Error(j?.error?.message ?? t('calendar.couldNotPlan'));
  }
  notifyChanged('content', 'calendar', 'campaigns');
}

const PrevIcon = (
  <svg className="icon-mirror" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
const NextIcon = (
  <svg className="icon-mirror" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export function Calendar({ say, onOpenPosts }: { say: (t: string) => void; onOpenPosts: () => void }) {
  const pid = useProjectId();
  const [scope, setScope] = useState<'project' | 'all'>('project');
  // The zone the server counted days in (the project's time zone; the default zone for "All accounts" and for
  // older projects). Until the first answer it is the default zone; kept from the last answer so the shown week
  // can follow it.
  const [zone, setZone] = useState<string | null>(null);
  // The week the user moved to; null means "the current week in the grid's zone", so a project east of the
  // default zone opens on its own Monday once the server has told us its zone.
  const [picked, setPicked] = useState<string | null>(null);
  const tz = scope === 'all' ? DEFAULT_TIME_ZONE : projectTimeZone(zone);
  const today = todayIn(tz);
  const weekStart = picked ?? startOfWeek(today);
  const days = weekDates(weekStart);
  const cal = useCalendarRange(days[0]!, days[6]!, scope === 'project' ? pid : null, scope === 'all');
  if (scope === 'project' && cal.data && cal.data.timezone !== zone) setZone(cal.data.timezone);
  const [open, setOpen] = useState<CalItem | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const changes = dstChangesIn(tz, days);
  const confirmBox = useConfirm();

  // Campaigns › "Show all" opens the Calendar on `?campaign=<id>`: only that campaign's posts, with a chip to clear.
  const campaign = useUrlParam('campaign');
  const ofCampaign = (i: CalItem) => !campaign || i.campaign?.id === campaign;
  const campaignName = campaign ? (cal.data?.campaigns?.find((c) => c.id === campaign)?.name ?? [...(cal.data?.items ?? []), ...(cal.data?.unplanned ?? [])].find((i) => i.campaign?.id === campaign)?.campaign?.name ?? null) : null;
  const shownItems = (cal.data?.items ?? []).filter(ofCampaign);
  const shownUnplanned = (cal.data?.unplanned ?? []).filter(ofCampaign);
  const clearCampaign = () => navigateTo('calendar', { replace: true });

  const projects = cal.data?.projects ?? [];
  /** The zone a project's own times are shown and planned in. */
  const zoneOf = (project: string) => projectTimeZone(projects.find((p) => p.id === project)?.timeZone ?? (scope === 'all' ? null : tz));
  const key = (i: CalItem) => `${i.project}/${i.id}`;
  const all = [...(cal.data?.items ?? []), ...(cal.data?.unplanned ?? [])];
  const find = (k: string | null) => all.find((i) => key(i) === k) ?? null;

  const dropOn = async (project: string, date: string) => {
    const it = find(drag);
    setDrag(null);
    setOver(null);
    if (!it) return;
    if (it.project !== project) {
      say(t('calendar.ownAccount'));
      return;
    }
    const own = zoneOf(it.project);
    const time = it.when ? partsIn(own, it.when).time : DEFAULT_TIME;
    const r = wallToUtcIn(own, date, time);
    if (!r.ok) {
      say(r.message);
      return;
    }
    const when = formatWhenIn(own, r.iso);
    const scheduled = it.status === 'scheduled';
    if (scheduled && !(await confirmBox.confirm(moveScheduleRequest(it, when)))) return;
    try {
      await plan(it, r.iso);
      say(scheduled ? t('calendar.moved', { id: it.id, when }) : t('calendar.planned', { id: it.id, when }));
      await cal.reload();
    } catch (e) {
      say((e as Error).message);
    }
  };

  const chip = (i: CalItem) => {
    const locked = LOCKED.includes(i.status);
    const own = zoneOf(i.project);
    const late = overdue(i);
    const word = statusWord(i);
    const time = i.when ? formatTime(i.when, own) : null;
    // In "All accounts", a project in another zone says so in its own label (screen readers and the tooltip).
    const zoneNote = scope === 'all' && own !== tz ? ` ${own}` : '';
    return (
      <button
        key={key(i)}
        type="button"
        className={`cal2-item k-${i.kind} s-${i.status} ${late ? 'is-overdue' : ''}`}
        title={late ? OVERDUE_TEXT : undefined}
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
        aria-label={`${i.title}, ${late ? OVERDUE_TEXT : word}${time ? `, ${time}${zoneNote}` : ''}`}
      >
        {i.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={i.thumb} alt="" />
        ) : (
          <span className="cal2-noimg" />
        )}
        <span className="cal2-meta">
          {/* An unplanned chip has no time; its title already names the post (no "#12"). */}
          {time ? (
            <span className="cal2-time" data-content>
              {time}
            </span>
          ) : null}
          <span className="cal2-title" data-content>
            {i.title.replace(/^.*?·\s*/, '')}
          </span>
          <span className="cal2-status">{word}</span>
        </span>
      </button>
    );
  };

  const cell = (project: string, date: string) => shownItems.filter((i) => i.project === project && i.when && partsIn(tz, i.when).date === date);

  return (
    <div className="st-stack cal-screen">
      <div className="calw-head">
        <div className="st-stack calw-head-text">
          <span className="cal-week" data-content>
            {formatWeekRange(weekStart)}
          </span>
          <span className="xs st-muted">{scope === 'project' && cal.data?.timeZoneLabel ? cal.data.timeZoneLabel : timeZoneLabel(tz)}</span>
        </div>
        <div className="cal-controls">
          <ChipRow label={t('calendar.accounts')}>
            <Chip selected={scope === 'project'} onClick={() => setScope('project')}>
              {t('calendar.thisAccount')}
            </Chip>
            <Chip
              selected={scope === 'all'}
              onClick={() => {
                setScope('all');
                setPicked(null);
              }}
            >
              {t('calendar.allAccounts')}
            </Chip>
          </ChipRow>
          <div className="cal-weeknav" role="group" aria-label={t('calendar.changeWeek')}>
            <IconButton aria-label={t('calendar.previous')} icon={PrevIcon} onClick={() => setPicked(addDays(weekStart, -7))} />
            <Button level="secondary" dense aria-pressed={weekStart === startOfWeek(today)} onClick={() => setPicked(null)}>
              {t('calendar.thisWeek')}
            </Button>
            <IconButton aria-label={t('calendar.next')} icon={NextIcon} onClick={() => setPicked(addDays(weekStart, 7))} />
          </div>
        </div>
      </div>

      {campaign ? (
        <div className="u-row u-gap-2">
          <ChipRow label={t('calendar.filter')}>
            <Chip selected onClick={clearCampaign}>
              {campaignName ? t('calendar.campaignChip', { name: campaignName }) : t('calendar.campaignChipUnnamed')}
            </Chip>
          </ChipRow>
          <Button level="tertiary" dense onClick={clearCampaign}>
            {t('calendar.clear')}
          </Button>
        </div>
      ) : null}

      {changes.slice(0, 1).map((c) => (
        <p key={c.date} className="cal2-dst st-small" role="note">
          {clockChangeText(c)}
        </p>
      ))}

      {cal.error ? <Notice kind="error" title={t('calendar.couldNotLoad')} details={cal.error} onRetry={() => void cal.reload()} /> : null}
      {!cal.data && cal.error ? null : !cal.data ? (
        <div className="st-card ld-card" role="status" aria-busy="true" aria-label={t('calendar.loading')}>
          <div className="ld-cal">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={`h${i}`} h={14} w={i === 0 ? '70%' : '55%'} />
            ))}
            {Array.from({ length: 16 }, (_, i) => (
              <Skeleton key={`c${i}`} h={i % 8 === 0 ? 36 : 84} r={10} />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="cal2-scroll">
            <div className="cal2-grid cal2-week" role="table" aria-label={t('calendar.week', { range: formatWeekRange(weekStart) })}>
              <div className="cal2-corner" role="columnheader">
                {t('calendar.account')}
              </div>
              {days.map((d) => (
                <div key={d} className={`cal2-head ${d === today ? 'today' : ''}`} role="columnheader" aria-current={d === today ? 'date' : undefined}>
                  <span data-content>{formatDateLabel(d)}</span>
                  {d === today ? <span className="cal2-todaydot">{t('calendar.today')}</span> : null}
                </div>
              ))}
              {projects.map((p) => (
                <div key={p.id} role="row" className="cal2-row">
                  <div className="cal2-account" role="rowheader">
                    <span className="cal2-account-name" data-content>
                      {p.name}
                    </span>
                    <span className="xs st-muted" data-content>
                      {p.handle}
                    </span>
                    {scope === 'all' && projectTimeZone(p.timeZone) !== tz ? (
                      <span className="xs st-muted" data-content>
                        {projectTimeZone(p.timeZone)}
                      </span>
                    ) : null}
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
                        {items.filter((i) => i.kind !== 'unplanned').length > 1 ? <span className="cal2-warn">{t('calendar.twoPosts')}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <section className="st-card st-stack cal-tray" aria-label={t('calendar.notPlanned')}>
            <span className="label">{t('calendar.notPlanned')}</span>
            {shownUnplanned.length ? (
              <div className="cal2-tray">
                {shownUnplanned.map((i) => (
                  <div key={key(i)} className="st-stack cal-tray-item">
                    {scope === 'all' ? (
                      <span className="xs st-muted" data-content>
                        {projects.find((p) => p.id === i.project)?.handle}
                      </span>
                    ) : null}
                    {chip(i)}
                  </div>
                ))}
              </div>
            ) : (
              <span className="st-small st-muted">{t('calendar.allPlanned')}</span>
            )}
          </section>

          {/* Mobile list */}
          <div className="cal2-list">
            {days.map((d) => {
              const items = shownItems.filter((i) => i.when && partsIn(tz, i.when).date === d);
              return (
                <section key={d} className="st-stack cal-list-day" aria-label={formatDateLabel(d, true)}>
                  <span className="cal-list-date" data-content>
                    {formatDateLabel(d)}
                  </span>
                  {items.length ? items.map(chip) : <span className="xs st-muted">{t('calendar.nothingPlanned')}</span>}
                </section>
              );
            })}
          </div>
        </>
      )}

      {open ? (
        <PlanDrawer
          item={open}
          tz={zoneOf(open.project)}
          showZone={scope === 'all' && zoneOf(open.project) !== tz}
          handle={projects.find((p) => p.id === open.project)?.handle ?? ''}
          onClose={() => setOpen(null)}
          confirm={confirmBox.confirm}
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
      {confirmBox.node}
    </div>
  );
}

/** The days the drawer offers, from today in the project's zone (en-GB labels, never a US date picker). */
function dayOptions(tz: string, current: string | null): string[] {
  const first = todayIn(tz);
  const out = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(first, i));
  if (current && current > out.at(-1)!) out.push(current);
  return out;
}

function PlanDrawer({ item, tz, showZone, handle, confirm, onClose, onSaved, onReview }: { item: CalItem; tz: string; showZone: boolean; handle: string; confirm: ConfirmFn; onClose: () => void; onSaved: (m: string) => Promise<void>; onReview: () => void }) {
  const p = item.when ? partsIn(tz, item.when) : null;
  const first = todayIn(tz);
  const [date, setDate] = useState(p && p.date >= first ? p.date : first);
  const [time, setTime] = useState(p?.time ?? DEFAULT_TIME);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = LOCKED.includes(item.status);
  const scheduled = item.status === 'scheduled';
  const timeOk = TIME_RE.test(time);
  const dirty = !locked && (date !== (p?.date ?? first) || time !== (p?.time ?? DEFAULT_TIME));

  const save = async (clear: boolean) => {
    setErr('');
    let iso: string | null = null;
    if (!clear) {
      if (!timeOk) {
        setErr(t('calendar.timeError'));
        return;
      }
      const r = wallToUtcIn(tz, date, time);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      iso = r.iso;
    }
    const when = iso ? formatWhenIn(tz, iso) : '';
    // A real schedule goes out at its time: moving or unscheduling it asks first.
    if (scheduled && !(await confirm(clear ? unscheduleRequest(item, tz) : moveScheduleRequest(item, when)))) return;
    setBusy(true);
    try {
      await plan(item, iso);
      await onSaved(scheduled ? (clear ? t('calendar.unscheduled', { id: item.id }) : t('calendar.moved', { id: item.id, when })) : clear ? t('calendar.unplanned', { id: item.id }) : t('calendar.planned', { id: item.id, when }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const late = overdue(item);

  return (
    <Drawer
      open
      title={t('post.title', { id: item.id })}
      status={<Pill status={statusWord(item)} />}
      dirty={dirty && !busy}
      onClose={onClose}
      primary={
        locked ? null : (
          <Button level="primary" busy={busy} disabled={busy} reason={t('post.busyReason')} onClick={() => void save(false)}>
            {t('calendar.save')}
          </Button>
        )
      }
      secondary={
        <>
          {!locked && item.when ? (
            <Button level="secondary" disabled={busy} reason={t('post.busyReason')} onClick={() => void save(true)}>
              {scheduled ? t('calendar.unschedule') : t('calendar.unplan')}
            </Button>
          ) : null}
          <Button level="tertiary" onClick={onReview}>
            {t('calendar.openInPosts')}
          </Button>
        </>
      }
    >
      <div className="st-stack cal-drawer">
        {item.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="cal2-preview" src={item.thumb} alt="" />
        ) : null}
        <span className="cal-drawer-title" data-content>
          {item.title}
        </span>
        <span className="st-small st-muted" data-content>
          {handle}
        </span>
        {late ? (
          <p className="st-small cal-late" role="status">
            {OVERDUE_TEXT}
          </p>
        ) : null}
        {locked ? (
          <span className="st-small">
            {item.kind === 'posted' && item.when ? t('calendar.lockedPosted', { when: formatWhenIn(tz, item.when) }) : t('calendar.lockedSending')}{' '}
            {item.url ? (
              <a className="real-link" href={item.url} target="_blank" rel="noreferrer">
                {t('post.viewLive')}
              </a>
            ) : null}
          </span>
        ) : (
          <>
            <div className="cal-fields">
              <label className="wiz-field">
                {t('calendar.day')}
                <select className="st-input" value={date} onChange={(e) => setDate(e.target.value)} data-content>
                  {dayOptions(tz, date).map((d) => (
                    <option key={d} value={d}>
                      {formatDateLabel(d)}
                      {d.slice(0, 4) === first.slice(0, 4) ? '' : ` ${d.slice(0, 4)}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wiz-field">
                {t('calendar.time')}
                <input
                  className="st-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="18:00"
                  maxLength={5}
                  value={time}
                  aria-invalid={!timeOk || undefined}
                  onChange={(e) => setTime(e.target.value.trim())}
                />
              </label>
            </div>
            {showZone ? <span className="xs st-muted">{timeZoneLabel(tz)}</span> : null}
            <span className="xs st-muted">{scheduled ? t('calendar.scheduledLine') : t('calendar.plannedOnly')}</span>
          </>
        )}
        {err ? (
          <p className="real-error st-small" role="alert">
            {err}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
