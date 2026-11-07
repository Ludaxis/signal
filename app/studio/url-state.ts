'use client';
// URL state for the Studio: the open tab lives in `?tab=`, so reload, deep links and Back work.
// Changing tab pushes a history entry; Back and Forward move through them. Other parameters belong to the
// tab that set them (for example `?tab=connections&service=<id>`) and are dropped when the tab changes.
import { useCallback, useSyncExternalStore } from 'react';

export const VIEWS = ['today', 'campaigns', 'pipelines', 'calendar', 'posts', 'library', 'results', 'comments', 'brand', 'memory', 'connections'] as const;
export type View = (typeof VIEWS)[number];
export const DEFAULT_VIEW: View = 'today';

const EVENT = 'studio:navigate';

export function isView(v: unknown): v is View {
  return typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
}

/** The tab named by a query string; anything missing or unknown is Today. */
export function viewFromSearch(search: string): View {
  const tab = new URLSearchParams(search).get('tab');
  return isView(tab) ? tab : DEFAULT_VIEW;
}

/** The query string for a tab and its own parameters, `tab` first. */
export function searchFor(view: View, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ tab: view });
  for (const [k, v] of Object.entries(params)) if (k !== 'tab') q.set(k, v);
  return `?${q.toString()}`;
}

/**
 * Moves to `view`. Pushes a history entry unless `replace` (used when the page lands on a return URL, such as
 * a login callback, that should not stay in history). Does nothing when the URL would not change.
 */
export function navigateTo(view: View, opts: { replace?: boolean; params?: Record<string, string> } = {}): void {
  if (typeof window === 'undefined') return;
  const next = searchFor(view, opts.params);
  const url = `${window.location.pathname}${next}${window.location.hash}`;
  if (!opts.replace && window.location.search === next) return;
  if (opts.replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState(window.history.state, '', url);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}
const snapshot = () => window.location.search;
// The server render (and the first client render, for hydration) shows Today; the URL's tab follows at once.
const serverSnapshot = () => '';

/** The current tab from the URL, and a function that changes it (with a history entry). */
export function useStudioView(): [View, (view: View, opts?: { replace?: boolean; params?: Record<string, string> }) => void] {
  const search = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const go = useCallback((view: View, opts?: { replace?: boolean; params?: Record<string, string> }) => navigateTo(view, opts), []);
  return [viewFromSearch(search), go];
}

const never = () => () => {};
/**
 * False during the server render and hydration (when the URL is not yet read), true from the first client
 * render after. The Studio mounts tab content only once this is true, so a deep link such as ?tab=posts never
 * mounts Today first (no flash, no Today fetch).
 */
export function useUrlReady(): boolean {
  return useSyncExternalStore(never, () => true, () => false);
}

/** One parameter of the current URL (for tabs that keep their own state there). */
export function useUrlParam(name: string): string | null {
  const search = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return new URLSearchParams(search).get(name);
}

/** The whole current query string (for tabs with several parameters). */
export function useSearch(): string {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
