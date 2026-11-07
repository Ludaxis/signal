// The Work group tabs: Today, Posts and Calendar. One test per rule of each tab, plus one filled button per view
// and no banned words on these fixtures. Synthetic data only.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Today, approvalNotice } from '@/app/studio/Studio';
import { Posts, postsViewFromSlug, postsViewParams } from '@/app/studio/Posts';
import { Calendar, clockChangeText } from '@/app/studio/Calendar';
import { GenerateBar, PackageActions, type Payload, type RealPackage } from '@/app/studio/RealPosts';
import { needsYou } from '@/app/studio/posts-rules';
import { setProjectId } from '@/app/studio/Projects';
import { CountBadge } from '@/app/studio/ui';
import { en, format, t } from '@/app/studio/copy/en';
import { STATUS_WORDS } from '@/app/studio/ui/status';
import { TOAST_UNDO_MS } from '@/app/studio/ui/Toast';
import { dstChanges } from '@/lib/time';
import { DEFAULT_TIME_ZONE } from '@/lib/studio/time';

const NOW = Date.parse('2026-11-06T10:00:00Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const BANNED = /\b(package|SHA|fingerprint|runbook|rev|gate|Probabilities|Judge|legacy)\b|\.env|Request failed/i;

function pkg(id: string, status: RealPackage['status'], extra: Partial<RealPackage> = {}): RealPackage {
  return {
    id,
    title: `Example post ${id}`,
    format: 'carousel',
    destination: '@example.account',
    status,
    problems: [],
    caption: 'An example caption.',
    files: [{ name: 'slide-1.png', role: 'slide', sha256: 'a'.repeat(64), ok: true }],
    approval: ['approved', 'scheduled', 'posted', 'failed'].includes(status) ? { approved_by: 'owner', approved_at: iso(NOW - 24 * H) } : null,
    posted: status === 'posted' ? { url: 'https://www.instagram.com/p/EXAMPLE01/', posted_at: iso(NOW - 30 * H) } : null,
    outcome: status === 'failed' ? { state: 'failed', at: iso(NOW - 2 * H), message: 'The provider refused it.' } : null,
    labelConfirmed: status === 'posted',
    plannedFor: null,
    scheduled: null,
    metrics: null,
    dispatch: status === 'failed' ? { request_id: 'r1', provider: 'upload-post' } : null,
    ...extra,
  };
}

/** The Needs you fixture: 2 to approve, 1 failed, 1 approved (ahead), plus a posted and a rejected post. */
function standard(): RealPackage[] {
  return [
    pkg('01', 'ready', { plannedFor: iso(NOW + 30 * H), campaign: { id: 'c1', name: 'Autumn', slot: 's1' } }),
    pkg('02', 'ready'),
    pkg('03', 'failed', { plannedFor: iso(NOW - 3 * H) }),
    pkg('04', 'approved', { plannedFor: iso(NOW + 50 * H), postmaker: { template: 'Story', version: 2 } }),
    pkg('05', 'posted', { metrics: { fetched_at: iso(NOW), metrics: { views: 120, reach: null, likes: null, comments: null, saves: null, shares: null, impressions: null } } }),
    pkg('06', 'discarded'),
  ];
}

function payload(packages: RealPackage[], extra: Partial<Payload> = {}): Payload {
  return {
    account: { destination: '@example.account', maxPosts: 14, posted: 1, open: true, expiresAt: NOW + 10 * 24 * H, maxPerDay: 1 },
    folder: '/tmp/example',
    packages,
    live: { enabled: false, reason: '' },
    scheduling: { enabled: false, reason: '' },
    project: { id: 'example', name: 'Example', handle: '@example.account' },
    ...extra,
  };
}

const studioRoot = () => {
  const el = document.createElement('div');
  el.className = 'studio';
  document.body.appendChild(el);
  return el;
};
/** Rendered text minus user content ([data-content]), as the text budget counts it. */
const uiText = (el: HTMLElement) => {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll('[data-content]').forEach((n) => n.remove());
  return c.textContent ?? '';
};
const primaries = (el: ParentNode) => el.querySelectorAll('.btn-primary, .st-btn-primary').length;

let calls: { url: string; body: unknown }[] = [];
function stubFetch(data: Payload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.startsWith('/api/studio/content?')) return Response.json(data);
      if (url.startsWith('/api/studio/campaigns')) return Response.json({ campaigns: [], plans: {}, formats: [] });
      if (url.startsWith('/api/studio/content/')) {
        const id = url.split('/')[4]!;
        const p = data.packages.find((x) => x.id === id)!;
        return Response.json({ package: { ...p, status: body?.action === 'approve' ? 'approved' : body?.action === 'discard' ? 'discarded' : p.status } });
      }
      return Response.json({});
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  setProjectId('example');
  window.history.replaceState(null, '', '/studio');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const go = vi.fn();
const noop = () => undefined;

describe('Today', () => {
  it('The Needs you count equals the Posts nav badge for the same data (2 to approve + 1 failed = 3)', () => {
    const data = payload(standard());
    render(<Today data={data} go={go} onMake={noop} />);
    const list = screen.getByRole('region', { name: /^Needs you/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const badgeCount = needsYou(data.packages).length;
    expect(badgeCount).toBe(3);
    render(<CountBadge count={badgeCount} label={t('shell.postsBadge', { count: badgeCount })} />);
    expect(screen.getByText('3 need you')).toBeTruthy();
    expect(within(list).getByText('3')).toBeTruthy();
  });

  it('A post whose files changed since approval is one Needs you row asking for a new make', () => {
    const data = payload([pkg('08', 'changed'), pkg('09', 'posted')]);
    render(<Today data={data} go={go} onMake={noop} />);
    const list = screen.getByRole('region', { name: /^Needs you/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Files changed since approval. Make it again.')).toBeTruthy();
    expect(needsYou(data.packages)).toHaveLength(1);
  });

  it('The list shows at most 5 rows, then "See all in Posts"', () => {
    const many = Array.from({ length: 7 }, (_, i) => pkg(String(10 + i), 'ready'));
    render(<Today data={payload(many)} go={go} onMake={noop} />);
    const list = screen.getByRole('region', { name: /^Needs you/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(list).getByRole('button', { name: 'See all in Posts' }));
    expect(go).toHaveBeenCalledWith('posts');
  });

  it('No posting-settings or cap text unless they end within 3 days or 2 posts are left; then one line under 12 words', () => {
    const base = payload(standard()).account;
    expect(approvalNotice(base, NOW)).toBeNull();
    const soon = approvalNotice({ ...base, expiresAt: NOW + 2.5 * 24 * H }, NOW)!;
    expect(soon).toBe('Posting settings end in 2 days.');
    const cap = approvalNotice({ ...base, posted: 12 }, NOW)!;
    expect(cap).toBe('2 posts left in the account limits.');
    for (const line of [soon, cap]) expect(line.split(/\s+/).length).toBeLessThan(12);
    expect(approvalNotice({ ...base, open: false, expiresAt: 0 }, NOW)).toBeNull();
    // Settings with no end date (sent as null) never end.
    expect(approvalNotice({ ...base, expiresAt: null }, NOW)).toBeNull();

    const { container, unmount } = render(<Today data={payload(standard())} go={go} onMake={noop} />);
    expect(container.querySelector('.today-notice')).toBeNull();
    expect(uiText(container)).not.toMatch(/approval|days? left|\/14/i);
    unmount();
    const near = render(<Today data={payload(standard(), { account: { ...base, expiresAt: NOW + 2 * 24 * H } })} go={go} onMake={noop} />);
    const notes = near.container.querySelectorAll('.today-notice');
    expect(notes).toHaveLength(1);
    fireEvent.click(within(notes[0] as HTMLElement).getByRole('button', { name: 'Open Connections' }));
    expect(go).toHaveBeenCalledWith('connections');
  });

  it('At most one filled button; with nothing to do, "Nothing needs you." and the primary "Make a post"', () => {
    const busy = render(<Today data={payload(standard())} go={go} onMake={noop} />);
    expect(primaries(busy.container)).toBeLessThanOrEqual(1);
    busy.unmount();
    const onMake = vi.fn();
    const calm = render(<Today data={payload([pkg('05', 'posted')])} go={go} onMake={onMake} />);
    expect(screen.getByText('Nothing needs you.')).toBeTruthy();
    expect(primaries(calm.container)).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Make a post' }));
    expect(onMake).toHaveBeenCalled();
  });

  it('Dates are en-GB, 24-hour and in the project time zone', () => {
    // 22:30 UTC on Thu 5 Nov is already Fri 6 Nov, 02:00 in Asia/Tehran.
    const p = [pkg('05', 'posted', { posted: { url: null, posted_at: '2026-11-05T22:30:00Z' } }), pkg('07', 'approved', { plannedFor: '2026-11-07T16:45:00Z' })];
    const data = payload(p, { project: { id: 'example', name: 'Example', handle: '@example.account', timeZone: 'Asia/Tehran' } });
    const { container } = render(<Today data={data} go={go} onMake={noop} />);
    expect(container.textContent).toContain('Fri 6 Nov');
    expect(container.textContent).toContain('Sat 7 Nov, 20:15');
    expect(container.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|AM|PM/);
  });

  it('Today has no banned words', () => {
    const { container } = render(<Today data={payload(standard())} go={go} onMake={noop} />);
    expect(uiText(container)).not.toMatch(BANNED);
  });
});

describe('Posts', () => {
  async function renderPosts(data = payload(standard())) {
    stubFetch(data);
    const say = vi.fn();
    const r = render(<Posts say={say} onMake={noop} />, { container: studioRoot() });
    await screen.findByRole('region', { name: 'To approve' });
    return { ...r, say };
  }

  it('Columns are exactly To approve, Approved, Posted, Rejected; no "package", "SHA" or "fingerprint"', async () => {
    const { container } = await renderPosts();
    expect(Array.from(container.querySelectorAll('.pb-col-title')).map((h) => uiText(h as HTMLElement).trim())).toEqual(['To approve', 'Approved', 'Posted', 'Rejected']);
    expect(container.textContent).not.toMatch(/package|\bSHA\b|fingerprint/i);
    // The drawer too.
    fireEvent.click(screen.getByRole('button', { name: 'Open post 01' }));
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    expect(drawer.textContent).not.toMatch(/package|\bSHA\b|fingerprint/i);
    expect(uiText(drawer)).not.toMatch(BANNED);
  });

  it('A file mismatch says "Files changed since approval. Make it again."', async () => {
    await renderPosts(payload([pkg('08', 'changed', { problems: ['slide-1.png changed or is missing since the package was made.'] })]));
    fireEvent.click(screen.getByRole('button', { name: 'Open post 08' }));
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    expect(within(drawer).getByText('Files changed since approval. Make it again.')).toBeTruthy();
    expect(uiText(drawer).replace(/Details[\s\S]*$/, '')).not.toMatch(/package/i);
  });

  it('The Gallery shows status only as dictionary words, with Posted / All', async () => {
    const { container } = await renderPosts();
    fireEvent.click(screen.getByRole('tab', { name: /^Gallery/ }));
    const panel = container.querySelector('#pb-panel-gallery') as HTMLElement;
    expect(within(panel).getAllByRole('button', { name: /^Open post/ })).toHaveLength(1);
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    const cards = within(panel).getAllByRole('button', { name: /^Open post/ });
    expect(cards).toHaveLength(5); // everything except the rejected post
    const pills = Array.from(panel.querySelectorAll('.pill')).map((p) => p.textContent);
    expect(pills.length).toBe(5);
    for (const w of pills) expect(STATUS_WORDS.post as readonly string[]).toContain(w);
    expect(panel.textContent).not.toMatch(/\b(ready|discarded|uncertain|invalid)\b/);
  });

  it('Reject uses the shared Dialog with "Reject post"', async () => {
    await renderPosts();
    fireEvent.click(screen.getByRole('button', { name: 'Open post 02' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByRole('heading', { name: 'Reject post 02?' })).toBeTruthy();
    expect(within(box).getByText('It will not be posted.')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Reject post' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/studio/content/02').map((c) => (c.body as { action: string }).action)).toEqual(['discard']));
  });

  it('Approve needs no confirmation and shows a toast with Undo for 8 s; Undo sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const say = vi.fn();
    const data = payload(standard());
    stubFetch(data);
    render(<PackageActions pkg={data.packages[1]!} live={data.live} scheduling={data.scheduling} say={say} onChange={noop} reload={async () => undefined} />, { container: studioRoot() });
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(say).toHaveBeenCalledWith('Post 02 approved.', { onUndo: expect.any(Function) });
    expect(TOAST_UNDO_MS).toBe(8000);
    await act(async () => {
      vi.advanceTimersByTime(TOAST_UNDO_MS - 100);
    });
    expect(calls.filter((c) => c.url.startsWith('/api/studio/content/02'))).toEqual([]);
    // Undo inside the window: nothing is ever sent.
    const { onUndo } = say.mock.calls[0]![1] as { onUndo: () => void };
    act(() => onUndo());
    await act(async () => {
      vi.advanceTimersByTime(TOAST_UNDO_MS * 2);
    });
    expect(calls.filter((c) => c.url.startsWith('/api/studio/content/02'))).toEqual([]);
    expect(say).toHaveBeenCalledWith('Post 02 not approved.');
  });

  it('Without Undo, the approval is sent once when the 8 s are up', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const say = vi.fn();
    const data = payload(standard());
    stubFetch(data);
    const onChange = vi.fn();
    render(<PackageActions pkg={data.packages[0]!} live={data.live} scheduling={data.scheduling} say={say} onChange={onChange} reload={async () => undefined} />, { container: studioRoot() });
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText('Approving…')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(TOAST_UNDO_MS);
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.url === '/api/studio/content/01').map((c) => c.body)).toEqual([{ action: 'approve', project: 'example' }]));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('Each card says where it came from in one line', async () => {
    const data = payload(standard());
    data.packages[1] = pkg('02', 'ready', { source: { generator: 'signal-template-v1' } });
    data.packages.push(pkg('09', 'ready', { source: null }));
    const { container } = await renderPosts(data);
    const origin = (id: string) => (container.querySelector(`article[aria-label="Post ${id}"] .pb-origin`) as HTMLElement).textContent;
    expect(origin('01')).toBe('Campaign · Autumn');
    expect(origin('04')).toBe('Post maker · Story v2');
    expect(origin('02')).toBe('Made in Signal');
    expect(origin('09')).toBe('Uploaded');
  });

  it('The board and the open drawer each have at most one filled button', async () => {
    const { container } = await renderPosts();
    const main = container.querySelector('.posts-screen') as HTMLElement;
    expect(primaries(main)).toBeLessThanOrEqual(1);
    for (const id of ['01', '03', '04', '05']) {
      fireEvent.click(screen.getByRole('button', { name: `Open post ${id}` }));
      const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
      const visible = Array.from(drawer.querySelectorAll('.btn-primary, .st-btn-primary')).filter((b) => !b.closest('details:not([open])'));
      expect(visible.length, `drawer of post ${id}`).toBeLessThanOrEqual(1);
      fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    }
  });
});

describe('Calendar', () => {
  function calendarFetch(items: unknown[], tz = 'Europe/Berlin', projects?: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const all = url.includes('scope=all');
        if (url.startsWith('/api/studio/calendar'))
          return Response.json({ timezone: all ? 'Europe/Berlin' : tz, timeZoneLabel: `Times in ${all ? 'Europe/Berlin' : tz}`, projects: projects ?? [{ id: 'example', name: 'Example', handle: '@example', timeZone: tz }], items, unplanned: [] });
        return Response.json({ package: {} });
      }),
    );
  }

  it('24-hour HH:MM times and "Times in <project zone>" from the project, not a literal', async () => {
    calendarFetch([{ project: 'example', id: '13', title: 'Example 13', status: 'approved', format: 'image', when: '2026-11-07T14:45:00Z', kind: 'planned', thumb: null, url: null }], 'Asia/Tehran');
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    expect(await screen.findByText('Times in Asia/Tehran')).toBeTruthy();
    const chip = (await screen.findAllByRole('button', { name: /^Example 13, Approved, 18:15$/ }))[0]!;
    expect(container.textContent).not.toMatch(/\b(AM|PM)\b| time ·/);
    fireEvent.click(chip);
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    expect((within(drawer).getByRole('textbox', { name: 'Time' }) as HTMLInputElement).value).toBe('18:15');
    expect((within(drawer).getByRole('combobox', { name: 'Day' }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Sat 7 Nov');
  });

  it('"All accounts" uses the default zone and labels other zones on their own chips', async () => {
    calendarFetch(
      [
        { project: 'east', id: '21', title: 'East 21', status: 'approved', format: 'image', when: '2026-11-07T14:45:00Z', kind: 'planned', thumb: null, url: null },
        { project: 'example', id: '22', title: 'Home 22', status: 'approved', format: 'image', when: '2026-11-07T14:45:00Z', kind: 'planned', thumb: null, url: null },
      ],
      'Asia/Tehran',
      [
        { id: 'example', name: 'Example', handle: '@example', timeZone: DEFAULT_TIME_ZONE },
        { id: 'east', name: 'East', handle: '@east', timeZone: 'Asia/Tehran' },
      ],
    );
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    fireEvent.click(await screen.findByRole('button', { name: 'All accounts' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('scope=all'))).toBe(true));
    expect(await screen.findByText(`Times in ${DEFAULT_TIME_ZONE}`)).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: 'East 21, Approved, 18:15 Asia/Tehran' })).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: 'Home 22, Approved, 15:45' })).length).toBeGreaterThan(0);
  });

  it('The drawer has one filled button, Save; Unplan replaces "Remove from calendar"', async () => {
    calendarFetch([{ project: 'example', id: '14', title: 'Example 14', status: 'ready', format: 'image', when: '2026-11-08T17:00:00Z', kind: 'planned', thumb: null, url: null }]);
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Example 14,/ }))[0]!);
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    const filled = drawer.querySelectorAll('.btn-primary, .st-btn-primary');
    expect(filled).toHaveLength(1);
    expect(filled[0]!.textContent).toBe('Save');
    expect(within(drawer).getByRole('button', { name: 'Unplan' })).toBeTruthy();
    expect(within(drawer).getByText('Planned only. Not scheduled.')).toBeTruthy();
    expect(uiText(drawer)).not.toMatch(BANNED);
    // A wrong time says how to fix it.
    fireEvent.change(within(drawer).getByRole('textbox', { name: 'Time' }), { target: { value: '6pm' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await within(drawer).findByRole('alert')).toHaveProperty('textContent', 'Use HH:MM, for example 18:00.');
  });

  it('In the week of a clock change, one line names the day and the shift', async () => {
    const [c] = dstChanges(['2026-10-25'], 'Europe/Berlin');
    expect(clockChangeText(c!)).toBe('Clocks go back on Sun 25 Oct.');
    const [f] = dstChanges(['2027-03-28'], 'Europe/Berlin');
    expect(clockChangeText(f!)).toBe('Clocks go forward on Sun 28 Mar.');
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
    calendarFetch([]);
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    expect(await screen.findByText('Clocks go back on Sun 25 Oct.')).toBeTruthy();
    expect(container.querySelectorAll('.cal2-dst')).toHaveLength(1);
  });

  it('The Calendar main view has no filled button and no banned words', async () => {
    calendarFetch([{ project: 'example', id: '15', title: 'Example 15', status: 'scheduled', format: 'image', when: '2026-11-08T17:00:00Z', kind: 'planned', thumb: null, url: null }]);
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    await screen.findAllByRole('button', { name: /^Example 15,/ });
    expect(primaries(container)).toBeLessThanOrEqual(1);
    expect(uiText(container)).not.toMatch(BANNED);
  });
});

describe('Fixes after review', () => {
  it('A deferred approval goes to the project it was chosen in, even after a project switch', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const data = payload(standard());
    stubFetch(data);
    const onChange = vi.fn();
    render(<PackageActions pkg={data.packages[0]!} live={data.live} scheduling={data.scheduling} say={vi.fn()} onChange={onChange} reload={async () => undefined} />, { container: studioRoot() });
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    act(() => setProjectId('other'));
    await act(async () => {
      vi.advanceTimersByTime(TOAST_UNDO_MS);
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.url === '/api/studio/content/01').map((c) => c.body)).toEqual([{ action: 'approve', project: 'example' }]));
    // The other project is shown now: its own post 01 is not replaced by the approved one.
    await act(async () => undefined);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('The Posts drawer puts its one primary and Reject in the sticky footer', async () => {
    stubFetch(payload(standard()));
    render(<Posts say={vi.fn()} onMake={noop} />, { container: studioRoot() });
    await screen.findByRole('region', { name: 'To approve' });
    fireEvent.click(screen.getByRole('button', { name: 'Open post 02' }));
    const foot = document.querySelector('dialog.ui-drawer .drawer-foot') as HTMLElement;
    expect(foot).toBeTruthy();
    expect(within(foot.querySelector('.drawer-foot-primary') as HTMLElement).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(foot.querySelector('.drawer-foot-secondary') as HTMLElement).getByRole('button', { name: 'Reject' })).toBeTruthy();
    // The checks stay in the scrolling body.
    expect((document.querySelector('dialog.ui-drawer .drawer-body') as HTMLElement).querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    fireEvent.click(within(document.querySelector('dialog.ui-drawer') as HTMLElement).getByRole('button', { name: 'Close' }));
    // An approved post without one-click posting: "Record as posted" is the footer primary.
    fireEvent.click(screen.getByRole('button', { name: 'Open post 04' }));
    const foot4 = document.querySelector('dialog.ui-drawer .drawer-foot-primary') as HTMLElement;
    expect(within(foot4).getByRole('button', { name: 'Record as posted' })).toBeTruthy();
  });

  it('The Posts unschedule confirm repeats verb and object and dismisses with Cancel', async () => {
    const data = payload([pkg('05', 'scheduled', { approval: { approved_by: 'owner', approved_at: iso(NOW - H) }, scheduled: { job_id: 'j', scheduled_for: iso(NOW + 5 * H), provider: 'signal' } })]);
    stubFetch(data);
    render(<PackageActions pkg={data.packages[0]!} live={data.live} scheduling={data.scheduling} say={vi.fn()} onChange={noop} reload={async () => undefined} />, { container: studioRoot() });
    fireEvent.click(screen.getByRole('button', { name: 'Unschedule' }));
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByRole('heading', { name: 'Unschedule post 05?' })).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Unschedule post' })).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Keep schedule' })).toBeNull();
  });

  it('?view= uses the tab words, and the older column ids still open their view', () => {
    expect(postsViewParams('planned')).toEqual({ view: 'to-approve' });
    expect(postsViewParams('review')).toEqual({ view: 'approved' });
    expect(postsViewParams('board')).toEqual({});
    expect(postsViewFromSlug('to-approve')).toBe('planned');
    expect(postsViewFromSlug('approved')).toBe('review');
    expect(postsViewFromSlug('review')).toBe('review');
    expect(postsViewFromSlug('planned')).toBe('planned');
    expect(postsViewFromSlug('gallery')).toBe('gallery');
    expect(postsViewFromSlug('nonsense')).toBeNull();
  });

  it('Choosing the To approve tab writes ?view=to-approve', async () => {
    stubFetch(payload(standard()));
    render(<Posts say={vi.fn()} onMake={noop} />, { container: studioRoot() });
    await screen.findByRole('region', { name: 'To approve' });
    fireEvent.click(screen.getByRole('tab', { name: /^To approve/ }));
    expect(new URLSearchParams(window.location.search).get('view')).toBe('to-approve');
  });

  it('An unplanned Calendar chip shows no "#12" id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/studio/calendar'))
          return Response.json({ timezone: 'Europe/Berlin', timeZoneLabel: 'Times in Europe/Berlin', projects: [{ id: 'example', name: 'Example', handle: '@example', timeZone: 'Europe/Berlin' }], items: [], unplanned: [{ project: 'example', id: '02', title: 'Example 02', status: 'ready', format: 'image', when: null, kind: 'planned', thumb: null, url: null }] });
        return Response.json({});
      }),
    );
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    await screen.findAllByRole('button', { name: /^Example 02,/ });
    expect(container.textContent).not.toMatch(/#\d/);
  });

  describe('the make drawer form', () => {
    const FORMATS = [
      { id: 'website-card', label: 'Website post' },
      { id: 'codex-post', label: 'Codex image post' },
      { id: 'higgsfield-image', label: 'Paid image' },
    ];

    it('takes the format labels from the server, holds a paid format while it is off, and has one primary "Make it"', async () => {
      // jsdom has no scrollIntoView (the Select scrolls its open list).
      Element.prototype.scrollIntoView = vi.fn();
      const { container } = render(<GenerateBar say={noop} onMade={noop} codex={{ enabled: true, reason: '' }} higgsfield={{ enabled: false, reason: '' }} formats={FORMATS} />, { container: studioRoot() });
      expect(primaries(container)).toBe(1);
      expect(screen.getByRole('button', { name: 'Make it' }).className).toContain('btn-primary');
      fireEvent.click(screen.getByRole('button', { name: /Post format/ }));
      const options = screen.getAllByRole('option');
      expect(options.map((o) => o.querySelector('.st-select-label')?.textContent)).toEqual(['Website post', 'Codex image post', 'Paid image']);
      const paid = options.find((o) => o.textContent?.includes('Paid image'))!;
      expect(paid.getAttribute('aria-disabled')).toBe('true');
      expect(paid.textContent).toContain(t('make.higgsfieldOff'));
    });

    it('No banned words and no game wording, also while a make runs ("Saving the post")', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
      vi.setSystemTime(new Date(NOW));
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
      const { container } = render(<GenerateBar say={noop} onMade={noop} codex={{ enabled: false, reason: '' }} formats={FORMATS} />, { container: studioRoot() });
      expect(uiText(container)).not.toMatch(BANNED);
      fireEvent.click(screen.getByRole('button', { name: 'Make it' }));
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      const text = uiText(container);
      expect(text).toContain('Saving the post');
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/\bgame\b/i);
    });

    it('starts on a format it can make, with the line for that format', () => {
      const { container } = render(<GenerateBar say={noop} onMade={noop} codex={{ enabled: false, reason: '' }} formats={[FORMATS[1]!, FORMATS[0]!]} />, { container: studioRoot() });
      expect(container.textContent).toContain(t('make.intro.website'));
      expect(container.textContent).not.toContain(t('make.intro.brief'));
      expect((screen.getByRole('button', { name: 'Make it' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('Every Work-group line in en.ts is at most 12 words', () => {
    const long: string[] = [];
    for (const [k, v] of Object.entries(en)) {
      if (!/^(today|posts|post|calendar|make)\./.test(k)) continue;
      const names = [...v.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]!);
      // Each plural form, with every placeholder as one word.
      for (const n of [0, 1, 5]) {
        const line = format(v, Object.fromEntries(names.map((x) => [x, n])));
        if (line.split(/\s+/).length > 12) long.push(`${k}: ${line}`);
      }
    }
    expect(long).toEqual([]);
  });
});
