// The Calendar opens on the current week in the project's time zone, not the default zone's
// week, once the server says which zone the project uses; Previous/Next still move from there.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Calendar } from '@/app/studio/Calendar';

let urls: string[] = [];
function calendarFetch(timezone: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('/api/studio/calendar')) return Response.json({ timezone, timeZoneLabel: `Times in ${timezone}`, projects: [{ id: 'example', name: 'Example', handle: '@example', timeZone: timezone }], items: [], unplanned: [] });
      return Response.json({});
    }),
  );
}
const studioRoot = () => {
  const el = document.createElement('div');
  el.className = 'studio';
  document.body.appendChild(el);
  return el;
};
const from = (u: string) => new URL(u, 'http://localhost').searchParams.get('from');
const noop = () => undefined;

beforeEach(() => {
  urls = [];
  // Monday 9 Nov 2026 00:30 in Asia/Tehran (UTC+3:30) is still Sunday 8 Nov 22:00 in Europe/Berlin (UTC+1).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T21:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Calendar week in the project time zone', () => {
  it("moves to the project's own Monday once the server reports Asia/Tehran", async () => {
    calendarFetch('Asia/Tehran');
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    // First load: the default zone's week (the zone is not known yet), then the project's week.
    await waitFor(() => expect(urls.map(from)).toContain('2026-11-09'));
    expect(from(urls[0]!)).toBe('2026-11-02');
    expect(await screen.findByText(/Times in Asia\/Tehran/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'This week' }).getAttribute('aria-pressed')).toBe('true');

    // Previous and Next move from the project's week and are not reset by later answers.
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    await waitFor(() => expect(from(urls.at(-1)!)).toBe('2026-11-02'));
    expect(screen.getByRole('button', { name: 'This week' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(from(urls.at(-1)!)).toBe('2026-11-09'));
  });

  it('stays on the default zone week for a project without its own zone', async () => {
    calendarFetch('Europe/Berlin');
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    await screen.findByText(/Times in Europe\/Berlin/);
    expect(new Set(urls.filter((u) => u.startsWith('/api/studio/calendar')).map(from))).toEqual(new Set(['2026-11-02']));
  });
});
