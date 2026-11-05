'use client';
// Keeps every Studio screen in step without a page reload.
// Any action that changes data calls notifyChanged(topic…). Every screen that shows that data
// subscribes with useOnChanged(topics, reload) and refetches. The same signal reaches other open
// tabs (BroadcastChannel). Screens also refetch when the tab becomes visible again and, for posts,
// on a slow poll while visible, so changes made on the server (scheduler, status checks) show up too.
import { useEffect, useRef } from 'react';

export type Topic = 'content' | 'calendar' | 'campaigns' | 'brand' | 'connections' | 'autopilot';
const EVENT = 'signal:changed';
let channel: BroadcastChannel | null = null;
function bc(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel('signal-studio');
  return channel;
}

/** Tell every screen (and other tabs) that these kinds of data changed. */
export function notifyChanged(...topics: Topic[]): void {
  if (typeof window === 'undefined' || topics.length === 0) return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { topics } }));
  try {
    bc()?.postMessage({ topics });
  } catch {
    /* other tabs are a nice-to-have */
  }
}

/**
 * Calls `reload` when one of `topics` changes, when the tab becomes visible again (at most every 5 s),
 * and every `pollMs` while visible (0 = no polling). Bursts of changes are merged into one reload.
 */
export function useOnChanged(topics: Topic[], reload: () => unknown, pollMs = 0): void {
  const fn = useRef(reload);
  useEffect(() => {
    fn.current = reload;
  }, [reload]);
  const key = topics.join(',');
  useEffect(() => {
    const want = new Set(key.split(',') as Topic[]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = Date.now();
    const run = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        void fn.current();
      }, 120);
    };
    const onLocal = (e: Event) => {
      const t = (e as CustomEvent<{ topics: Topic[] }>).detail?.topics ?? [];
      if (t.some((x) => want.has(x))) run();
    };
    const ch = bc();
    const onRemote = (e: MessageEvent<{ topics?: Topic[] }>) => {
      if ((e.data?.topics ?? []).some((x) => want.has(x))) run();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 5000) run();
    };
    window.addEventListener(EVENT, onLocal);
    ch?.addEventListener('message', onRemote);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const poll = pollMs > 0 ? setInterval(() => document.visibilityState === 'visible' && Date.now() - last > pollMs - 500 && run(), pollMs) : null;
    return () => {
      window.removeEventListener(EVENT, onLocal);
      ch?.removeEventListener('message', onRemote);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
  }, [key, pollMs]);
}
