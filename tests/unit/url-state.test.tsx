// URL state per tab: ?tab= drives the Studio view; changing tab adds a history entry.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { VIEWS, navigateTo, searchFor, useStudioView, useUrlParam, useUrlReady, viewFromSearch } from '@/app/studio/url-state';

afterEach(() => window.history.replaceState(null, '', '/studio'));

describe('viewFromSearch / searchFor', () => {
  it('reads the tab, falling back to Today for a missing or unknown tab', () => {
    expect(viewFromSearch('')).toBe('today');
    expect(viewFromSearch('?tab=posts')).toBe('posts');
    expect(viewFromSearch('?tab=connections&service=elevenlabs')).toBe('connections');
    expect(viewFromSearch('?tab=nope')).toBe('today');
    expect(viewFromSearch('?ig=connected')).toBe('today');
  });

  it('writes tab first and keeps the tab’s own parameters', () => {
    expect(searchFor('posts')).toBe('?tab=posts');
    expect(searchFor('connections', { service: 'elevenlabs', tab: 'ignored' })).toBe('?tab=connections&service=elevenlabs');
    for (const v of VIEWS) expect(viewFromSearch(searchFor(v))).toBe(v);
  });
});

describe('navigateTo and useStudioView', () => {
  it('pushes one history entry per tab change and follows Back (popstate)', () => {
    window.history.replaceState(null, '', '/studio');
    const { result } = renderHook(() => useStudioView());
    expect(result.current[0]).toBe('today');
    const before = window.history.length;
    act(() => result.current[1]('posts'));
    expect(window.location.search).toBe('?tab=posts');
    expect(result.current[0]).toBe('posts');
    expect(window.history.length).toBe(before + 1);
    // Same tab again: no new entry.
    act(() => result.current[1]('posts'));
    expect(window.history.length).toBe(before + 1);
    // Back: the browser restores the URL and fires popstate.
    act(() => {
      window.history.replaceState(null, '', '/studio?tab=calendar');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current[0]).toBe('calendar');
  });

  it('replaces the entry for return URLs such as a login callback', () => {
    window.history.replaceState(null, '', '/studio?ig=connected&msg=ok');
    const before = window.history.length;
    const { result } = renderHook(() => useStudioView());
    act(() => navigateTo('connections', { replace: true }));
    expect(window.location.search).toBe('?tab=connections');
    expect(window.history.length).toBe(before);
    expect(result.current[0]).toBe('connections');
  });

  it('is not ready on the server (or during hydration), and ready on the client, so deep links skip Today', () => {
    function Probe() {
      return <span>{useUrlReady() ? 'ready' : 'hydrating'}</span>;
    }
    expect(renderToString(<Probe />)).toContain('hydrating');
    const { result } = renderHook(() => useUrlReady());
    expect(result.current).toBe(true);
  });

  it('exposes other parameters of the current URL', () => {
    window.history.replaceState(null, '', '/studio?tab=connections&service=figma');
    const { result } = renderHook(() => useUrlParam('service'));
    expect(result.current).toBe('figma');
  });
});
