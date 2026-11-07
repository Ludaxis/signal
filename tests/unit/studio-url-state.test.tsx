// The Studio shell follows the URL: a reload or deep link on ?tab=posts opens Posts (Today never mounts first), a nav
// click pushes one history entry, and Back (popstate) returns to the tab before. Synthetic data; fetch is a stub.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { Studio } from '@/app/studio/Studio';

const content = {
  account: { destination: '@example.account', maxPosts: 30, posted: 0, open: false, expiresAt: null, maxPerDay: 1 },
  folder: '/tmp/example',
  packages: [],
  live: { enabled: false, reason: '' },
  scheduling: { enabled: false, reason: '' },
  project: { id: 'example', name: 'Example', handle: '@example.account' },
  formats: [],
};
let urls: string[] = [];

beforeEach(() => {
  urls = [];
  window.localStorage.setItem('signal.studio.project', 'example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('/api/studio/content?')) return Response.json(content);
      if (url.startsWith('/api/studio/projects')) return Response.json({ projects: [{ id: 'example', name: 'Example', handle: '@example.account', uploadPostProfile: '', contentDir: '', account: null }] });
      if (url.startsWith('/api/studio/campaigns')) return Response.json({ campaigns: [], plans: {}, formats: [] });
      return Response.json({});
    }),
  );
});
afterEach(async () => {
  cleanup();
  // Let the requests the shell started settle while fetch is still the stub.
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/studio');
  document.body.innerHTML = '';
});

const heading = () => document.querySelector('h1.page-title')?.textContent;

describe('Studio URL state', () => {
  it('?tab=posts opens Posts on load, and Today never mounts first', async () => {
    window.history.replaceState(null, '', '/studio?tab=posts');
    render(<Studio />);
    await waitFor(() => expect(heading()).toBe('Posts'));
    expect(screen.getByRole('button', { name: /^Posts/, current: 'page' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull();
  });

  it('a nav click pushes one history entry; Back returns to the tab before', async () => {
    window.history.replaceState(null, '', '/studio?tab=posts');
    render(<Studio />);
    await waitFor(() => expect(heading()).toBe('Posts'));
    const before = window.history.length;
    const nav = screen.getByRole('navigation');
    fireEvent.click(within(nav).getByRole('button', { name: /^Calendar/ }));
    expect(window.location.search).toBe('?tab=calendar');
    expect(window.history.length).toBe(before + 1);
    await waitFor(() => expect(heading()).toBe('Calendar'));
    // Back: the browser restores the URL and fires popstate.
    act(() => {
      window.history.replaceState(null, '', '/studio?tab=posts');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(heading()).toBe('Posts'));
  });

  it('an unknown tab falls back to Today, and the retired Library tab lands on the Posts gallery', async () => {
    window.history.replaceState(null, '', '/studio?tab=nope');
    const first = render(<Studio />);
    await waitFor(() => expect(heading()).toBe('Today'));
    first.unmount();
    window.history.replaceState(null, '', '/studio?tab=library');
    render(<Studio />);
    await waitFor(() => expect(window.location.search).toBe('?tab=posts&view=gallery'));
    await waitFor(() => expect(heading()).toBe('Posts'));
  });
});
