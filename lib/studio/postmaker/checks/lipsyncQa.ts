// Lip-sync QA per line: cross-correlate the mouth-openness trace (sprite class → openness, or the
// vendor video's mouth-region luminance variance) with the audio RMS envelope, one value per frame. Peak lag ≤ 1
// frame; the mouth is off rest on ≥ 80 % of voiced frames. On failure the step falls back once (vendor → viseme on a
// Tier A rig, otherwise → none) and records the reason (free local fallbacks are automatic).
import { t } from '@/app/studio/copy/en';
import type { RigTier } from '../types';

export const MAX_LAG_FRAMES = 1;
export const MIN_COVERAGE = 0.8;
const REST = 0.05;

export interface LipsyncLine {
  lineId: string;
  mode: 'viseme' | 'vendor' | 'none';
  mouth: number[];
  rms: number[];
  /** RMS above this is a voiced frame (default 10 % of the line's peak). */
  voicedAbove?: number;
}

export interface LipsyncLineReport {
  lineId: string;
  lag: number;
  coverage: number;
  ok: boolean;
  reasons: string[];
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The lag (in frames, mouth relative to audio) with the highest normalised cross-correlation, within ±maxLag. */
export function peakLag(mouth: readonly number[], rms: readonly number[], maxLag = 6): number {
  const n = Math.min(mouth.length, rms.length);
  const ma = mean(mouth.slice(0, n));
  const ra = mean(rms.slice(0, n));
  let best = { lag: 0, r: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let dm = 0;
    let dr = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      const a = mouth[j]! - ma;
      const b = rms[i]! - ra;
      num += a * b;
      dm += a * a;
      dr += b * b;
    }
    const r = dm && dr ? num / Math.sqrt(dm * dr) : -Infinity;
    if (r > best.r + 1e-12 || (Math.abs(r - best.r) <= 1e-12 && Math.abs(lag) < Math.abs(best.lag))) best = { lag, r };
  }
  return best.lag;
}

export function lipsyncLineQa(l: LipsyncLine): LipsyncLineReport {
  if (l.mode === 'none') return { lineId: l.lineId, lag: 0, coverage: 1, ok: true, reasons: [] };
  const n = Math.min(l.mouth.length, l.rms.length);
  const peak = Math.max(0, ...l.rms.slice(0, n));
  const thr = l.voicedAbove ?? peak * 0.1;
  let voiced = 0;
  let open = 0;
  for (let i = 0; i < n; i++)
    if (l.rms[i]! > thr) {
      voiced++;
      if (l.mouth[i]! > REST) open++;
    }
  const coverage = voiced ? Math.round((open / voiced) * 1000) / 1000 : 0;
  const lag = peakLag(l.mouth, l.rms);
  const reasons: string[] = [];
  if (Math.abs(lag) > MAX_LAG_FRAMES) reasons.push(t('check.lipsync.lag', { line: l.lineId, lag: Math.abs(lag) }));
  if (coverage < MIN_COVERAGE) reasons.push(t('check.lipsync.coverage', { line: l.lineId, pct: Math.round(coverage * 100) }));
  return { lineId: l.lineId, lag, coverage, ok: reasons.length === 0, reasons };
}

/** The one fallback after a failed line: vendor → viseme on Tier A, vendor → none otherwise; viseme → none. */
export function lipsyncFallback(mode: LipsyncLine['mode'], tier: RigTier): LipsyncLine['mode'] | null {
  if (mode === 'vendor') return tier === 'A' ? 'viseme' : 'none';
  if (mode === 'viseme') return 'none';
  return null;
}
