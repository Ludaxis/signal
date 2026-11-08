// Viseme track (quality bar `viseme` mode): voice alignments → one mouth state per frame for a character.
// Persian lines go through the Persian mapper (lang/fa/viseme.ts: the pronunciation text, `M` held ≥ 2 frames on
// ب/پ/م, runs under 2 frames merged); Latin lines through the standard 8-class mapping on the alignment characters.
// Lines are placed at their start frames; after a line the last shape holds for up to 6 silent frames, then the
// mouth rests on `X`. Pure module.
import type { CharAlignment } from '../../lang/fa/offsets';
import { visemeFrames, type Viseme } from '../../lang/fa/viseme';

export const REST_AFTER_FRAMES = 6;
export const M_MIN_FRAMES = 2;

export interface VisemeLine {
  lineId: string;
  lang: 'fa' | 'en';
  /** The pronunciation text (fa) or the spoken text (en); the alignment's characters must spell it. */
  text: string;
  alignment: CharAlignment;
  /** Absolute frame the line's audio starts. */
  startFrame: number;
  /** Per-frame amplitude in dBFS, relative to the line start (optional). */
  amplitudeDb?: number[];
}

export interface VisemeTrackResult {
  from: number;
  frames: Viseme[];
  /** Absolute onset frames of every bilabial (ب/پ/م, or m/b/p). */
  mOnsets: { lineId: string; frame: number }[];
}

const LATIN: [RegExp, Viseme][] = [
  [/[mbp]/i, 'M'],
  [/[fv]/i, 'F'],
  [/[ltdn]/i, 'L'],
  [/[o]/i, 'O'],
  [/[uwq]/i, 'U'],
  [/[a]/i, 'A'],
  [/[eiy]/i, 'E'],
];

/** Latin class of one alignment character, or null when it does not move the mouth (space, punctuation). */
export function latinVisemeOf(c: string, amplitudeDb?: number): Viseme | null {
  for (const [re, v] of LATIN) if (re.test(c)) return v;
  if (/[a-z]/i.test(c)) return amplitudeDb !== undefined && amplitudeDb > -30 ? 'E' : 'X';
  return null;
}

/** The Latin frame builder (same rules as the Persian one: hold through short silences, merge 1-frame runs, M ≥ 2). */
function latinFrames(text: string, a: CharAlignment, amp: number[] | undefined, fps = 30): { frames: Viseme[]; mOnsets: number[] } {
  if (a.characters.join('') !== text) throw new Error('visemeTrack: alignment does not cover the text');
  const n = Math.max(1, Math.ceil((Math.max(0, ...a.endMs) / 1000) * fps));
  const raw: (Viseme | null)[] = new Array<Viseme | null>(n).fill(null);
  const mOnsets: number[] = [];
  a.characters.forEach((c, k) => {
    const f0 = Math.floor(((a.startMs[k] ?? 0) / 1000) * fps);
    const v = latinVisemeOf(c, amp?.[f0]);
    if (v === 'M') mOnsets.push(f0);
    if (v === null) return;
    const f1 = Math.max(f0 + 1, Math.round(((a.endMs[k] ?? 0) / 1000) * fps));
    for (let f = f0; f < Math.min(f1, n); f++) raw[f] = v;
  });
  const frames: Viseme[] = [];
  let prev: Viseme = 'X';
  let silent = 0;
  for (const v of raw) {
    if (v === null) {
      silent++;
      frames.push(silent > REST_AFTER_FRAMES ? 'X' : prev);
    } else {
      silent = 0;
      prev = v;
      frames.push(v);
    }
  }
  for (let f = 0; f < frames.length; ) {
    let g = f;
    while (g + 1 < frames.length && frames[g + 1] === frames[f]) g++;
    if (g === f && frames[f] !== 'M') frames[f] = f > 0 ? frames[f - 1]! : (frames[f + 1] ?? frames[f]!);
    f = g + 1;
  }
  for (const o of mOnsets) {
    const s = Math.max(0, Math.min(o, n - M_MIN_FRAMES));
    for (let x = s; x < Math.min(s + M_MIN_FRAMES, n); x++) frames[x] = 'M';
  }
  return { frames, mOnsets };
}

/** The mouth track over [from, to) for a character's lines (later lines win where two overlap). */
export function visemeTrack(lines: readonly VisemeLine[], from: number, to: number, fps = 30): VisemeTrackResult {
  const len = Math.max(0, to - from);
  const out: (Viseme | null)[] = new Array<Viseme | null>(len).fill(null);
  const mOnsets: VisemeTrackResult['mOnsets'] = [];
  for (const line of [...lines].sort((a, b) => a.startFrame - b.startFrame)) {
    const r =
      line.lang === 'fa'
        ? (() => {
            const t = visemeFrames(line.text, line.alignment, { fps, amplitudeDb: line.amplitudeDb, restAfterFrames: REST_AFTER_FRAMES });
            return { frames: t.frames, mOnsets: t.mOnsets.map((o) => o.frame) };
          })()
        : latinFrames(line.text, line.alignment, line.amplitudeDb, fps);
    r.frames.forEach((v, k) => {
      const i = line.startFrame + k - from;
      if (i >= 0 && i < len) out[i] = v;
    });
    for (const o of r.mOnsets) mOnsets.push({ lineId: line.lineId, frame: line.startFrame + o });
  }
  // after a line: hold the last shape up to 6 silent frames, then rest
  const frames: Viseme[] = [];
  let prev: Viseme = 'X';
  let silent = 0;
  for (const v of out) {
    if (v === null) {
      silent++;
      frames.push(silent > REST_AFTER_FRAMES ? 'X' : prev);
    } else {
      silent = 0;
      prev = v;
      frames.push(v);
    }
  }
  return { from, frames, mOnsets };
}
