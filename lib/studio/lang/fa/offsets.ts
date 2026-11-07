// alignToDisplay: map a character alignment on the tts string back to display tokens
// ("Captions"). tts chars → projection offsets → PronSpan → display range. Word timings are
// emitted in display text, so the caption shows «۱۵ آبان» while the audio says «پونزدهِ آبان».
// Silent spans (emoji, hashtags) get no timing. Never caption from tts or pron.

import type { FaLineText } from './pron';
import type { Projection } from './project';

export interface CharAlignment {
  characters: string[];
  startMs: number[];
  endMs: number[];
}

export interface WordTiming {
  /** Display UTF-16 range. */
  d: [number, number];
  /** The display text of the range (never tts or pron). */
  text: string;
  startMs: number;
  endMs: number;
  spanIndex: number;
}

export class AlignmentError extends Error {
  constructor(
    readonly code: 'ALIGNMENT_MISMATCH' | 'ALIGNMENT_SHAPE',
    message: string,
  ) {
    super(message);
    this.name = 'AlignmentError';
  }
}

/** Convert a vendor alignment in seconds (`characters`, `character_start_times_seconds`, …) to ms. */
export function fromSecondsAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): CharAlignment {
  return {
    characters: a.characters,
    startMs: a.character_start_times_seconds.map((s) => Math.round(s * 1000)),
    endMs: a.character_end_times_seconds.map((s) => Math.round(s * 1000)),
  };
}

export function alignToDisplay(alignment: CharAlignment, projection: Projection, line: Pick<FaLineText, 'display' | 'spans'>): WordTiming[] {
  const { characters, startMs, endMs } = alignment;
  if (characters.length !== startMs.length || characters.length !== endMs.length) throw new AlignmentError('ALIGNMENT_SHAPE', 'alignment arrays differ in length');
  if (characters.join('') !== projection.tts) throw new AlignmentError('ALIGNMENT_MISMATCH', 'the alignment does not cover the tts string');
  // map UTF-16 tts offsets to alignment indices
  const charAt: number[] = [];
  characters.forEach((c, k) => {
    for (let j = 0; j < c.length; j++) charAt.push(k);
  });
  const out: WordTiming[] = [];
  for (const o of projection.offsets) {
    if (o.span < 0 || o.t[1] <= o.t[0]) continue;
    const span = line.spans[o.span];
    if (!span || span.kind === 'silent') continue;
    let s = Infinity;
    let e = -Infinity;
    for (let x = o.t[0]; x < o.t[1]; x++) {
      const k = charAt[x];
      if (k === undefined || /^\s$/.test(characters[k] ?? '')) continue;
      s = Math.min(s, startMs[k] ?? Infinity);
      e = Math.max(e, endMs[k] ?? -Infinity);
    }
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({ d: span.d, text: line.display.slice(span.d[0], span.d[1]), startMs: s, endMs: e, spanIndex: o.span });
  }
  return out;
}

/** A deterministic mock alignment: every tts character gets `msPerChar` (mock provider and tests only). */
export function mockAlignment(tts: string, msPerChar = 60, startAt = 0): CharAlignment {
  const characters = [...tts];
  return {
    characters,
    startMs: characters.map((_, k) => startAt + k * msPerChar),
    endMs: characters.map((_, k) => startAt + (k + 1) * msPerChar),
  };
}
