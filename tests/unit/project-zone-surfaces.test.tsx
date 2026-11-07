// A project with timeZone 'Asia/Tehran' renders Memory (timeline and event sentences), the mind-map day,
// the Upload-Post picker's reset day and the Posts drawer's autopilot times in that zone. The clock is fixed across
// the 2026-10-25 change (the default zone leaves summer time that night; Tehran keeps +03:30), so every instant
// below lands on a different day or time in the two zones. Synthetic data only.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Memory } from '@/app/studio/Memory';
import { describeEvent } from '@/app/studio/memory-format';
import { quotaText } from '@/app/studio/UploadPostPicker';
import { AutopilotMarkView } from '@/app/studio/Autopilot';
import { demoPayload } from '@/lib/studio/memory/demo';
import type { MemEvent, MemoryPayload } from '@/lib/studio/memory/types';

const TZ = 'Asia/Tehran';
// Sat 24 Oct 21:00Z: Tehran Sun 25 Oct 00:30; the default zone (summer time) Sat 24 Oct 23:00.
const BEFORE = '2026-10-24T21:00:00.000Z';
// Sun 25 Oct 21:00Z: Tehran Mon 26 Oct 00:30; the default zone (winter time) Sun 25 Oct 22:00.
const AFTER = '2026-10-25T21:00:00.000Z';
// The fixed clock: Sun 25 Oct 21:30Z = Mon 26 Oct 01:00 in Tehran, Sun 25 Oct 22:30 in the default zone.
const NOW = '2026-10-25T21:30:00.000Z';

const ev = (id: string, at: string, type: MemEvent['type'], data: Record<string, unknown> = {}): MemEvent => ({ id, at, project: 'fixture', campaign: null, type, by: 'system', refs: { package: '07' }, data });

function payload(timeZone?: string): MemoryPayload {
  const base = demoPayload({ id: 'fixture', name: 'Fixture project', handle: '@fixture.account', ...(timeZone ? { timeZone } : {}) });
  return {
    ...base,
    campaigns: [],
    // One root node, made and last changed at BEFORE (Memory shows its empty state without any node).
    graph: { ...base.graph, nodes: base.graph.nodes.filter((n) => n.parent === null).slice(0, 1).map((n) => ({ ...n, created: BEFORE, updated: BEFORE, history: [], evidence: [], campaign: null })) },
    learnings: [],
    decisions: [],
    runs: [],
    events: [ev('ev_2', AFTER, 'post.made', { format: 'reel' }), ev('ev_1', BEFORE, 'post.scheduled', { at: AFTER, via: 'upload-post' })],
  };
}

function stub(data: MemoryPayload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith('/api/studio/memory') ? Response.json(data) : Response.json({}))),
  );
}
const studioRoot = () => {
  const el = document.createElement('div');
  el.className = 'studio';
  document.body.appendChild(el);
  return el;
};
const noop = () => undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  window.localStorage.setItem('signal.studio.project', 'fixture');
  window.history.replaceState(null, '', '/studio');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Project time zone in Memory, mind map, picker and Posts', () => {
  it('Memory timeline: days, times and event sentences in Asia/Tehran', async () => {
    stub(payload(TZ));
    const { container } = render(<Memory say={noop} />, { container: studioRoot() });
    fireEvent.click(await screen.findByRole('tab', { name: /Timeline/ }));
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    const days = Array.from(timeline.querySelectorAll('.mem-dayhead > span:first-child')).map((n) => n.textContent);
    expect(days).toEqual(['Monday 26 October', 'Sunday 25 October']);
    const times = Array.from(timeline.querySelectorAll('.mem-event-meta > span:first-child')).map((n) => n.textContent);
    expect(times).toEqual(['00:30', '00:30']);
    expect(within(timeline).getByText(/Post 07 scheduled for Mon 26 Oct, 00:30/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/23:00|22:00|Sat 24 Oct/);
  });

  it('mind map: the replay days run in Asia/Tehran, ending on its today', async () => {
    stub(payload(TZ));
    render(<Memory say={noop} />, { container: studioRoot() });
    const slider = await screen.findByRole('slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('Mon 26 Oct');
    expect(slider.getAttribute('max')).toBe('1'); // Sun 25 and Mon 26 Oct
  });

  it('a project without a zone keeps the default zone (unchanged days)', async () => {
    stub(payload());
    render(<Memory say={noop} />, { container: studioRoot() });
    fireEvent.click(await screen.findByRole('tab', { name: /Timeline/ }));
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(Array.from(timeline.querySelectorAll('.mem-dayhead > span:first-child')).map((n) => n.textContent)).toEqual(['Sunday 25 October', 'Saturday 24 October']);
    expect(within(timeline).getByText(/scheduled for Sun 25 Oct, 22:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Mindmap/ }));
    expect((await screen.findByRole('slider')).getAttribute('aria-valuetext')).toBe('Sun 25 Oct');
  });

  it('describeEvent reads the zone it is given', () => {
    const e = ev('ev_1', BEFORE, 'post.scheduled', { at: AFTER });
    expect(describeEvent(e, TZ)).toBe('Post 07 scheduled for Mon 26 Oct, 00:30');
    expect(describeEvent(e)).toBe('Post 07 scheduled for Sun 25 Oct, 22:00');
  });

  it('Upload-Post picker: the reset day is the project zone day', () => {
    const q = { used: 3, limit: 10, resetsAt: BEFORE };
    expect(quotaText(q, TZ)).toContain('resets Sun 25 Oct');
    expect(quotaText(q, null)).toContain('resets Sat 24 Oct');
  });

  it('Posts drawer: the autopilot mark shows made, approved and publish times in the project zone', () => {
    const mark = { madeAt: BEFORE, autoApproved: { at: BEFORE, scheduledFor: AFTER, trustInARow: 5 } };
    const live = render(<AutopilotMarkView packageId="07" mark={mark} live say={noop} onPulled={noop} tz={TZ} />, { container: studioRoot() });
    expect(live.container.textContent).toContain('Sun 25 Oct, 00:30');
    expect(live.container.textContent).toContain('Publishes Mon 26 Oct, 00:30 unless you pull it.');
    live.unmount();
    const done = render(<AutopilotMarkView packageId="07" mark={mark} live={false} say={noop} onPulled={noop} tz={TZ} />, { container: studioRoot() });
    expect(done.container.textContent).toContain('Approved automatically Sun 25 Oct, 00:30.');
  });
});
