// The tempo map the beat-driven loops ride on (quality bar `bounce-beat`, `dance-A/B`, `crowd`): beat onsets as
// whole frames, rounded from the declared BPM and first downbeat exactly as the layout engine's beat grid does, so a
// loop key and a chant card agree on every beat frame. Pure module.
import type { TempoMap } from './types';

const fpsOf = (t: TempoMap) => t.fps ?? 30;

/** Frames per beat (fractional: 18 at 100 BPM, 15 at 120 BPM). */
export const framesPerBeat = (t: TempoMap) => (60 * fpsOf(t)) / t.bpm;

/** Frame of beat k (k may be negative: pickup beats before the first downbeat). */
export const beatFrame = (t: TempoMap, k: number) => Math.round(t.firstDownbeatFrame + k * framesPerBeat(t));

/** Beat indices whose frames fall in [from, to). */
export function beatsIn(t: TempoMap, from: number, to: number): { k: number; frame: number }[] {
  const bf = framesPerBeat(t);
  const out: { k: number; frame: number }[] = [];
  for (let k = Math.floor((from - t.firstDownbeatFrame) / bf) - 1; ; k++) {
    const f = beatFrame(t, k);
    if (f >= to) break;
    if (f >= from) out.push({ k, frame: f });
  }
  return out;
}

/** The half-beat frame after beat k (rounded; 9 frames in at 100 BPM, 8 at 120 BPM). */
export const halfBeatFrame = (t: TempoMap, k: number) => Math.round(t.firstDownbeatFrame + (k + 0.5) * framesPerBeat(t));

/** Whether beat k opens a bar. */
export const isDownbeat = (t: TempoMap, k: number) => ((k % t.beatsPerBar) + t.beatsPerBar) % t.beatsPerBar === 0;
