// What the `motion` step checks a spec against, from the project pack: each character's rig capabilities.
// Tier A and C rigs go through loader (`loadRig`: resolver status, licence and sha256, `validateRig`, the
// pack's pose and gesture overrides, which must be performable), so a spec can use exactly the views, hand shapes and
// eye states the rig draws and every core pose and gesture. A flat tier B character has no rig: the `front` view,
// `neutral` plus one pose per still tagged `pose-of:<charId>` (pack format), no gesture, no eye or hand key.
// Generic core: ids come from the pack.
import { loadRig, type LoadedRig } from '../anim/rig/load';
import { worldMatrices, apply } from '../anim/solve';
import { EYE_STATES, GESTURE_IDS, HAND_SHAPES, POSE_IDS, type CutoutRig, type EyeState, type GestureId, type HandShape, type PoseId, type ViewId } from '../anim/types';
import type { LoadedPack } from '../pack/load';
import type { AssetLibrary, ResolveOptions } from '../pack/resolve';
import type { RigTier } from '../types';
import { CORE_CLIP_FRAMES, type MotionRigCaps, type MotionWorld } from './motion';

const REST = { rot: 0, x: 0, y: 0, sx: 1, sy: 1 };

/** The rest-pose height of a view in rig px (top of the highest part to the bottom of the lowest). */
export function restBodyPx(rig: CutoutRig, view: ViewId = 'front'): number | null {
  const m = worldMatrices(rig, view, () => REST, { x: 0, y: 0, scale: 1 });
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of rig.parts) {
    if (p.view !== view || !p.size) continue;
    const w = m.get(p.name);
    if (!w) continue;
    for (const [x, y] of [[0, 0], [p.size[0], 0], [0, p.size[1]], [p.size[0], p.size[1]]] as const) {
      const [, cy] = apply(w, x, y);
      top = Math.min(top, cy);
      bottom = Math.max(bottom, cy);
    }
  }
  return Number.isFinite(top) && bottom > top ? Math.round(bottom - top) : null;
}

const statesOf = (rig: CutoutRig, part: string) => new Set(rig.parts.filter((p) => p.name === part).flatMap((p) => Object.keys(p.states ?? {})));

/** A loaded rig's capabilities: its views, the hand shapes both hands draw, the eye states both eyes draw. */
export function motionRigCaps(r: Pick<LoadedRig, 'tier' | 'rig' | 'library'>): MotionRigCaps {
  const hl = statesOf(r.rig, 'hand_L');
  const hr = statesOf(r.rig, 'hand_R');
  const el = statesOf(r.rig, 'eye_L');
  const er = statesOf(r.rig, 'eye_R');
  return {
    tier: r.tier,
    views: [...r.rig.views],
    poses: [...POSE_IDS],
    gestures: [...GESTURE_IDS],
    hands: HAND_SHAPES.filter((h) => hl.has(h) && hr.has(h)) as HandShape[],
    eyes: EYE_STATES.filter((e) => el.has(e) && er.has(e)) as EyeState[],
    bodyPx: restBodyPx(r.rig, r.rig.views.includes('front') ? 'front' : r.rig.views[0]),
    clipFrames: Object.fromEntries(GESTURE_IDS.map((g) => [g, r.library.gestures[g]?.frames ?? CORE_CLIP_FRAMES[g]])) as Record<GestureId, number>,
  };
}

/** A flat (tier B) character: front view, neutral and its pose stills; no gestures, no eye or hand keys. */
export function flatRigCaps(stills: readonly string[]): MotionRigCaps {
  const poses = ['neutral', ...stills.filter((p) => (POSE_IDS as readonly string[]).includes(p) && p !== 'neutral')] as PoseId[];
  return { tier: 'B', views: ['front'], poses, gestures: [], hands: [], eyes: [], bodyPx: null, clipFrames: { ...CORE_CLIP_FRAMES } };
}

/**
 * The motion world of a pack: every character asset with a rig tier. A rig that does not load (missing file, bad
 * hash, invalid) is left out, so a spec that casts it fails with `motion.rig-lacks` naming the character.
 */
export async function motionWorldFor(pack: Pick<LoadedPack, 'manifest'>, lib: AssetLibrary, o: ResolveOptions & { vendorLipsync?: boolean; uiTargets?: MotionWorld['uiTargets'] }): Promise<MotionWorld> {
  const rigs: Record<string, MotionRigCaps> = {};
  const assets = [...lib.values()].map((e) => e.asset);
  for (const a of assets) {
    if (a.kind !== 'character' || a.tags.some((t) => t.startsWith('pose-of:'))) continue;
    const tier: RigTier | undefined = pack.manifest.rigTier[a.id];
    if (!tier) continue;
    if (tier === 'B') {
      rigs[a.id] = flatRigCaps(assets.filter((s) => s.kind === 'character' && s.tags.includes(`pose-of:${a.id}`)).map((s) => s.id.slice(a.id.length + 1)));
      continue;
    }
    try {
      rigs[a.id] = motionRigCaps(await loadRig(pack, lib, a.id, o));
    } catch {
      // not castable: the rules name the character when a spec uses it
    }
  }
  return { rigs, ...(o.vendorLipsync ? { vendorLipsync: true } : {}), ...(o.uiTargets ? { uiTargets: o.uiTargets } : {}) };
}
