import { describe, expect, it } from 'vitest';
import { COLUMNS, columnOf, planMove, sortForColumn, type MovablePost, type PostStatus } from '@/app/studio/posts-rules';

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

  it('refuses moving posts that are on their way, failed posts to Posted or Rejected, and anything backwards', () => {
    for (const s of ['sending', 'submitted', 'uncertain'] as const) {
      expect(planMove('review', 'posted', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/on its way/) });
      expect(planMove('review', 'rejected', post(s), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
    }
    expect(planMove('review', 'posted', post('failed'), LIVE, NOW)).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/Check status/) });
    expect(planMove('review', 'rejected', post('failed'), LIVE, NOW)).toMatchObject({ kind: 'refuse' });
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
