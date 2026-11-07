// Render-side lints on the composed Timeline (compose runs them); the check-side pacing lint is checks/pacing.ts.
// Deterministic pacing and flash lints on a timeline.
// Pacing: the longest gap between beats ≤ 120 frames; the hook's sentence complete by frame 60; every chant
// card 30-60 frames and starting within ±2 frames of a beat onset of the declared grid (any onset);
// the end card 180-270 frames. Flash (C12): no 1-second window may hold more than 2 colour changes (3 flashes per
// second fails). Every violation names its frame.
import { REVEAL_FILL, type Timeline } from '../render/timeline';

export interface LintViolation {
  rule: 'beat-gap' | 'hook-complete' | 'chant-length' | 'chant-downbeat' | 'endcard-length' | 'flash';
  frame: number;
  message: string;
}

type PacingInput = Pick<Timeline, 'durationInFrames' | 'events' | 'marks' | 'segments' | 'grid'> & { elements: { kind: string; from: number; to: number; colour?: string }[] };

export function pacingLint(t: PacingInput): LintViolation[] {
  const out: LintViolation[] = [];
  const frames = [...new Set([0, ...t.events.map((e) => e.frame), t.durationInFrames])].sort((a, b) => a - b);
  for (let k = 1; k < frames.length; k++) {
    const gap = frames[k]! - frames[k - 1]!;
    if (gap > 120) out.push({ rule: 'beat-gap', frame: frames[k - 1]!, message: `No beat for ${gap} frames from frame ${frames[k - 1]}` });
  }
  if (t.segments.some((s) => s.segment === 'hook')) {
    const h = t.marks.hookComplete;
    if (h === null || h > 60) out.push({ rule: 'hook-complete', frame: h ?? 0, message: `The hook completes at frame ${h ?? 'never'} (by 60)` });
  }
  for (const c of t.elements.filter((e) => e.kind === 'card')) {
    const len = c.to - c.from;
    if (len < 30 || len > 60) out.push({ rule: 'chant-length', frame: c.from, message: `Chant card at frame ${c.from} lasts ${len} frames (30-60)` });
    const near = t.grid.beats.reduce((d, b) => Math.min(d, Math.abs(b - c.from)), Infinity);
    if (near > 2) out.push({ rule: 'chant-downbeat', frame: c.from, message: `Chant card at frame ${c.from} is ${near} frames off the beat` });
  }
  for (const s of t.segments.filter((x) => x.segment === 'endcard')) {
    const len = s.to - s.from;
    if (len < 180 || len > 270) out.push({ rule: 'endcard-length', frame: s.from, message: `The end card lasts ${len} frames (180-270)` });
  }
  return out;
}

type FlashElement = { kind: string; from: number; to?: number; colour?: string; background?: string };

/** Full-frame fills, bottom to top: a scene's background, a chant or interrupt card, the reveal's fixed dark fill. */
const FILL_ORDER = ['scene', 'endcard', 'card', 'reveal'] as const;
const fillOf = (e: FlashElement): string | null => {
  if (e.kind === 'reveal') return REVEAL_FILL; // its `colour` is the word's colour, not the fill
  if (e.kind === 'scene') return e.background ?? e.colour ?? '';
  if (e.kind === 'card' || e.kind === 'endcard') return e.colour ?? e.background ?? '';
  return null;
};

/**
 * Colour-change frames: every frame where the full-frame colour on screen (the topmost live fill: reveal over card
 * over end card over scene) differs from the colour just before. Scene cuts, chant and interrupt cards, the reveal's
 * dark fill and the end card all count, so chant → reveal → end card inside one second is three changes.
 */
export function colourChanges(elements: FlashElement[]): number[] {
  const fills = elements.filter((e) => fillOf(e) !== null);
  const at = (f: number): string | null => {
    let top: FlashElement | null = null;
    for (const e of fills) {
      if (f < e.from || (e.to !== undefined && f >= e.to)) continue;
      if (!top || FILL_ORDER.indexOf(e.kind as (typeof FILL_ORDER)[number]) >= FILL_ORDER.indexOf(top.kind as (typeof FILL_ORDER)[number])) top = e;
    }
    return top ? fillOf(top) : null;
  };
  const frames = [...new Set(fills.flatMap((e) => (e.to === undefined ? [e.from] : [e.from, e.to])))].sort((a, b) => a - b);
  const out: number[] = [];
  let prev: string | null = null;
  for (const f of frames) {
    const c = at(f);
    if (c === null) continue;
    if (prev !== null && c !== prev) out.push(f);
    prev = c;
  }
  return out;
}

export function flashLint(t: { elements: FlashElement[] }, fps = 30): LintViolation[] {
  const changes = colourChanges(t.elements);
  const out: LintViolation[] = [];
  for (let k = 0; k < changes.length; k++) {
    const inWindow = changes.filter((f) => f >= changes[k]! && f < changes[k]! + fps).length;
    if (inWindow > 2) {
      out.push({ rule: 'flash', frame: changes[k]!, message: `${inWindow} colour changes within 1 s from frame ${changes[k]}` });
      break;
    }
  }
  return out;
}
