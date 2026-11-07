'use client';
// Focus handling shared by every overlay in the Studio (drawers, dialogs, sheets): one stack, so
// Escape closes only the top overlay and focus returns to the one below.
import { useEffect, useRef, type RefObject } from 'react';

/** Open overlays, innermost last: Escape closes only the top one, and focus falls back to the one below. */
const traps: HTMLElement[] = [];

/** Keeps keyboard focus inside `ref` while mounted, closes on Escape, and gives focus back afterwards. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    traps.push(el);
    const before = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null || x === el);
    const first = focusables()[0];
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (traps[traps.length - 1] !== el) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const a = f[0]!;
      const z = f[f.length - 1]!;
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === a || !inside)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (document.activeElement === z || !inside)) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      traps.splice(traps.indexOf(el), 1);
      const under = traps[traps.length - 1];
      if (before?.isConnected && (!under || under.contains(before))) before.focus({ preventScroll: true });
      else if (under) under.focus({ preventScroll: true });
      else if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref]);
}

/** Stops the page behind a panel from scrolling while the panel is open. */
export function useScrollLock(): void {
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = 'hidden';
    return () => {
      el.style.overflow = prev;
    };
  }, []);
}
