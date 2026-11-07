// The `motion:<lang>` step (roles, quality bar S4, 5.3): the animator's acting, camera and
// timing per beat within the motion presets, as a `MotionSpec`, compiled (anim/compile.ts) into the tracks the
// renderer draws.
//
// - The answer is a proposal. zod checks its shape; code then applies every Rejects rule of roles as a named
// error (`MotionSpecRejected`, one code per rule, `MOTION_REJECTS`): an id outside - or the character's rig
// (loader gives the rig's views, poses, gestures, hand shapes and eye states), linear easing, a hold under
//   8 frames, a gesture off a token onset, a transition inside a spoken word, `vendor` lip-sync on a shot that is not
//   `close` or without the owner's flag, a chant cut more than 2 frames off the declared grid, and a `totalFrames`
// change while compose is current under keep-contracts (`ExecInput.keep`). The idle rule and
//   the duration bounds of the presets apply too.
// - Mock mode plans deterministically from the preset tables, the rigs and the word timings (gestures at token onsets
//   −3 frames, `breath` and `blink` on every visible character, holds of 8 frames or more, chant cards on the grid);
//   the same validator checks that plan. Same inputs, same spec, byte for byte.
// - Live mode calls the `animator` role (opus, $1.20, 6 turns) through the injected AgentCall: the engine's is
//   `connectorCall` over claude-cli with `requireLive` (a refused call fails the step; it never turns to mock).
// - The stored document is the `MotionDoc` (beats, holds, totalFrames, cutFrames) plus the spec, what it was
//   compiled against and the compiled tracks, so compose, mix and the `motion.retimeHolds` adapter keep reading it.
// Generic core: no project, brand or character names; ids come from the pack.
import { z } from 'zod';
import {
  beatStarts,
  castSpecs,
  compileMotion,
  cutFramesOf,
  DEFAULT_UI_TARGETS,
  gridBeats,
  isTokenRef,
  lineBudget,
  linesByBeat,
  resolveAt,
  SWIPE_START,
  tokenOnset,
  totalOf,
  type CompiledMotion,
  type LineFrames,
  type MotionAt,
  type MotionBasis,
  type MotionSpec,
  type MotionSpecBeat,
  type SceneBeat,
  type SceneCast,
} from '../anim/compile';
import { CORE_GESTURES, swipeLegFrames } from '../anim/library/gestures';
import { holdLint, idleLint } from '../anim/lint';
import { EYE_STATES, GESTURE_IDS, HAND_SHAPES, LOOP_IDS, POSE_IDS, VIEWS, type AnimLoopId, type EyeState, type GestureId, type HandShape, type PoseId, type ViewId } from '../anim/types';
import { PostmakerError } from '../errors';
import { motionContract, type AlignmentDoc, type MotionDoc } from '../graph/adapters';
import { CURVE_IDS } from '../render/curves';
import { PRESETS, PRESET_IDS, presetForSegment, segmentBounds, TRANSITION_FRAMES, TRANSITION_IDS, type PresetId, type SegmentId, type ShotId, type TransitionId } from '../render/presets';
import type { ContextBundle, Contract, RigTier, StepCheck } from '../types';
import { agentEstimate, callAgent, type AgentCall } from './agent';
import type { Executor, ExecInput, ExecResult } from './types';
import { issueText, SEGMENTS } from './vocab';

// ---- the answer's shape (roles; ids are checked by the rules below so each gets its named error) --------------

const id = z.string().min(1).max(64);
const frame = z.number().int().min(-100_000).max(100_000);
const tokenAt = z.strictObject({ line: id, token: z.number().int().min(0).max(500) });
const frameAt = z.strictObject({ frame });
const at = z.union([tokenAt, frameAt]);
const castSchema = z.strictObject({
  charId: id,
  poses: z.array(z.strictObject({ pose: id, at })).max(24),
  gestures: z.array(z.strictObject({ gesture: id, at: tokenAt, offsetFrames: z.number().int().min(-60).max(60) })).max(24),
  loops: z.array(id).max(8),
  eyes: z.array(z.strictObject({ state: id, at: frameAt })).max(24).optional(),
  hands: z.array(z.strictObject({ side: z.enum(['L', 'R']), shape: id, at: frameAt })).max(24).optional(),
});
export const motionBeatSchema = z.strictObject({
  beatId: z.string().regex(/^b\d{2,3}$/),
  preset: id,
  durationFrames: z.number().int().min(1).max(20_000),
  cast: z.array(castSchema).max(8),
  camera: z.array(z.strictObject({ at: frameAt, rect: z.strictObject({ x: z.number().int().min(-4000).max(8000), y: z.number().int().min(-4000).max(8000), w: z.number().int().min(1).max(8000), h: z.number().int().min(1).max(8000) }), curve: id, frames: z.number().int().min(12).max(60) })).max(6),
  stickers: z.array(z.strictObject({ assetId: id, at })).max(12),
  swipe: z.strictObject({ targets: z.array(id).min(2).max(8), speedPxPerSec: z.number().min(600).max(900) }).nullable(),
  keyToken: tokenAt.nullable(),
  cuts: z.array(z.strictObject({ at: frameAt, transition: id })).max(24),
  lipsync: z.array(z.strictObject({ line: id, mode: id })).max(24),
});
export const motionSpecSchema = z.strictObject({
  beats: z.array(motionBeatSchema).min(1).max(60),
  contractNotes: z.array(z.string().max(300)).max(20),
});
type LooseSpec = z.infer<typeof motionSpecSchema>;

// ---- Rejects ------------------------------------------------------------------------------------------------------

/** One code per Rejects rule of roles. */
export const MOTION_REJECTS = {
  unknownId: 'motion.unknown-id',
  rig: 'motion.rig-lacks',
  linear: 'motion.linear-easing',
  hold: 'motion.hold-short',
  onset: 'motion.gesture-onset',
  inWord: 'motion.transition-in-word',
  vendor: 'motion.vendor-lipsync',
  chantGrid: 'motion.chant-off-grid',
  totalFrames: 'motion.total-frames',
} as const;
export type MotionRejectCode =
  | (typeof MOTION_REJECTS)[keyof typeof MOTION_REJECTS]
  | 'motion.beats'
  | 'motion.preset-mismatch'
  | 'motion.cast'
  | 'motion.idles'
  | 'motion.duration'
  | 'motion.frame-range'
  | 'motion.camera-curve'
  | 'motion.swipe'
  | 'motion.lipsync-lines'
  | 'motion.no-tempo';

export interface MotionIssue {
  code: MotionRejectCode;
  beatId: string | null;
  text: string;
}

export class MotionSpecRejected extends PostmakerError {
  constructor(public issues: MotionIssue[]) {
    super(422, issues[0]!.code, issues.length > 1 ? `${issues[0]!.text} (+${issues.length - 1} more)` : issues[0]!.text);
    this.name = 'MotionSpecRejected';
  }
}

// ---- what the spec is checked against --------------------------------------------------------------------------------

/** What one character's rig can perform (loader for tiers A and C; a flat tier B still shows poses only). */
export interface MotionRigCaps {
  tier: RigTier;
  views: ViewId[];
  poses: PoseId[];
  gestures: GestureId[];
  hands: HandShape[];
  eyes: EyeState[];
  /** Full-body rest height in rig px (place.scale = anchor.h / bodyPx); null = unknown. */
  bodyPx: number | null;
  /** Clip length per gesture (a pack override may change it). */
  clipFrames: Record<GestureId, number>;
}

export interface MotionWorld {
  rigs: Record<string, MotionRigCaps>;
  /** Phone UI targets (phone-local px); default DEFAULT_UI_TARGETS. */
  uiTargets?: Record<string, { x: number; y: number }>;
  /** The owner's flag for vendor lip-sync on a flagged close-up (gated; off by default). */
  vendorLipsync?: boolean;
}

export const CORE_CLIP_FRAMES = Object.fromEntries(GESTURE_IDS.map((g) => [g, CORE_GESTURES[g].frames])) as Record<GestureId, number>;

export interface MotionContext {
  basis: MotionBasis;
  lines: Map<string, LineFrames[]>;
  rigs: Record<string, MotionRigCaps>;
  vendorLipsync: boolean;
  /** keep-contracts while compose is current: the length the timeline was made with. */
  keepTotalFrames: number | null;
}

const POSE_SET = new Set<string>(POSE_IDS);
const GESTURE_SET = new Set<string>(GESTURE_IDS);
const LOOP_SET = new Set<string>(LOOP_IDS);
const EYE_SET = new Set<string>(EYE_STATES);
const HAND_SET = new Set<string>(HAND_SHAPES);
const CURVE_SET = new Set<string>(CURVE_IDS);
const PRESET_SET = new Set<string>(PRESET_IDS);
const TRANSITION_SET = new Set<string>(TRANSITION_IDS);
const LIPSYNC_SET = new Set(['viseme', 'vendor', 'none']);
const TEMPO_LOOPS = new Set(['bounce-beat', 'crowd', 'dance-A', 'dance-B']);
export const GESTURE_OFFSET = { min: -6, max: 0, default: -3 } as const;
export const CHANT_GRID_FRAMES = 2;

const clipFramesOf = (ctx: MotionContext, charId: string) => (g: GestureId) => ctx.rigs[charId]?.clipFrames[g] ?? CORE_CLIP_FRAMES[g];

/** The beats of a segment run (consecutive beats with the same segment), for the preset bounds. */
function segmentRuns(beats: readonly { segment: SegmentId }[]): { segment: SegmentId; idx: number[] }[] {
  const runs: { segment: SegmentId; idx: number[] }[] = [];
  beats.forEach((b, i) => {
    const last = runs.at(-1);
    if (last && last.segment === b.segment) last.idx.push(i);
    else runs.push({ segment: b.segment, idx: [i] });
  });
  return runs;
}

/** Applies every rule to a shape-valid answer; returns the issues (empty = the spec passes). Pure. */
export function motionSpecIssues(spec: LooseSpec | MotionSpec, ctx: MotionContext): MotionIssue[] {
  const out: MotionIssue[] = [];
  const push = (code: MotionRejectCode, beatId: string | null, text: string) => out.push({ code, beatId, text });
  const want = ctx.basis.beats.map((b) => b.id);
  if (spec.beats.map((b) => b.beatId).join(',') !== want.join(',')) {
    push('motion.beats', null, `The spec must cover the beats ${want.join(', ')} in order.`);
    return out;
  }
  const starts = beatStarts(spec as MotionSpec);
  const total = totalOf(spec as MotionSpec);
  const grid = gridBeats(ctx.basis.grid, total + 600);
  spec.beats.forEach((b, k) => {
    const scene = ctx.basis.beats[k]!;
    const lines = ctx.lines.get(b.beatId) ?? [];
    const dur = b.durationFrames;
    const B = b.beatId;
    const inBeat = (f: number) => f >= 0 && f < dur;
    const resolve = (a: MotionAt, what: string, tokenOffset = 0): number | null => {
      const f = resolveAt(lines, a as MotionAt, tokenOffset);
      if (f === null) {
        push(MOTION_REJECTS.unknownId, B, `${B}: ${what} names line ${(a as { line: string }).line} token ${(a as { token: number }).token}, which this beat does not speak.`);
        return null;
      }
      if (!inBeat(Math.max(0, f))) push('motion.frame-range', B, `${B}: ${what} at frame ${f} is outside the beat (0-${dur - 1}).`);
      return f;
    };
    const words = lines.flatMap((l) => l.words);
    const insideWord = (f: number) => words.find((w) => w.start < f && f < w.end) ?? null;

    // preset
    if (!PRESET_SET.has(b.preset)) push(MOTION_REJECTS.unknownId, B, `${B}: ${b.preset} is not a motion preset.`);
    else if (b.preset !== scene.preset) push('motion.preset-mismatch', B, `${B}: ${scene.segment} beats use the ${scene.preset} motion.`);

    // duration: at least the spoken lines
    const budget = lineBudget(lines);
    if (dur < budget) push('motion.duration', B, `${B}: ${dur} frames is shorter than its lines (${budget} frames).`);

    // cuts and transitions
    for (const c of b.cuts) {
      if (!TRANSITION_SET.has(c.transition)) {
        push(MOTION_REJECTS.unknownId, B, `${B}: ${c.transition} is not a transition.`);
        continue;
      }
      if (!inBeat(c.at.frame)) push('motion.frame-range', B, `${B}: the cut at frame ${c.at.frame} is outside the beat.`);
      // Chant cards cut on the music grid (their own rule below): a chanted word may run across them.
      if (scene.segment === 'chant' && c.transition === 'card-cut') continue;
      const len = TRANSITION_FRAMES[c.transition as TransitionId];
      for (const f of [c.at.frame, c.at.frame + len]) {
        const w = insideWord(f);
        if (w) push(MOTION_REJECTS.inWord, B, `${B}: the ${c.transition} ${f === c.at.frame ? 'starts' : 'ends'} at frame ${f}, inside the word "${w.token}" (${w.start}-${w.end}).`);
      }
    }

    // camera: settle only
    for (const m of b.camera) {
      if (/linear/i.test(m.curve)) push(MOTION_REJECTS.linear, B, `${B}: camera moves never use linear easing; use settle.`);
      else if (!CURVE_SET.has(m.curve)) push(MOTION_REJECTS.unknownId, B, `${B}: ${m.curve} is not a curve.`);
      else if (m.curve !== 'settle') push('motion.camera-curve', B, `${B}: camera moves use settle, not ${m.curve}.`);
      if (!inBeat(m.at.frame)) push('motion.frame-range', B, `${B}: the camera move at frame ${m.at.frame} is outside the beat.`);
    }

    // stickers and the key token
    for (const s of b.stickers) {
      if (scene.stickers && !scene.stickers.includes(s.assetId)) push(MOTION_REJECTS.unknownId, B, `${B}: sticker ${s.assetId} is not in this scene.`);
      resolve(s.at, `sticker ${s.assetId}`);
    }
    if (b.keyToken && tokenOnset(lines, b.keyToken) === null) push(MOTION_REJECTS.unknownId, B, `${B}: the key token names line ${b.keyToken.line} token ${b.keyToken.token}, which this beat does not speak.`);

    // the phone demo
    if (b.swipe) {
      if (!scene.ui) push('motion.swipe', B, `${B}: a swipe needs the phone on screen.`);
      const unknown = b.swipe.targets.filter((t) => !ctx.basis.uiTargets[t]);
      if (unknown.length) push(MOTION_REJECTS.unknownId, B, `${B}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a UI target' : 'are not UI targets'}.`);
      else {
        const end = SWIPE_START + swipeLegFrames(b.swipe.targets.map((t) => ({ id: t, ...ctx.basis.uiTargets[t]! })), b.swipe.speedPxPerSec).reduce((a, x) => a + x, 0);
        if (end >= dur) push('motion.swipe', B, `${B}: the swipe ends at frame ${end}, after the beat (${dur} frames).`);
      }
    }

    // lip-sync mode per line
    const seen = new Set<string>();
    for (const l of b.lipsync) {
      if (!LIPSYNC_SET.has(l.mode)) push(MOTION_REJECTS.unknownId, B, `${B}: ${l.mode} is not a lip-sync mode.`);
      if (!lines.some((x) => x.id === l.line)) push(MOTION_REJECTS.unknownId, B, `${B}: line ${l.line} is not spoken in this beat.`);
      if (l.mode === 'vendor' && (scene.shot !== 'close' || !ctx.vendorLipsync))
        push(MOTION_REJECTS.vendor, B, scene.shot !== 'close' ? `${B}: vendor lip-sync needs a close shot; this is ${scene.shot}.` : `${B}: vendor lip-sync needs the owner's flag for this close-up.`);
      seen.add(l.line);
    }
    const missing = lines.filter((l) => !seen.has(l.id)).map((l) => l.id);
    if (missing.length) push('motion.lipsync-lines', B, `${B}: choose a lip-sync mode for ${missing.join(', ')}.`);

    // the cast: exactly the scene's characters, each within its rig
    const ids = b.cast.map((c) => c.charId);
    if (scene.cast === null) {
      if (ids.length) push('motion.cast', B, `${B}: the scene has no cast; ${ids.join(', ')} cannot appear.`);
    } else {
      for (const c of ids) if (!scene.cast.some((x) => x.charId === c)) push('motion.cast', B, `${B}: ${c} is not in this scene.`);
      for (const c of scene.cast) if (!ids.includes(c.charId)) push('motion.cast', B, `${B}: ${c.charId} is on screen and needs motion.`);
    }
    if (new Set(ids).size !== ids.length) push('motion.cast', B, `${B}: a character is listed twice.`);
    for (const c of b.cast) {
      const rig = ctx.rigs[c.charId];
      if (!rig) push(MOTION_REJECTS.rig, B, `${B}: no rig is loaded for ${c.charId}.`);
      for (const p of c.poses) {
        if (!POSE_SET.has(p.pose)) push(MOTION_REJECTS.unknownId, B, `${B}: ${p.pose} is not a pose.`);
        else if (rig && !rig.poses.includes(p.pose as PoseId)) push(MOTION_REJECTS.rig, B, `${B}: ${c.charId} cannot do the ${p.pose} pose.`);
        resolve(p.at, `the ${p.pose} pose of ${c.charId}`, isTokenRef(p.at as MotionAt) ? -3 : 0);
      }
      for (const g of c.gestures) {
        if (!GESTURE_SET.has(g.gesture)) {
          push(MOTION_REJECTS.unknownId, B, `${B}: ${g.gesture} is not a gesture.`);
          continue;
        }
        if (rig && !rig.gestures.includes(g.gesture as GestureId)) push(MOTION_REJECTS.rig, B, `${B}: ${c.charId} cannot do the ${g.gesture} gesture.`);
        const o = tokenOnset(lines, g.at);
        if (o === null) push(MOTION_REJECTS.onset, B, `${B}: the ${g.gesture} of ${c.charId} names line ${g.at.line} token ${g.at.token}, which this beat does not speak.`);
        else if (g.offsetFrames < GESTURE_OFFSET.min || g.offsetFrames > GESTURE_OFFSET.max) push(MOTION_REJECTS.onset, B, `${B}: the ${g.gesture} of ${c.charId} starts ${g.offsetFrames} frames from its word; use ${GESTURE_OFFSET.min} to ${GESTURE_OFFSET.max}.`);
        else if (o + g.offsetFrames < 0) push(MOTION_REJECTS.onset, B, `${B}: the ${g.gesture} of ${c.charId} would start before the beat.`);
        if (g.gesture === 'swipe' && !b.swipe) push('motion.swipe', B, `${B}: the swipe of ${c.charId} needs the beat's swipe targets.`);
      }
      for (const l of c.loops) {
        if (!LOOP_SET.has(l)) push(MOTION_REJECTS.unknownId, B, `${B}: ${l} is not a loop.`);
        else if (TEMPO_LOOPS.has(l) && !ctx.basis.grid) push('motion.no-tempo', B, `${B}: ${l} needs a declared beat grid.`);
      }
      for (const e of c.eyes ?? []) {
        if (!EYE_SET.has(e.state)) push(MOTION_REJECTS.unknownId, B, `${B}: ${e.state} is not an eye state.`);
        else if (rig && !rig.eyes.includes(e.state as EyeState)) push(MOTION_REJECTS.rig, B, `${B}: ${c.charId} has no ${e.state} eyes.`);
        if (!inBeat(e.at.frame)) push('motion.frame-range', B, `${B}: an eye key at frame ${e.at.frame} is outside the beat.`);
      }
      for (const h of c.hands ?? []) {
        if (!HAND_SET.has(h.shape)) push(MOTION_REJECTS.unknownId, B, `${B}: ${h.shape} is not a hand shape.`);
        else if (rig && !rig.hands.includes(h.shape as HandShape)) push(MOTION_REJECTS.rig, B, `${B}: ${c.charId} has no ${h.shape} hand.`);
        if (!inBeat(h.at.frame)) push('motion.frame-range', B, `${B}: a hand key at frame ${h.at.frame} is outside the beat.`);
      }
    }

    // chant cards on the declared grid (any beat onset, ±2 frames)
    if (scene.segment === 'chant') {
      if (!grid.length) push(MOTION_REJECTS.chantGrid, B, `${B}: chant cards need a declared beat grid.`);
      else {
        const S = starts[k]!;
        const frames = [0, ...b.cuts.filter((c) => c.transition === 'card-cut').map((c) => c.at.frame)];
        for (const f of [...new Set(frames)]) {
          const off = grid.reduce((d, g) => Math.min(d, Math.abs(g - (S + f))), Infinity);
          if (off > CHANT_GRID_FRAMES) push(MOTION_REJECTS.chantGrid, B, `${B}: the chant card at frame ${S + f} is ${off} frames off the beat.`);
        }
      }
    }
  });

  // segment lengths within the preset bounds
  for (const run of segmentRuns(ctx.basis.beats)) {
    const sum = run.idx.reduce((s, i) => s + spec.beats[i]!.durationFrames, 0);
    const { min, max } = segmentBounds(run.segment);
    const first = spec.beats[run.idx[0]!]!.beatId;
    if (sum < min) push('motion.duration', first, `The ${run.segment} segment lasts ${sum} frames; it needs at least ${min}.`);
    if (max !== null && sum > max) push('motion.duration', first, `The ${run.segment} segment lasts ${sum} frames; it allows at most ${max}.`);
  }

  if (ctx.keepTotalFrames !== null && total !== ctx.keepTotalFrames) push(MOTION_REJECTS.totalFrames, null, `The video must stay ${ctx.keepTotalFrames} frames long while the timeline is kept; this spec is ${total}.`);

  // on the placed characters: idles (idleLint) and holds (only once every id is known)
  if (!out.some((i) => i.code === MOTION_REJECTS.unknownId || i.code === MOTION_REJECTS.rig || i.code === 'motion.beats')) {
    const chars = (spec as MotionSpec).beats.flatMap((b, k) => castSpecs(b, ctx.basis.beats[k]!, starts[k]!, ctx.lines.get(b.beatId) ?? [], { bodyPx: {}, uiTargets: ctx.basis.uiTargets }));
    const flat = Object.keys(ctx.rigs).filter((id) => ctx.rigs[id]!.tier === 'B');
    for (const v of idleLint(chars, { flat })) push('motion.idles', null, `${v.message}; every character on screen over 60 frames breathes and blinks.`);
    const byChar = new Map<string, typeof chars>();
    for (const c of chars) byChar.set(c.charId, [...(byChar.get(c.charId) ?? []), c]);
    for (const [charId, list] of byChar) for (const v of holdLint(list, clipFramesOf(ctx, charId))) push(MOTION_REJECTS.hold, null, `${v.message}.`);
  }
  return out;
}

/** Parses and checks an answer; throws `invalid-answer` (422) for a shape error and `MotionSpecRejected` for a rule. */
export function validateMotionSpec(raw: unknown, ctx: MotionContext): MotionSpec {
  const parsed = motionSpecSchema.safeParse(raw);
  if (!parsed.success) throw new PostmakerError(422, 'invalid-answer', issueText(parsed.error));
  const issues = motionSpecIssues(parsed.data, ctx);
  if (issues.length) throw new MotionSpecRejected(issues);
  return parsed.data as unknown as MotionSpec;
}

// ---- the context from the step's inputs ------------------------------------------------------------------------------

const DEFAULT_SHOT: Record<SegmentId, ShotId> = { hook: 'wide', story: 'medium', interrupt: 'card', demo: 'insert', chant: 'card', escalation: 'wide', reveal: 'card', endcard: 'card', other: 'medium' };
const FULL: MotionBasis['beats'][number]['camera'] = { x: 0, y: 0, w: 1080, h: 1920 };

interface SceneDocBeat {
  id?: string;
  beatId?: string;
  preset?: string;
  shot?: string;
  cast?: { charId: string; view?: string; pose?: string; anchor?: { x: number; y: number; h: number } }[];
  ui?: unknown;
  stickers?: { assetId: string }[];
  camera?: { x: number; y: number; w: number; h: number };
}

/** The scenes, recipe, voice and grid as the compiler reads them (ScenesDoc from, or the fake's beats). */
export function motionBasis(i: Pick<ExecInput, 'recipe' | 'byPort' | 'lang' | 'params'>, world: Pick<MotionWorld, 'rigs' | 'uiTargets'>): MotionBasis {
  const scenes = ((i.byPort.scenes as { beats?: SceneDocBeat[] } | null)?.beats ?? []) as SceneDocBeat[];
  const byId = new Map(scenes.map((s) => [s.beatId ?? s.id ?? '', s]));
  const beats: SceneBeat[] = i.recipe.beats.map((rb) => {
    const segment = ((SEGMENTS as readonly string[]).includes(rb.segment) ? rb.segment : 'other') as SegmentId;
    const s = byId.get(rb.id);
    const preset = (s?.preset && PRESET_SET.has(s.preset) ? s.preset : presetForSegment(segment)) as PresetId;
    const cast: SceneCast[] | null = Array.isArray(s?.cast)
      ? s!.cast.map((c) => ({ charId: c.charId, view: ((VIEWS as readonly string[]).includes(c.view ?? '') ? c.view : 'front') as ViewId, anchor: c.anchor ?? { x: 540, y: 1500, h: 1000 }, ...(c.pose && POSE_SET.has(c.pose) ? { pose: c.pose as PoseId } : {}) }))
      : null;
    return {
      id: rb.id,
      segment,
      preset,
      shot: (s?.shot ?? DEFAULT_SHOT[segment]) as ShotId,
      cast,
      camera: s?.camera ? { x: s.camera.x, y: s.camera.y, w: s.camera.w, h: s.camera.h } : FULL,
      ui: Boolean(s?.ui) || (s?.shot ?? DEFAULT_SHOT[segment]) === 'insert',
      stickers: Array.isArray(s?.stickers) ? s!.stickers.map((x) => x.assetId) : null,
      targetFrames: Math.max(1, Math.round((rb.end - rb.start) * 30)),
      techniques: [...rb.techniques],
    };
  });
  const g = (i.byPort.beatGrid as { bpm?: number; downbeatMs?: number } | null) ?? i.recipe.tempo ?? null;
  const n = i.params.chantBeatsPerCard === 4 ? 4 : 2;
  const bodyPx: Record<string, number> = {};
  for (const [c, r] of Object.entries(world.rigs)) if (r.bodyPx) bodyPx[c] = r.bodyPx;
  return {
    lang: i.lang === 'fa' ? 'fa' : 'en',
    beats,
    bodyPx,
    grid: g && typeof g.bpm === 'number' && g.bpm > 0 ? { bpm: g.bpm, downbeatMs: g.downbeatMs ?? 0, chantBeatsPerCard: n } : null,
    uiTargets: world.uiTargets ?? DEFAULT_UI_TARGETS,
  };
}

export function motionContext(i: Pick<ExecInput, 'recipe' | 'byPort' | 'lang' | 'params' | 'keep'>, world: MotionWorld): MotionContext {
  return {
    basis: motionBasis(i, world),
    lines: linesByBeat(i.byPort.alignment as AlignmentDoc | null),
    rigs: world.rigs,
    vendorLipsync: world.vendorLipsync === true,
    keepTotalFrames: typeof i.keep?.totalFrames === 'number' ? i.keep.totalFrames : null,
  };
}

// ---- the deterministic spec (mock) ------------------------------------------------------------------------------------

/** The gesture a mock spec plays on the key token, per segment (only when the rig can). */
const MOCK_GESTURE: Partial<Record<SegmentId, GestureId>> = { hook: 'gasp', story: 'point', escalation: 'jump', other: 'nod' };
const STICKER_GAP = 20;

function mockDurations(ctx: MotionContext, o: { seed: number; holdFrames?: number; previous?: MotionSpec | null }): number[] {
  const beats = ctx.basis.beats;
  const hold = o.holdFrames ?? 12 + (o.seed % 3);
  const budget = beats.map((b) => lineBudget(ctx.lines.get(b.id) ?? []));
  const dur = beats.map((b, k) => ((ctx.lines.get(b.id) ?? []).length ? budget[k]! + hold : b.targetFrames));
  for (const run of segmentRuns(beats)) {
    const { min, max } = segmentBounds(run.segment);
    const last = run.idx.at(-1)!;
    const sum = run.idx.reduce((s, i) => s + dur[i]!, 0);
    if (sum < min) dur[last] = dur[last]! + (min - sum);
    else if (max !== null && sum > max) dur[last] = Math.max(budget[last]!, dur[last]! - (sum - max));
  }
  // chant cards start on the grid: the beat before a chant beat absorbs the offset
  const grid = gridBeats(ctx.basis.grid, dur.reduce((a, b) => a + b, 0) + 1200);
  beats.forEach((b, k) => {
    if (b.segment !== 'chant' || k === 0 || !grid.length) return;
    const S = dur.slice(0, k).reduce((a, x) => a + x, 0);
    const g = grid.find((f) => f >= S);
    if (g !== undefined && g > S) dur[k - 1] = dur[k - 1]! + (g - S);
  });
  // keep-contracts: the timeline's length stays (the previous lengths first, then the last beat absorbs the rest)
  if (ctx.keepTotalFrames !== null) {
    const prev = o.previous?.beats;
    if (prev && prev.length === beats.length && prev.every((p, k) => p.beatId === beats[k]!.id && p.durationFrames >= budget[k]!)) prev.forEach((p, k) => (dur[k] = p.durationFrames));
    const diff = ctx.keepTotalFrames - dur.reduce((a, b) => a + b, 0);
    const last = beats.length - 1;
    if (diff !== 0 && last >= 0) dur[last] = Math.max(budget[last]!, dur[last]! + diff);
  }
  return dur;
}

/**
 * A spec from the preset tables, the rigs and the word timings alone: every scene character in its scene pose with
 * `breath` and `blink` (plus the preset's beat loops when a grid exists), one gesture on the key token at its onset
 * −3 frames when the rig can play it, stickers on word onsets at least 20 frames apart, the phone swipe through the
 * first two UI targets at 750 px/s, chant cards on every n-th grid beat, and a lip-sync mode per line.
 */
export function mockMotionSpec(ctx: MotionContext, o: { seed: number; holdFrames?: number; previous?: MotionSpec | null }): MotionSpec {
  const durations = mockDurations(ctx, o);
  const grid = gridBeats(ctx.basis.grid, durations.reduce((a, b) => a + b, 0) + 1200);
  let S = 0;
  const beats: MotionSpecBeat[] = ctx.basis.beats.map((scene, k) => {
    const dur = durations[k]!;
    const lines = ctx.lines.get(scene.id) ?? [];
    const first = lines.find((l) => l.words.length) ?? null;
    const keyToken = first ? { line: first.id, token: first.words.length - 1 } : null;
    const presetLoops = PRESETS[scene.preset].loops.filter((l) => l !== 'breath' && l !== 'blink' && (!TEMPO_LOOPS.has(l) || ctx.basis.grid));
    const cast = (scene.cast ?? []).map((c, n) => {
      const rig = ctx.rigs[c.charId];
      const pose: PoseId = rig ? ([c.pose, 'neutral'].find((p): p is PoseId => !!p && rig.poses.includes(p as PoseId)) ?? rig.poses[0] ?? 'neutral') : 'neutral';
      const loops: AnimLoopId[] = ['breath', 'blink'];
      if (scene.segment === 'escalation' && ctx.basis.grid) loops.push(n === 0 ? 'bounce-beat' : 'crowd');
      else for (const l of presetLoops) if (!loops.includes(l as AnimLoopId)) loops.push(l as AnimLoopId);
      const gesture = MOCK_GESTURE[scene.segment];
      const gestures: MotionSpecBeat['cast'][number]['gestures'] = [];
      if (n === 0 && gesture && keyToken && rig?.gestures.includes(gesture)) {
        const onset = tokenOnset(lines, keyToken)!;
        if (onset + GESTURE_OFFSET.default >= 0) gestures.push({ gesture, at: keyToken, offsetFrames: GESTURE_OFFSET.default });
      }
      return { charId: c.charId, poses: [{ pose, at: { frame: 0 } }], gestures, loops };
    });
    const words = lines.flatMap((l) => l.words.map((w, t) => ({ line: l.id, token: t, start: w.start })));
    const used: number[] = [];
    const stickers = (scene.stickers ?? []).map((assetId, n) => {
      const w = words.find((x) => x.start >= STICKER_GAP && x.start < dur && used.every((f) => Math.abs(x.start - f) >= STICKER_GAP));
      if (w) {
        used.push(w.start);
        return { assetId, at: { line: w.line, token: w.token } };
      }
      const f = Math.min(dur - 1, STICKER_GAP * (n + 1));
      used.push(f);
      return { assetId, at: { frame: f } };
    });
    const targets = Object.keys(ctx.basis.uiTargets).sort().slice(0, 2);
    const swipe = scene.ui && scene.segment === 'demo' && targets.length === 2 ? { targets, speedPxPerSec: 750 } : null;
    const cuts: MotionSpecBeat['cuts'] = [];
    if (scene.segment === 'chant' && ctx.basis.grid) {
      const n = ctx.basis.grid.chantBeatsPerCard;
      const j0 = grid.findIndex((g) => g >= S - CHANT_GRID_FRAMES);
      for (let j = j0 + n; j0 >= 0 && j < grid.length; j += n) {
        const f = grid[j]! - S;
        if (f + 30 > dur + CHANT_GRID_FRAMES) break;
        cuts.push({ at: { frame: f }, transition: 'card-cut' });
      }
    }
    const tierA = scene.cast?.[0] ? ctx.rigs[scene.cast[0].charId]?.tier === 'A' : false;
    const talking = scene.techniques.includes('dialogue') || scene.techniques.includes('lip-sync-close-up');
    const lipsync = lines.map((l) => ({ line: l.id, mode: (tierA && talking && scene.shot !== 'wide' ? 'viseme' : 'none') as 'viseme' | 'none' }));
    const out: MotionSpecBeat = { beatId: scene.id, preset: scene.preset, durationFrames: dur, cast, camera: [], stickers, swipe, keyToken, cuts, lipsync };
    S += dur;
    return out;
  });
  return { beats, contractNotes: [] };
}

// ---- the stored document and its contract ------------------------------------------------------------------------------

/** `motion.<lang>.json`: the MotionDoc plus the spec, what it was compiled against and the compiled tracks. */
export interface MotionStepDoc extends MotionDoc {
  schema: 'signal.pm.motion/1';
  lang: 'fa' | 'en';
  /** Who wrote the spec: the animator's answer, or the deterministic plan. */
  source: 'animator' | 'mock';
  spec: MotionSpec;
  basis: MotionBasis;
  /** The rig capabilities and the vendor flag the spec was checked against (the adapter checks again with them). */
  world: { rigs: Record<string, MotionRigCaps>; vendorLipsync: boolean };
  compiled: CompiledMotion;
}

export const isMotionStepDoc = (d: unknown): d is MotionStepDoc => Boolean(d && typeof d === 'object' && (d as { schema?: string }).schema === 'signal.pm.motion/1');

export function motionStepDoc(spec: MotionSpec, ctx: MotionContext, source: MotionStepDoc['source']): MotionStepDoc {
  const compiled = compileMotion(spec, ctx.basis, ctx.lines);
  const starts = beatStarts(spec);
  return {
    schema: 'signal.pm.motion/1',
    fps: 30,
    beats: spec.beats.map((b, k) => {
      const lines = ctx.lines.get(b.beatId) ?? [];
      return { id: b.beatId, startFrame: starts[k]!, endFrame: starts[k]! + b.durationFrames, holdFrames: lines.length ? b.durationFrames - lineBudget(lines) : 0, lines: lines.map((l) => l.id) };
    }),
    totalFrames: compiled.totalFrames,
    cutFrames: cutFramesOf(compiled),
    lang: ctx.basis.lang,
    source,
    spec,
    basis: ctx.basis,
    world: { rigs: ctx.rigs, vendorLipsync: ctx.vendorLipsync },
    compiled,
  };
}

/** The checks an issue list becomes on a version (the adapter's re-check; required, so the version needs you). */
export const issueChecks = (issues: readonly MotionIssue[], nodeId: string): StepCheck[] =>
  issues.length
    ? issues.slice(0, 12).map((x, n) => ({ id: `${nodeId}:${x.code}:${n}`, ok: false, required: true, text: x.text, ...(x.beatId ? { evidence: x.beatId } : {}) }))
    : [{ id: `${nodeId}:motion.spec`, ok: true, required: true, text: 'Every beat moves within its preset, on its word onsets and the beat grid.' }];

/**
 * `motion.retimeHolds` on a compiled document: each spoken beat refits to its new lines and keeps its hold, a silent
 * beat keeps its length (the rule), the spec takes the new lengths, the rules run again with the same rigs
 * and the tracks are compiled again, so the adapted version is what the executor would store for the same spec.
 */
export function retimeMotionDoc(current: MotionStepDoc, alignment: AlignmentDoc, nodeId = 'motion'): { doc: MotionStepDoc; checks: StepCheck[] } {
  const lines = linesByBeat(alignment);
  const lengths = new Map(current.beats.map((b) => [b.id, (lines.get(b.id) ?? []).length ? lineBudget(lines.get(b.id)!) + b.holdFrames : b.endFrame - b.startFrame]));
  const spec: MotionSpec = { ...current.spec, beats: current.spec.beats.map((b) => ({ ...b, durationFrames: lengths.get(b.beatId) ?? b.durationFrames })) };
  const ctx: MotionContext = { basis: current.basis, lines, rigs: current.world.rigs, vendorLipsync: current.world.vendorLipsync, keepTotalFrames: null };
  const issues = motionSpecIssues(spec, ctx);
  const doc = motionStepDoc(spec, ctx, current.source);
  // the holds the doc records stay the ones it had (a refit never changes them)
  doc.beats = doc.beats.map((b) => ({ ...b, holdFrames: current.beats.find((x) => x.id === b.id)?.holdFrames ?? b.holdFrames }));
  return { doc, checks: issueChecks(issues, nodeId) };
}

// ---- the agent call --------------------------------------------------------------------------------------------------

export const MOTION_TASK =
  'Write the MotionSpec for every beat in the input, in order: the motion preset that drives its segment, its length in frames, the acting of every character on screen (poses, gestures on word onsets, loops, eye and hand keys within its rig), camera moves, sticker timing, the phone swipe on demo beats, the key token, cuts with their transitions and a lip-sync mode for every spoken line. Use only the ids you are given. Keep every rule in downstream.';
export const MOTION_OUTPUT_SPEC =
  'One JSON object: { "beats": [{ "beatId": "b01", "preset": "hook|story|interrupt|demo-chant|reveal|endcard", "durationFrames": 180, "cast": [{ "charId": "<id>", "poses": [{ "pose": "<pose id>", "at": { "frame": 0 } }], "gestures": [{ "gesture": "<gesture id>", "at": { "line": "l01", "token": 4 }, "offsetFrames": -3 }], "loops": ["breath", "blink"], "eyes": [{ "state": "<eye state>", "at": { "frame": 40 } }], "hands": [{ "side": "R", "shape": "<hand shape>", "at": { "frame": 40 } }] }], "camera": [{ "at": { "frame": 60 }, "rect": { "x": 0, "y": 0, "w": 1080, "h": 1920 }, "curve": "settle", "frames": 30 }], "stickers": [{ "assetId": "<id>", "at": { "line": "l01", "token": 2 } }], "swipe": null, "keyToken": { "line": "l01", "token": 4 }, "cuts": [{ "at": { "frame": 0 }, "transition": "cut" }], "lipsync": [{ "line": "l01", "mode": "viseme|vendor|none" }] }], "contractNotes": [] }';

/** The input the animator reads (trusted): beats with their lines as word frames, the cast with its rig, the grid. */
function agentParams(ctx: MotionContext) {
  const bounds = (s: SegmentId) => segmentBounds(s);
  return {
    fps: 30,
    canvas: { width: 1080, height: 1920 },
    lang: ctx.basis.lang,
    beats: ctx.basis.beats.map((b) => {
      const lines = ctx.lines.get(b.id) ?? [];
      return {
        beatId: b.id,
        segment: b.segment,
        preset: b.preset,
        shot: b.shot,
        segmentFrames: bounds(b.segment),
        linesFrames: lineBudget(lines),
        targetFrames: b.targetFrames,
        lines: lines.map((l) => ({ line: l.id, start: l.start, tokens: l.words.map((w, t) => ({ token: t, text: w.token, onset: w.start, end: w.end })) })),
        cast: (b.cast ?? []).map((c) => ({ charId: c.charId, view: c.view, ...(ctx.rigs[c.charId] ? { tier: ctx.rigs[c.charId]!.tier, poses: ctx.rigs[c.charId]!.poses, gestures: ctx.rigs[c.charId]!.gestures, hands: ctx.rigs[c.charId]!.hands, eyes: ctx.rigs[c.charId]!.eyes } : { rig: null }) })),
        stickers: b.stickers ?? [],
        phone: b.ui,
      };
    }),
    loops: LOOP_IDS,
    transitions: TRANSITION_IDS,
    uiTargets: Object.keys(ctx.basis.uiTargets).sort(),
    grid: ctx.basis.grid ? { ...ctx.basis.grid, beatFrames: gridBeats(ctx.basis.grid, 2400).slice(0, 80) } : null,
    vendorLipsync: ctx.vendorLipsync,
    keepTotalFrames: ctx.keepTotalFrames,
  };
}

/** The animator's bundle: the runner's bundle with the fixed task, the trusted params, the kept length and the spec. */
export function motionBundle(i: Pick<ExecInput, 'context' | 'node' | 'lang'>, ctx: MotionContext): ContextBundle {
  const base: ContextBundle = i.context ?? { task: '', node: { id: i.node.id, kind: 'motion', lang: i.lang, params: {} }, upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {}, outputSpec: '' };
  const downstream: ContextBundle['downstream'] =
    ctx.keepTotalFrames !== null ? [...base.downstream, { nodeId: `compose:${ctx.basis.lang}`, rules: [{ id: 'motion.totalFrames.exact', label: 'Same video length', key: 'totalFrames', tolerance: 'exact', current: ctx.keepTotalFrames }] }] : base.downstream;
  return { ...base, task: [MOTION_TASK, base.task].filter(Boolean).join('\n\n'), node: { ...base.node, params: { ...base.node.params, ...agentParams(ctx) } }, downstream, outputSpec: MOTION_OUTPUT_SPEC };
}

// ---- the executor ----------------------------------------------------------------------------------------------------

export interface MotionDeps {
  call?: AgentCall | null;
  billing?: 'subscription' | 'api-key';
  /** The rigs (and UI targets, vendor flag) for this run; null = no project pack, so the step keeps its fake. */
  world: (i: ExecInput) => Promise<MotionWorld | null>;
  /** The step without a pack (the fake). */
  fallback?: Executor;
}

export const MOTION_IMPL_VERSION = 'motion@2';

export function motionExecutor(deps: MotionDeps): Executor {
  return {
    kind: 'motion',
    implVersion: MOTION_IMPL_VERSION,
    deterministic: false,
    estimate: (e) => agentEstimate(e.mode, deps.billing, 1.2, 90),
    async run(i): Promise<ExecResult> {
      const world = await deps.world(i);
      if (!world) {
        if (deps.fallback) return deps.fallback.run(i);
        throw new PostmakerError(409, 'needs_you', 'Animation needs a project pack.');
      }
      const ctx = motionContext(i, world);
      let raw: unknown;
      let costUsd: number | null = 0;
      let model: string | null = 'mock';
      let source: MotionStepDoc['source'] = 'mock';
      if (i.mode === 'mock') {
        const prev = i.previous?.data.motion;
        raw = mockMotionSpec(ctx, { seed: i.seed, holdFrames: typeof i.params.holdFrames === 'number' ? i.params.holdFrames : undefined, previous: isMotionStepDoc(prev) ? prev.spec : null });
      } else {
        const r = await callAgent({ agent: 'animator', kind: 'motion', bundle: motionBundle(i, ctx), call: deps.call ?? null, signal: i.signal, validate: (v) => v });
        raw = r.value;
        costUsd = r.costUsd;
        model = r.model;
        source = 'animator';
      }
      let spec: MotionSpec;
      try {
        spec = validateMotionSpec(raw, ctx);
      } catch (e) {
        // the call was billed even though its answer is unusable: the cost travels with the error
        if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = costUsd;
        throw e;
      }
      const doc = motionStepDoc(spec, ctx, source);
      return {
        outputs: [{ port: 'motion', name: `motion.${doc.lang}.json`, kind: 'json', mime: 'application/json', ...(i.lang ? { lang: i.lang } : {}), data: doc }],
        provides: motionContract(doc),
        checks: issueChecks([], i.node.id),
        status: 'ok',
        costUsd,
        model,
      };
    },
    contractOf: (data): Contract => motionContract(data.motion as MotionDoc),
  };
}
