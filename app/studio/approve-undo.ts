'use client';
// Approve with Undo. An approval is written once on the server and cannot be taken back, so
// Undo works by waiting: Approve shows a toast with Undo for 8 s, and the approval is sent only when that time is
// up. Undo inside the window sends nothing. The wait lives here, outside any component, so closing the drawer or
// changing tab does not lose it; when the page is hidden (closed, reloaded) the waiting approvals are sent at once
// with keepalive, because the person already chose Approve. Nothing is approved without that click.
import { useSyncExternalStore } from 'react';
import { TOAST_UNDO_MS } from './ui/Toast';

export type ApproveSend = (opts: { keepalive: boolean }) => Promise<void>;
interface Waiting {
  timer: ReturnType<typeof setTimeout>;
  send: ApproveSend;
  onError: (e: Error) => void;
}

const waiting = new Map<string, Waiting>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();
const emit = () => {
  snapshot = new Set(waiting.keys());
  for (const l of listeners) l();
};

function run(key: string, keepalive: boolean): void {
  const w = waiting.get(key);
  if (!w) return;
  clearTimeout(w.timer);
  waiting.delete(key);
  emit();
  void w.send({ keepalive }).catch((e: unknown) => w.onError(e instanceof Error ? e : new Error(String(e))));
}

let hooked = false;
function hookPageHide(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('pagehide', () => flushApprovals());
}

/**
 * Waits `delayMs` (8 s, the Undo toast's time), then calls `send`. Returns Undo: true when it stopped the approval
 * in time, false when it had already been sent. A second Approve for the same key while one waits is ignored.
 */
export function deferApprove(key: string, send: ApproveSend, onError: (e: Error) => void, delayMs = TOAST_UNDO_MS): () => boolean {
  hookPageHide();
  if (!waiting.has(key)) {
    waiting.set(key, { timer: setTimeout(() => run(key, false), delayMs), send, onError });
    emit();
  }
  return () => {
    const w = waiting.get(key);
    if (!w) return false;
    clearTimeout(w.timer);
    waiting.delete(key);
    emit();
    return true;
  };
}

/** Sends every waiting approval now (page hidden). */
export function flushApprovals(): void {
  for (const key of [...waiting.keys()]) run(key, true);
}

/** Whether an approval for `key` is waiting out its Undo time. */
export function isApproving(key: string): boolean {
  return waiting.has(key);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const EMPTY: ReadonlySet<string> = new Set();

/** The keys of approvals waiting out their Undo time (re-renders when one starts, is undone or is sent). */
export function useApproving(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
