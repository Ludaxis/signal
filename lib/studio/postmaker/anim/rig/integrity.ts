// Pivot integrity (quality bar conventions, acceptance 2): rotating a limb to its limits never opens a
// transparent gap at its joint. Geometric test on coverage masks (1 = an opaque pixel of the part), in the parent's
// px space with the joint J at the child's anchor:
//   - the joint disc: the largest disc around J that the parent and the child cover together at rest, at most the
//     child's half-width at its pivot (across the bone, the bone running from the pivot to the part's centroid), so
//     the background beside a limb is never counted as a joint;
//   - overdraw: the largest disc around J that both cover at rest (the 6-12 px of overlap every joint carries);
//   - at 0°, ±limit/2 and ±limit (lo/2, lo, hi/2, hi for asymmetric limits), inside the joint disc shrunk by 1 px,
//     the widest transparent gap (uncovered by the parent and the rotated child) is at most 1 px: a gap's width at a
//     sample is 2k + 1 where k is the largest radius around it that stays uncovered, so one stray edge pixel passes
//     and a wedge does not. A square-ended joint opens a wedge at a bend and fails; a joint with a round end (or
//     enough overdraw) passes at every angle.
// Pure module: masks come from rig/coverage.ts (node) or from synthetic shapes in tests.
import type { CutoutRig, RigPart, ViewId } from '../types';

export interface Mask {
  w: number;
  h: number;
  /** Row-major, 1 = covered. */
  data: Uint8Array;
}

export const JOINT_TOLERANCE_PX = 1;
export const OVERDRAW_MIN_PX = 6;
const R_MAX = 64;
const GAP_MAX = 8;

export const coveredAt = (m: Mask, x: number, y: number) => {
  const i = Math.floor(x);
  const j = Math.floor(y);
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] === 1;
};

/** Is the parent-space point q covered by the child rotated by `deg` about its pivot (attached at J)? */
function childCovers(child: Mask, pivot: [number, number], J: [number, number], deg: number, qx: number, qy: number): boolean {
  const r = (-deg * Math.PI) / 180;
  const dx = qx - J[0];
  const dy = qy - J[1];
  const lx = Math.cos(r) * dx - Math.sin(r) * dy + pivot[0];
  const ly = Math.sin(r) * dx + Math.cos(r) * dy + pivot[1];
  return coveredAt(child, lx, ly);
}

function* disc(r: number): Generator<[number, number]> {
  const R = Math.floor(r);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= r * r) yield [dx + 0.5, dy + 0.5];
}

function largestDisc(test: (x: number, y: number) => boolean, J: [number, number]): number {
  let good = 0;
  for (let r = 1; r <= R_MAX; r++) {
    let all = true;
    for (const [dx, dy] of disc(r))
      if (!test(J[0] + dx, J[1] + dy)) {
        all = false;
        break;
      }
    if (!all) break;
    good = r;
  }
  return good;
}

/** The child's half-width at its pivot, across the bone (pivot → centroid of the covered pixels). */
export function crossHalfWidth(m: Mask, pivot: [number, number]): number {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.data[y * m.w + x] === 1) {
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
  if (!n) return 0;
  let dx = sx / n - pivot[0];
  let dy = sy / n - pivot[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) [dx, dy] = [0, 1];
  else [dx, dy] = [dx / len, dy / len];
  const reach = (sx2: number, sy2: number) => {
    let t = 0;
    while (t < R_MAX && coveredAt(m, pivot[0] + sx2 * (t + 1), pivot[1] + sy2 * (t + 1))) t++;
    return t;
  };
  return Math.min(reach(-dy, dx), reach(dy, -dx));
}

export interface JointReport {
  view: ViewId;
  part: string;
  parent: string;
  /** Joint disc radius (px) and the overlap radius at rest. */
  radius: number;
  overdraw: number;
  /** The widest gap (px) at each test angle; 0 = fully covered. */
  angles: { deg: number; gapPx: number }[];
  ok: boolean;
  message: string | null;
}

export const testAngles = (lim: [number, number]): number[] => [...new Set([0, lim[0] / 2, lim[0], lim[1] / 2, lim[1]])].sort((a, b) => a - b);

/** One joint: parent and child masks (every state of the child is tested; the worst counts). */
export function jointReport(parent: { part: RigPart; mask: Mask }, child: { part: RigPart; masks: Mask[] }, o: { tolerance?: number; angles?: number[] } = {}): JointReport {
  const tol = o.tolerance ?? JOINT_TOLERANCE_PX;
  const J = child.part.anchor;
  const lim = child.part.limits?.rot ?? [0, 0];
  const angles = o.angles ?? testAngles(lim);
  let radius = Infinity;
  let overdraw = Infinity;
  const gaps = new Map<number, number>(angles.map((a) => [a, 0]));
  for (const cm of child.masks) {
    const union = (x: number, y: number) => coveredAt(parent.mask, x, y) || childCovers(cm, child.part.pivot, J, 0, x, y);
    const both = (x: number, y: number) => coveredAt(parent.mask, x, y) && childCovers(cm, child.part.pivot, J, 0, x, y);
    const r = Math.min(largestDisc(union, J), crossHalfWidth(cm, child.part.pivot));
    radius = Math.min(radius, r);
    overdraw = Math.min(overdraw, largestDisc(both, J));
    for (const deg of angles) {
      const open = (x: number, y: number) => !coveredAt(parent.mask, x, y) && !childCovers(cm, child.part.pivot, J, deg, x, y);
      let gap = 0;
      for (const [dx, dy] of disc(Math.max(0, r - 1))) {
        const x = J[0] + dx;
        const y = J[1] + dy;
        if (!open(x, y)) continue;
        let k = 0;
        while (k < GAP_MAX && [...disc(k + 1)].every(([u, v]) => open(x + u - 0.5, y + v - 0.5))) k++;
        gap = Math.max(gap, 2 * k + 1);
      }
      gaps.set(deg, Math.max(gaps.get(deg)!, gap));
    }
  }
  const worst = [...gaps].find(([, g]) => g > tol);
  const thin = overdraw < OVERDRAW_MIN_PX;
  const ok = !worst && !thin;
  const message = worst
    ? `${child.part.view} ${child.part.name} opens a ${worst[1]} px gap at ${worst[0]}° against ${parent.part.name}.`
    : thin
      ? `${child.part.view} ${child.part.name} overlaps ${parent.part.name} by ${overdraw} px (at least ${OVERDRAW_MIN_PX}).`
      : null;
  return { view: child.part.view, part: child.part.name, parent: parent.part.name, radius, overdraw, angles: angles.map((deg) => ({ deg, gapPx: gaps.get(deg)! })), ok, message };
}

/** Every joint of a view with rotation limits. `masks(part)` gives the part's masks (default file first). */
export function jointReports(rig: CutoutRig, view: ViewId, masks: (p: RigPart) => Mask[], o: { tolerance?: number } = {}): JointReport[] {
  const parts = rig.parts.filter((p) => p.view === view);
  const byName = new Map(parts.map((p) => [p.name, p]));
  const out: JointReport[] = [];
  for (const p of parts) {
    if (!p.limits?.rot || !p.parent) continue;
    const parent = byName.get(p.parent);
    if (!parent) continue;
    const pm = masks(parent)[0];
    const cms = masks(p);
    if (!pm || !cms.length) continue;
    out.push(jointReport({ part: parent, mask: pm }, { part: p, masks: cms }, o));
  }
  return out;
}
