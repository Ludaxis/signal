// Flash lint (C12; WCAG 2.3.1 general flash): at most 3 full-frame luminance
// flashes in any 1 s window. Input: the mean relative luminance of every frame (0-1), from the render child or the
// preview strip. A change counts when consecutive frames move the same way by at least 0.1 in total and the darker
// state is below 0.8 (the WCAG general-flash pair). A run of same-sign deltas is one change. Changes within one
// second of each other (Δ ≤ fps frames, both ends included) share a window; more than 3 in a window fail.
// So chant cards alternating every 10 frames (3 per second) fail; every 30 frames pass.
import { t } from '@/app/studio/copy/en';

export const FLASH_DELTA = 0.1;
export const FLASH_DARK = 0.8;
export const MAX_FLASHES_PER_SECOND = 3;

/** sRGB 0-255 → relative luminance (WCAG). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Frames where a qualifying luminance change starts. */
export function flashEvents(trace: readonly number[]): number[] {
  const out: number[] = [];
  let i = 1;
  while (i < trace.length) {
    const d = trace[i]! - trace[i - 1]!;
    if (d === 0) {
      i++;
      continue;
    }
    const sign = Math.sign(d);
    const start = i - 1;
    let j = i;
    while (j + 1 < trace.length && Math.sign(trace[j + 1]! - trace[j]!) === sign) j++;
    const a = trace[start]!;
    const b = trace[j]!;
    if (Math.abs(b - a) >= FLASH_DELTA && Math.min(a, b) < FLASH_DARK) out.push(i);
    i = j + 1;
  }
  return out;
}

export interface FlashReport {
  ok: boolean;
  events: number[];
  worst: { frame: number; count: number };
  text: string | null;
}

export function flashLint(trace: readonly number[], fps: number): FlashReport {
  const ev = flashEvents(trace);
  let worst = { frame: 0, count: 0 };
  for (let i = 0, j = 0; i < ev.length; i++) {
    while (j < ev.length && ev[j]! - ev[i]! <= fps) j++;
    if (j - i > worst.count) worst = { frame: ev[i]!, count: j - i };
  }
  const ok = worst.count <= MAX_FLASHES_PER_SECOND;
  return { ok, events: ev, worst, text: ok ? null : t('check.flash.tooMany', { count: worst.count, frame: worst.frame }) };
}

/** A luminance trace for full-frame cards (tests and the timeline fallback): each card holds its luminance. */
export function cardTrace(cards: readonly { frames: number; luminance: number }[]): number[] {
  return cards.flatMap((c) => Array.from({ length: c.frames }, () => c.luminance));
}
