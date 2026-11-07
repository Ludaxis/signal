// Key tracks: the values of one part channel over time, from keys that each name a curve. Shared by gestures, loops
// and pose blends so every motion in the system eases through the same function. Pure module.
import { easeOf } from './ease';
import type { KeyCurve } from './types';

export interface NumKey {
  frame: number;
  value: number;
  curve: KeyCurve;
}

/** Value at frame f (keys sorted by frame). Before the first key: its value; after the last: the last value. */
export function evalKeys(keys: readonly NumKey[], f: number): number {
  if (keys.length === 0) return 0;
  if (f <= keys[0]!.frame) return keys[0]!.value;
  const last = keys[keys.length - 1]!;
  if (f >= last.frame) return last.value;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.frame <= f) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  return a.value + (b.value - a.value) * easeOf(b.curve, (f - a.frame) / span, span);
}

/** The state of the last key at or before f, or null. */
export function evalState(keys: readonly { frame: number; value: string }[], f: number): string | null {
  let s: string | null = null;
  for (const k of keys) if (k.frame <= f) s = k.value;
  return s;
}

export const round4 = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};
