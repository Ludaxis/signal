// Persian letter → viseme mapping for the `viseme` lip-sync mode. Applied to the
// pronunciation text (which holds respellings and marked vowels) with a character alignment.
// Rules: runs shorter than 2 frames merge into a neighbour; M holds at least 2 frames on ب/پ/م; the
// mouth returns to X after 6 frames of silence; amplitude above −30 dBFS opens rest consonants to E.

import { ZWNJ, isLetter } from './chars';
import type { CharAlignment } from './offsets';

export type Viseme = 'X' | 'A' | 'E' | 'O' | 'U' | 'M' | 'F' | 'L';

export interface VisemeOptions {
  fps?: number;
  /** Per-frame amplitude in dBFS (optional). */
  amplitudeDb?: number[];
  /** Frames of silence before the mouth returns to rest. */
  restAfterFrames?: number;
}

const M = new Set(['ب', 'پ', 'م']);
const L = new Set(['ل', 'ن', 'ت', 'د', 'ط', 'ر']);
const VOWEL_MARKS = new Set(['\u064E', '\u0650', '\u064F']);

function isVowelNext(text: string[], i: number): boolean {
  const n = text[i + 1];
  return n !== undefined && (VOWEL_MARKS.has(n) || n === 'ا' || n === 'آ');
}

/** Class for the character at index i, or null when the character does not change the mouth. */
export function visemeOf(chars: string[], i: number, amplitudeDb?: number): Viseme | null {
  const c = chars[i] ?? '';
  const atStart = i === 0 || !isLetter(chars[i - 1]) && !VOWEL_MARKS.has(chars[i - 1] ?? '') && chars[i - 1] !== '\u0651';
  if (M.has(c)) return 'M';
  if (c === 'ف') return 'F';
  if (c === 'و') return atStart || isVowelNext(chars, i) ? 'F' : 'U';
  if (c === '\u064F') return 'O';
  if (c === 'ا' || c === 'آ' || c === '\u064E') return 'A';
  if (c === 'ی' || c === '\u0650') return 'E';
  if (c === 'ه') {
    const next = chars[i + 1];
    const final = next === undefined || next === ZWNJ || !isLetter(next);
    if (final && !atStart) return 'E';
  }
  if (L.has(c)) return 'L';
  if (isLetter(c)) return amplitudeDb !== undefined && amplitudeDb > -30 ? 'E' : 'X';
  return null;
}

export interface VisemeTrack {
  frames: Viseme[];
  /** Onset frame of every ب/پ/م in the text. */
  mOnsets: { index: number; frame: number }[];
}

export function visemeFrames(text: string, alignment: CharAlignment, opts: VisemeOptions = {}): VisemeTrack {
  const fps = opts.fps ?? 30;
  const rest = opts.restAfterFrames ?? 6;
  const chars = alignment.characters;
  if (chars.join('') !== text) throw new Error('visemeFrames: alignment does not cover the text');
  const lastEnd = Math.max(0, ...alignment.endMs);
  const n = Math.max(1, Math.ceil((lastEnd / 1000) * fps));
  const raw: (Viseme | null)[] = new Array<Viseme | null>(n).fill(null);
  const mOnsets: { index: number; frame: number }[] = [];
  chars.forEach((_, k) => {
    const f0 = Math.floor(((alignment.startMs[k] ?? 0) / 1000) * fps);
    const amp = opts.amplitudeDb?.[f0];
    const v = visemeOf(chars, k, amp);
    if (v === 'M') mOnsets.push({ index: k, frame: f0 });
    if (v === null) return;
    const f1 = Math.max(f0 + 1, Math.round(((alignment.endMs[k] ?? 0) / 1000) * fps));
    for (let f = f0; f < Math.min(f1, n); f++) raw[f] = v;
  });
  // silence: hold the previous shape up to `rest` frames, then X
  const frames: Viseme[] = [];
  let prev: Viseme = 'X';
  let silent = 0;
  for (let f = 0; f < n; f++) {
    const v = raw[f];
    if (v === null || v === undefined) {
      silent++;
      frames.push(silent > rest ? 'X' : prev);
    } else {
      silent = 0;
      prev = v;
      frames.push(v);
    }
  }
  // merge runs shorter than 2 frames into the previous neighbour (or the next at the start)
  let f = 0;
  while (f < frames.length) {
    let g = f;
    while (g + 1 < frames.length && frames[g + 1] === frames[f]) g++;
    const len = g - f + 1;
    if (len < 2 && frames[f] !== 'M') {
      const fill = f > 0 ? frames[f - 1]! : (frames[g + 1] ?? frames[f]!);
      for (let x = f; x <= g; x++) frames[x] = fill;
    }
    f = g + 1;
  }
  // M is held at least 2 frames from every ب/پ/م onset; the track never grows past n frames, so an
  // onset on the last frame holds on the last two frames instead
  for (const o of mOnsets) {
    const start = Math.max(0, Math.min(o.frame, n - 2));
    for (let x = start; x < Math.min(start + 2, n); x++) frames[x] = 'M';
  }
  return { frames, mOnsets };
}
