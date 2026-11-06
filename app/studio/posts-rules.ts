// Posts board: which column a post sits in, and what moving it between columns means.
// Pure functions, no React: the board, the Move to… menu and the unit tests all use the same rules,
// so a drag can never do something the buttons would refuse (or the other way round).
//
//   Planned  → Review   = approve (optionally also schedule for its planned time)
//   Planned  → Posted   = approve, then post now (or record a hand-made post)
//   Review   → Posted   = post now (or record a hand-made post when automatic posting is off)
//   anything not posted and not on its way → Rejected = discard (a failed post too: nothing went out)
//   Everything else is refused with a plain reason. Nothing here talks to the server.
//
// Overdue plans: a plan is not a schedule (nothing is scheduled without a click), so an
// approved post whose planned time has passed just waits. isOverdue() marks it on the board, in the
// drawer and in the Calendar, and overdueTimes() gives the two times the drawer offers to schedule it.
import { addDays, zonedParts, zonedToUtc } from '@/lib/time';

export type PostStatus = 'ready' | 'changed' | 'approved' | 'scheduled' | 'sending' | 'submitted' | 'uncertain' | 'failed' | 'posted' | 'discarded' | 'invalid';
export type Column = 'planned' | 'review' | 'posted' | 'rejected';

export const COLUMNS: { id: Column; title: string; hint: string }[] = [
  { id: 'planned', title: 'Planned', hint: 'Made and waiting for you' },
  { id: 'review', title: 'Review', hint: 'OK to post' },
  { id: 'posted', title: 'Posted', hint: 'On Instagram' },
  { id: 'rejected', title: 'Rejected', hint: 'Will not be posted' },
];
export const COLUMN_TITLE: Record<Column, string> = { planned: 'Planned', review: 'Review', posted: 'Posted', rejected: 'Rejected' };

/** Posts in flight hold a slot on Instagram: nothing may move them until their result is known. */
export const IN_FLIGHT: PostStatus[] = ['sending', 'submitted', 'uncertain'];

export function columnOf(status: PostStatus): Column {
  switch (status) {
    case 'ready':
    case 'changed':
    case 'invalid':
      return 'planned';
    case 'approved':
    case 'scheduled':
    case 'sending':
    case 'submitted':
    case 'uncertain':
    case 'failed':
      return 'review';
    case 'posted':
      return 'posted';
    case 'discarded':
      return 'rejected';
  }
}

/** The bit of a post the rules need. */
export interface MovablePost {
  id: string;
  status: PostStatus;
  plannedFor: string | null;
  scheduled: { scheduled_for: string; provider?: 'upload-post' | 'signal' } | null;
}
/** What the account can do right now (from GET /api/studio/content: live, scheduling). */
export interface MoveCapabilities {
  /** Automatic posting works for this account (Instagram API or Upload-Post). */
  live: boolean;
  /** A scheduling path exists (Signal's scheduler or Upload-Post schedules). Only counts while `live` is on: a schedule is a post. */
  scheduling: boolean;
}

/** The capabilities the board uses: scheduling needs live posting (otherwise approve-and-schedule approves, then fails). */
export function moveCapabilities(live: { enabled: boolean } | null | undefined, scheduling: { enabled: boolean } | null | undefined): MoveCapabilities {
  const on = Boolean(live?.enabled);
  return { live: on, scheduling: on && Boolean(scheduling?.enabled) };
}

/** One request to POST /api/studio/content/:id. */
export type MoveStep = { action: 'approve' } | { action: 'schedule' } | { action: 'send' } | { action: 'discard' } | { action: 'cancel-schedule' } | { action: 'posted'; url: string; aiLabel: boolean };

export type MovePlan =
  /** Same column: nothing to do, nothing to say. */
  | { kind: 'none' }
  | { kind: 'refuse'; message: string }
  /** Approve. `scheduleAt` is set when the dialog may also offer "Schedule for <planned time>". */
  | { kind: 'approve'; steps: [{ action: 'approve' }]; scheduleAt: string | null }
  /** Post now through the automatic path (optionally approving first). */
  | { kind: 'send'; steps: MoveStep[]; approveFirst: boolean }
  /** Automatic posting is off: the dialog asks for the Instagram link and the AI-label check (optionally approving first). */
  | { kind: 'record'; approveFirst: boolean }
  /** Reject: discard (after cancelling a schedule when there is one). */
  | { kind: 'discard'; steps: MoveStep[] };

const TEN_MINUTES = 10 * 60_000;

/** What the toast says when a multi-step move stopped after its first step went through (the dialog then closes). */
export function partialText(id: string, first: MoveStep, failed: MoveStep, error: string): string {
  const did = first.action === 'approve' ? `Post ${id} was approved` : first.action === 'cancel-schedule' ? `The schedule for post ${id} was cancelled` : `Post ${id} was updated`;
  const not = failed.action === 'schedule' ? 'not scheduled' : failed.action === 'send' ? 'not posted' : failed.action === 'posted' ? 'not recorded as posted' : failed.action === 'discard' ? 'not rejected' : 'not finished';
  return `${did}, but ${not}${error ? `: ${error}` : '.'}`;
}

export function planMove(from: Column, to: Column, post: MovablePost, caps: MoveCapabilities, now = Date.now()): MovePlan {
  if (from === to) return { kind: 'none' };
  const s = post.status;
  if (columnOf(s) !== from) return { kind: 'refuse', message: `Post ${post.id} moved on its own. The board was refreshed.` };
  if (from === 'posted') return { kind: 'refuse', message: `Post ${post.id} is already on Instagram. It can only be taken down in Instagram itself.` };
  if (from === 'rejected') return { kind: 'refuse', message: `Post ${post.id} was rejected and stays rejected. Make a new post instead.` };
  if (IN_FLIGHT.includes(s)) return { kind: 'refuse', message: `Post ${post.id} is on its way to Instagram. Open it and check its status first.` };
  if (to === 'planned') return { kind: 'refuse', message: `Approval cannot be undone. If post ${post.id} should not go out, move it to Rejected.` };

  if (to === 'rejected') {
    if (s === 'scheduled') return { kind: 'discard', steps: [{ action: 'cancel-schedule' }, { action: 'discard' }] };
    return { kind: 'discard', steps: [{ action: 'discard' }] };
  }

  // from here: to is 'review' or 'posted'
  if (s === 'changed' || s === 'invalid') return { kind: 'refuse', message: `Post ${post.id} has a problem with its files, so it cannot be approved. Make a new one, or reject it.` };

  if (to === 'review') {
    // Only Planned → Review gets here (Review → Review is 'none'; Posted/Rejected were refused above).
    const at = post.plannedFor && Date.parse(post.plannedFor) > now + TEN_MINUTES && caps.scheduling && caps.live ? post.plannedFor : null;
    return { kind: 'approve', steps: [{ action: 'approve' }], scheduleAt: at };
  }

  // to === 'posted'
  if (s === 'failed') return { kind: 'refuse', message: `Post ${post.id} did not go through last time. Open it and press Check status, or resolve it by hand.` };
  if (s === 'scheduled') {
    if (post.scheduled?.provider !== 'signal' || !caps.live) return { kind: 'refuse', message: `Post ${post.id} is scheduled on Upload-Post. Cancel that schedule first (open the post), then post it.` };
    return { kind: 'send', steps: [{ action: 'send' }], approveFirst: false };
  }
  const approveFirst = s === 'ready';
  if (!caps.live) return { kind: 'record', approveFirst };
  return { kind: 'send', steps: approveFirst ? [{ action: 'approve' }, { action: 'send' }] : [{ action: 'send' }], approveFirst };
}

/** Sort order inside a column or list tab. */
export function sortForColumn<T extends { id: string; plannedFor: string | null; scheduled: { scheduled_for: string } | null; posted: { posted_at: string } | null }>(col: Column, items: T[]): T[] {
  const when = (p: T) => p.scheduled?.scheduled_for ?? p.plannedFor ?? null;
  return [...items].sort((a, b) => {
    if (col === 'posted') return (b.posted?.posted_at ?? '').localeCompare(a.posted?.posted_at ?? '') || b.id.localeCompare(a.id);
    if (col === 'rejected') return b.id.localeCompare(a.id);
    const wa = when(a);
    const wb = when(b);
    if (wa && wb && wa !== wb) return wa.localeCompare(wb);
    if (wa && !wb) return -1;
    if (!wa && wb) return 1;
    return a.id.localeCompare(b.id);
  });
}

// ---- overdue plans ----------------------------------------------------------------------------

/** What the board card, the drawer and the Calendar chip say about an overdue plan. */
export const OVERDUE_TEXT = 'Planned time passed. Post now, schedule, or re-plan.';

/** An approved post whose planned time has passed without being scheduled or posted. */
export function isOverdue(p: { status: string; plannedFor: string | null; scheduled?: unknown; posted?: unknown }, now = Date.now()): boolean {
  if (p.status !== 'approved' || !p.plannedFor || p.scheduled || p.posted) return false;
  const t = Date.parse(p.plannedFor);
  return Number.isFinite(t) && t <= now;
}

/** Upload-Post schedules at least 10 minutes ahead; the drawer leaves a margin for the confirm and the upload. */
export const SCHEDULE_LEAD_MS = 15 * 60_000;

/**
 * The two times an overdue post can be scheduled for, both at least SCHEDULE_LEAD_MS from now:
 *   atPlannedTime: the planned clock time (Studio time zone) on the next day it is still ahead (keeps the cadence)
 *   soonest:       now + the lead, rounded up to the next 5 minutes
 */
export function overdueTimes(plannedFor: string, now = Date.now()): { atPlannedTime: string | null; soonest: string } {
  const step = 5 * 60_000;
  const soonest = new Date(Math.ceil((now + SCHEDULE_LEAD_MS) / step) * step).toISOString();
  const time = zonedParts(plannedFor).time;
  let date = zonedParts(now).date;
  let atPlannedTime: string | null = null;
  for (let i = 0; i < 3 && !atPlannedTime; i++, date = addDays(date, 1)) {
    const r = zonedToUtc(date, time);
    if (r.ok && Date.parse(r.iso) >= now + SCHEDULE_LEAD_MS) atPlannedTime = r.iso;
  }
  return { atPlannedTime, soonest };
}

/** Whether the drawer may offer Reject for a post (the server checks again: see discardBlock in lib/studio/content.ts). */
export function canReject(p: { status: PostStatus; posted?: unknown; scheduled?: unknown; dispatch?: unknown; outcome?: { state: string } | null; unreadable?: string[] }): boolean {
  if (p.posted) return false;
  if (p.status === 'invalid') {
    if ((p.unreadable ?? []).some((n) => ['posted.json', 'dispatch.json', 'outcome.json', 'scheduled.json', 'discarded.json', 'package folder'].includes(n))) return false;
    return !p.scheduled && (!p.dispatch || p.outcome?.state === 'failed');
  }
  return ['ready', 'changed', 'approved', 'failed'].includes(p.status);
}
