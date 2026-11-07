// Overdue plans in the drawer and the Calendar, the drawer's Check status / Reject gates, the
// Calendar's confirm before a real schedule moves, and the Upload-Post quota and ?connected= texts.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { PackageActions, type Live, type RealPackage } from '@/app/studio/RealPosts';
import type { ConfirmFn } from '@/app/studio/ui/Dialog';
import { Calendar } from '@/app/studio/Calendar';
import { OVERDUE_TEXT } from '@/app/studio/posts-rules';
import { connectedMessage, parseQuota, quotaText } from '@/app/studio/UploadPostPicker';
import { accountDefaults } from '@/app/studio/Projects';
import { TIMEZONE } from '@/lib/time';

const LIVE: Live = { enabled: true, reason: '', provider: 'upload-post' };
const SCHED: Live = { enabled: true, reason: '', provider: 'upload-post' };

function pkg(extra: Partial<RealPackage> = {}): RealPackage {
  return {
    id: '03',
    title: 'Weekly tip',
    format: 'carousel',
    destination: '@signal.demo',
    status: 'approved',
    problems: [],
    caption: 'Caption',
    files: [{ name: 'slide-1.png', role: 'slide', sha256: 'a'.repeat(64), ok: true }],
    approval: { approved_by: 'owner', approved_at: '2026-11-04T10:00:00.000Z' },
    posted: null,
    outcome: null,
    labelConfirmed: false,
    plannedFor: new Date(Date.now() - 2 * 3600_000).toISOString(),
    scheduled: null,
    metrics: null,
    dispatch: null,
    ...extra,
  };
}

let calls: { url: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ package: pkg() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const noop = () => undefined;
const reload = async () => undefined;

describe('drawer: an overdue plan', () => {
  it('says the planned time passed and offers two "Schedule for …" times, one confirm each', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true);
    render(<PackageActions pkg={pkg()} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} confirm={confirm} />);
    expect(screen.getByText(OVERDUE_TEXT)).toBeTruthy();
    const both = screen.getAllByRole('button', { name: /^Schedule for / });
    expect(both).toHaveLength(2);
    fireEvent.click(both[1]!);
    await waitFor(() => expect(calls.map((c) => (c.body as { action: string }).action)).toEqual(['plan', 'schedule']));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({ title: expect.stringMatching(/^Schedule post 03 for .+\?$/), body: 'It goes out then, even if this computer is off.', confirmLabel: 'Schedule post' });
    const planned = Date.parse((calls[0]!.body as { plannedFor: string }).plannedFor);
    expect(planned - Date.now()).toBeGreaterThanOrEqual(14 * 60_000);
  });

  it('schedules nothing when the confirm is answered No', async () => {
    render(<PackageActions pkg={pkg()} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} confirm={async () => false} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Schedule for / })[0]!);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('without scheduling, still shows the state and says how to re-plan', () => {
    render(<PackageActions pkg={pkg()} live={{ enabled: false, reason: 'Publishing is paused.' }} scheduling={{ enabled: false, reason: 'Scheduling is off.' }} say={noop} onChange={noop} reload={reload} />);
    expect(screen.getByText(OVERDUE_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Schedule for/ })).toBeNull();
  });
});

describe('drawer gates', () => {
  it('offers Check status only when there is a send to check', () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const { unmount } = render(<PackageActions pkg={pkg({ status: 'scheduled', scheduled: { job_id: '', scheduled_for: at, provider: 'signal' } })} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} />);
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
    unmount();
    render(<PackageActions pkg={pkg({ status: 'scheduled', scheduled: { job_id: 'j1', scheduled_for: at, provider: 'upload-post' }, dispatch: { request_id: 'r1', provider: 'upload-post' } })} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} />);
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
  });

  it('offers Reject for a failed post with nothing posted', () => {
    render(<PackageActions pkg={pkg({ status: 'failed', dispatch: { request_id: 'r1' }, outcome: { state: 'failed', at: '2026-11-04T10:00:00Z', message: 'Upload-Post rejected the post (HTTP 400): bad' } })} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} />);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});

describe('Calendar', () => {
  // Pin the clock (Date only) to a Wednesday midday so "now + 2 days" always falls inside the viewed week.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  function calendarFetch(items: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.startsWith('/api/studio/calendar')) return Response.json({ timezone: TIMEZONE, projects: [{ id: 'demo', name: 'Demo', handle: '@signal.demo' }], items, unplanned: [] });
        return Response.json({ package: {} });
      }),
    );
  }
  const studioRoot = () => {
    const el = document.createElement('div');
    el.className = 'studio';
    document.body.appendChild(el);
    return el;
  };

  it('marks an approved plan whose time passed', async () => {
    const when = new Date(Date.now() - 3600_000).toISOString();
    calendarFetch([{ project: 'demo', id: '13', title: 'Post 13', status: 'approved', format: 'image', when, kind: 'planned', thumb: null, url: null }]);
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    const chips = await screen.findAllByRole('button', { name: new RegExp(`Post 13, ${OVERDUE_TEXT.replace(/\./g, '\\.')}`) });
    expect(chips[0]!.className).toMatch(/is-overdue/);
    expect(within(chips[0]!).getByText('Approved')).toBeTruthy();
  });

  it('asks before unscheduling a real schedule, labels it "Unschedule", and sends nothing on No', async () => {
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    calendarFetch([{ project: 'demo', id: '05', title: 'Post 05', status: 'scheduled', format: 'image', when, kind: 'planned', thumb: null, url: null }]);
    const say = vi.fn();
    render(<Calendar say={say} onOpenPosts={noop} />, { container: studioRoot() });
    const chip = (await screen.findAllByRole('button', { name: /^Post 05, Scheduled/ }))[0]!;
    fireEvent.click(chip);
    expect(screen.getByText('Scheduled. It goes out at this time.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unplan' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unschedule' }));
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByRole('heading', { name: 'Unschedule post 05?' })).toBeTruthy();
    expect(within(box).getByText(/^It stays approved and planned for /)).toBeTruthy();
    // the dismiss is the plain Cancel, the confirm repeats verb and object.
    fireEvent.click(within(box).getByRole('button', { name: 'Cancel' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.startsWith('/api/studio/content/'))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Unschedule' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unschedule post' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/studio/content/05').map((c) => c.body)).toEqual([{ action: 'plan', project: 'demo', plannedFor: null }]));
    await waitFor(() => expect(say).toHaveBeenCalledWith('Post 05 unscheduled.'));
  });
});

describe('Upload-Post quota and the connect return', () => {
  it('reads uploadPost.quota only when it is well-formed', () => {
    expect(parseQuota(undefined)).toBeNull();
    expect(parseQuota({ used: 3 })).toBeNull();
    expect(parseQuota({ used: 3, limit: 0 })).toBeNull();
    expect(parseQuota({ used: 3, limit: 10, resetsAt: '2026-12-01T00:00:00Z' })).toEqual({ used: 3, limit: 10, resetsAt: '2026-12-01T00:00:00Z' });
    expect(quotaText({ used: 3, limit: 10, resetsAt: '2026-12-01T00:00:00Z' })).toBe('3 of 10 Upload-Post uploads used this month · resets Tue 1 Dec');
    expect(quotaText({ used: 3, limit: 10, resetsAt: null })).toBe('3 of 10 Upload-Post uploads used this month');
  });

  it('checks the profile again after ?connected= and says what it found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ allowed: true, reason: '', profiles: [{ username: 'brand', displayName: null, instagram: { handle: '@signal.demo', name: null, reauth: false } }, { username: 'bare', displayName: null, instagram: null }] })));
    expect(await connectedMessage('brand')).toBe('Upload-Post “brand” is connected to Instagram @signal.demo.');
    expect(await connectedMessage('bare')).toBe('Upload-Post “bare” has no Instagram connected yet. Open Upload-Post in Connections and press Connect Instagram again.');
    expect(await connectedMessage('gone')).toBe('Back from Upload-Post, but “gone” is not on your Upload-Post plan.');
  });
});

describe('Change limits starts from the current settings', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const base = { active: true, ends_at: '2026-11-17T22:59:00Z', max_posts: 20, max_per_day: 2, posting: false, codex_images: true, verified: { at: 'x', instagram: 'signal.demo' } };
  it('keeps the limits, one-click posting, Codex images and the days left', () => {
    expect(accountDefaults(base, now)).toEqual({ days: 12, maxPosts: 20, maxPerDay: 2, posting: false, codexImages: true, confirm: '' });
  });
  it('keeps "no end" as 0 days, and an ended period starts from 0 days too', () => {
    expect(accountDefaults({ ...base, ends_at: null }, now).days).toBe(0);
    expect(accountDefaults({ ...base, active: false, ends_at: '2026-11-01T00:00:00Z' }, now).days).toBe(0);
  });
  it('clamps out-of-range limits and starts a new project from the defaults', () => {
    expect(accountDefaults({ ...base, max_posts: 5000, max_per_day: 9, posting: true }, now)).toMatchObject({ maxPosts: 1000, maxPerDay: 5, posting: true });
    expect(accountDefaults(null, now)).toEqual({ days: 0, maxPosts: 30, maxPerDay: 1, posting: false, codexImages: false, confirm: '' });
  });
});

describe('drawer confirms have one question as the title', () => {
  it('asks "Send post 03 …now?" with one consequence line, then sends once', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true);
    render(<PackageActions pkg={pkg({ plannedFor: null, destination: '@example.account' })} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} confirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post now' }));
    await waitFor(() => expect(calls.map((c) => (c.body as { action: string }).action)).toEqual(['send']));
    expect(confirm.mock.calls[0]![0]).toEqual({
      title: 'Post 03 to @example.account now?',
      body: 'It goes out once and cannot be undone here.',
      confirmLabel: 'Post now',
    });
  });

  it('marks an unclear post as not posted with a one-question title and no "package"', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true);
    render(<PackageActions pkg={pkg({ status: 'uncertain', dispatch: { request_id: 'r1', provider: 'upload-post' } })} live={LIVE} scheduling={SCHED} say={noop} onChange={noop} reload={reload} confirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'It is not posted' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const req = confirm.mock.calls[0]![0] as { title: string; body: string };
    expect(req.title).toBe('Mark post 03 as not posted?');
    expect(`${req.title} ${req.body}`).not.toMatch(/package/i);
    expect(req.title.split('?').length).toBe(2);
  });
});
