// The Calendar honours `?campaign=<id>` from Campaigns › "Show all": only that
// campaign's posts in the grid and the tray, a chip "Campaign: ‹name›", and Clear drops the filter. Synthetic data.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Calendar } from '@/app/studio/Calendar';
import { setProjectId } from '@/app/studio/Projects';

const NOW = '2026-11-04T10:00:00Z';
const item = (id: string, when: string | null, campaign: { id: string; name: string } | null) => ({ project: 'example', id, title: `Example post ${id}`, status: 'approved', format: 'image', when, kind: when ? 'planned' : 'unplanned', thumb: null, url: null, campaign });
const AUTUMN = { id: 'c-autumn', name: 'Autumn series' };

function stub(campaigns = [{ id: 'c-autumn', project: 'example', name: 'Autumn series' }]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/studio/calendar'))
        return Response.json({
          timezone: 'Europe/Berlin',
          timeZoneLabel: 'Times in Europe/Berlin',
          projects: [{ id: 'example', name: 'Example', handle: '@example.account', timeZone: 'Europe/Berlin' }],
          items: [item('01', '2026-11-05T17:00:00Z', AUTUMN), item('04', '2026-11-06T17:00:00Z', null)],
          unplanned: [item('02', null, null), item('03', null, AUTUMN)],
          campaigns,
        });
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
const noop = () => undefined;
const titles = (el: HTMLElement) => Array.from(el.querySelectorAll('.cal2-grid .cal2-title, .cal2-tray .cal2-title')).map((n) => n.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  setProjectId('example');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/studio');
});

describe('Calendar campaign filter', () => {
  it('shows only the campaign posts, with a named chip; Clear shows everything again', async () => {
    window.history.replaceState(null, '', '/studio?tab=calendar&campaign=c-autumn');
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    expect(await screen.findByRole('button', { name: 'Campaign: Autumn series' })).toBeTruthy();
    expect(titles(container)).toEqual(['Example post 01', 'Example post 03']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('Times in Europe/Berlin');
    expect(window.location.search).toBe('?tab=calendar');
    expect(screen.queryByRole('button', { name: /^Campaign:/ })).toBeNull();
    expect(titles(container).sort()).toEqual(['Example post 01', 'Example post 02', 'Example post 03', 'Example post 04']);
  });

  it('without the parameter nothing is filtered and no chip shows', async () => {
    window.history.replaceState(null, '', '/studio?tab=calendar');
    const { container } = render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    await screen.findByText('Times in Europe/Berlin');
    expect(screen.queryByRole('button', { name: /^Campaign:/ })).toBeNull();
    expect(titles(container)).toHaveLength(4);
  });

  it('names the campaign from its posts when the campaign list does not have it', async () => {
    stub([]);
    window.history.replaceState(null, '', '/studio?tab=calendar&campaign=c-autumn');
    render(<Calendar say={noop} onOpenPosts={noop} />, { container: studioRoot() });
    expect(await screen.findByRole('button', { name: 'Campaign: Autumn series' })).toBeTruthy();
  });
});

beforeEach(() => stub());

// ---- GET /api/studio/calendar carries each post's campaign and the campaign names ------------------------------
describe('GET /api/studio/calendar › campaign', () => {
  it('lists the campaign of a post made from a plan, null otherwise', async () => {
    const { createHash } = await import('node:crypto');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { NextRequest } = await import('next/server');
    vi.doMock('@/lib/server/studioAuth', () => ({ requireStudioUser: async () => ({ email: 'owner@test' }) }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cal-campaign-'));
    const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
    try {
      process.env.SIGNAL_CONTENT_DIR = path.join(root, 'posts');
      process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
      for (const id of ['01', '02']) {
        const d = path.join(root, 'posts', id);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'slide-1.png'), `png-${id}`);
        fs.writeFileSync(path.join(d, 'caption.txt'), `Caption ${id}`);
        // The fallback project's handle when no projects file exists (tests only).
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination: '@mybrand', files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(`png-${id}`) }, { name: 'caption.txt', role: 'caption', sha256: sha(`Caption ${id}`) }] }));
      }
      fs.writeFileSync(path.join(root, 'posts', '01', 'campaign.json'), JSON.stringify({ campaign: 'c-autumn', campaign_name: 'Autumn series', slot: 's1' }));
      vi.useRealTimers();
      const route = await import('@/app/api/studio/calendar/route');
      const r = await route.GET(new NextRequest('http://localhost/api/studio/calendar?from=2026-11-02&to=2026-11-08'));
      expect(r.status).toBe(200);
      const j = (await r.json()) as { unplanned: { id: string; campaign: unknown }[]; campaigns: unknown[] };
      expect(Object.fromEntries(j.unplanned.map((i) => [i.id, i.campaign]))).toEqual({ '01': { id: 'c-autumn', name: 'Autumn series' }, '02': null });
      expect(Array.isArray(j.campaigns)).toBe(true);
    } finally {
      vi.doUnmock('@/lib/server/studioAuth');
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
      delete process.env.SIGNAL_CONTENT_DIR;
      delete process.env.SIGNAL_PROJECTS_FILE;
    }
  });
});
