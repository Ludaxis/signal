// The six segment motion presets in machine form (the animation guide owns the ids and the frame rules). Rows reference only the six curve ids and the seven transition ids.
// The layout engine (layout.ts) turns these rows plus a beat's tokens into keyframes. Pure module: no imports
// outside render/.
import type { CurveId } from './curves';

export type PresetId = 'hook' | 'story' | 'interrupt' | 'demo-chant' | 'reveal' | 'endcard';
export type TransitionId = 'cut' | 'whip-pan' | 'zoom-punch' | 'card-cut' | 'match-cut' | 'iris' | 'crossfade';
/** The recipe segment vocabulary (`RecipeBeat.segment`). */
export type SegmentId = 'hook' | 'story' | 'interrupt' | 'demo' | 'chant' | 'escalation' | 'reveal' | 'endcard' | 'other';
export type ShotId = 'wide' | 'medium' | 'close' | 'insert' | 'card';
export type LoopId = 'breath' | 'blink' | 'sway' | 'bounce-beat' | 'crowd';

export const PRESET_IDS: readonly PresetId[] = ['hook', 'story', 'interrupt', 'demo-chant', 'reveal', 'endcard'];
export const TRANSITION_IDS: readonly TransitionId[] = ['cut', 'whip-pan', 'zoom-punch', 'card-cut', 'match-cut', 'iris', 'crossfade'];
export const TRANSITION_FRAMES: Record<TransitionId, number> = { cut: 0, 'whip-pan': 7, 'zoom-punch': 4, 'card-cut': 0, 'match-cut': 0, iris: 8, crossfade: 8 };

export type FrameRef =
  | { from: 'S' | 'E'; offset: number }
  | { from: 'word' | 'land'; token: 'first' | 'each' | 'key' | 'last'; offset: number }
  | { from: 'downbeat'; every: number; offset: number }
  | { from: 'row'; row: string; edge: 'start' | 'end'; offset: number };

export interface PresetRow {
  id: string;
  element: string;
  part?: 'demo' | 'chant';
  start: FrameRef;
  frames: number | 'curve' | 'until-end' | 'gesture';
  curve: CurveId | null;
  transition?: TransitionId;
  params?: { peak?: number; frames?: number; dir?: 'reading' | 'against' };
  repeat?: 'per-token' | 'per-card' | 'per-sticker' | 'per-target' | 'every-2-beats';
  optional?: boolean;
}

export interface MotionPreset {
  id: PresetId;
  segments: SegmentId[];
  shot: ShotId;
  /** Default frames in the 85 s cut (demo-chant: demo + chant). */
  defaultFrames: number | [number, number];
  minFrames: number | [number, number];
  maxFrames: number | null;
  loops: LoopId[];
  rows: PresetRow[];
}

const S = (offset = 0): FrameRef => ({ from: 'S', offset });
const E = (offset = 0): FrameRef => ({ from: 'E', offset });
const word = (token: 'first' | 'each' | 'key' | 'last', offset: number): FrameRef => ({ from: 'word', token, offset });
const land = (token: 'first' | 'each' | 'key' | 'last', offset: number): FrameRef => ({ from: 'land', token, offset });
const row = (r: string, edge: 'start' | 'end', offset = 0): FrameRef => ({ from: 'row', row: r, edge, offset });

export const PRESETS: Record<PresetId, MotionPreset> = {
  hook: {
    id: 'hook',
    segments: ['hook'],
    shot: 'wide',
    defaultFrames: 690,
    minFrames: 180,
    maxFrames: null,
    loops: ['breath', 'blink', 'bounce-beat'],
    rows: [
      { id: 'H1', element: 'background-cast', start: S(), frames: 'until-end', curve: null },
      { id: 'H2', element: 'pov-pill', start: S(), frames: 'curve', curve: 'pop-in' },
      { id: 'H3', element: 'hook-token-first', start: word('first', -2), frames: 'curve', curve: 'pop-in' },
      { id: 'H4', element: 'hook-token', start: word('each', -2), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'H5', element: 'highlight', start: land('key', 2), frames: 5, curve: null },
      { id: 'H6', element: 'emphasis', start: land('key', 0), frames: 'curve', curve: 'punch' },
      { id: 'H7', element: 'page-exit', start: word('first', -6), frames: 'curve', curve: 'out-fast' },
      { id: 'H8', element: 'sticker', start: word('each', 0), frames: 'curve', curve: 'pop-in', repeat: 'per-sticker' },
      { id: 'H9', element: 'camera-push-in', start: S(), frames: 'curve', curve: 'settle', params: { frames: 60 }, optional: true },
      { id: 'H10', element: 'beat-guard', start: S(), frames: 0, curve: null },
    ],
  },
  story: {
    id: 'story',
    segments: ['story', 'escalation', 'other'],
    shot: 'medium',
    defaultFrames: 510,
    minFrames: 120,
    maxFrames: null,
    loops: ['breath', 'blink'],
    rows: [
      { id: 'S1', element: 'entry', start: S(), frames: 0, curve: null, transition: 'cut' },
      { id: 'S2', element: 'character-enter', start: S(), frames: 16, curve: 'settle', optional: true },
      { id: 'S3', element: 'speaker-tag', start: word('first', -3), frames: 'curve', curve: 'pop-in' },
      { id: 'S4', element: 'speech-bubble', start: word('first', -3), frames: 'curve', curve: 'pop-in' },
      { id: 'S5', element: 'bubble-token', start: word('each', -2), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'S6', element: 'gesture', start: word('key', -3), frames: 'gesture', curve: null, optional: true },
      { id: 'S7', element: 'pose-change', start: word('first', -3), frames: 16, curve: 'settle' },
      { id: 'S8', element: 'reaction-close-up', start: word('key', 0), frames: 4, curve: 'punch', transition: 'zoom-punch', optional: true },
      { id: 'S9', element: 'tag-bubble-exit', start: E(-4), frames: 'curve', curve: 'out-fast' },
      { id: 'S10', element: 'escalation-pull-back', start: S(15), frames: 60, curve: 'settle', params: { frames: 60 }, optional: true },
    ],
  },
  interrupt: {
    id: 'interrupt',
    segments: ['interrupt'],
    shot: 'card',
    defaultFrames: 210,
    minFrames: 60,
    maxFrames: 210,
    loops: [],
    rows: [
      { id: 'I1', element: 'entry', start: S(), frames: 0, curve: null, transition: 'card-cut' },
      { id: 'I2', element: 'dark-card', start: S(), frames: 'until-end', curve: null },
      { id: 'I3', element: 'question-bubble-first', start: S(6), frames: 'curve', curve: 'pop-in' },
      { id: 'I4', element: 'question-bubble', start: row('I3', 'start', 8), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'I5', element: 'question-word', start: land('key', 0), frames: 'curve', curve: 'punch' },
      { id: 'I6', element: 'hold', start: land('last', 0), frames: 'until-end', curve: null },
      { id: 'I7', element: 'bubble-exit', start: E(-4), frames: 'curve', curve: 'out-fast' },
    ],
  },
  'demo-chant': {
    id: 'demo-chant',
    segments: ['demo', 'chant'],
    shot: 'insert',
    defaultFrames: [240, 150],
    minFrames: [150, 90],
    maxFrames: null,
    loops: [],
    rows: [
      { id: 'D1', element: 'entry', part: 'demo', start: S(), frames: 8, curve: null, transition: 'iris' },
      { id: 'D2', element: 'phone-insert', part: 'demo', start: S(), frames: 16, curve: 'settle' },
      { id: 'D3', element: 'finger', part: 'demo', start: S(16), frames: 'curve', curve: 'pop-in' },
      { id: 'D4', element: 'swipe-path', part: 'demo', start: S(24), frames: 'gesture', curve: null },
      { id: 'D5', element: 'target-select', part: 'demo', start: S(24), frames: 'curve', curve: 'punch', params: { peak: 1.06 }, repeat: 'per-target' },
      { id: 'D6', element: 'feedback-sticker', part: 'demo', start: row('D4', 'end', 2), frames: 'curve', curve: 'pop-in', repeat: 'per-sticker' },
      { id: 'D7', element: 'instruction-caption', part: 'demo', start: word('each', -2), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'C1', element: 'card-cut', part: 'chant', start: { from: 'downbeat', every: 2, offset: 0 }, frames: 0, curve: null, transition: 'card-cut', repeat: 'per-card' },
      { id: 'C2', element: 'brand-word', part: 'chant', start: row('C1', 'start', 0), frames: 'curve', curve: 'pop-in', repeat: 'per-card' },
      { id: 'C3', element: 'card-hit', part: 'chant', start: { from: 'downbeat', every: 2, offset: 0 }, frames: 'curve', curve: 'punch', repeat: 'per-card' },
      { id: 'C4', element: 'card-colour', part: 'chant', start: row('C1', 'start', 0), frames: 0, curve: null, repeat: 'per-card' },
      { id: 'C5', element: 'flash-guard', part: 'chant', start: S(), frames: 0, curve: null },
    ],
  },
  reveal: {
    id: 'reveal',
    segments: ['reveal'],
    shot: 'card',
    defaultFrames: 210,
    minFrames: 60,
    maxFrames: null,
    loops: [],
    rows: [
      { id: 'R1', element: 'entry', start: S(), frames: 0, curve: null, transition: 'cut' },
      { id: 'R2', element: 'zwj-step-first', start: S(6), frames: 'curve', curve: 'pop-in' },
      { id: 'R3', element: 'zwj-step', start: S(11), frames: 5, curve: null, repeat: 'per-token' },
      { id: 'R4', element: 'full-word', start: S(6), frames: 'curve', curve: 'punch' },
      { id: 'R5', element: 'letter', start: S(6), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'R6', element: 'confetti', start: row('R4', 'start'), frames: 'until-end', curve: null },
      { id: 'R7', element: 'hold', start: row('R4', 'end'), frames: 'until-end', curve: null },
      { id: 'R8', element: 'exit', start: E(-8), frames: 8, curve: null, transition: 'crossfade' },
    ],
  },
  endcard: {
    id: 'endcard',
    segments: ['endcard'],
    shot: 'card',
    defaultFrames: 270,
    minFrames: 180,
    maxFrames: 270,
    loops: ['breath', 'blink', 'sway'],
    rows: [
      { id: 'E1', element: 'entry', start: S(), frames: 8, curve: null, transition: 'crossfade' },
      { id: 'E2', element: 'app-icon', start: S(4), frames: 16, curve: 'settle' },
      { id: 'E3', element: 'tagline-token', start: S(14), frames: 'curve', curve: 'pop-in', repeat: 'per-token' },
      { id: 'E4', element: 'sub-line', start: land('last', 6), frames: 'curve', curve: 'slide-in' },
      { id: 'E5', element: 'cta', start: row('E4', 'end', 6), frames: 'curve', curve: 'pop-in' },
      { id: 'E6', element: 'cta-pulse', start: row('E5', 'end', 0), frames: 'curve', curve: 'punch', params: { peak: 1.04 }, repeat: 'every-2-beats' },
      { id: 'E7', element: 'cast-idles', start: S(), frames: 'until-end', curve: null },
      { id: 'E8', element: 'confetti-tail', start: S(), frames: 60, curve: null },
      { id: 'E9', element: 'final-hold', start: E(-30), frames: 30, curve: null },
    ],
  },
};

/** The preset that drives a segment (roles table). */
export function presetForSegment(segment: SegmentId): PresetId {
  for (const p of PRESET_IDS) if (PRESETS[p].segments.includes(segment)) return p;
  return 'story';
}

/** Min/max frames of a segment under its preset (demo-chant binds demo and chant separately). */
export function segmentBounds(segment: SegmentId): { min: number; max: number | null } {
  const p = PRESETS[presetForSegment(segment)];
  if (p.id === 'demo-chant') {
    const mins = p.minFrames as [number, number];
    return { min: segment === 'demo' ? mins[0] : mins[1], max: p.maxFrames };
  }
  return { min: p.minFrames as number, max: p.maxFrames };
}
