// The core easing library (ids from the animation guide). These six ids are the only easing
// ids; component motion (highlight growth, sticker wobble, ZWJ prefix steps) keeps its own definition below.
// Every function is pure and frame-based (30 fps), so the Remotion components, the layout engine and the lints
// agree frame for frame. Pure module: no imports.

export type CurveId = 'pop-in' | 'slide-in' | 'punch' | 'whip' | 'settle' | 'out-fast';
export const CURVE_IDS: readonly CurveId[] = ['pop-in', 'slide-in', 'punch', 'whip', 'settle', 'out-fast'];

export interface CurveParams {
  /** punch peak, 1.04-1.10 (default 1.08). */
  peak?: number;
  /** settle stretch, 12-60 frames (the spring is time-scaled to settle in this many frames). */
  frames?: number;
  /** whip direction: +1 = towards +x, −1 = towards −x. */
  dir?: 1 | -1;
}

export interface CurveState {
  opacity: number;
  scale: number;
  x: number;
  y: number;
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const easeOutBack = (t: number, s = 1.7) => {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
};
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const easeInQuad = (t: number) => t * t;
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

/** The `settle` spring (mass 0.6, damping 12, stiffness 180), from 0 to 1 with no initial velocity, at time t (s). */
export const SETTLE_SPRING = { mass: 0.6, damping: 12, stiffness: 180 } as const;
export function springAt(tSec: number, s: { mass: number; damping: number; stiffness: number } = SETTLE_SPRING): number {
  if (tSec <= 0) return 0;
  const w0 = Math.sqrt(s.stiffness / s.mass);
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * tSec) * (Math.cos(wd * tSec) + ((zeta * w0) / wd) * Math.sin(wd * tSec));
  }
  return 1 - Math.exp(-w0 * tSec) * (1 + w0 * tSec);
}

/** Frames until the spring stays within `threshold` of 1 (numerical, 30 fps). */
export function settleFrames(threshold = 0.005, fps = 30): number {
  let last = 0;
  for (let f = 0; f < 10 * fps; f++) if (Math.abs(springAt(f / fps) - 1) > threshold) last = f;
  return last + 1;
}

/** The natural settle length in frames (measured; roles says "about 16"). */
export const SETTLE_NATURAL_FRAMES = settleFrames();

/** A curve's own length in frames (roles "frames" column). */
export function curveFrames(id: CurveId, p: CurveParams = {}): number {
  switch (id) {
    case 'pop-in':
      return 9;
    case 'slide-in':
      return 6;
    case 'punch':
      return 7;
    case 'whip':
      return 7;
    case 'settle':
      return p.frames ?? SETTLE_NATURAL_FRAMES;
    case 'out-fast':
      return 4;
  }
}

/** Entry curves start invisible; the others act on an element already on screen. */
export const isEntry = (id: CurveId) => id === 'pop-in' || id === 'slide-in';

/**
 * The state of an element `f` frames after its curve started (f may be negative: before the start).
 * pop-in: scale 0.80 → 1.06 over 6 frames with easeOutBack(1.7), opacity 0 → 1, then 3 frames settling to 1.00.
 * slide-in: y +24 → 0, opacity 0 → 1, easeOutCubic, 6 frames. punch: 1 → peak (easeOutQuad, 3) → 1 (easeInOutSine, 4).
 * whip: x 0 → dir × 1080, easeInOutCubic, 7 frames. settle: the spring (y offset fraction, use `progress`).
 * out-fast: opacity 1 → 0 in 4 frames (easeInQuad on the fade, never linear).
 */
export function curveAt(id: CurveId, f: number, p: CurveParams = {}): CurveState {
  const rest: CurveState = { opacity: 1, scale: 1, x: 0, y: 0 };
  switch (id) {
    case 'pop-in': {
      if (f < 0) return { ...rest, opacity: 0, scale: 0.8 };
      if (f < 6) {
        const t = f / 6;
        return { ...rest, opacity: clamp01(easeOutCubic(t) * 1.25), scale: lerp(0.8, 1.06, easeOutBack(t)) };
      }
      if (f < 9) return { ...rest, scale: lerp(1.06, 1, easeInOutSine((f - 6) / 3)) };
      return rest;
    }
    case 'slide-in': {
      if (f < 0) return { ...rest, opacity: 0, y: 24 };
      const t = clamp01(f / 6);
      const e = easeOutCubic(t);
      return { ...rest, opacity: e, y: lerp(24, 0, e) };
    }
    case 'punch': {
      const peak = p.peak ?? 1.08;
      if (f < 0 || f >= 7) return rest;
      if (f < 3) return { ...rest, scale: lerp(1, peak, easeOutQuad(f / 3)) };
      return { ...rest, scale: lerp(peak, 1, easeInOutSine((f - 3) / 4)) };
    }
    case 'whip': {
      const t = clamp01(f / 7);
      return { ...rest, x: (p.dir ?? 1) * 1080 * easeInOutCubic(t) };
    }
    case 'settle':
      return { ...rest, y: 1 - settleProgress(f, p.frames) };
    case 'out-fast': {
      if (f < 0) return rest;
      return { ...rest, opacity: 1 - easeInQuad(clamp01(f / 4)) };
    }
  }
}

/** The settle spring's progress 0 → 1 at frame f, time-stretched to `frames` when given. */
export function settleProgress(f: number, frames?: number, fps = 30): number {
  if (f <= 0) return 0;
  const scale = frames ? SETTLE_NATURAL_FRAMES / frames : 1;
  return springAt((f * scale) / fps);
}

// ---- component motion (no curve id) -------------------------------------------------------------------------------

/** Highlight growth: 0 → 1 over 5 frames, easeOutCubic (starts 2 frames after the word lands). */
export const highlightProgress = (f: number) => (f <= 0 ? 0 : f >= 5 ? 1 : easeOutCubic(f / 5));

/** Sticker wobble: ±6° decaying over 12 frames. */
export const stickerWobbleDeg = (f: number) => (f < 0 || f >= 12 ? 0 : 6 * Math.sin((f / 12) * Math.PI * 3) * (1 - f / 12));

/** ZWJ prefix reveal: one step every 5 frames. */
export const ZWJ_STEP_FRAMES = 5;
