// The mix plan (quality mix targets; `mixPlan.json`): per-stem volume automation as
// frame/value pairs, rendered by the `AudioMaster` composition, then normalised by ffmpeg two-pass loudnorm.
// Targets: narration at −16 LUFS integrated before the mix; music under speech ducked by −10 dB (range −9 to −12)
// with 4-frame ramps in and 10-frame ramps out, deep enough that the narration sits at least 8 dB above the bed
// (the duck goes to −12 dB where the bed is louder); chant and reveal up to −12 LUFS short-term; interrupt drops the
// music to silence; SFX peaks ≤ −6 dBFS. Master −14 LUFS integrated ±1, true peak ≤ −1.0 dBTP. Pure module.
import type { SegmentId } from './presets';

export const MIX_TARGETS = {
  narrationLufs: -16,
  masterLufs: -14,
  masterToleranceLu: 1,
  truePeakDbtp: -1.0,
  /** loudnorm's own true-peak target: 1 dB below the limit, the headroom the AAC encode of the final MP4 needs. */
  loudnormTpDbtp: -2.0,
  duckDb: -10,
  duckRange: [-12, -9] as [number, number],
  /** Narration at least this far above the music bed (short-term) while speaking. */
  narrationOverBedDb: 8,
  rampInFrames: 4,
  rampOutFrames: 10,
  bedLufs: -18,
  fullLufs: -12,
  sfxPeakDbfs: -6,
} as const;

export interface StemClip {
  id: string;
  kind: 'voice' | 'sfx';
  /** Served path inside the render bundle. */
  src: string;
  from: number;
  frames: number;
  gainDb: number;
  lineId?: string;
}

export interface MixPlan {
  schema: 'signal.pm.mix-plan/1';
  durationFrames: number;
  /** graph/adapters.ts MixPlanDoc compatibility. */
  cues: { beatId: string; atFrame: number }[];
  voice: StemClip[];
  sfx: StemClip[];
  music: { src: string | null; gainDb: number; curve: [number, number][] } | null;
  targets: typeof MIX_TARGETS;
}

export interface MixInput {
  durationFrames: number;
  segments: { beatId: string; segment: SegmentId; from: number; to: number }[];
  voice: { id: string; lineId: string; src: string; from: number; frames: number; measuredLufs: number | null }[];
  sfx?: { id: string; src: string; from: number; frames: number; peakDbfs: number | null }[];
  music: { src: string; measuredLufs: number | null } | null;
}

const MUSIC_LEVEL: Record<SegmentId, number | null> = {
  hook: MIX_TARGETS.bedLufs,
  story: MIX_TARGETS.bedLufs,
  other: MIX_TARGETS.bedLufs,
  escalation: MIX_TARGETS.bedLufs + 2,
  demo: MIX_TARGETS.bedLufs + 2,
  chant: MIX_TARGETS.fullLufs,
  reveal: MIX_TARGETS.fullLufs,
  endcard: MIX_TARGETS.bedLufs,
  interrupt: null, // silence for contrast
};

/** The duck under speech for a bed level: −10 dB, or deeper (to −12) when the narration would sit < 8 dB above. */
export const duckDepth = (levelLufs: number) =>
  Math.max(MIX_TARGETS.duckRange[0], Math.min(MIX_TARGETS.duckDb, MIX_TARGETS.narrationLufs - MIX_TARGETS.narrationOverBedDb - levelLufs));

/** Music gain in dB relative to its measured level, per frame (piecewise linear points). */
export function musicCurve(i: MixInput): [number, number][] {
  const measured = i.music?.measuredLufs ?? MIX_TARGETS.bedLufs;
  const SILENT = -90;
  const levelAt = (f: number) => {
    const s = i.segments.find((x) => f >= x.from && f < x.to);
    return s ? MUSIC_LEVEL[s.segment] : MIX_TARGETS.bedLufs;
  };
  const base = (f: number) => {
    const level = levelAt(f);
    return level === null ? SILENT : level - measured;
  };
  const points: [number, number][] = [];
  // Ducking envelope: 0 → duck over 4 frames before speech, back over 10 frames after it.
  const duckAt = (f: number) => {
    let d = 0;
    for (const v of i.voice) {
      const a = v.from;
      const b = v.from + v.frames;
      if (f >= a && f < b) return 1;
      if (f >= a - MIX_TARGETS.rampInFrames && f < a) d = Math.max(d, (f - (a - MIX_TARGETS.rampInFrames)) / MIX_TARGETS.rampInFrames);
      if (f >= b && f < b + MIX_TARGETS.rampOutFrames) d = Math.max(d, 1 - (f - b) / MIX_TARGETS.rampOutFrames);
    }
    return d;
  };
  for (let f = 0; f < i.durationFrames; f++) {
    const b = base(f);
    points.push([f, b <= SILENT ? SILENT : Math.round((b + duckAt(f) * duckDepth(levelAt(f) ?? MIX_TARGETS.bedLufs)) * 100) / 100]);
  }
  // Keep only the points where the slope changes (piecewise linear form).
  return points.filter((p, k) => {
    if (k === 0 || k === points.length - 1) return true;
    const a = points[k - 1]!;
    const c = points[k + 1]!;
    return Math.abs((p[1] - a[1]) / (p[0] - a[0]) - (c[1] - p[1]) / (c[0] - p[0])) > 1e-6;
  });
}

export function planMix(i: MixInput): MixPlan {
  return {
    schema: 'signal.pm.mix-plan/1',
    durationFrames: i.durationFrames,
    cues: i.segments.map((s) => ({ beatId: s.beatId, atFrame: s.from })),
    voice: i.voice.map((v) => ({ id: v.id, kind: 'voice', src: v.src, from: v.from, frames: v.frames, lineId: v.lineId, gainDb: v.measuredLufs === null ? 0 : Math.round((MIX_TARGETS.narrationLufs - v.measuredLufs) * 100) / 100 })),
    sfx: (i.sfx ?? []).map((s) => ({ id: s.id, kind: 'sfx', src: s.src, from: s.from, frames: s.frames, gainDb: s.peakDbfs === null ? -12 : Math.min(0, MIX_TARGETS.sfxPeakDbfs - s.peakDbfs) })),
    music: i.music ? { src: i.music.src, gainDb: 0, curve: musicCurve(i) } : null,
    targets: MIX_TARGETS,
  };
}

/** The linear gain of a piecewise-linear dB curve at frame f (used by AudioMaster). */
export function gainAt(curve: [number, number][], f: number): number {
  if (curve.length === 0) return 1;
  let db = curve[0]![1];
  for (let k = 1; k < curve.length; k++) {
    const [f0, d0] = curve[k - 1]!;
    const [f1, d1] = curve[k]!;
    if (f <= f0) break;
    db = f >= f1 ? d1 : d0 + ((d1 - d0) * (f - f0)) / (f1 - f0);
  }
  return db <= -90 ? 0 : 10 ** (db / 20);
}

export const dbToGain = (db: number) => (db <= -90 ? 0 : 10 ** (db / 20));

/** The gain in dB of a piecewise-linear curve at frame f (−90 = silent). */
export function dbAt(curve: [number, number][], f: number): number {
  const g = gainAt(curve, f);
  return g <= 0 ? -90 : 20 * Math.log10(g);
}

/** The lines sampled for the narration-versus-bed check: first, middle and last voice clip (quality: 3 lines). */
export function sampleVoice(plan: Pick<MixPlan, 'voice'>, n = 3): StemClip[] {
  const v = plan.voice.filter((c) => c.frames > 0);
  if (v.length <= n) return v;
  return [...new Set(Array.from({ length: n }, (_, k) => Math.round((k * (v.length - 1)) / (n - 1))))].map((k) => v[k]!);
}

/** The measured window of a line: its middle 3 s (short-term loudness), or the whole line when shorter. */
export function lineWindow(c: Pick<StemClip, 'from' | 'frames'>): { from: number; frames: number } {
  const frames = Math.min(c.frames, 90);
  return { from: c.from + Math.floor((c.frames - frames) / 2), frames };
}

export interface NarrationDelta {
  lineId: string;
  frame: number;
  voiceLufs: number;
  bedLufs: number;
  deltaDb: number;
  ok: boolean;
}

/** The planned delta: narration at its planned level against the ducked bed at the window's middle frame. */
export function plannedNarrationDelta(plan: MixPlan, c: StemClip, measured: { voice: number | null; music: number | null }): NarrationDelta {
  const w = lineWindow(c);
  const mid = w.from + Math.floor(w.frames / 2);
  const voiceLufs = (measured.voice ?? MIX_TARGETS.narrationLufs - c.gainDb) + c.gainDb;
  const curve = plan.music?.curve ?? [];
  const musicDb = plan.music ? dbAt(curve, mid) : -90;
  const bedLufs = musicDb <= -90 ? -70 : (measured.music ?? MIX_TARGETS.bedLufs) + musicDb;
  const deltaDb = Math.round((voiceLufs - bedLufs) * 10) / 10;
  return { lineId: c.lineId ?? c.id, frame: mid, voiceLufs, bedLufs, deltaDb, ok: deltaDb >= MIX_TARGETS.narrationOverBedDb };
}
