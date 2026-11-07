// Text budgets per tab, measured with a unit word counter: each tab's main view is rendered with a synthetic fixture,
// user content ([data-content]: titles, captions, numbers, handles), hidden panels and closed dialogs are removed,
// and the words of interface copy left are counted (a word holds at least one letter or digit). The counts are
// printed as one table per run so they can be compared over time; a tab over its budget fails with its longest lines.
// jsdom has no layout, so text that only CSS hides would still count; real browsers can only count fewer.
import { render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { CAMPAIGNS_FIXTURE, COMMENTS_FIXTURE, MAKING_FIXTURE, RESULTS_BY_TEMPLATE, SETTINGS_FIXTURE, TEXT_BUDGET, WORKSPACE_FIXTURE, connectionsPayload } from '@/tests/fixtures/plan-setup';
import { Today } from '@/app/studio/Studio';
import { Posts } from '@/app/studio/Posts';
import { Calendar } from '@/app/studio/Calendar';
import { Campaigns } from '@/app/studio/Campaigns';
import { Brand } from '@/app/studio/Brand';
import { Results } from '@/app/studio/Results';
import { Comments } from '@/app/studio/Comments';
import { Memory } from '@/app/studio/Memory';
import { Connections } from '@/app/studio/Connections';
import type { Payload, RealPackage } from '@/app/studio/RealPosts';
import { demoPayload } from '@/lib/studio/memory/demo';

type Tab = keyof typeof TEXT_BUDGET;
const NOW = Date.parse('2026-11-04T10:00:00Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const noop = () => undefined;
const counts: Partial<Record<Tab, number>> = {};

/** The words of interface copy in `root`, and the text runs they came from (for a useful failure message). */
export function uiWords(root: HTMLElement): { count: number; runs: string[] } {
  const c = root.cloneNode(true) as HTMLElement;
  c.querySelectorAll('[data-content], [hidden], [aria-hidden="true"], dialog:not([open]), .visually-hidden, script, style').forEach((n) => n.remove());
  const runs: string[] = [];
  const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const text = (walk.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) runs.push(text);
  }
  const count = runs.join(' ').split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { count, runs };
}

function measure(tab: Tab, root: HTMLElement) {
  const { count, runs } = uiWords(root);
  counts[tab] = count;
  const longest = [...runs].sort((a, b) => b.split(' ').length - a.split(' ').length).slice(0, 10);
  expect(count, `${tab}: ${count} words (budget ${TEXT_BUDGET[tab]}). Longest: ${longest.join(' | ')}`).toBeLessThanOrEqual(TEXT_BUDGET[tab]);
}

const studioRoot = () => {
  const el = document.createElement('div');
  el.className = 'studio';
  document.body.appendChild(el);
  return el;
};
function stubFetch(route: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const out = route(String(input));
      return out === undefined ? Response.json({ error: { message: 'Unknown.' } }, { status: 404 }) : Response.json(out);
    }),
  );
}

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
  } as RealPackage;
}
/** The standard fixture: one project, a few posts in every state, one active campaign. */
function payload(): Payload {
  return {
    account: { destination: '@example.account', maxPosts: 30, posted: 1, open: true, expiresAt: NOW + 20 * 24 * H, maxPerDay: 1 },
    folder: '/tmp/example',
    packages: [
      pkg('01', 'ready', { plannedFor: iso(NOW + 30 * H), campaign: { id: 'c1', name: 'Autumn', slot: 's1' } }),
      pkg('02', 'ready'),
      pkg('03', 'failed', { plannedFor: iso(NOW - 3 * H) }),
      pkg('04', 'approved', { plannedFor: iso(NOW + 50 * H) }),
      pkg('05', 'posted', { metrics: { fetched_at: iso(NOW), metrics: { views: 120, reach: null, likes: null, comments: null, saves: null, shares: null, impressions: null } } }),
    ],
    live: { enabled: false, reason: '' },
    scheduling: { enabled: false, reason: '' },
    analytics: { enabled: true, reason: '', source: 'upload-post' },
    insights: { posts: 1, measured: 1, totals: { views: 120, reach: 100, engagement: 9 }, byFormat: [], bestWeekday: null, bestHour: null, bestTimeReason: 'needs 3 measured posts', bestTimeSample: 1, top: [] },
    project: { id: 'example', name: 'Example', handle: '@example.account', timeZone: 'Europe/Berlin' },
    formats: [{ id: 'codex-post', label: 'Codex image post' }],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  window.localStorage.setItem('signal.studio.project', 'example');
  window.history.replaceState(null, '', '/studio');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
afterAll(() => {
  const rows = (Object.keys(TEXT_BUDGET) as Tab[]).map((tab) => `${tab.padEnd(12)} ${String(counts[tab] ?? 'not run').padStart(7)} / ${TEXT_BUDGET[tab]}`);
  process.stdout.write(`\nText budget (words on the main view / budget):\n${rows.join('\n')}\n`);
});

describe('text budget per tab (unit word counter)', () => {
  it('counts the words a person reads, not user content or hidden panels', () => {
    const el = document.createElement('div');
    el.innerHTML = '<h2>Needs you</h2><p data-content>Example post title with many words</p><span hidden>Hidden text</span><p>Open · Calendar</p>';
    expect(uiWords(el).count).toBe(4);
  });

  it('Today', () => {
    const { container } = render(<Today data={payload()} go={noop} onMake={noop} />, { container: studioRoot() });
    measure('today', container);
  });

  it('Posts', async () => {
    const data = payload();
    stubFetch((url) => (url.startsWith('/api/studio/content?') ? data : url.startsWith('/api/studio/campaigns') ? { campaigns: [], plans: {}, formats: [] } : {}));
    const { container } = render(<Posts say={noop} onMake={noop} />, { container: studioRoot() });
    await screen.findByRole('region', { name: 'To approve' });
    measure('posts', container);
  });

  it('Calendar', async () => {
    const item = (id: string, when: string) => ({ project: 'example', id, title: `Example ${id}`, status: 'approved', format: 'image', when, kind: 'planned', thumb: null, url: null, campaign: null });
    stubFetch((url) =>
      url.startsWith('/api/studio/calendar')
        ? { timezone: 'Europe/Berlin', timeZoneLabel: 'Times in Europe/Berlin', projects: [{ id: 'example', name: 'Example', handle: '@example', timeZone: 'Europe/Berlin' }], items: [item('11', '2026-11-05T17:00:00Z'), item('12', '2026-11-07T09:00:00Z')], unplanned: [], campaigns: [] }
        : {},
    );
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    await screen.findAllByRole('button', { name: /^Example 11,/ });
    measure('calendar', container);
  });

  it('Campaigns', async () => {
    stubFetch((url) => (url.includes('progress=1') ? { progress: null } : url.startsWith('/api/studio/campaigns') ? CAMPAIGNS_FIXTURE : {}));
    const { container } = render(<Campaigns say={noop} openPosts={noop} />, { container: studioRoot() });
    await screen.findByText('Autumn questions');
    measure('campaigns', container);
  });

  it('Brand', async () => {
    const kit = { name: 'Fixture brand', tagline: 'Calm and clear', website: 'https://example.test', colors: { primary: '#3c24c0', background: '#ffffff', text: '#111111', accent: '#02bf7d' }, palette: [], fonts: ['Fixture Sans'], fontFile: null, logo: null, ogImage: null, voice: ['calm'], copy: [], instagram: null, sources: [], updatedAt: '2026-11-03T10:00:00.000Z' };
    stubFetch((url) => (url.startsWith('/api/studio/brand') ? { kit, pack: { lexicon: null }, timeZone: 'Europe/Berlin' } : undefined));
    const { container } = render(<Brand say={noop} onMade={noop} />, { container: studioRoot() });
    await screen.findByText('Fonts');
    measure('brand', container);
  });

  it('Results', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/results') ? RESULTS_BY_TEMPLATE : undefined));
    const { container } = render(<Results data={payload()} reload={async () => undefined} say={noop} />, { container: studioRoot() });
    await screen.findByText('Question card');
    measure('results', container);
  });

  it('Comments', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/instagram') ? COMMENTS_FIXTURE : undefined));
    const { container } = render(<Comments say={noop} onManage={noop} />, { container: studioRoot() });
    await screen.findByText('The second one, easily.');
    measure('comments', container);
  });

  it('Memory', async () => {
    const demo = demoPayload({ id: 'example', name: 'Example', handle: '@example.account', timeZone: 'Europe/Berlin' });
    stubFetch((url) => (url.startsWith('/api/studio/memory') ? demo : undefined));
    const { container } = render(<Memory say={noop} />, { container: studioRoot() });
    await screen.findByText('What Signal learned, and why.');
    measure('memory', container);
  });

  it('Connections (the real Making rows from the fixture, Sources and Features closed)', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/settings') ? SETTINGS_FIXTURE : url.startsWith('/api/studio/workspace') ? WORKSPACE_FIXTURE : url.startsWith('/api/studio/connections') ? connectionsPayload({ making: MAKING_FIXTURE }) : undefined));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    const making = await screen.findByRole('heading', { name: 'Making' });
    expect(within(making.closest('section')!).getAllByRole('listitem')).toHaveLength(7);
    measure('connections', container);
  });
});
