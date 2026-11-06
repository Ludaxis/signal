import { describe, expect, it } from 'vitest';
import { COLUMNS, OVERDUE_TEXT, SCHEDULE_LEAD_MS, canReject, columnOf, isOverdue, moveCapabilities, overdueTimes, partialText, planMove, sortForColumn, type MovablePost, type PostStatus } from '@/app/studio/posts-rules';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const post = (status: PostStatus, extra: Partial<MovablePost> = {}): MovablePost => ({ id: '07', status, plannedFor: null, scheduled: null, ...extra });
const LIVE = { live: true, scheduling: true };
const MANUAL = { live: false, scheduling: false };

describe('column assignment by status', () => {
  it('puts every status in exactly one of the four columns', () => {
    const all: PostStatus[] = ['ready', 'changed', 'approved', 'scheduled', 'sending', 'submitted', 'uncertain', 'failed', 'posted', 'discarded', 'invalid'];
    const ids = COLUMNS.map((c) => c.id);
    for (const s of all) expect(ids).toContain(columnOf(s));
    expect(columnOf('ready')).toBe('planned');
    expect(columnOf('changed')).toBe('planned');
    expect(columnOf('invalid')).toBe('planned');
    for (const s of ['approved', 'scheduled', 'sending', 'submitted', 'uncertain', 'failed'] as const) expect(columnOf(s)).toBe('review');
    expect(columnOf('posted')).toBe('posted');
    expect(columnOf('discarded')).toBe('rejected');
  });
});

describe('move rules', () => {
  it('does nothing for a drop on the same column', () => {
    expect(planMove('planned', 'planned', post('ready'), LIVE, NOW)).toEqual({ kind: 'none' });
  });

  it('Planned → Review approves, and offers the planned time when scheduling exists and the time is far enough away', () => {
    expect(planMove('planned', 'review', post('ready'), LIVE, NOW)).toEqual({ kind: 'approve', steps: [{ action: 'approve' }], scheduleAt: null });
    const soon = new Date(NOW + 5 * 60_000).toISOString();
    const later = new Date(NOW + 3 * 3600_000).toISOString();
    expect(planMove('planned', 'review', post('ready', { plannedFor: later }), LIVE, NOW)).toMatchObject({ kind: 'approve', scheduleAt: later });
    expect(planMove('planned', 'review', post('ready', { plannedFor: soon }), LIVE, NOW)).toMatchObject({ kind: 'approve', scheduleAt: null });
    expect(planMove('planned', 'review', post('ready', { plannedFor: later }), { live: true, scheduling: false }, NOW)).toMatchObject({ kind: 'approve', scheduleAt: null });
  });

  it('never offers "Approve and schedule" while one-click posting is off', () => {
    const later = new Date(NOW + 3 * 3600_000).toISOString();
    // Even if a caller passes scheduling without live, the rule refuses to offer the schedule.
    expect(planMove('planned', 'review', post('ready', { plannedFor: later }), { live: false, scheduling: true }, NOW)).toMatchObject({ kind: 'approve', scheduleAt: null });
    expect(moveCapabilities({ enabled: false }, { enabled: true })).toEqual({ live: false, scheduling: false });
    expect(moveCapabilities({ enabled: true }, { enabled: true })).toEqual({ live: true, scheduling: true });
    expect(moveCapabilities({ enabled: true }, undefined)).toEqual({ live: true, scheduling: false });
    expect(moveCapabilities(null, null)).toEqual({ live: false, scheduling: false });
  });

  it('Review → Posted posts now when automatic posting is on, otherwise asks for the link', () => {
    expect(planMove('review', 'posted', post('approved'), LIVE, NOW)).toEqual({ kind: 'send', steps: [{ action: 'send' }], approveFirst: false });
    expect(planMove('review', 'posted', post('approved'), MANUAL, NOW)).toEqual({ kind: 'record', approveFirst: false });
  });

  it('Planned → Posted approves first, then posts or records', () => {
    expect(planMove('planned', 'posted', post('ready'), LIVE, NOW)).toEqual({ kind: 'send', steps: [{ action: 'approve' }, { action: 'send' }], approveFirst: true });
    expect(planMove('planned', 'posted', post('ready'), MANUAL, NOW)).toEqual({ kind: 'record', approveFirst: true });
  });

  it('refuses posts whose files changed or are broken (they can only be rejected)', () => {
    for (const s of ['changed', 'invalid'] as const) {
      expect(planMove('planned', 'review', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
      expect(planMove('planned', 'posted', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
      expect(planMove('planned', 'rejected', post(s), LIVE, NOW)).toEqual({ kind: 'discard', steps: [{ action: 'discard' }] });
    }
  });

  it('a scheduled post is posted now only from Signal’s own scheduler; Upload-Post schedules must be cancelled first', () => {
    const at = new Date(NOW + 86_400_000).toISOString();
    expect(planMove('review', 'posted', post('scheduled', { scheduled: { scheduled_for: at, provider: 'signal' } }), LIVE, NOW)).toMatchObject({ kind: 'send', approveFirst: false });
    expect(planMove('review', 'posted', post('scheduled', { scheduled: { scheduled_for: at, provider: 'upload-post' } }), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
    expect(planMove('review', 'posted', post('scheduled', { scheduled: { scheduled_for: at, provider: 'signal' } }), MANUAL, NOW)).toMatchObject({ kind: 'refuse' });
    expect(planMove('review', 'rejected', post('scheduled', { scheduled: { scheduled_for: at, provider: 'signal' } }), LIVE, NOW)).toEqual({ kind: 'discard', steps: [{ action: 'cancel-schedule' }, { action: 'discard' }] });
  });

  it('refuses moving posts that are on their way, failed posts to Posted, and anything backwards', () => {
    for (const s of ['sending', 'submitted', 'uncertain'] as const) {
      expect(planMove('review', 'posted', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/on its way/) });
      expect(planMove('review', 'rejected', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
    }
    expect(planMove('review', 'posted', post('failed'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/Check status/) });
    // A failed post (nothing went out) can be rejected.
    expect(planMove('review', 'rejected', post('failed'), LIVE, NOW)).toEqual({ kind: 'discard', steps: [{ action: 'discard' }] });
    expect(planMove('review', 'planned', post('approved'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/cannot be undone/) });
    expect(planMove('review', 'rejected', post('approved'), LIVE, NOW)).toEqual({ kind: 'discard', steps: [{ action: 'discard' }] });
  });

  it('nothing leaves Posted or Rejected', () => {
    for (const to of ['planned', 'review', 'rejected'] as const) expect(planMove('posted', to, post('posted'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/already on Instagram/) });
    for (const to of ['planned', 'review', 'posted'] as const) expect(planMove('rejected', to, post('discarded'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/stays rejected/) });
  });

  it('refuses when the card is no longer in the column it was dragged from (stale board)', () => {
    expect(planMove('planned', 'review', post('approved'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/refreshed/) });
  });
});

describe('sorting', () => {
  const item = (id: string, o: { plannedFor?: string; scheduled?: string; posted?: string } = {}) => ({ id, plannedFor: o.plannedFor ?? null, scheduled: o.scheduled ? { scheduled_for: o.scheduled } : null, posted: o.posted ? { posted_at: o.posted } : null });
  it('Planned and Review go by time, unplanned last, then by id; Posted newest first', () => {
    const r = sortForColumn('planned', [item('03'), item('02', { plannedFor: '2026-11-08T17:00:00Z' }), item('01', { plannedFor: '2026-11-06T17:00:00Z' })]);
    expect(r.map((x) => x.id)).toEqual(['01', '02', '03']);
    const v = sortForColumn('review', [item('05', { scheduled: '2026-11-09T17:00:00Z' }), item('04', { plannedFor: '2026-11-10T17:00:00Z' })]);
    expect(v.map((x) => x.id)).toEqual(['05', '04']);
    const p = sortForColumn('posted', [item('01', { posted: '2026-11-01T10:00:00Z' }), item('02', { posted: '2026-11-03T10:00:00Z' })]);
    expect(p.map((x) => x.id)).toEqual(['02', '01']);
    expect(sortForColumn('rejected', [item('01'), item('02')]).map((x) => x.id)).toEqual(['02', '01']);
  });
});

describe('overdue plans', () => {
  const past = new Date(NOW - 3600_000).toISOString();
  const future = new Date(NOW + 3600_000).toISOString();
  it('marks only approved, unscheduled, unposted posts whose planned time has passed', () => {
    expect(isOverdue({ status: 'approved', plannedFor: past }, NOW)).toBe(true);
    expect(isOverdue({ status: 'approved', plannedFor: future }, NOW)).toBe(false);
    expect(isOverdue({ status: 'approved', plannedFor: null }, NOW)).toBe(false);
    expect(isOverdue({ status: 'ready', plannedFor: past }, NOW)).toBe(false);
    expect(isOverdue({ status: 'scheduled', plannedFor: past }, NOW)).toBe(false);
    expect(isOverdue({ status: 'approved', plannedFor: past, scheduled: { scheduled_for: past } }, NOW)).toBe(false);
    expect(isOverdue({ status: 'approved', plannedFor: past, posted: { posted_at: past } }, NOW)).toBe(false);
    expect(OVERDUE_TEXT).toBe('Planned time passed. Post now, schedule, or re-plan.');
  });

  it('offers the planned clock time on the next day it is ahead, and a soonest time, both far enough away', () => {
    // NOW = 13:00 in the test zone on 5 Nov. Planned 12:30 on 5 Nov → 12:30 on 6 Nov; soonest 13:15.
    const planned = '2026-11-05T11:30:00.000Z';
    const t = overdueTimes(planned, NOW);
    expect(t.atPlannedTime).toBe('2026-11-06T11:30:00.000Z');
    expect(t.soonest).toBe('2026-11-05T12:15:00.000Z');
    // Planned 18:00 yesterday → 18:00 today (still ahead).
    expect(overdueTimes('2026-11-04T17:00:00.000Z', NOW).atPlannedTime).toBe('2026-11-05T17:00:00.000Z');
    // Planned 13:05 → 13:05 today is within the lead, so tomorrow.
    expect(overdueTimes('2026-11-04T12:05:00.000Z', NOW).atPlannedTime).toBe('2026-11-06T12:05:00.000Z');
    for (const iso of Object.values(overdueTimes(planned, NOW))) expect(Date.parse(iso!) - NOW).toBeGreaterThanOrEqual(SCHEDULE_LEAD_MS);
  });
});

describe('who may be rejected from the drawer', () => {
  it('allows failed posts with nothing posted and blocks anything sent, scheduled or unreadable', () => {
    expect(canReject({ status: 'failed', outcome: { state: 'failed' }, dispatch: {} })).toBe(true);
    expect(canReject({ status: 'failed', posted: { url: null } })).toBe(false);
    for (const s of ['ready', 'changed', 'approved'] as const) expect(canReject({ status: s })).toBe(true);
    for (const s of ['scheduled', 'sending', 'submitted', 'uncertain', 'posted', 'discarded'] as const) expect(canReject({ status: s })).toBe(false);
    expect(canReject({ status: 'invalid', unreadable: ['plan.json'] })).toBe(true);
    expect(canReject({ status: 'invalid', unreadable: ['posted.json'] })).toBe(false);
    expect(canReject({ status: 'invalid', unreadable: ['plan.json'], scheduled: {} })).toBe(false);
    expect(canReject({ status: 'invalid', dispatch: {}, outcome: { state: 'submitted' } })).toBe(false);
  });

  it('says what happened when a two-step move stopped half way', () => {
    expect(partialText('07', { action: 'approve' }, { action: 'schedule' }, 'Pick a time at least 10 minutes from now to schedule.')).toBe('Post 07 was approved, but not scheduled: Pick a time at least 10 minutes from now to schedule.');
    expect(partialText('07', { action: 'approve' }, { action: 'send' }, '')).toBe('Post 07 was approved, but not posted.');
    expect(partialText('07', { action: 'cancel-schedule' }, { action: 'discard' }, 'x')).toBe('The schedule for post 07 was cancelled, but not rejected: x');
  });
});
