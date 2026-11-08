// The idle lint (quality bar rule, acceptance 3): every character visible for more than 60 frames carries
// at least `breath` and `blink`. A character is the set of its tracks in a compiled timeline (it may enter and leave
// several times; the visible frames add up). Each violation names the character id and the missing loop. A flat
// (tier B) character carries `breath` but is exempt from `blink`: a flat still cannot draw one.
// The hold lint (quality bar, roles "holds are ≥ 8 frames"): between two moves of one character
// in one appearance (a pose change, which blends over the preset table's blend, or a gesture clip) at least 8 still
// frames. A pose key on the appearance's first frame is already in place and is not a move. Pure module.
import { gestureFrames } from './compile';
import { CORE_GESTURES } from './library/gestures';
import { POSE_BLEND_FRAMES } from './solve';
import type { AnimLoopId, CharacterSpec, GestureId } from './types';

export const IDLE_LOOPS: readonly AnimLoopId[] = ['breath', 'blink'];
/** The idle loops a flat (tier B) character carries: no `blink`. */
export const FLAT_IDLE_LOOPS: readonly AnimLoopId[] = ['breath'];
export const IDLE_MIN_FRAMES = 60;

export interface IdleViolation {
  rule: 'c5.idle-missing';
  charId: string;
  loop: AnimLoopId;
  frame: number;
  message: string;
}

/** Tracks as the compiled timeline holds them: one per character appearance. */
export type CharacterTrack = Pick<CharacterSpec, 'charId' | 'from' | 'to' | 'loops'>;

/** `flat`: the ids of flat (tier B) characters, which need `breath` only. */
export function idleLint(tracks: readonly CharacterTrack[], o: { flat?: Iterable<string> } = {}): IdleViolation[] {
  const flat = new Set(o.flat ?? []);
  const byChar = new Map<string, CharacterTrack[]>();
  for (const t of tracks) byChar.set(t.charId, [...(byChar.get(t.charId) ?? []), t]);
  const out: IdleViolation[] = [];
  for (const [charId, list] of [...byChar].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const visible = list.reduce((n, t) => n + Math.max(0, t.to - t.from), 0);
    if (visible <= IDLE_MIN_FRAMES) continue;
    for (const loop of flat.has(charId) ? FLAT_IDLE_LOOPS : IDLE_LOOPS) {
      const missing = list.filter((t) => t.to - t.from > 0 && !t.loops.includes(loop));
      if (!missing.length) continue;
      const frame = Math.min(...missing.map((t) => t.from));
      out.push({ rule: 'c5.idle-missing', charId, loop, frame, message: `${charId} is on screen ${visible} frames without ${loop} (from frame ${frame})` });
    }
  }
  return out;
}

export const HOLD_MIN_FRAMES = 8;

export interface HoldViolation {
  rule: 'c5.hold-short';
  charId: string;
  /** The frame the move that comes too soon starts. */
  frame: number;
  gap: number;
  message: string;
}

export type MoveTrack = Pick<CharacterSpec, 'charId' | 'from' | 'to' | 'poses' | 'gestures' | 'blendFrames'>;

/** The moves of one appearance: [start, end) per pose change and gesture, sorted by start. */
export function movesOf(t: MoveTrack, clipFrames: (id: GestureId) => number = (id) => CORE_GESTURES[id].frames): { start: number; end: number; what: string }[] {
  const out = [
    ...t.poses.filter((p) => p.at > t.from).map((p) => ({ start: p.at, end: p.at + (t.blendFrames ?? POSE_BLEND_FRAMES), what: p.pose })),
    ...t.gestures.map((g) => ({ start: g.at, end: g.at + gestureFrames(g, clipFrames), what: g.gesture })),
  ];
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function holdLint(tracks: readonly MoveTrack[], clipFrames?: (id: GestureId) => number): HoldViolation[] {
  const out: HoldViolation[] = [];
  for (const t of tracks) {
    const moves = movesOf(t, clipFrames);
    for (let i = 1; i < moves.length; i++) {
      const gap = moves[i]!.start - moves[i - 1]!.end;
      if (gap < HOLD_MIN_FRAMES) out.push({ rule: 'c5.hold-short', charId: t.charId, frame: moves[i]!.start, gap, message: `${t.charId} holds ${gap} frames before ${moves[i]!.what} at frame ${moves[i]!.start} (at least ${HOLD_MIN_FRAMES})` });
    }
  }
  return out.sort((a, b) => a.frame - b.frame || (a.charId < b.charId ? -1 : 1));
}

/** The motion lint on compiled characters: idles and holds. */
export function c5Lint(tracks: readonly (CharacterTrack & MoveTrack)[], clipFrames?: (id: GestureId) => number, flat?: Iterable<string>): (IdleViolation | HoldViolation)[] {
  return [...idleLint(tracks, { flat }), ...holdLint(tracks, clipFrames)];
}
