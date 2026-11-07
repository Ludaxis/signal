// Posts board: which column a post sits in, and what moving it between columns means.
// Pure functions, no React: the board, the Move to… menu and the unit tests all use the same rules,
// so a drag can never do something the buttons would refuse (or the other way round).
//
// Column ids are internal; the titles follow the status dictionary:
//   planned = To approve, review = Approved, posted = Posted, rejected = Rejected.
//
//   To approve → Approved = approve (optionally also schedule for its planned time)
//   To approve → Posted   = approve, then post now (or record a hand-made post)
//   Approved   → Posted   = post now (or record a hand-made post when automatic posting is off)
//   anything not posted and not on its way → Rejected = discard (a failed post too: nothing went out)
//   Everything else is refused with a plain reason. Nothing here talks to the server.
//
// Overdue plans: a plan is not a schedule (nothing is scheduled without a click), so an
// approved post whose planned time has passed just waits. isOverdue() marks it on the board, in the
// drawer and in the Calendar, and overdueTimes() gives the two times the drawer offers to schedule it.
import { addDays } from '@/lib/time';
import { partsIn, wallToUtcIn, type Zoned } from '@/lib/studio/time';
import { comparePackageIds } from '@/lib/studio/package-id';
import { t } from './copy/en';
import type { StatusWord } from './ui/status';

export type PostStatus = 'ready' | 'changed' | 'approved' | 'scheduled' | 'sending' | 'submitted' | 'uncertain' | 'failed' | 'posted' | 'discarded' | 'invalid';
export type Column = 'planned' | 'review' | 'posted' | 'rejected';

export const COLUMN_TITLE: Record<Column, string> = {
  planned: t('posts.col.toApprove'),
  review: t('posts.col.approved'),
  posted: t('posts.col.posted'),
  rejected: t('posts.col.rejected'),
};
export const COLUMNS: { id: Column; title: string }[] = (['planned', 'review', 'posted', 'rejected'] as const).map((id) => ({ id, title: COLUMN_TITLE[id] }));

/** The one status-dictionary word for a post. Raw status values never reach the screen. */
export const POST_STATUS_WORD: Record<PostStatus, StatusWord> = {
  ready: 'To approve',
  changed: 'Files changed',
  invalid: 'Files changed',
  approved: 'Approved',
  scheduled: 'Scheduled',
  sending: 'Sending',
  submitted: 'Sending',
  uncertain: 'Check status',
  failed: 'Failed',
  posted: 'Posted',
  discarded: 'Rejected',
};
export function postStatusWord(status: PostStatus): StatusWord {
  return POST_STATUS_WORD[status];
}

/**
 * "Needs you": posts To approve, at Check status or Failed, posts whose files changed since approval
 * (they need a new make, so they are listed too), and approved posts
 * whose planned time passed (the old "Due now" banner). Today's list and the Posts nav badge both
 * count this one set, so the two numbers always agree. Post maker runs and blocking connections join
 * it when they exist (they are not part of these payloads yet).
 */
export function needsYou<T extends { status: PostStatus; plannedFor: string | null; scheduled?: unknown; posted?: unknown; missedAt?: string | null }>(posts: T[], now = Date.now()): T[] {
  return posts.filter((p) => p.status === 'ready' || p.status === 'uncertain' || p.status === 'failed' || filesChanged(p) || isOverdue(p, now) || (p.status === 'approved' && Boolean(p.missedAt)));
}

/** A post whose files changed since approval (status word "Files changed"): it must be made again. */
export function filesChanged(p: { status: PostStatus }): boolean {
  return p.status === 'changed' || p.status === 'invalid';
}

/** Where a post came from, in one line. */
export function originLine(p: {
  postmaker?: { template: string; version: number } | null;
  campaign?: { name: string } | null;
  pipeline?: { name: string } | null;
  source?: { generator?: string } | null;
}): string {
  if (p.postmaker) return t('posts.origin.postmaker', { template: p.postmaker.template, version: p.postmaker.version });
  if (p.campaign) return t('posts.origin.campaign', { name: p.campaign.name });
  if (p.pipeline) return t('posts.origin.pipeline', { name: p.pipeline.name });
  if (p.source?.generator) return t('posts.origin.made');
  return t('posts.origin.uploaded');
}

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
  const did = first.action === 'approve' ? t('posts.partial.approved', { id }) : first.action === 'cancel-schedule' ? t('posts.partial.unscheduled', { id }) : t('posts.partial.updated', { id });
  const not =
    failed.action === 'schedule'
      ? t('posts.partial.notScheduled')
      : failed.action === 'send'
        ? t('posts.partial.notPosted')
        : failed.action === 'posted'
          ? t('posts.partial.notRecorded')
          : failed.action === 'discard'
            ? t('posts.partial.notRejected')
            : t('posts.partial.notFinished');
  return error ? t('posts.partial.withError', { did, not, error }) : t('posts.partial.noError', { did, not });
}

export function planMove(from: Column, to: Column, post: MovablePost, caps: MoveCapabilities, now = Date.now()): MovePlan {
  if (from === to) return { kind: 'none' };
  const s = post.status;
  if (columnOf(s) !== from) return { kind: 'refuse', message: t('posts.refuse.movedOnItsOwn', { id: post.id }) };
  if (from === 'posted') return { kind: 'refuse', message: t('posts.refuse.posted', { id: post.id }) };
  if (from === 'rejected') return { kind: 'refuse', message: t('posts.refuse.rejected', { id: post.id }) };
  if (IN_FLIGHT.includes(s)) return { kind: 'refuse', message: t('posts.refuse.sending', { id: post.id }) };
  if (to === 'planned') return { kind: 'refuse', message: t('posts.refuse.approved', { id: post.id }) };

  if (to === 'rejected') {
    if (s === 'scheduled') return { kind: 'discard', steps: [{ action: 'cancel-schedule' }, { action: 'discard' }] };
    return { kind: 'discard', steps: [{ action: 'discard' }] };
  }

  // from here: to is 'review' or 'posted'
  if (s === 'changed' || s === 'invalid') return { kind: 'refuse', message: t('posts.filesChanged') };

  if (to === 'review') {
    // Only Planned → Review gets here (Review → Review is 'none'; Posted/Rejected were refused above).
    const at = post.plannedFor && Date.parse(post.plannedFor) > now + TEN_MINUTES && caps.scheduling && caps.live ? post.plannedFor : null;
    return { kind: 'approve', steps: [{ action: 'approve' }], scheduleAt: at };
  }

  // to === 'posted'
  if (s === 'failed') return { kind: 'refuse', message: t('posts.refuse.failed', { id: post.id }) };
  if (s === 'scheduled') {
    if (post.scheduled?.provider !== 'signal' || !caps.live) return { kind: 'refuse', message: t('posts.refuse.scheduled', { id: post.id }) };
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
    if (col === 'posted') return (b.posted?.posted_at ?? '').localeCompare(a.posted?.posted_at ?? '') || comparePackageIds(b.id, a.id);
    if (col === 'rejected') return comparePackageIds(b.id, a.id);
    const wa = when(a);
    const wb = when(b);
    if (wa && wb && wa !== wb) return wa.localeCompare(wb);
    if (wa && !wb) return -1;
    if (!wa && wb) return 1;
    return comparePackageIds(a.id, b.id);
  });
}

/** Gallery order: newest package first, by package number (numeric: 100 before 99). */
export function galleryOrder<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => comparePackageIds(b.id, a.id));
}

/** Results and Today "posted" lists: latest post first; the same instant falls back to the higher package number. */
export function postedNewestFirst<T extends { id: string; posted: { posted_at: string } | null }>(items: T[]): T[] {
  return items.filter((p) => p.posted).sort((a, b) => (b.posted!.posted_at < a.posted!.posted_at ? -1 : b.posted!.posted_at > a.posted!.posted_at ? 1 : comparePackageIds(b.id, a.id)));
}

/** Today's "needs you" list: planned time first (unplanned last), then package number. */
export function needsYouOrder<T extends { id: string; plannedFor: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.plannedFor ?? '9').localeCompare(b.plannedFor ?? '9') || comparePackageIds(a.id, b.id));
}

// ---- overdue plans ----------------------------------------------------------------------------

/** What the board card, the drawer and the Calendar chip say about an overdue plan. */
export const OVERDUE_TEXT = t('posts.overdue');

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
 *   atPlannedTime: the planned clock time (project zone; default zone when none) on the next day it is still ahead (keeps the cadence)
 *   soonest:       now + the lead, rounded up to the next 5 minutes
 */
export function overdueTimes(plannedFor: string, now = Date.now(), zone?: Zoned): { atPlannedTime: string | null; soonest: string } {
  const step = 5 * 60_000;
  const soonest = new Date(Math.ceil((now + SCHEDULE_LEAD_MS) / step) * step).toISOString();
  const time = partsIn(zone, plannedFor).time;
  let date = partsIn(zone, now).date;
  let atPlannedTime: string | null = null;
  for (let i = 0; i < 3 && !atPlannedTime; i++, date = addDays(date, 1)) {
    const r = wallToUtcIn(zone, date, time);
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
