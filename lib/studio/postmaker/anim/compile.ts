// The MotionSpec compiler (roles, quality bar S4): the animator's per-beat spec, placed on the frame
// grid, becomes what the renderer draws:
//   - `characters`: one solver input (`CharacterSpec`, absolute frames) per character and beat, with its
//     place from the scene anchor, its view, poses, gestures (token onset + offset), loops, eyes and hands;
// - `tracks`: per-element keyframe tracks whose every key names a curve id (camera moves `settle`, sticker
//     entries `pop-in`, pose changes and character entries `settle`, `whip-pan` `whip`, `zoom-punch` `punch`); a key's
//     curve eases from the previous key into it (anim/track.ts convention). Component motion with no curve id (iris,
//     crossfade, sticker wobble) stays a cut entry, never a key;
//   - `cuts` (each beat's entry and the spec's own cuts, with their transition and length), `swipes` (finger paths
// through UI targets at 600-900 px/s, leg lengths from `swipeLegFrames`), the lip-sync mode per line,
//     the key token per beat and the pacing events.
// Frames: 30 fps; a beat's `at.frame` is relative to its first frame S; `at: {line, token}` resolves to the token's
// onset frame from the voice word timings (lines of a beat follow each other from S, like the layout engine).
// Pure module (types only from render/; runtime imports from anim/ and render/presets).
import { swipeLegFrames } from './library/gestures';
import { POSE_BLEND_FRAMES } from './solve';
import type { CurveId } from '../render/curves';
import { poseBlendFrames, TRANSITION_FRAMES, type PresetId, type SegmentId, type ShotId, type TransitionId } from '../render/presets';
import type { AnimLoopId, CharacterSpec, EyeState, GestureId, HandShape, PoseId, Side, ViewId } from './types';

export const MOTION_FPS = 30;
/** Preset S2: a new character lands with `settle` over 16 frames. */
export const ENTER_FRAMES = 16;
/** The demo finger starts its path at S + 24 (preset). */
export const SWIPE_START = 24;
/** `pop-in` runs 9 frames (6 + 3 settle). */
export const POP_IN_FRAMES = 9;
/** `zoom-punch` rises 4 frames to the `punch` peak. */
export const ZOOM_PUNCH_PEAK = 1.08;
export const POSE_SETTLE_FRAMES = POSE_BLEND_FRAMES;

// ---- the spec (roles, as code reads it after validation) ----------------------------------------------------------

export type LipsyncMode = 'viseme' | 'vendor' | 'none';
export interface TokenRef {
  line: string;
  token: number;
}
export interface FrameAt {
  frame: number;
}
export type MotionAt = TokenRef | FrameAt;
export const isTokenRef = (a: MotionAt): a is TokenRef => typeof (a as TokenRef).line === 'string';

export interface MotionCast {
  charId: string;
  poses: { pose: PoseId; at: MotionAt }[];
  gestures: { gesture: GestureId; at: TokenRef; offsetFrames: number }[];
  loops: AnimLoopId[];
  eyes?: { state: EyeState; at: FrameAt }[];
  hands?: { side: Side; shape: HandShape; at: FrameAt }[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MotionSpecBeat {
  beatId: string;
  preset: PresetId;
  durationFrames: number;
  cast: MotionCast[];
  camera: { at: FrameAt; rect: Rect; curve: 'settle'; frames: number }[];
  stickers: { assetId: string; at: MotionAt }[];
  swipe: { targets: string[]; speedPxPerSec: number } | null;
  keyToken: TokenRef | null;
  cuts: { at: FrameAt; transition: TransitionId }[];
  lipsync: { line: string; mode: LipsyncMode }[];
}

export interface MotionSpec {
  beats: MotionSpecBeat[];
  contractNotes: string[];
}

// ---- what the compiler reads besides the spec ----------------------------------------------------------------------------

export interface WordFrames {
  token: string;
  /** Beat-relative frames: onset (inclusive) and end (exclusive). */
  start: number;
  end: number;
}
export interface LineFrames {
  id: string;
  /** Beat-relative onset of the line's audio. */
  start: number;
  ms: number;
  words: WordFrames[];
}

export interface SceneCast {
  charId: string;
  view: ViewId;
  /** The rig root (`hip` pivot) in canvas px and the full-body height in px (roles item 6). */
  anchor: { x: number; y: number; h: number };
  /** The pose the scene plan gives the character (the mock spec starts from it). */
  pose?: PoseId;
}

/** One beat as the scenes and the recipe give it (stored with the motion version so the adapter can recompile). */
export interface SceneBeat {
  id: string;
  segment: SegmentId;
  preset: PresetId;
  shot: ShotId;
  /** Null when the scenes document carries no cast list (the fake art step): every charId is then refused. */
  cast: SceneCast[] | null;
  camera: Rect;
  /** A phone frame on screen (insert shots). */
  ui: boolean;
  /** Sticker ids the scene places; null when the scenes document does not say. */
  stickers: string[] | null;
  /** Frames the beat targets when nothing is spoken (from the recipe). */
  targetFrames: number;
  techniques: string[];
}

export interface MotionBasis {
  lang: 'fa' | 'en';
  beats: SceneBeat[];
  /** Full-body rest height of each rig in rig px (place.scale = anchor.h / bodyPx); absent → 1. */
  bodyPx: Record<string, number>;
  /** The declared music grid (beat onsets from the first downbeat). */
  grid: { bpm: number; downbeatMs: number; chantBeatsPerCard: 2 | 4 } | null;
  /** Phone UI target positions in phone-local px. */
  uiTargets: Record<string, { x: number; y: number }>;
}

/** The fallback UI targets of a phone insert (the layout engine's two demo targets plus one), phone-local px. */
export const DEFAULT_UI_TARGETS: Record<string, { x: number; y: number }> = {
  'target-1': { x: 120, y: 420 },
  'target-2': { x: 300, y: 620 },
  'target-3': { x: 210, y: 760 },
};

// ---- word frames from the voice alignment ----------------------------------------------------------------------------

const frameOf = (ms: number) => Math.round((ms * MOTION_FPS) / 1000);

/** The lines of each beat with beat-relative word frames; lines follow each other in alignment order from S. */
export function linesByBeat(alignment: { lines: { id: string; beatId: string; ms: number; words: { token: string; startMs: number; endMs: number }[] }[] } | null): Map<string, LineFrames[]> {
  const out = new Map<string, LineFrames[]>();
  const base = new Map<string, number>();
  for (const l of alignment?.lines ?? []) {
    const b = base.get(l.beatId) ?? 0;
    const list = out.get(l.beatId) ?? [];
    list.push({ id: l.id, start: frameOf(b), ms: l.ms, words: l.words.map((w) => ({ token: w.token, start: frameOf(b + w.startMs), end: frameOf(b + w.endMs) })) });
    out.set(l.beatId, list);
    base.set(l.beatId, b + l.ms);
  }
  return out;
}

/** Frames the lines of a beat need: ceil(Σ lineMs × 30 / 1000) (roles, the layout engine's rule). */
export const lineBudget = (lines: readonly LineFrames[]) => (lines.length ? Math.ceil((lines.reduce((s, l) => s + l.ms, 0) * MOTION_FPS) / 1000) : 0);

/** The beat-relative onset of a token, or null when the line or token is not in this beat. */
export function tokenOnset(lines: readonly LineFrames[], at: TokenRef): number | null {
  const w = lines.find((l) => l.id === at.line)?.words[at.token];
  return w ? w.start : null;
}

/** Where `at` lands, beat-relative: a frame as given; a token at its onset plus `tokenOffset` (−3 for poses, S7). */
export function resolveAt(lines: readonly LineFrames[], at: MotionAt, tokenOffset = 0): number | null {
  if (!isTokenRef(at)) return at.frame;
  const o = tokenOnset(lines, at);
  return o === null ? null : o + tokenOffset;
}

/** The beat onsets of the declared grid in [0, total), absolute frames (render/layout.ts `beatGrid`). */
export function gridBeats(grid: MotionBasis['grid'], total: number): number[] {
  if (!grid) return [];
  const out: number[] = [];
  const msPerBeat = 60000 / grid.bpm;
  for (let j = 0; ; j++) {
    const f = frameOf(grid.downbeatMs + j * msPerBeat);
    if (f >= total) break;
    out.push(f);
  }
  return out;
}

/** A beat's entry transition when the spec names none at frame 0 (the preset's own entry row). */
export function entryTransition(b: Pick<SceneBeat, 'segment' | 'preset'>, prev: Pick<SceneBeat, 'segment' | 'ui'> | null): TransitionId {
  switch (b.preset) {
    case 'interrupt':
      return 'card-cut';
    case 'demo-chant':
      return b.segment === 'chant' ? 'card-cut' : prev?.ui ? 'cut' : 'iris';
    case 'endcard':
      return prev?.segment === 'reveal' ? 'crossfade' : 'cut';
    default:
      return 'cut';
  }
}

// ---- gesture spans (for holds and pacing) ---------------------------------------------------------------------------

/** Frames a gesture clip takes; `swipe` measures its path. */
export function gestureFrames(g: Pick<CharacterSpec['gestures'][number], 'gesture' | 'count' | 'targets' | 'speedPxPerSec'>, clipFrames: (id: GestureId) => number): number {
  if (g.gesture === 'swipe') return Math.max(1, swipeLegFrames(g.targets ?? [], g.speedPxPerSec).reduce((a, b) => a + b, 0));
  return clipFrames(g.gesture) * (g.gesture === 'clap' ? Math.max(1, g.count ?? 1) : 1);
}

// ---- the compiled output ---------------------------------------------------------------------------------------------

export interface MotionKey {
  frame: number;
  value: number | string;
  curve: CurveId;
}
export interface MotionTrack {
  /** `camera:<beat>`, `sticker:<beat>:<n>`, `char:<id>:<beat>`, `cut:<beat>:<frame>`. */
  element: string;
  prop: string;
  keys: MotionKey[];
}
export interface CompiledCut {
  beatId: string;
  frame: number;
  transition: TransitionId;
  frames: number;
}
export interface CompiledSwipe {
  beatId: string;
  from: number;
  to: number;
  speedPxPerSec: number;
  targets: { id: string; x: number; y: number; at: number }[];
}
export interface CompiledCharacter extends CharacterSpec {
  beatId: string;
}
export interface CompiledMotion {
  schema: 'signal.pm.motion-tracks/1';
  fps: 30;
  totalFrames: number;
  beats: { beatId: string; segment: SegmentId; preset: PresetId; shot: ShotId; from: number; to: number }[];
  cuts: CompiledCut[];
  characters: CompiledCharacter[];
  tracks: MotionTrack[];
  swipes: CompiledSwipe[];
  lipsync: { beatId: string; line: string; mode: LipsyncMode; from: number; to: number }[];
  keyTokens: { beatId: string; line: string; token: number; frame: number }[];
  events: { frame: number; kind: 'cut' | 'pose' | 'gesture' | 'sticker' | 'camera' }[];
}

/** Beat start frames (absolute) from the spec's durations. */
export function beatStarts(spec: Pick<MotionSpec, 'beats'>): number[] {
  const out: number[] = [];
  let f = 0;
  for (const b of spec.beats) {
    out.push(f);
    f += b.durationFrames;
  }
  return out;
}

export const totalOf = (spec: Pick<MotionSpec, 'beats'>) => spec.beats.reduce((s, b) => s + b.durationFrames, 0);

/** The solver inputs of one beat's cast (absolute frames). Unresolvable references are skipped (validation names them). */
export function castSpecs(b: MotionSpecBeat, scene: SceneBeat, S: number, lines: readonly LineFrames[], basis: Pick<MotionBasis, 'bodyPx' | 'uiTargets'>): CompiledCharacter[] {
  const out: CompiledCharacter[] = [];
  const swipeTargets = b.swipe ? b.swipe.targets.map((id) => ({ id, ...(basis.uiTargets[id] ?? { x: 0, y: 0 }) })) : [];
  for (const c of b.cast) {
    const placed = scene.cast?.find((x) => x.charId === c.charId);
    const anchor = placed?.anchor ?? { x: 540, y: 1500, h: 1000 };
    const body = basis.bodyPx[c.charId];
    const poses = c.poses
      .map((p) => ({ pose: p.pose, at: resolveAt(lines, p.at, -3) }))
      .filter((p): p is { pose: PoseId; at: number } => p.at !== null)
      .map((p) => ({ pose: p.pose, at: S + Math.max(0, p.at) }));
    const gestures = c.gestures
      .map((g) => {
        const o = tokenOnset(lines, g.at);
        if (o === null) return null;
        const at = S + o + g.offsetFrames;
        return g.gesture === 'swipe' && b.swipe ? { gesture: g.gesture, at, targets: swipeTargets, speedPxPerSec: b.swipe.speedPxPerSec } : { gesture: g.gesture, at };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
    const spec: CompiledCharacter = {
      beatId: b.beatId,
      charId: c.charId,
      from: S,
      to: S + b.durationFrames,
      place: { x: anchor.x, y: anchor.y, scale: body && body > 0 ? Math.round((anchor.h / body) * 10000) / 10000 : 1 },
      view: placed?.view ?? 'front',
      blendFrames: poseBlendFrames(b.preset),
      poses,
      gestures,
      loops: [...c.loops],
    };
    if (c.eyes?.length) spec.eyes = c.eyes.map((e) => ({ state: e.state, at: S + e.at.frame }));
    if (c.hands?.length) spec.hands = c.hands.map((h) => ({ side: h.side, shape: h.shape, at: S + h.at.frame }));
    out.push(spec);
  }
  return out;
}

/**
 * Compiles a validated spec. `scenes` must hold one entry per spec beat (same order); `lines` the word frames by
 * beat. Deterministic: the same inputs give the same output, key for key.
 */
export function compileMotion(spec: MotionSpec, basis: MotionBasis, lines: Map<string, LineFrames[]>): CompiledMotion {
  const starts = beatStarts(spec);
  const total = totalOf(spec);
  const sceneOf = new Map(basis.beats.map((b) => [b.id, b]));
  const out: CompiledMotion = { schema: 'signal.pm.motion-tracks/1', fps: 30, totalFrames: total, beats: [], cuts: [], characters: [], tracks: [], swipes: [], lipsync: [], keyTokens: [], events: [] };
  const dir = basis.lang === 'fa' ? -1 : 1; // whip 'reading': the new scene enters from the right for en, the left for fa
  let prevScene: SceneBeat | null = null;
  let prevCast = new Set<string>();
  spec.beats.forEach((b, k) => {
    const S = starts[k]!;
    const E = S + b.durationFrames;
    const scene = sceneOf.get(b.beatId)!;
    const ls = lines.get(b.beatId) ?? [];
    out.beats.push({ beatId: b.beatId, segment: scene.segment, preset: b.preset, shot: scene.shot, from: S, to: E });

    // cuts: the entry (frame 0, the spec's own when given) and the inner cuts
    const cuts = [...b.cuts].sort((x, y) => x.at.frame - y.at.frame);
    if (!cuts.some((c) => c.at.frame === 0)) cuts.unshift({ at: { frame: 0 }, transition: entryTransition(scene, prevScene) });
    for (const c of cuts) {
      const f = S + c.at.frame;
      if (f === 0) continue; // the first frame of the video is not a cut
      const frames = TRANSITION_FRAMES[c.transition];
      out.cuts.push({ beatId: b.beatId, frame: f, transition: c.transition, frames });
      out.events.push({ frame: f, kind: 'cut' });
      if (c.transition === 'whip-pan') out.tracks.push({ element: `cut:${b.beatId}:${f}`, prop: 'x', keys: [{ frame: f, value: dir * 1080, curve: 'whip' }, { frame: f + frames, value: 0, curve: 'whip' }] });
      if (c.transition === 'zoom-punch') out.tracks.push({ element: `cut:${b.beatId}:${f}`, prop: 'scale', keys: [{ frame: f, value: 1, curve: 'punch' }, { frame: f + frames, value: ZOOM_PUNCH_PEAK, curve: 'punch' }] });
    }

    // characters: solver inputs, the pose keys (settle) and a new character's entry (settle)
    const chars = castSpecs(b, scene, S, ls, basis);
    for (const c of chars) {
      out.characters.push(c);
      const el = `char:${c.charId}:${b.beatId}`;
      if (c.poses.length) out.tracks.push({ element: el, prop: 'pose', keys: c.poses.map((p) => ({ frame: p.at, value: p.pose, curve: 'settle' as const })) });
      for (const p of c.poses) if (p.at > S) out.events.push({ frame: p.at, kind: 'pose' });
      for (const g of c.gestures) out.events.push({ frame: g.at, kind: 'gesture' });
      if (b.preset === 'story' && !prevCast.has(c.charId) && k > 0) out.tracks.push({ element: el, prop: 'enter', keys: [{ frame: S, value: 0, curve: 'settle' }, { frame: S + ENTER_FRAMES, value: 1, curve: 'settle' }] });
    }

    // camera moves: from the scene's framing (or the last move) to each rect, `settle`
    let rect: Rect = scene.camera;
    const camera = [...b.camera].sort((x, y) => x.at.frame - y.at.frame);
    if (camera.length) {
      const keys: Record<'x' | 'y' | 'w' | 'h', MotionKey[]> = { x: [], y: [], w: [], h: [] };
      for (const m of camera) {
        const f = S + m.at.frame;
        for (const p of ['x', 'y', 'w', 'h'] as const) keys[p].push({ frame: f, value: rect[p], curve: 'settle' }, { frame: f + m.frames, value: m.rect[p], curve: 'settle' });
        rect = m.rect;
        out.events.push({ frame: f, kind: 'camera' });
      }
      for (const p of ['x', 'y', 'w', 'h'] as const) out.tracks.push({ element: `camera:${b.beatId}`, prop: p, keys: keys[p] });
    }

    // stickers: pop-in at the token onset or the frame
    b.stickers.forEach((s, n) => {
      const at = resolveAt(ls, s.at);
      if (at === null) return;
      const f = S + at;
      out.tracks.push({ element: `sticker:${b.beatId}:${n}`, prop: 'enter', keys: [{ frame: f, value: 0, curve: 'pop-in' }, { frame: f + POP_IN_FRAMES, value: 1, curve: 'pop-in' }] });
      out.events.push({ frame: f, kind: 'sticker' });
    });

    // the phone demo: the finger's path through the targets at the chosen speed
    if (b.swipe) {
      const pts = b.swipe.targets.map((id) => ({ id, ...(basis.uiTargets[id] ?? { x: 0, y: 0 }) }));
      const legs = swipeLegFrames(pts, b.swipe.speedPxPerSec);
      let f = S + SWIPE_START;
      const targets = pts.map((p, i) => {
        if (i > 0) f += legs[i - 1]!;
        return { id: p.id, x: p.x, y: p.y, at: f };
      });
      out.swipes.push({ beatId: b.beatId, from: S + SWIPE_START, to: targets.at(-1)!.at, speedPxPerSec: b.swipe.speedPxPerSec, targets });
    }

    // lip-sync mode per line, with the line's frames
    for (const l of b.lipsync) {
      const lf = ls.find((x) => x.id === l.line);
      if (!lf) continue;
      out.lipsync.push({ beatId: b.beatId, line: l.line, mode: l.mode, from: S + lf.start, to: S + lf.start + Math.ceil((lf.ms * MOTION_FPS) / 1000) });
    }
    if (b.keyToken) {
      const o = tokenOnset(ls, b.keyToken);
      if (o !== null) out.keyTokens.push({ beatId: b.beatId, line: b.keyToken.line, token: b.keyToken.token, frame: S + o });
    }
    prevScene = scene;
    prevCast = new Set(b.cast.map((c) => c.charId));
  });
  out.events.sort((a, b) => a.frame - b.frame || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return out;
}

/** Cut frames for the contract: every compiled cut (the first beat's entry is not a cut). */
export const cutFramesOf = (c: Pick<CompiledMotion, 'cuts'>) => [...new Set(c.cuts.map((x) => x.frame))].sort((a, b) => a - b);

// ---- timeline round trip ---------------------------------------------------------------

/** The compiled motion as the timeline carries it (`Timeline.motion`, read by the StorySpine wiring in). */
export function timelineWithMotion<T extends { durationInFrames: number }>(t: T, m: CompiledMotion): T & { motion: CompiledMotion } {
  if (t.durationInFrames !== m.totalFrames) throw new Error(`The timeline has ${t.durationInFrames} frames; the motion has ${m.totalFrames}.`);
  return { ...t, motion: m };
}

/** Reads the compiled motion back from a timeline (null when it carries none). */
export function motionOfTimeline(t: { motion?: CompiledMotion | null }): CompiledMotion | null {
  return t.motion && t.motion.schema === 'signal.pm.motion-tracks/1' ? t.motion : null;
}
