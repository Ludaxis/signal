// The solver: pose + gestures + loops → per-frame part transforms for one character (quality bar -).
// Deterministic: the same rig, spec and seed give byte-identical frames (numbers rounded to 4 decimals). Layers, in
// order, on each part channel (rotation and offsets add, scales multiply):
// 1. the pose (blended into from the previous one with `settle` over the preset table's blend,: `spec.blendFrames`,
//      else the table's story row; dance loops key a pose per beat);
//   2. active gestures (keys relative to the pose; `side: 'L'` mirrors a clip; point and gasp hold their end);
//   3. loops (breath, sway, bounce-beat or crowd), the seeded blink on the eye channel;
//   4. the view turn: a 2-frame swap hidden in a head turn (4° and a 0.97 squash on the swap frame);
//   5. limit clamping: every rotation stays inside its part's `limits.rot`.
// Then world matrices: M(part) = M(parent) · T(anchor) · T(x, y) · R(rot) · S(sx, sy) · T(−pivot), the root placed at
// `spec.place`. Pure module (no runtime imports outside anim/, render/curves and the pure render/presets table), so
// CutoutCharacter can run it.
import { swipeAt, swipeFrames } from './library/gestures';
import { coreLibraryPure } from './library/core';
import { mirrorPose } from './library/poses';
import { blinkEyeAt, blinkSchedule, bounceTracks, breathAmount, breathPhase, BREATH_HEAD_PX, BREATH_SCALE, crowdOffset, danceKeys, swayAt, type BeatTracks, type DanceKey } from './loops';
import { evalKeys, evalState, round4, type NumKey } from './track';
import { easeOf } from './ease';
import { poseBlendFrames } from '../render/presets';
import {
  CHANNELS,
  type Channel,
  type CharacterLibrary,
  type CharacterSpec,
  type CutoutRig,
  type EyeState,
  type GestureDef,
  type HandShape,
  type Matrix,
  type MouthState,
  type PartKeys,
  type PoseDef,
  type RigPart,
  type Side,
  type SolveContext,
  type SolvedFrame,
  type SolvedPart,
  type ViewId,
} from './types';

/** The blend of a spec that names no preset (read from the preset table, never a fixed number here). */
export const POSE_BLEND_FRAMES = poseBlendFrames();
export const VIEW_TURN = { deg: 4, squash: 0.97 } as const;
const PUPIL_VISIBLE = new Set(['open', 'half', 'wide']);
const BLINKABLE = new Set(['open', 'wide', 'half']);

type Values = Record<Channel, number>;
const REST: Values = { rot: 0, x: 0, y: 0, sx: 1, sy: 1 };
const isScale = (c: Channel) => c === 'sx' || c === 'sy';

const mirrorName = (n: string) => (n.endsWith('_R') ? `${n.slice(0, -2)}_L` : n.endsWith('_L') ? `${n.slice(0, -2)}_R` : n);

// ---- matrices --------------------------------------------------------------------------------------------------------

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function mul(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const rotate = (deg: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
export const scale = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0];
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The local matrix of a part relative to its parent's px box. */
export const localMatrix = (p: Pick<RigPart, 'anchor' | 'pivot'>, v: Values): Matrix =>
  mul(mul(mul(translate(p.anchor[0] + v.x, p.anchor[1] + v.y), rotate(v.rot)), scale(v.sx, v.sy)), translate(-p.pivot[0], -p.pivot[1]));

/** Parts of a view, parents before children. */
export function viewParts(rig: CutoutRig, view: ViewId): RigPart[] {
  const parts = rig.parts.filter((p) => p.view === view);
  const byName = new Map(parts.map((p) => [p.name, p]));
  const out: RigPart[] = [];
  const seen = new Set<string>();
  const visit = (p: RigPart, depth: number) => {
    if (seen.has(p.name) || depth > parts.length) return;
    if (p.parent && byName.has(p.parent)) visit(byName.get(p.parent)!, depth + 1);
    seen.add(p.name);
    out.push(p);
  };
  for (const p of parts) visit(p, 0);
  return out;
}

/** World matrices of every part of a view for the given channel values (missing parts at rest). */
export function worldMatrices(rig: CutoutRig, view: ViewId, values: (name: string) => Values, place: CharacterSpec['place']): Map<string, Matrix> {
  const out = new Map<string, Matrix>();
  const base = mul(translate(place.x, place.y), scale(place.scale, place.scale));
  for (const p of viewParts(rig, view)) {
    // the root (and a part whose parent is missing, which validateRig refuses) hangs from the placement
    const parent = p.parent ? out.get(p.parent) : undefined;
    out.set(p.name, parent ? mul(parent, localMatrix(p, values(p.name))) : mul(base, localMatrix({ anchor: [0, 0], pivot: p.pivot }, values(p.name))));
  }
  return out;
}

// ---- preparing a character -------------------------------------------------------------------------------------------

interface ActiveGesture {
  at: number;
  until: number; // exclusive end of its effect (clip end, or the hold's end)
  frames: number;
  clipFrames: number; // per repeat (clap)
  def: GestureDef;
  side: Side;
  tracks: Map<string, NumKey[]>; // `${part}.${prop}` (already mirrored)
  states: Map<string, { frame: number; value: string }[]>;
  swipe: CharacterSpec['gestures'][number] | null;
  contact: number | null;
}

export interface PreparedCharacter {
  spec: CharacterSpec;
  rig: CutoutRig;
  at(f: number): SolvedFrame;
}

function gestureTracks(def: GestureDef, side: Side) {
  const tracks = new Map<string, NumKey[]>();
  const states = new Map<string, { frame: number; value: string }[]>();
  for (const k of def.keys) {
    const part = side === 'L' ? mirrorName(k.part) : k.part;
    if (k.prop === 'state') {
      const list = states.get(part) ?? [];
      list.push({ frame: k.frame, value: String(k.value) });
      states.set(part, list);
      continue;
    }
    const mirror = side === 'L' && (k.prop === 'rot' || k.prop === 'x');
    const key = `${part}.${k.prop}`;
    const list = tracks.get(key) ?? [];
    list.push({ frame: k.frame, value: mirror ? -Number(k.value) : Number(k.value), curve: k.curve });
    tracks.set(key, list);
  }
  for (const l of tracks.values()) l.sort((a, b) => a.frame - b.frame);
  for (const l of states.values()) l.sort((a, b) => a.frame - b.frame);
  return { tracks, states };
}

const keysOf = (pose: PoseDef) => pose.parts;

export function prepareCharacter(rig: CutoutRig, spec: CharacterSpec, ctx: SolveContext): PreparedCharacter {
  const library: CharacterLibrary = ctx.library ?? coreLibraryPure();
  const seed = ctx.seed;
  const loops = new Set(spec.loops);
  const poses = [...spec.poses].sort((a, b) => a.at - b.at);
  const views = [...(spec.views ?? [])].sort((a, b) => a.at - b.at);
  const tempo = ctx.tempo ?? null;
  const needsTempo = loops.has('bounce-beat') || loops.has('crowd') || loops.has('dance-A') || loops.has('dance-B');
  if (needsTempo && !tempo) throw new Error(`${spec.charId}: a beat loop needs a tempo map.`);

  // pose keys: the spec's own, replaced by dance keys inside a dance loop's span (the whole visible span)
  const dance: DanceKey[] = tempo && (loops.has('dance-A') || loops.has('dance-B')) ? danceKeys(tempo, loops.has('dance-A') ? 'dance-A' : 'dance-B', spec.from, spec.to) : [];
  type PoseKey = { at: number; def: PoseDef };
  const poseKeys: PoseKey[] = dance.length
    ? dance.map((d) => ({ at: d.frame, def: d.mirrored ? mirrorPose(library.poses[d.pose]) : library.poses[d.pose] }))
    : poses.map((p) => ({ at: p.at, def: library.poses[p.pose] }));
  const neutral = library.poses.neutral;
  const poseStarts = poseKeys.map((p) => p.at);

  const sortedGestures = [...spec.gestures].sort((a, b) => a.at - b.at);
  const gestures: ActiveGesture[] = sortedGestures.map((g, i) => {
    const def = library.gestures[g.gesture];
    const side = g.side ?? 'R';
    const swipe = g.gesture === 'swipe' ? g : null;
    const clipFrames = swipe ? Math.max(1, swipeFrames(swipe.targets ?? [], swipe.speedPxPerSec)) : def.frames;
    const frames = clipFrames * (g.gesture === 'clap' ? Math.max(1, g.count ?? 1) : 1);
    const nextGesture = sortedGestures[i + 1]?.at ?? Infinity;
    const nextPose = poseStarts.find((s) => s > g.at) ?? Infinity;
    const until = def.holdEnd ? Math.min(nextGesture, nextPose, spec.to) : g.at + frames;
    return { at: g.at, until, frames, clipFrames, def, side, ...gestureTracks(def, side), swipe, contact: def.contactFrame ?? null };
  });

  const blinks = loops.has('blink') ? blinkSchedule(seed, spec.charId, spec.from, spec.to) : [];
  const phase = breathPhase(seed, spec.charId);
  const beat: BeatTracks | null = tempo && (loops.has('bounce-beat') || loops.has('crowd') || dance.length) ? bounceTracks(tempo, spec.from, spec.to, loops.has('crowd') ? crowdOffset(seed, spec.charId, spec.crowdIndex ?? 0) : 0) : null;
  const eyeKeys = [...(spec.eyes ?? [])].sort((a, b) => a.at - b.at);
  const handKeys = [...(spec.hands ?? [])].sort((a, b) => a.at - b.at);

  const at = (f: number): SolvedFrame => {
    // 1. view and the turn that hides the swap
    let view: ViewId = spec.view ?? 'front';
    for (const v of views) if (v.at <= f) view = v.view;
    const turn = views.find((v) => v.at === f || v.at === f + 1);
    const parts = viewParts(rig, view);

    // 2. the pose (blend from the previous key)
    let ki = -1;
    for (let i = 0; i < poseKeys.length; i++) if (poseKeys[i]!.at <= f) ki = i;
    const cur = ki >= 0 ? poseKeys[ki]! : null;
    const prev = ki > 0 ? poseKeys[ki - 1]!.def : neutral;
    const target = cur?.def ?? neutral;
    const blendSpan = cur ? Math.min(spec.blendFrames ?? POSE_BLEND_FRAMES, (poseKeys[ki + 1]?.at ?? Infinity) - cur.at) : 1;
    // the first key at or before the first visible frame is already in place; later keys blend in
    const blend = cur && !(ki === 0 && cur.at <= spec.from) ? easeOf('settle', (f - cur.at) / blendSpan, blendSpan) : 1;
    const states = new Map<string, string>();
    for (const [name, k] of Object.entries(keysOf(target))) if (k.state) states.set(name, k.state);
    const poseValue = (name: string, c: Channel): number => {
      const a = (keysOf(prev)[name] as PartKeys | undefined)?.[c] ?? REST[c];
      const b = (keysOf(target)[name] as PartKeys | undefined)?.[c] ?? REST[c];
      return a + (b - a) * blend;
    };

    // explicit eye and hand keys win over an older pose key
    const poseFrame = cur?.at ?? -Infinity;
    for (const e of eyeKeys) if (e.at <= f && e.at >= poseFrame) for (const n of ['eye_L', 'eye_R']) states.set(n, e.state);
    for (const h of handKeys) if (h.at <= f && h.at >= poseFrame) states.set(`hand_${h.side}`, h.shape);

    const values = new Map<string, Values>();
    for (const p of parts) {
      const v = { ...REST };
      for (const c of CHANNELS) v[c] = poseValue(p.name, c);
      values.set(p.name, v);
    }
    const add = (name: string, c: Channel, d: number) => {
      const v = values.get(name);
      if (!v) return;
      if (isScale(c)) v[c] *= d;
      else v[c] += d;
    };

    // 3. gestures
    let finger: SolvedFrame['finger'] = null;
    const cues: string[] = [];
    for (const g of gestures) {
      if (f < g.at || f >= g.until) continue;
      const raw = f - g.at;
      const local = raw < g.frames ? (g.clipFrames > 0 ? raw % g.clipFrames : raw) : g.clipFrames; // held: the end values
      for (const [key, keys] of g.tracks) {
        const [name, c] = key.split('.') as [string, Channel];
        add(name, c, evalKeys(keys, local));
      }
      for (const [name, list] of g.states) {
        const s = evalState(list, local);
        if (s) states.set(name, s);
      }
      if (g.contact !== null && raw < g.frames && raw % g.clipFrames === g.contact) cues.push('clap');
      if (g.swipe && raw < g.frames) {
        const p = swipeAt(g.swipe.targets ?? [], raw, g.swipe.speedPxPerSec);
        finger = { x: round4(p.x), y: round4(p.y) };
      }
    }

    // 4. loops
    if (loops.has('breath')) {
      const b = breathAmount(f, phase);
      add('torso', 'sy', 1 + BREATH_SCALE * b);
      add('head', 'y', -BREATH_HEAD_PX * b);
    }
    if (loops.has('sway')) {
      const s = swayAt(f);
      add('hip', 'rot', s.hipRot);
      add('head', 'rot', s.headRot);
    }
    if (beat) {
      add('hip', 'y', evalKeys(beat.hipY, f));
      add('hip', 'sx', evalKeys(beat.hipSx, f));
      add('hip', 'sy', evalKeys(beat.hipSy, f));
      add('arm_upper_R', 'rot', evalKeys(beat.armR, f));
      add('arm_upper_L', 'rot', evalKeys(beat.armL, f));
    }
    let eye = (states.get('eye_R') ?? states.get('eye_L') ?? 'open') as EyeState;
    if (BLINKABLE.has(eye)) {
      const b = blinkEyeAt(blinks, f);
      if (b) eye = (b === 'open' ? eye : b) as EyeState;
    }
    states.set('eye_L', eye);
    states.set('eye_R', eye);

    // 5. the view turn (2 frames, ending on the swap frame)
    if (turn) {
      const swap = turn.at === f;
      add('head', 'rot', swap ? VIEW_TURN.deg : VIEW_TURN.deg / 2);
      add('head', 'sx', swap ? VIEW_TURN.squash : 1 - (1 - VIEW_TURN.squash) / 2);
    }

    // mouth: the viseme track while it runs, else the pose (or gesture) mouth
    let mouth = (states.get('mouth') ?? 'X') as MouthState;
    if (spec.mouth && f >= spec.mouth.from && f < spec.mouth.from + spec.mouth.frames.length) mouth = spec.mouth.frames[f - spec.mouth.from]!;
    states.set('mouth', mouth);
    for (const side of ['L', 'R'] as const) if (!states.has(`hand_${side}`)) states.set(`hand_${side}`, 'open');

    // 6. clamp
    for (const p of parts) {
      const lim = p.limits?.rot;
      const v = values.get(p.name)!;
      if (lim) v.rot = Math.min(lim[1], Math.max(lim[0], v.rot));
    }

    const world = worldMatrices(rig, view, (n) => values.get(n) ?? REST, spec.place);
    const out: SolvedPart[] = parts.map((p) => {
      const v = values.get(p.name)!;
      let state: string | null = null;
      let file: string | null = p.file ?? null;
      if (p.name.startsWith('lid_')) state = p.states?.[eye] ? eye : p.states?.open ? 'open' : null;
      else if (p.name.startsWith('pupil_')) file = PUPIL_VISIBLE.has(eye) ? file : null;
      else state = states.get(p.name) ?? null;
      if (state && p.states?.[state]) file = p.states[state]!;
      else if (state && p.states && !file) file = Object.values(p.states)[0] ?? null;
      else if (!state && !file && p.states) file = Object.values(p.states)[0] ?? null;
      const m = world.get(p.name)!;
      return { name: p.name, rot: round4(v.rot), x: round4(v.x), y: round4(v.y), sx: round4(v.sx), sy: round4(v.sy), state, file, matrix: m.map(round4) as Matrix, z: p.z };
    });
    out.sort((a, b) => a.z - b.z || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hands: Record<Side, HandShape> = { L: (states.get('hand_L') ?? 'open') as HandShape, R: (states.get('hand_R') ?? 'open') as HandShape };
    return { frame: f, charId: spec.charId, view, eye, mouth, hands, parts: out, finger, cues };
  };
  return { spec, rig, at };
}

/** One frame. */
export const solveFrame = (rig: CutoutRig, spec: CharacterSpec, f: number, ctx: SolveContext) => prepareCharacter(rig, spec, ctx).at(f);

/** Every frame in [from, to) (defaults: the spec's visible span). */
export function solveRange(rig: CutoutRig, spec: CharacterSpec, ctx: SolveContext, from = spec.from, to = spec.to): SolvedFrame[] {
  const p = prepareCharacter(rig, spec, ctx);
  const out: SolvedFrame[] = [];
  for (let f = from; f < to; f++) out.push(p.at(f));
  return out;
}
