// Loudness: master at −14 LUFS integrated ±1 and ≤ −1.0 dBTP; narration at least 8 dB above
// the music bed (short-term) while speaking. Input: the ffmpeg `loudnorm=print_format=json` print of the master (the
// mix step or the render child measures it with the bundled ffmpeg) or the master's `meta.lufs`.
import { t } from '@/app/studio/copy/en';

export const TARGET_LUFS = -14;
export const LUFS_TOLERANCE = 1;
export const MAX_TRUE_PEAK = -1;
export const MIN_NARRATION_DELTA_DB = 8;

export interface LoudnessMeasure {
  i: number;
  tp: number | null;
  lra: number | null;
}

/** The JSON block ffmpeg's loudnorm prints at the end of stderr; null when absent or unreadable. */
export function parseLoudnorm(stderr: string): LoudnessMeasure | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const num = (k: string) => (j[k] !== undefined && Number.isFinite(Number(j[k])) ? Number(j[k]) : null);
    const i = num('input_i');
    if (i === null) return null;
    return { i, tp: num('input_tp'), lra: num('input_lra') };
  } catch {
    return null;
  }
}

export interface LoudnessReport {
  ok: boolean;
  reasons: string[];
}

export function loudnessCheck(m: LoudnessMeasure): LoudnessReport {
  const reasons: string[] = [];
  if (Math.abs(m.i - TARGET_LUFS) > LUFS_TOLERANCE) reasons.push(t('check.loudness.off', { lufs: m.i.toFixed(1) }));
  if (m.tp === null || m.tp > MAX_TRUE_PEAK) reasons.push(t('check.loudness.peak', { tp: m.tp === null ? '?' : m.tp.toFixed(1) }));
  return { ok: reasons.length === 0, reasons };
}

/** Narration-versus-bed short-term deltas at sampled lines; every one must be ≥ 8 dB. */
export function narrationDeltaCheck(samples: readonly { lineId: string; narrationLufs: number; bedLufs: number }[]): { ok: boolean; worst: { lineId: string; delta: number } | null } {
  let worst: { lineId: string; delta: number } | null = null;
  for (const s of samples) {
    const delta = Math.round((s.narrationLufs - s.bedLufs) * 10) / 10;
    if (!worst || delta < worst.delta) worst = { lineId: s.lineId, delta };
  }
  return { ok: worst !== null && worst.delta >= MIN_NARRATION_DELTA_DB, worst };
}
