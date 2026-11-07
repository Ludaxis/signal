// The lip-sync plate (quality bar, `vendor` mode): the character's head and shoulders at 1024 × 1024,
// the head static and centred, neutral mouth, on the plain pack background, with no captions or stickers. The plate's
// head transform is known from the rig, so the vendor's returned clip is placed back over the animated head with
// `faceBoxFor`, and the mouth-and-jaw mask comes from the animated frame's `mouth` and `head` bounds. Pure module.
import { apply, solveFrame } from '../anim/solve';
import type { CharacterSpec, CutoutRig, SolvedFrame, ViewId } from '../anim/types';
import type { Rect } from './lipsyncComposite';

export const PLATE_SIZE = 1024;
/** The head fills this share of the plate's height and its centre sits this far down. */
const HEAD_SHARE = 0.42;
const HEAD_CENTRE_Y = 0.4;

/** The canvas box of a solved part (its own px box through its matrix); null when the part is not drawn. */
export function partBox(rig: CutoutRig, f: SolvedFrame, name: string): Rect | null {
  const p = f.parts.find((x) => x.name === name);
  const def = rig.parts.find((x) => x.view === f.view && x.name === name);
  if (!p || !def?.size) return null;
  const pts = [[0, 0], [def.size[0], 0], [0, def.size[1]], [def.size[0], def.size[1]]].map(([x, y]) => apply(p.matrix, x!, y!));
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The plate's solver spec (neutral, no loops, no gestures) and where its head and mouth land, in plate px. */
export function plateFor(rig: CutoutRig, o: { charId?: string; view?: ViewId; size?: number } = {}): { spec: CharacterSpec; head: Rect; mouth: Rect; size: number } {
  const size = o.size ?? PLATE_SIZE;
  const view = o.view ?? (rig.views.includes('front') ? 'front' : rig.views[0]!);
  const probe: CharacterSpec = { charId: o.charId ?? rig.id, from: 0, to: 1, place: { x: 0, y: 0, scale: 1 }, view, poses: [{ pose: 'neutral', at: 0 }], gestures: [], loops: [] };
  const rest = solveFrame(rig, probe, 0, { seed: 1 });
  const head = partBox(rig, rest, 'head');
  if (!head) throw new Error(`${probe.charId}: the rig has no head to make a plate from.`);
  const scale = (size * HEAD_SHARE) / head.h;
  const place = { x: size / 2 - (head.x + head.w / 2) * scale, y: size * HEAD_CENTRE_Y - (head.y + head.h / 2) * scale, scale };
  const spec = { ...probe, place };
  const f = solveFrame(rig, spec, 0, { seed: 1 });
  return { spec, head: partBox(rig, f, 'head')!, mouth: partBox(rig, f, 'mouth') ?? partBox(rig, f, 'head')!, size };
}

/** Where the whole plate lands on the animated frame so that its head covers the animated head. */
export function faceBoxFor(plate: { head: Rect; size: number }, animatedHead: Rect): Rect {
  const k = animatedHead.h / plate.head.h;
  return { x: animatedHead.x - plate.head.x * k, y: animatedHead.y - plate.head.y * k, w: plate.size * k, h: plate.size * k };
}
