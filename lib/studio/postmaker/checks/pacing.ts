// Pacing lint on a timeline: the longest beat gap ≤ 4 s (120 frames at
// 30 fps), the hook complete by 2 s (frame 60), every chant card 1-2 s (30-60 frames) starting within ±2 frames of a
// beat onset of the declared grid (any onset, not only downbeats; declared grids only), and
// an end card of 6-9 s (180-270 frames). Every violation carries its frame number.
import { t } from '@/app/studio/copy/en';

export interface PacingTimeline {
  fps: number;
  totalFrames: number;
  /** The frame the last token of the hook sentence lands; null = unknown (reported). */
  hookCompleteFrame: number | null;
  /** Beat frames: caption page starts, cuts, pose changes, sticker pops, camera move starts. */
  events: number[];
  chantCards?: { from: number; to: number }[];
  /** The declared grid: BPM and the first downbeat offset. */
  beatGrid?: { bpm: number; downbeatMs: number } | null;
  endCard?: { from: number; to: number } | null;
}

export interface PacingViolation {
  id: 'gap' | 'hook' | 'hook-unknown' | 'chant-length' | 'chant-off-beat' | 'no-grid' | 'end-card';
  frame: number | null;
  text: string;
}

export interface PacingReport {
  ok: boolean;
  violations: PacingViolation[];
  longestGap: { frames: number; from: number };
  maxChantOffset: number | null;
  endCardFrames: number | null;
}

export const CHANT_TOLERANCE_FRAMES = 2;

/** Frames of the beat onsets of a declared grid, up to `totalFrames`. */
export function beatOnsets(grid: { bpm: number; downbeatMs: number }, fps: number, totalFrames: number): number[] {
  if (!(grid.bpm > 0)) return [];
  const step = (60_000 / grid.bpm) * (fps / 1000);
  const out: number[] = [];
  // Onsets before the first downbeat count too (the grid extends backwards to frame 0).
  let f = (grid.downbeatMs * fps) / 1000;
  while (f - step >= 0) f -= step;
  for (; f < totalFrames + step; f += step) out.push(f);
  return out;
}

export function pacingLint(tl: PacingTimeline): PacingReport {
  const v: PacingViolation[] = [];
  const maxGap = tl.fps * 4;
  const hookBy = tl.fps * 2;
  const points = [...new Set([0, ...tl.events.filter((e) => e >= 0 && e <= tl.totalFrames), tl.totalFrames])].sort((a, b) => a - b);
  let longest = { frames: 0, from: 0 };
  for (let i = 1; i < points.length; i++) {
    const gap = points[i]! - points[i - 1]!;
    if (gap > longest.frames) longest = { frames: gap, from: points[i - 1]! };
    if (gap > maxGap) v.push({ id: 'gap', frame: points[i - 1]!, text: t('check.pacing.gap', { frames: gap, frame: points[i - 1]! }) });
  }
  if (tl.hookCompleteFrame === null) v.push({ id: 'hook-unknown', frame: null, text: t('check.pacing.hookUnknown') });
  else if (tl.hookCompleteFrame > hookBy) v.push({ id: 'hook', frame: tl.hookCompleteFrame, text: t('check.pacing.hook', { frame: tl.hookCompleteFrame, max: hookBy }) });

  let maxOffset: number | null = null;
  const cards = tl.chantCards ?? [];
  if (cards.length) {
    const onsets = tl.beatGrid ? beatOnsets(tl.beatGrid, tl.fps, tl.totalFrames) : [];
    if (!onsets.length) v.push({ id: 'no-grid', frame: cards[0]!.from, text: t('check.pacing.noGrid') });
    for (const c of cards) {
      const len = c.to - c.from;
      if (len < tl.fps || len > tl.fps * 2) v.push({ id: 'chant-length', frame: c.from, text: t('check.pacing.chantLength', { frame: c.from, frames: len }) });
      if (onsets.length) {
        const off = Math.min(...onsets.map((o) => Math.abs(c.from - o)));
        const rounded = Math.round(off * 100) / 100;
        maxOffset = Math.max(maxOffset ?? 0, rounded);
        if (off > CHANT_TOLERANCE_FRAMES) v.push({ id: 'chant-off-beat', frame: c.from, text: t('check.pacing.chantOffBeat', { frame: c.from, offset: Math.round(off) }) });
      }
    }
  }

  let endCardFrames: number | null = null;
  if (tl.endCard) {
    endCardFrames = tl.endCard.to - tl.endCard.from;
    if (endCardFrames < tl.fps * 6 || endCardFrames > tl.fps * 9) v.push({ id: 'end-card', frame: tl.endCard.from, text: t('check.pacing.endCard', { frames: endCardFrames, min: tl.fps * 6, max: tl.fps * 9 }) });
  }
  return { ok: v.length === 0, violations: v, longestGap: longest, maxChantOffset: maxOffset, endCardFrames };
}
