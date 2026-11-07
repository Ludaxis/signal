// validateRig (quality bar acceptance 1, pack guide): every issue a rig has, each with its own code and the
// part and view named. A Tier A rig must pass before it renders; the loader refuses a rig with any issue.
//
// Rules: at least the `front` and `three-quarter-L` views; one part per name and view; every required part in every
// view (a profile view may leave out the far side's face and ear parts); the eye, mouth and hand states (the 8
// visemes and 4 expression mouths, the 7 hand shapes, the 5 eye states); one root (`hip`, parent null) per view and
// `torso` its child; parents exist in the same view and the tree has no cycle; the pivot inside the part's own box and
// the anchor inside the parent's box; rotation limits ordered (lo ≤ 0 ≤ hi, so the rest drawing is reachable).
// Pure module: sizes come from the part records (the loader fills them from the files).
import { REQUIRED_PARTS, REQUIRED_STATES, REQUIRED_VIEWS, ROOT_PART, SLOT_PARTS, type CutoutRig, type RigPart, type ViewId } from '../types';

export type RigIssueCode =
  | 'rig.view-missing'
  | 'rig.part-duplicate'
  | 'rig.part-missing'
  | 'rig.face-part-missing'
  | 'rig.state-missing'
  | 'rig.viseme-missing'
  | 'rig.root'
  | 'rig.parent-missing'
  | 'rig.cycle'
  | 'rig.part-size-missing'
  | 'rig.pivot-outside'
  | 'rig.anchor-outside'
  | 'rig.limits';

export interface RigIssue {
  code: RigIssueCode;
  part: string | null;
  view: ViewId | null;
  message: string;
}

const FACE = new Set(['brow_L', 'brow_R', 'eye_L', 'eye_R', 'pupil_L', 'pupil_R', 'lid_L', 'lid_R', 'mouth', 'nose']);
const VISEME_SET = new Set(['X', 'A', 'E', 'O', 'U', 'M', 'F', 'L']);
const SLOTS = new Set<string>(SLOT_PARTS);

/** Parts a profile view may leave out: the far side (profile-L shows the left side, so the right side is far). */
function optionalInView(name: string, view: ViewId): boolean {
  if (view === 'profile-L') return /^(ear|eye|pupil|lid|brow|cheek)_R$/.test(name);
  if (view === 'profile-R') return /^(ear|eye|pupil|lid|brow|cheek)_L$/.test(name);
  return false;
}

const inside = (p: [number, number], size: [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= size[0] && p[1] <= size[1];

export function validateRig(rig: CutoutRig): { ok: boolean; issues: RigIssue[] } {
  const issues: RigIssue[] = [];
  const add = (code: RigIssueCode, part: string | null, view: ViewId | null, message: string) => issues.push({ code, part, view, message });

  for (const v of REQUIRED_VIEWS) if (!rig.views.includes(v)) add('rig.view-missing', null, v, `${rig.id} has no ${v} view.`);

  const byView = new Map<ViewId, Map<string, RigPart>>();
  for (const p of rig.parts) {
    if (!rig.views.includes(p.view)) {
      add('rig.view-missing', p.name, p.view, `${rig.id}: ${p.name} is drawn in ${p.view}, which the rig does not list.`);
      continue;
    }
    const m = byView.get(p.view) ?? new Map<string, RigPart>();
    byView.set(p.view, m);
    if (m.has(p.name)) add('rig.part-duplicate', p.name, p.view, `${rig.id}: ${p.name} appears twice in ${p.view}.`);
    else m.set(p.name, p);
  }

  for (const view of rig.views) {
    const parts = byView.get(view) ?? new Map<string, RigPart>();
    for (const name of REQUIRED_PARTS) {
      if (parts.has(name) || optionalInView(name, view)) continue;
      add(FACE.has(name) ? 'rig.face-part-missing' : 'rig.part-missing', name, view, `${rig.id}: ${view} has no ${name}.`);
    }
    for (const [name, states] of Object.entries(REQUIRED_STATES)) {
      const p = parts.get(name);
      if (!p) continue;
      for (const s of states)
        if (!p.states?.[s]) add(name === 'mouth' && VISEME_SET.has(s) ? 'rig.viseme-missing' : 'rig.state-missing', name, view, `${rig.id}: ${view} ${name} has no ${s} ${name === 'mouth' && VISEME_SET.has(s) ? 'viseme' : 'state'}.`);
    }

    const roots = [...parts.values()].filter((p) => p.parent === null);
    if (roots.length !== 1 || roots[0]!.name !== ROOT_PART) add('rig.root', roots[0]?.name ?? null, view, `${rig.id}: ${view} needs exactly one root, ${ROOT_PART}.`);
    const torso = parts.get('torso');
    if (torso && torso.parent !== ROOT_PART) add('rig.root', 'torso', view, `${rig.id}: ${view} torso must be the child of ${ROOT_PART}.`);

    for (const p of parts.values()) {
      if (p.parent !== null && !parts.has(p.parent)) add('rig.parent-missing', p.name, view, `${rig.id}: ${view} ${p.name} hangs from ${p.parent}, which is missing.`);
      // cycle: walk up at most parts.size steps
      let cur: RigPart | undefined = p;
      for (let k = 0; cur && cur.parent !== null && k <= parts.size; k++) {
        cur = parts.get(cur.parent);
        if (cur === p || k === parts.size) {
          add('rig.cycle', p.name, view, `${rig.id}: ${view} ${p.name} is its own ancestor.`);
          break;
        }
      }
      const lim = p.limits?.rot;
      if (lim && !(lim[0] <= 0 && 0 <= lim[1])) add('rig.limits', p.name, view, `${rig.id}: ${view} ${p.name} limits ${lim[0]}…${lim[1]} must include 0.`);
      const parent = p.parent ? parts.get(p.parent) : undefined;
      if (parent?.size && !inside(p.anchor, parent.size))
        add('rig.anchor-outside', p.name, view, `${rig.id}: ${view} ${p.name} anchor ${p.anchor.join(',')} is outside ${parent.name}.`);
      if (SLOTS.has(p.name) && !p.file && !p.states) continue; // an empty slot has no box of its own
      if (!p.size) {
        add('rig.part-size-missing', p.name, view, `${rig.id}: ${view} ${p.name} has no size.`);
        continue;
      }
      if (!inside(p.pivot, p.size)) add('rig.pivot-outside', p.name, view, `${rig.id}: ${view} ${p.name} pivot ${p.pivot.join(',')} is outside its ${p.size.join('×')} box.`);
    }
  }
  return { ok: issues.length === 0, issues };
}
