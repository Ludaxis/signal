// Per-character overrides (pack guide, roles): a character's `poses.json` / `gestures.json` may replace
// the keys of a core id; they may not add ids. A pose override merges per part (the parts it names replace the core
// keys of those parts); a gesture override replaces the clip. An unknown id, an unknown part or state, or a key
// outside a part's limits fails with the character, id and part named. `checkPerformable` also refuses a library
// whose states the rig cannot show (a hand shape the rig lacks, for example).
import { CORE_GESTURE_IDS, CORE_POSE_IDS, gestureOverridesSchema, poseOverridesSchema } from '../rig/schema';
import { coreLibraryPure } from './core';
import type { CharacterLibrary, CutoutRig, GestureDef, GestureId, PoseDef, PoseId } from '../types';

export type OverrideIssueCode = 'override.invalid' | 'override.unknown-id' | 'override.unknown-part' | 'override.unknown-state' | 'override.outside-limits';

export interface OverrideIssue {
  code: OverrideIssueCode;
  charId: string;
  id: string | null;
  part: string | null;
  message: string;
}

export const coreLibrary = (): CharacterLibrary => coreLibraryPure();

interface PartInfo {
  states: Set<string>;
  limits: [number, number] | null;
}

/** Part name → the states every view shares and the tightest rotation limits over the views. */
function partInfo(rig: CutoutRig): Map<string, PartInfo> {
  const m = new Map<string, PartInfo>();
  for (const p of rig.parts) {
    const states = new Set(Object.keys(p.states ?? {}));
    const prev = m.get(p.name);
    const lim = p.limits?.rot ?? null;
    if (!prev) m.set(p.name, { states, limits: lim });
    else {
      prev.states = new Set([...prev.states].filter((s) => states.has(s)));
      if (lim) prev.limits = prev.limits ? [Math.max(prev.limits[0], lim[0]), Math.min(prev.limits[1], lim[1])] : lim;
    }
  }
  return m;
}

function checkKey(info: Map<string, PartInfo>, charId: string, id: string, part: string, prop: string, value: number | string, out: OverrideIssue[]) {
  const p = info.get(part);
  if (!p) {
    out.push({ code: 'override.unknown-part', charId, id, part, message: `${charId}: ${id} moves ${part}, which the rig does not have.` });
    return;
  }
  if (prop === 'state') {
    if (typeof value !== 'string' || !p.states.has(value)) out.push({ code: 'override.unknown-state', charId, id, part, message: `${charId}: ${id} shows ${part} as ${String(value)}, which the rig does not draw.` });
    return;
  }
  if (prop === 'rot' && p.limits && typeof value === 'number' && (value < p.limits[0] || value > p.limits[1]))
    out.push({ code: 'override.outside-limits', charId, id, part, message: `${charId}: ${id} turns ${part} to ${value}°, outside ${p.limits[0]}…${p.limits[1]}°.` });
}

/** Merges the character's override files (raw JSON, or null when absent) over the core library. */
export function mergeOverrides(rig: CutoutRig, poses: unknown | null, gestures: unknown | null): { library: CharacterLibrary; issues: OverrideIssue[] } {
  const library = coreLibrary();
  const issues: OverrideIssue[] = [];
  const info = partInfo(rig);
  const charId = rig.id;

  if (poses !== null && poses !== undefined) {
    const parsed = poseOverridesSchema.safeParse(poses);
    if (!parsed.success) issues.push({ code: 'override.invalid', charId, id: null, part: null, message: `${charId}: poses.json is not valid.` });
    else
      for (const [id, def] of Object.entries(parsed.data.poses)) {
        if (!CORE_POSE_IDS.includes(id)) {
          issues.push({ code: 'override.unknown-id', charId, id, part: null, message: `${charId}: poses.json adds ${id}; packs only override core poses.` });
          continue;
        }
        for (const [part, keys] of Object.entries(def.parts)) for (const [prop, value] of Object.entries(keys)) if (value !== undefined) checkKey(info, charId, id, part, prop, value, issues);
        const core = library.poses[id as PoseId];
        library.poses[id as PoseId] = { parts: { ...core.parts, ...def.parts } } satisfies PoseDef;
      }
  }

  if (gestures !== null && gestures !== undefined) {
    const parsed = gestureOverridesSchema.safeParse(gestures);
    if (!parsed.success) issues.push({ code: 'override.invalid', charId, id: null, part: null, message: `${charId}: gestures.json is not valid.` });
    else
      for (const [id, def] of Object.entries(parsed.data.gestures)) {
        if (!CORE_GESTURE_IDS.includes(id)) {
          issues.push({ code: 'override.unknown-id', charId, id, part: null, message: `${charId}: gestures.json adds ${id}; packs only override core gestures.` });
          continue;
        }
        for (const key of def.keys) checkKey(info, charId, id, key.part, key.prop, key.value, issues);
        const core = library.gestures[id as GestureId];
        library.gestures[id as GestureId] = { ...core, frames: def.frames, keys: def.keys as GestureDef['keys'] };
      }
  }
  return { library, issues };
}

/** Every state a library asks for must exist on the rig's part (in every view that draws the part). */
export function checkPerformable(rig: CutoutRig, library: CharacterLibrary): OverrideIssue[] {
  const info = partInfo(rig);
  const out: OverrideIssue[] = [];
  const need = (id: string, part: string, s: string) => {
    const p = info.get(part);
    if (p && !p.states.has(s)) out.push({ code: 'override.unknown-state', charId: rig.id, id, part, message: `${rig.id} cannot perform ${id}: ${part} has no ${s}.` });
  };
  for (const [id, pose] of Object.entries(library.poses)) for (const [part, k] of Object.entries(pose.parts)) if (k.state) need(id, part, k.state);
  for (const [id, g] of Object.entries(library.gestures))
    for (const key of g.keys) {
      if (key.prop !== 'state') continue;
      need(id, key.part, String(key.value));
      const mirror = key.part.endsWith('_R') ? `${key.part.slice(0, -2)}_L` : null; // gestures can play on the left side
      if (mirror) need(id, mirror, String(key.value));
    }
  return out;
}
