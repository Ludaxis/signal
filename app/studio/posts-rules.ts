// Posts board: which column a post sits in, and what moving it between columns means.
// Pure functions, no React: the board, the Move to… menu and the unit tests all use the same rules,
// so a drag can never do something the buttons would refuse (or the other way round).
//
//   Planned  → Review   = approve (optionally also schedule for its planned time)
//   Planned  → Posted   = approve, then post now (or record a hand-made post)
//   Review   → Posted   = post now (or record a hand-made post when automatic posting is off)
//   anything not posted and not on its way → Rejected = discard
//   Everything else is refused with a plain reason. Nothing here talks to the server.

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
  /** A scheduling path exists (Signal's scheduler or Upload-Post schedules). */
  scheduling: boolean;
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

export function planMove(from: Column, to: Column, post: MovablePost, caps: MoveCapabilities, now = Date.now()): MovePlan {
  if (from === to) return { kind: 'none' };
  const s = post.status;
  if (columnOf(s) !== from) return { kind: 'refuse', message: `Post ${post.id} moved on its own. The board was refreshed.` };
  if (from === 'posted') return { kind: 'refuse', message: `Post ${post.id} is already on Instagram. It can only be taken down in Instagram itself.` };
  if (from === 'rejected') return { kind: 'refuse', message: `Post ${post.id} was rejected and stays rejected. Make a new post instead.` };
  if (IN_FLIGHT.includes(s)) return { kind: 'refuse', message: `Post ${post.id} is on its way to Instagram. Open it and check its status first.` };
  if (to === 'planned') return { kind: 'refuse', message: `Approval cannot be undone. If post ${post.id} should not go out, move it to Rejected.` };

  if (to === 'rejected') {
    if (s === 'failed') return { kind: 'refuse', message: `Post ${post.id} did not go through. Open it to sort out what happened; it cannot be rejected as it is.` };
    if (s === 'scheduled') return { kind: 'discard', steps: [{ action: 'cancel-schedule' }, { action: 'discard' }] };
    return { kind: 'discard', steps: [{ action: 'discard' }] };
  }

  // from here: to is 'review' or 'posted'
  if (s === 'changed' || s === 'invalid') return { kind: 'refuse', message: `Post ${post.id} has a problem with its files, so it cannot be approved. Make a new one, or reject it.` };

  if (to === 'review') {
    // Only Planned → Review gets here (Review → Review is 'none'; Posted/Rejected were refused above).
    const at = post.plannedFor && Date.parse(post.plannedFor) > now + TEN_MINUTES && caps.scheduling ? post.plannedFor : null;
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
