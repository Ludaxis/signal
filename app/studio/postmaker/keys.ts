'use client';
// Keyboard map (WCAG 2.1.4): single-key shortcuts work only when focus is not in a text field and no dialog or
// drawer is open; they can be turned off (the setting is this browser's own), and "?" shows the list. Modified keys
// (⌘ / Ctrl) are not single-key shortcuts and stay on.
import { useEffect, useRef, useSyncExternalStore } from 'react';

const STORE = 'signal.pm.singleKeys';
const EVENT = 'signal:pm-keys';

export function singleKeysOn(): boolean {
  try {
    return window.localStorage.getItem(STORE) !== 'off';
  } catch {
    return true;
  }
}

export function setSingleKeys(on: boolean): void {
  try {
    window.localStorage.setItem(STORE, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the setting lasts for this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useSingleKeys(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    singleKeysOn,
    () => true,
  );
}

/** True when the key event comes from a place where typing goes (fields, editable text, a select). */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  const field = el.closest('input, textarea, select, [contenteditable="true"]');
  if (!field) return false;
  if (field instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(field.type);
  return true;
}

/** A key combination, written like '⌘Enter', '⇧R', '⌥ArrowUp', 'ArrowDown', ',', '?'. */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): string {
  const mod = e.metaKey || e.ctrlKey ? '⌘' : '';
  const alt = e.altKey ? '⌥' : '';
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (key === ' ') key = 'Space';
  // Shift is part of the character for punctuation ('?', '['); for letters and named keys it is a modifier.
  const shift = e.shiftKey && (/^[A-Z]$/.test(key) || key.length > 1) ? '⇧' : '';
  return `${mod}${alt}${shift}${key}`;
}

export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

/** A modal (native dialog) or the shortcut list is open: only its own keys apply. */
const modalOpen = () => typeof document !== 'undefined' && !!document.querySelector('dialog[open]');

/**
 * Binds `map` on the window while mounted. Single keys (no ⌘) fire only outside text fields, with no dialog open and
 * when single-key shortcuts are on; ⌘ combinations fire outside dialogs, also from fields except ⌘V and ⌘O.
 */
export function useKeys(map: KeyMap, enabled = true): void {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = comboOf(e);
      const fn = ref.current[combo];
      if (!fn) return;
      if (modalOpen()) return;
      const modified = combo.startsWith('⌘');
      if (!modified && (inTextField(e.target) || !singleKeysOn())) return;
      if (modified && inTextField(e.target) && (combo === '⌘V' || combo === '⌘O' || combo === '⌘[' || combo === '⌘]')) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
