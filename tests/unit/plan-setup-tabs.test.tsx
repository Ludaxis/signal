// The Plan, Learn and Setup tabs: Campaigns, Results, Comments, Brand, Memory and Connections (the 7 Making capability
// rows, the Features group with the eight Post maker switches, the deep link), plus one filled button per view and
// no banned words on each fixture. Computed styles (comment direction, the Persian font) need a real browser and are
// not checked here.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { BANNED, CAMPAIGNS_FIXTURE, COMMENTS_FIXTURE, CONNECTIONS_BANNED, ELEVENLABS_ON_NO_KEY, MAKING_FIXTURE, RESULTS_BY_TEMPLATE, SETTINGS_FIXTURE, WORKSPACE_FIXTURE, connectionsPayload } from '@/tests/fixtures/plan-setup';
import { CAMPAIGN_STATUS, CampaignCard, Campaigns, PLAN_PREVIEW, SUMMARY_LINES, type ListPayload } from '@/app/studio/Campaigns';
import { Results } from '@/app/studio/Results';
import { Comments } from '@/app/studio/Comments';
import { Brand, PERSIAN_FACE, DISPLAY_FACE } from '@/app/studio/Brand';
import { CHOICE_COLUMNS, Memory } from '@/app/studio/Memory';
import { Connections } from '@/app/studio/Connections';
import { CAPABILITY_ROWS, POSTMAKER_FEATURES, STATE_LINE_WORDS, capabilityGroups, fallbackMaking, hasSwitch, parseMaking, rowView, statePhrase } from '@/app/studio/connections-making';
import { detectLang } from '@/app/studio/content-lang';
import { STATUS_WORDS } from '@/app/studio/ui';
import { FORMAT_LABEL } from '@/lib/studio/formats';
import { demoPayload } from '@/lib/studio/memory/demo';
import type { Payload } from '@/app/studio/RealPosts';

type Route = (url: string, init?: RequestInit) => unknown | Response | undefined;
let calls: { url: string; body: unknown }[] = [];
function stubFetch(route: Route) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const out = route(url, init);
      if (out instanceof Response) return out;
      if (out === undefined) return Response.json({ error: { message: 'Unknown action.' } }, { status: 400 });
      return Response.json(out);
    }),
  );
}
const studioRoot = () => {
  const el = document.createElement('div');
  el.className = 'studio';
  document.body.appendChild(el);
  return el;
};
const primaries = (el: ParentNode) => el.querySelectorAll('.btn-primary, .st-btn-primary').length;
const noop = () => undefined;

beforeEach(() => {
  calls = [];
  window.localStorage.setItem('signal.studio.project', 'fixture');
  window.history.replaceState(null, '', '/studio');
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---- Campaigns ------------------------------------------------------------------------------------------------
describe('Campaigns', () => {
  const data = CAMPAIGNS_FIXTURE as unknown as ListPayload;
  const running = data.campaigns[0]!;
  const renderCard = () => {
    stubFetch((url) => (url.includes('progress=1') ? { progress: null } : { ok: true }));
    return render(<CampaignCard c={running} plan={data.plans[running.id]!} data={data} say={noop} onChange={async () => undefined} openPosts={noop} />, { container: studioRoot() });
  };

  it('A card shows at most 3 summary lines and 5 slots without being expanded', () => {
    const { container } = renderCard();
    expect(SUMMARY_LINES).toBe(3);
    expect(PLAN_PREVIEW).toBe(5);
    expect(container.querySelectorAll('.camp-line').length).toBeLessThanOrEqual(3);
    expect(data.plans[running.id]!.slots.length).toBe(7);
    expect(container.querySelectorAll('[data-slot]').length).toBe(5);
    expect(screen.getByRole('button', { name: 'Show all 7' })).toBeTruthy();
  });

  it('End campaign opens the shared Dialog, never window.confirm, and the confirm reads "End campaign"', async () => {
    const native = vi.spyOn(window, 'confirm');
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'End campaign' }));
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByText('End campaign Autumn questions?')).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'End campaign' })).toBeTruthy();
    expect(native).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole('button', { name: 'End campaign' }));
    await waitFor(() => expect(calls.some((c) => (c.body as { patch?: { status?: string } } | null)?.patch?.status === 'done')).toBe(true));
  });

  it('Status words are only Draft, Running, Paused or Ended', async () => {
    expect(Object.values(CAMPAIGN_STATUS).sort()).toEqual([...STATUS_WORDS.campaign].sort());
    stubFetch((url) => (url.includes('progress=1') ? { progress: null } : url.startsWith('/api/studio/campaigns') ? CAMPAIGNS_FIXTURE : { ok: true }));
    const { container } = render(<Campaigns say={noop} openPosts={noop} />, { container: studioRoot() });
    await screen.findByText('Autumn questions');
    const pills = Array.from(container.querySelectorAll('.pill-status')).map((p) => p.textContent);
    expect(pills).toEqual(['Running', 'Ended']);
    expect(container.textContent).not.toMatch(/Finished|Finish\b/);
  });

  it('a slot shows its time and hook, with Make and Skip; no template line until Post maker templates exist here', () => {
    const { container } = renderCard();
    const slots = Array.from(container.querySelectorAll<HTMLElement>('[data-slot]'));
    expect(within(slots[0]!).getByText('Fixture hook 1')).toBeTruthy();
    for (const s of slots) {
      expect(within(s).getByRole('button', { name: 'Make' })).toBeTruthy();
      expect(within(s).getByRole('button', { name: 'Skip' })).toBeTruthy();
      expect(within(s).queryByText('No template')).toBeNull();
    }
  });

  it('empty: New campaign sits inside the empty notice and is the one primary', async () => {
    stubFetch((url) => (url.includes('progress=1') ? { progress: null } : url.startsWith('/api/studio/campaigns') ? { ...CAMPAIGNS_FIXTURE, campaigns: [], plans: {} } : { ok: true }));
    const { container } = render(<Campaigns say={noop} openPosts={noop} />, { container: studioRoot() });
    const notice = await waitFor(() => {
      const n = container.querySelector<HTMLElement>('.notice-empty');
      expect(n).toBeTruthy();
      return n!;
    });
    expect(within(notice).getByRole('button', { name: 'New campaign' }).className).toMatch(/btn-primary/);
    expect(primaries(container)).toBe(1);
  });

  it('One primary on the tab and in the Strategy drawer; no banned words', async () => {
    stubFetch((url) => (url.includes('progress=1') ? { progress: null } : url.startsWith('/api/studio/campaigns') ? CAMPAIGNS_FIXTURE : { ok: true }));
    const { container } = render(<Campaigns say={noop} openPosts={noop} />, { container: studioRoot() });
    await screen.findByText('Autumn questions');
    expect(primaries(container)).toBe(1);
    expect(container.textContent).not.toMatch(BANNED);
    fireEvent.click(screen.getAllByRole('button', { name: 'Strategy' })[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Strategy' });
    expect(primaries(drawer)).toBeLessThanOrEqual(1);
  });
});

// ---- Results --------------------------------------------------------------------------------------------------
function resultsPayload(measured: number): Payload {
  const metrics = { views: 900, reach: 700, likes: 40, comments: 3, saves: 9, shares: 1 };
  return {
    account: { destination: '@fixture.account', maxPosts: 0, posted: 0, open: false, expiresAt: 0, maxPerDay: 0 },
    folder: '~/x',
    packages: measured
      ? ([{ id: '07', title: 'Fixture post', format: 'carousel', destination: '@fixture.account', status: 'posted', problems: [], caption: '', files: [], approval: null, posted: { posted_at: '2026-11-02T18:00:00.000Z', url: 'https://example.test/p/07' }, outcome: null, labelConfirmed: true, plannedFor: null, scheduled: null, metrics: { metrics, fetched_at: '2026-11-03T08:00:00.000Z' }, dispatch: null }] as unknown as Payload['packages'])
      : [],
    live: { enabled: false, reason: '' },
    analytics: { enabled: true, reason: '', source: 'upload-post' },
    insights: { posts: measured, measured, totals: { views: 900, reach: 700, engagement: 53 }, byFormat: measured ? [{ format: 'codex-post', posts: 1, avgViews: 900, avgRate: 0.07 }] : [], bestWeekday: null, bestHour: null, bestTimeReason: 'needs 3 measured posts', bestTimeSample: 0, top: [] },
    project: { id: 'fixture', name: 'Fixture project', handle: '@fixture.account', timeZone: 'Asia/Tehran' },
  };
}

describe('Results', () => {
  it('names come from template records; no core format label appears', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/results') ? RESULTS_BY_TEMPLATE : undefined));
    const { container } = render(<Results data={resultsPayload(1)} reload={async () => undefined} say={noop} />, { container: studioRoot() });
    await screen.findByText('Question card');
    expect(screen.getByText('No template')).toBeTruthy();
    for (const label of Object.values(FORMAT_LABEL)) expect(container.textContent, label).not.toContain(label);
    expect(screen.getByRole('heading', { name: 'By template' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/by format/i);
  });

  it('the empty state is at most 12 words plus one disclosure', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/results') ? { byTemplate: [] } : undefined));
    const { container } = render(<Results data={resultsPayload(0)} reload={async () => undefined} say={noop} />, { container: studioRoot() });
    const empty = container.querySelector<HTMLElement>('.res-empty')!;
    expect(empty).toBeTruthy();
    const line = empty.querySelector('.notice-title')!.textContent!;
    expect(line).toBe('No numbers yet. They arrive a few hours after posting.');
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(within(empty).getAllByRole('button')).toHaveLength(1);
    expect(within(empty).getByRole('button', { name: 'How this works' }).getAttribute('aria-expanded')).toBe('false');
    expect(primaries(container)).toBe(0);
    expect(container.textContent).not.toMatch(BANNED);
  });
});

// ---- Comments -------------------------------------------------------------------------------------------------
describe('Comments', () => {
  it('a Persian comment carries lang="fa" and dir="auto", and the reply box takes dir="auto"', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/instagram') ? COMMENTS_FIXTURE : undefined));
    const { container } = render(<Comments say={noop} onManage={noop} />, { container: studioRoot() });
    const fa = await screen.findByText('این خیلی قشنگه، کی دوباره می‌ذارین؟');
    expect(fa.getAttribute('lang')).toBe('fa');
    expect(fa.getAttribute('dir')).toBe('auto');
    expect(screen.getByText('The second one, easily.').getAttribute('lang')).toBe('en');
    const replies = screen.getAllByPlaceholderText('Write a reply');
    expect(replies).toHaveLength(2);
    for (const r of replies) expect(r.getAttribute('dir')).toBe('auto');
    expect(replies[0]!.getAttribute('lang')).toBe('fa');
    expect(primaries(container)).toBe(0);
    expect(container.textContent).not.toMatch(BANNED);
  });

  it('Delete uses the shared Dialog', async () => {
    const native = vi.spyOn(window, 'confirm');
    stubFetch((url) => (url.startsWith('/api/studio/instagram') ? COMMENTS_FIXTURE : undefined));
    render(<Comments say={noop} onManage={noop} />, { container: studioRoot() });
    await screen.findByText('The second one, easily.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByText('Delete the comment by @reader.one?')).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Delete comment' })).toBeTruthy();
    expect(native).not.toHaveBeenCalled();
  });

  it('detectLang reads the script', () => {
    expect(detectLang('سلام، چطوری؟')).toBe('fa');
    expect(detectLang('مرحبا كيف حالك')).toBe('ar');
    expect(detectLang('Hello there')).toBe('en');
    expect(detectLang('123 !!')).toBeUndefined();
    expect(detectLang('')).toBeUndefined();
  });
});

// ---- Brand ----------------------------------------------------------------------------------------------------
describe('Brand', () => {
  const kit = { name: 'Fixture brand', tagline: 'Calm and clear', website: 'https://example.test', colors: { primary: '#3c24c0', background: '#ffffff', text: '#111111', accent: '#02bf7d' }, palette: [], fonts: ['Fixture Sans'], fontFile: null, logo: null, ogImage: null, voice: ['calm'], copy: [], instagram: null, sources: [], updatedAt: '2026-11-05T10:00:00.000Z' };

  it('a Persian font row renders Vazirmatn content in a lang="fa" block, plus Latin and Display rows', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/brand') ? { kit, pack: { lexicon: { count: 3 } }, timeZone: 'Europe/Berlin' } : undefined));
    const { container } = render(<Brand say={noop} onMade={noop} />, { container: studioRoot() });
    await screen.findByText('Fonts');
    const persian = container.querySelector('[data-font-row="persian"]')!;
    expect(persian.textContent).toContain(PERSIAN_FACE);
    const block = persian.querySelector('[lang="fa"]')!;
    expect(block.getAttribute('dir')).toBe('rtl');
    expect(block.className).toMatch(/\bfa\b/);
    expect(container.querySelector('[data-font-row="display"] [lang="fa"].fa-display')).toBeTruthy();
    expect(container.querySelector('[data-font-row="display"]')!.textContent).toContain(DISPLAY_FACE);
    expect(container.querySelector('[data-font-row="latin"]')!.textContent).toContain('Fixture Sans');
    // Voice per language: English words and the Persian register chips; the pack's list link.
    expect(screen.getByRole('button', { name: 'Colloquial' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Formal' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Pronunciation list · 3 words/ })).toBeTruthy();
    expect(screen.getByText('Import from a website or a folder.')).toBeTruthy();
    expect(primaries(container)).toBe(1);
    expect(container.textContent).not.toMatch(BANNED);
  });

  it('saves the Persian register with the brand', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/brand') ? { kit, pack: { lexicon: null } } : undefined));
    render(<Brand say={noop} onMade={noop} />, { container: studioRoot() });
    fireEvent.click(await screen.findByRole('button', { name: 'Formal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save brand' }));
    await waitFor(() => expect(calls.some((c) => (c.body as { patch?: { faRegister?: string } } | null)?.patch?.faRegister === 'formal')).toBe(true));
    expect(screen.queryByRole('button', { name: /Pronunciation list/ })).toBeNull();
  });

  it('no text names a game and the core passes no isGame prop', async () => {
    stubFetch((url) => (url.startsWith('/api/studio/brand') ? { kit, pack: { lexicon: null } } : undefined));
    const { container } = render(<Brand say={noop} onMade={noop} />, { container: studioRoot() });
    await screen.findByText('Fonts');
    expect(container.textContent).not.toMatch(/\bgames?\b/i);
    const studio = path.join(__dirname, '..', '..', 'app', 'studio');
    for (const f of ['Brand.tsx', 'Studio.tsx']) expect(readFileSync(path.join(studio, f), 'utf8')).not.toMatch(/isGame/);
  });
});

// ---- Memory ---------------------------------------------------------------------------------------------------
describe('Memory', () => {
  it('no visible column header reads Probabilities, Via, Route or Judge; Choices and Agent runs replace the old names', async () => {
    const demo = demoPayload({ id: 'fixture', name: 'Fixture project', handle: '@fixture.account', timeZone: 'Asia/Tehran' });
    stubFetch((url) => (url.startsWith('/api/studio/memory') ? demo : undefined));
    const { container } = render(<Memory say={noop} />, { container: studioRoot() });
    expect(await screen.findByText('What Signal learned, and why.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Agent runs/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /^Decisions/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Choices' }));
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent ?? '');
    expect(headers).toEqual([...CHOICE_COLUMNS]);
    for (const h of headers) expect(h).not.toMatch(/Probabilities|Via|Route|Judge/);
    // Route counts and model cost sit behind Details (hidden until opened).
    const visible = container.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('[hidden]').forEach((n) => n.remove());
    expect(visible.textContent).not.toMatch(/By route|Judge cost|Probabilities/);
    expect(primaries(container)).toBe(0);
  });

  it('shows the fixed example-data banner while example data is on', async () => {
    const demo = demoPayload({ id: 'fixture', name: 'Fixture project', handle: '@fixture.account' });
    stubFetch((url) => (url.startsWith('/api/studio/memory') ? (url.includes('demo=1') ? demo : { ...demo, enabled: false, reason: 'Memory is off.', graph: { ...demo.graph, nodes: [] } }) : undefined));
    const { container } = render(<Memory say={noop} />, { container: studioRoot() });
    fireEvent.click(await screen.findByRole('button', { name: 'Show example data' }));
    expect(await screen.findByText('Example data. Not your project.')).toBeTruthy();
    expect(container.textContent).not.toMatch(BANNED);
  });
});

// ---- Connections ----------------------------------------------------------------------------------------------
function connectionsRoute(opts: { making?: unknown; switchAnswer?: unknown } = {}): Route {
  return (url, init) => {
    if (url.startsWith('/api/studio/settings')) return SETTINGS_FIXTURE;
    if (url.startsWith('/api/studio/workspace')) return WORKSPACE_FIXTURE;
    if (url.startsWith('/api/studio/connections')) {
      if (init?.method === 'POST') return opts.switchAnswer;
      return connectionsPayload(opts.making === undefined ? {} : { making: opts.making });
    }
    return undefined;
  };
}
const lineOf = (li: HTMLElement) => li.querySelector('.row-line')?.textContent ?? '';

describe('Connections', () => {
  it('shows one Making row per capability, each carrying its primary connector, each state line at most 6 words', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    const making = Array.from(container.querySelectorAll<HTMLElement>('[aria-labelledby="cx-make"] li'));
    expect(making.map((li) => li.dataset.service)).toEqual(['voice', 'lipsync', 'music', 'video', 'images', 'agents', 'rendering']);
    expect(making.map((li) => li.querySelector('.cx-row-name')!.textContent)).toEqual(['Voice', 'Lip-sync', 'Music', 'Video', 'Images', 'Agents', 'Rendering']);
    for (const li of making) expect(lineOf(li).split(/\s+/).filter(Boolean).length, li.dataset.service).toBeLessThanOrEqual(6);
    // The line names the primary connector and its state; the alternatives are not on the main view.
    expect(lineOf(making[0]!)).toBe('ElevenLabs · Runs as mock');
    expect(lineOf(making[2]!)).toBe('Pack music · Runs as mock');
    expect(lineOf(making[6]!)).toBe('Remotion renderer · Not checked yet');
    expect(container.querySelector('[aria-labelledby="cx-make"]')!.textContent).not.toMatch(/Azure|Hedra|Suno|ffmpeg/);
    // The local renderer has no switch (rendering is a capability row).
    expect(container.querySelector('[data-service="rendering"] [role="switch"]')).toBeNull();
    expect(container.querySelector('[aria-labelledby="cx-mac"]')).toBeNull();
    expect(screen.queryByText(/Coming next/)).toBeNull();
    expect(screen.getByRole('heading', { name: /steps to start posting/ })).toBeTruthy();
    expect(screen.getByText('Posting switch')).toBeTruthy();
  });

  it('at most one filled button on the whole screen, the ready card next step', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    const filled = container.querySelectorAll('.btn-primary, .st-btn-primary');
    expect(filled.length).toBe(1);
    expect(filled[0]!.closest('.cx-ready')).toBeTruthy();
  });

  it('a row whose primary has a switch shows it, off by default, with a state line; on with no key reads "Key missing" in amber', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE, switchAnswer: ELEVENLABS_ON_NO_KEY }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    const primaries = new Map(capabilityGroups(parseMaking(MAKING_FIXTURE)!).map((g) => [g.id, g.primary.id]));
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[aria-labelledby="cx-make"] li'));
    for (const li of rows) {
      const sw = li.querySelector('[role="switch"]')!;
      // A primary on the shared Post maker switch (Figma, the renderer) has no switch of its own.
      if (!hasSwitch(primaries.get(li.dataset.service!)!)) {
        expect(sw, li.dataset.service).toBeNull();
        continue;
      }
      expect(sw, li.dataset.service).toBeTruthy();
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(lineOf(li)).not.toBe('');
    }
    const voice = container.querySelector<HTMLElement>('[data-service="voice"]')!;
    expect(within(voice).getByRole('switch').getAttribute('aria-label')).toBe('ElevenLabs switch');
    await act(async () => {
      fireEvent.click(within(voice).getByRole('switch'));
    });
    await waitFor(() => expect(lineOf(container.querySelector<HTMLElement>('[data-service="voice"]')!)).toBe('ElevenLabs · Key missing'));
    const line = container.querySelector('[data-service="voice"] .row-line .cx-line-amber')!;
    expect(line.textContent).toBe('Key missing');
    expect(line.className).not.toMatch(/error|danger/);
    expect(container.querySelector('[data-service="voice"] .pill-status')!.className).toContain('pill-needs-you');
    expect(calls.find((c) => (c.body as { action?: string } | null)?.action === 'connector.switch')!.body).toMatchObject({ id: 'elevenlabs', on: true });
  });

  it('no visible string contains .env, runbook, dev host, legacy or review calls; no banned words', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    expect(container.textContent).not.toMatch(CONNECTIONS_BANNED);
    expect(container.textContent).not.toMatch(BANNED);
    // Inside the Upload-Post drawer too (its key field is set outside the app in the fixture).
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-service="upload-post"]')!).getByRole('button', { name: 'Set up' }));
    const drawer = await screen.findByRole('dialog', { name: 'Upload-Post' });
    expect(drawer.textContent).not.toMatch(CONNECTIONS_BANNED);
    expect(primaries(drawer)).toBeLessThanOrEqual(1);
  });

  it('without a making field, shows the 7 capability rows as Off or Not set up', async () => {
    stubFetch(connectionsRoute());
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    const rows = container.querySelectorAll<HTMLElement>('[aria-labelledby="cx-make"] li');
    expect(rows.length).toBe(7);
    for (const li of rows) expect(['Off', 'Not set up']).toContain(li.querySelector('.pill-status')!.textContent);
  });

  it('?tab=connections&service=<id> opens the capability drawer holding that connector, primary first', async () => {
    window.history.replaceState(null, '', '/studio?tab=connections&service=hedra');
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    const drawer = await screen.findByRole('dialog', { name: 'Lip-sync' });
    const blocks = Array.from(drawer.querySelectorAll<HTMLElement>('[data-connector]')).map((b) => b.dataset.connector);
    expect(blocks).toEqual(['sync', 'hedra']);
    const hedra = within(drawer).getByRole('region', { name: 'Hedra' });
    expect(within(hedra).getByText('While it is off, steps run as mock.')).toBeTruthy();
    // The alternatives' switches sit in the drawer.
    expect(within(drawer).getByRole('switch', { name: 'Sync switch' })).toBeTruthy();
    expect(within(drawer).getByRole('switch', { name: 'Hedra switch' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=connections'));
  });

  it('a row name opens its capability drawer with the alternatives and their switches', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-service="music"]')!).getByRole('button', { name: 'Music' }));
    const drawer = await screen.findByRole('dialog', { name: 'Music' });
    expect(Array.from(drawer.querySelectorAll<HTMLElement>('[data-connector]')).map((b) => b.dataset.connector)).toEqual(['pack-music', 'owner-upload', 'elevenlabs-music', 'browser-agent:suno']);
    // Suno stays not allowed: no switch, the notice instead.
    const suno = within(drawer).getByRole('region', { name: 'Suno' });
    expect(within(suno).queryByRole('switch')).toBeNull();
    expect(within(suno).getByText('Not allowed yet.')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe('?tab=connections&service=music'));
  });

  it('a Making drawer runs the connector\'s free check (connector.test)', async () => {
    window.history.replaceState(null, '', '/studio?tab=connections&service=hedra');
    const said: string[] = [];
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE, switchAnswer: { ok: true, message: 'Key saved. Not tested.', row: MAKING_FIXTURE.find((r) => r.id === 'hedra') } }));
    render(<Connections say={(m) => said.push(m)} openBrand={noop} />, { container: studioRoot() });
    const drawer = await screen.findByRole('dialog', { name: 'Lip-sync' });
    const hedra = within(drawer).getByRole('region', { name: 'Hedra' });
    expect(within(hedra).getByRole('switch')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(hedra).getByRole('button', { name: 'Check' }));
    });
    expect(calls.find((c) => (c.body as { action?: string } | null)?.action === 'connector.test')!.body).toMatchObject({ id: 'hedra' });
    await waitFor(() => expect(said).toContain('Hedra: Key saved. Not tested.'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=connections'));
  });

  it('Sources and Features sit behind one closed disclosure labelled with their row count', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    // 2 sources + the Post maker switch + its 7 paid services + Autopilot.
    const more = screen.getByRole('button', { name: 'Sources and features (11)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector('[aria-labelledby="cx-src"]')).toBeTruthy();
    expect(panel.querySelector('[data-service="autopilot"]')).toBeTruthy();
    expect(container.querySelectorAll('[aria-labelledby="cx-src"] li, [aria-labelledby="cx-feat"] li')).toHaveLength(11);
    // The other signal.config.json switches stay reachable below; the Post maker ones are not listed twice.
    fireEvent.click(more);
    expect(panel.hidden).toBe(false);
    expect(within(panel).getByRole('heading', { name: 'More switches' })).toBeTruthy();
  });

  it('the Features group lists the eight Post maker switches from the fixture, all off, each state line at most 6 words', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[aria-labelledby="cx-feat"] li')).filter((li) => li.dataset.service !== 'autopilot');
    expect(rows.map((li) => li.dataset.service)).toEqual(['postmaker', 'elevenlabs', 'azure-speech', 'sync', 'hedra', 'higgsfield-video', 'elevenlabs-music', 'browser-agent:suno']);
    expect(rows).toHaveLength(POSTMAKER_FEATURES.length);
    for (const li of rows) {
      expect(['Off', 'Not set up']).toContain(li.querySelector('.pill-status')!.textContent);
      const sw = li.querySelector('[role="switch"]');
      if (sw) expect(sw.getAttribute('aria-checked'), li.dataset.service).toBe('false');
      const line = lineOf(li);
      expect(line, li.dataset.service).not.toBe('');
      expect(line.split(/\s+/).filter(Boolean).length, `${li.dataset.service}: ${line}`).toBeLessThanOrEqual(STATE_LINE_WORDS);
    }
    // Suno is blocked: its switch cannot be turned on.
    expect((container.querySelector('[data-service="browser-agent:suno"] [role="switch"]') as HTMLButtonElement).disabled).toBe(true);
    const pm = rows[0]!;
    expect(pm.textContent).toContain('Off. Turn on to make posts.');
    expect(pm.textContent).not.toMatch(/SIGNAL_|\.env/);
    // The More switches list below does not repeat them.
    const others = Array.from(container.querySelectorAll('.cx-features [role="switch"]')).map((x) => x.getAttribute('aria-label'));
    expect(others.some((l) => /Post maker|ElevenLabs|Azure|Sync lip|Hedra|Browser agent/.test(l ?? ''))).toBe(false);
  });

  it('the Post maker switch saves through the settings feature action', async () => {
    stubFetch(connectionsRoute({ making: MAKING_FIXTURE }));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    fireEvent.click(screen.getByRole('button', { name: /^Sources and features/ }));
    const sw = within(container.querySelector<HTMLElement>('[data-service="postmaker"]')!).getByRole('switch', { name: 'Post maker' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(calls.find((c) => c.url.startsWith('/api/studio/settings') && c.body)?.body).toEqual({ action: 'feature', id: 'postmaker', on: true }));
  });

  it('turning a paid service on asks once to accept its terms, then sends the switch with acceptTerms', async () => {
    let n = 0;
    const route = connectionsRoute({ making: MAKING_FIXTURE });
    stubFetch((url, init) => {
      if (url.startsWith('/api/studio/connections') && init?.method === 'POST') {
        n++;
        const body = JSON.parse(String(init.body)) as { acceptTerms?: boolean };
        if (!body.acceptTerms) return Response.json({ error: { code: 'terms-needed', message: 'Turning on Sync means you accept its terms.' } }, { status: 409 });
        return { ok: true, row: { ...MAKING_FIXTURE.find((r) => r.id === 'sync')!, switchOn: true, status: { state: 'needs-key', line: 'Key missing', fix: 'connections' } } };
      }
      return route(url, init);
    });
    const native = vi.spyOn(window, 'confirm');
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    await act(async () => {
      fireEvent.click(within(container.querySelector<HTMLElement>('[data-service="lipsync"]')!).getByRole('switch'));
    });
    const box = await screen.findByRole('alertdialog');
    expect(within(box).getByText('Accept Sync terms?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Accept and turn on' }));
    });
    await waitFor(() => expect(n).toBe(2));
    const sent = calls.filter((c) => (c.body as { action?: string } | null)?.action === 'connector.switch').map((c) => c.body);
    expect(sent).toEqual([
      { project: 'fixture', action: 'connector.switch', id: 'sync', on: true },
      { project: 'fixture', action: 'connector.switch', id: 'sync', on: true, acceptTerms: true },
    ]);
    await waitFor(() => expect(lineOf(container.querySelector<HTMLElement>('[data-service="lipsync"]')!)).toBe('Sync · Key missing'));
    expect(native).not.toHaveBeenCalled();
  });

  it('declining the terms sends nothing more and leaves the switch off', async () => {
    const route = connectionsRoute({ making: MAKING_FIXTURE });
    stubFetch((url, init) => (url.startsWith('/api/studio/connections') && init?.method === 'POST' ? Response.json({ error: { code: 'terms-needed', message: 'Terms.' } }, { status: 409 }) : route(url, init)));
    const { container } = render(<Connections say={noop} openBrand={noop} />, { container: studioRoot() });
    await screen.findByRole('heading', { name: 'Making' });
    await act(async () => {
      fireEvent.click(within(container.querySelector<HTMLElement>('[data-service="voice"]')!).getByRole('switch'));
    });
    const box = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Cancel' }));
    });
    expect(calls.filter((c) => (c.body as { action?: string } | null)?.action === 'connector.switch')).toHaveLength(1);
    expect(within(container.querySelector<HTMLElement>('[data-service="voice"]')!).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('rowView and parseMaking keep to the dictionary and drop malformed rows', () => {
    const words = new Set<string>(STATUS_WORDS.connection);
    for (const r of [...fallbackMaking(), ...(parseMaking(MAKING_FIXTURE) ?? [])]) expect(words.has(rowView(r).pill)).toBe(true);
    expect(parseMaking(undefined)).toBeNull();
    // Only an absent field falls back to the fixture rows; a present but malformed one shows no rows.
    expect(parseMaking(null)).toEqual([]);
    expect(parseMaking([{ id: 'x' }, null, MAKING_FIXTURE[0], MAKING_FIXTURE[0]])).toHaveLength(1);
    expect(fallbackMaking()).toHaveLength(16);
    expect(capabilityGroups(fallbackMaking())).toHaveLength(CAPABILITY_ROWS.length);
    for (const r of [...fallbackMaking(), ...(parseMaking(MAKING_FIXTURE) ?? [])]) expect(words.has(statePhrase(r).pill)).toBe(true);
    // A connector no capability row lists still gets a row of its own (never hidden).
    const extra = { ...parseMaking(MAKING_FIXTURE)![0]!, id: 'new-vendor', title: 'New vendor' };
    expect(capabilityGroups([extra]).map((g) => g.id)).toEqual(['new-vendor']);
    expect(rowView({ status: { state: 'needs-key', line: 'Off', fix: 'connections' }, switchOn: true })).toEqual({ pill: 'Needs you', line: 'Key missing', amber: true });
  });
});
