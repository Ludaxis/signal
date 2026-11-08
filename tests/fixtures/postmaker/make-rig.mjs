#!/usr/bin/env node
// Builds the synthetic Tier A fixture character `char-cutout` ([Pack example], quality bar, pack guide):
// original flat geometric art drawn here as SVG (no reference frames, no third-party art), as a
// `cutout-rig/1` rig with the `front` and `three-quarter-L` views, every required part, the 5 eye states, the 8
// visemes and 4 expression mouths, the 7 hand shapes, lids, slots and a turnaround sheet composed from the parts at
// rest. Limbs are capsules whose round ends sit on the joint centre, so no rotation inside the limits opens a gap.
// Nothing is committed but this script; make-pack.mjs calls it, or run it alone:
//
//   node tests/fixtures/postmaker/make-rig.mjs <character-folder>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RIG_ID = 'char-cutout';

export const COLOURS = {
  skin: '#E8A87C',
  skinShade: '#CF8C61',
  hair: '#3A2E5C',
  hairLight: '#4B3D73',
  shirt: '#2FA39A',
  shirtShade: '#23827B',
  pants: '#34406B',
  pantsShade: '#28325A',
  shoe: '#F2A541',
  ink: '#1E1B2E',
  white: '#FFFFFF',
  inner: '#7A2E3A',
  tongue: '#E2697A',
  blush: '#F28C8C',
};
const C = COLOURS;

const svg = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>\n`;
const capsule = (w, h, fill) => `<rect x="0" y="0" width="${w}" height="${h}" rx="${w / 2}" ry="${w / 2}" fill="${fill}"/>`;
const mirrorX = (w, inner) => `<g transform="translate(${w} 0) scale(-1 1)">${inner}</g>`;
const stroke = (d, width = 6, colour = C.ink) => `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

// ---- face states -------------------------------------------------------------------------------------------------

function eyeStates(w) {
  const cx = w / 2;
  const white = (ry) => `<ellipse cx="${cx}" cy="38" rx="${cx - 4}" ry="${ry}" fill="${C.white}" stroke="${C.ink}" stroke-width="4"/>`;
  return {
    open: white(30),
    half: white(30), // the lid covers the top half
    closed: stroke(`M6 40 Q${cx} 54 ${w - 6} 40`, 5),
    happy: stroke(`M6 48 Q${cx} 20 ${w - 6} 48`, 5),
    wide: `<ellipse cx="${cx}" cy="37" rx="${cx - 2}" ry="34" fill="${C.white}" stroke="${C.ink}" stroke-width="4"/>`,
  };
}

function lidStates(w) {
  const cx = w / 2;
  return {
    open: '',
    half: `<path d="M2 38 A${cx - 2} 34 0 0 1 ${w - 2} 38 Z" fill="${C.skin}"/>${stroke(`M4 38 L${w - 4} 38`, 4)}`,
    closed: `<ellipse cx="${cx}" cy="37" rx="${cx - 1}" ry="35" fill="${C.skin}"/>${stroke(`M6 40 Q${cx} 54 ${w - 6} 40`, 5)}`,
  };
}

const MOUTHS = {
  X: stroke('M38 42 Q60 48 82 42', 6),
  A: `<ellipse cx="60" cy="42" rx="18" ry="24" fill="${C.inner}"/><ellipse cx="60" cy="56" rx="11" ry="7" fill="${C.tongue}"/>`,
  E: `<rect x="26" y="30" width="68" height="24" rx="12" fill="${C.inner}"/><rect x="34" y="30" width="52" height="7" rx="3" fill="${C.white}"/>`,
  O: `<ellipse cx="60" cy="42" rx="16" ry="19" fill="${C.inner}"/>`,
  U: `<ellipse cx="60" cy="42" rx="10" ry="12" fill="${C.inner}"/>`,
  M: `${stroke('M32 41 Q60 45 88 41', 9, C.skinShade)}${stroke('M34 40 Q60 44 86 40', 4)}`,
  F: `<rect x="40" y="30" width="40" height="12" rx="4" fill="${C.white}"/>${stroke('M36 46 Q60 54 84 46', 6)}`,
  L: `<ellipse cx="60" cy="42" rx="20" ry="18" fill="${C.inner}"/><ellipse cx="60" cy="34" rx="11" ry="6" fill="${C.tongue}"/>`,
  smile: stroke('M30 34 Q60 64 90 34', 6),
  grin: `<path d="M28 32 Q60 78 92 32 Z" fill="${C.inner}"/><path d="M32 33 L88 33 L84 42 Q60 46 36 42 Z" fill="${C.white}"/>`,
  frown: stroke('M36 54 Q60 32 84 54', 6),
  shock: `<ellipse cx="60" cy="42" rx="24" ry="30" fill="${C.inner}"/><ellipse cx="60" cy="60" rx="14" ry="8" fill="${C.tongue}"/>`,
};

// ---- hands (96×104, wrist at the top centre; the right hand, mirrored for the left) --------------------------------

const palm = (h = 62) => `<rect x="20" y="0" width="56" height="${h}" rx="26" fill="${C.skin}"/>`;
const finger = (x, y, w, h, deg = 0, ox = x + w / 2, oy = y) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}" fill="${C.skin}" transform="rotate(${deg} ${ox} ${oy})"/>`;
const knuckles = stroke('M30 52 L66 52', 3, C.skinShade);
const HANDS = {
  open: `${palm()}${[24, 37, 50, 63].map((x) => finger(x, 44, 11, 36)).join('')}${finger(68, 14, 13, 34, -40, 74, 18)}`,
  fist: `<rect x="18" y="0" width="60" height="68" rx="28" fill="${C.skin}"/>${knuckles}`,
  point: `<rect x="18" y="0" width="60" height="64" rx="28" fill="${C.skin}"/>${finger(42, 46, 14, 54)}${knuckles}`,
  wave: `${palm()}${[-18, -6, 6, 18].map((d, i) => finger(26 + i * 12, 44, 11, 38, d, 31 + i * 12, 46)).join('')}${finger(68, 12, 13, 30, -45, 74, 16)}`,
  hold: `${palm(58)}<path d="M22 40 Q14 86 48 96 Q80 96 78 60" fill="none" stroke="${C.skin}" stroke-width="16" stroke-linecap="round"/>`,
  thumb: `<rect x="18" y="0" width="60" height="64" rx="28" fill="${C.skin}"/><rect x="62" y="14" width="32" height="15" rx="7.5" fill="${C.skin}"/>${knuckles}`,
  peace: `<rect x="18" y="0" width="60" height="64" rx="28" fill="${C.skin}"/>${finger(32, 46, 13, 52, 12, 38, 50)}${finger(52, 46, 13, 52, -12, 58, 50)}`,
};

// ---- the parts ---------------------------------------------------------------------------------------------------

/**
 * Part definitions per view. Each: box w×h, pivot (part px), parent, anchor (parent px), z, limits, and either one
 * drawing or states. `L`/`R` are the character's own sides: R is the viewer's left in the front view.
 */
function partsFor(view) {
  const q = view === 'three-quarter-L'; // turned towards its own left: the face moves to the viewer's right
  const fx = q ? 30 : 0; // face shift
  const eyeW = { R: 64, L: q ? 50 : 64 };
  const torsoW = q ? 240 : 260;
  const hipW = q ? 214 : 230;
  const p = [];
  const add = (o) => p.push({ view, ...o });

  add({ name: 'hip', w: hipW, h: 130, pivot: [hipW / 2, 45], parent: null, anchor: [0, 0], z: 5, limits: [-10, 10], draw: `<rect x="0" y="0" width="${hipW}" height="130" rx="34" fill="${C.pants}"/>${stroke(`M14 26 L${hipW - 14} 26`, 6, C.pantsShade)}` });
  add({
    name: 'torso',
    w: torsoW,
    h: 360,
    pivot: [torsoW / 2, 335],
    parent: 'hip',
    anchor: [hipW / 2, 35],
    z: 6,
    limits: [-10, 10],
    draw: `<path d="M0 90 Q0 0 90 0 L${torsoW - 90} 0 Q${torsoW} 0 ${torsoW} 90 L${torsoW - 6} 336 Q${torsoW - 6} 360 ${torsoW - 30} 360 L30 360 Q6 360 6 336 Z" fill="${C.shirt}"/><path d="M${torsoW / 2 - 46 + fx / 2} 0 Q${torsoW / 2 + fx / 2} 52 ${torsoW / 2 + 46 + fx / 2} 0 Z" fill="${C.shirtShade}"/><rect x="${torsoW / 2 + 30 + fx}" y="150" width="54" height="44" rx="10" fill="${C.shirtShade}"/>`,
  });
  add({ name: 'neck', w: 76, h: 130, pivot: [38, 92], parent: 'torso', anchor: [torsoW / 2 + fx / 2, 22], z: 4, limits: [-8, 8], draw: capsule(76, 130, C.skinShade) });
  add({
    name: 'head',
    w: 320,
    h: 340,
    pivot: [160 + fx / 3, 318],
    parent: 'neck',
    anchor: [38, 38],
    z: 9,
    limits: [-15, 15],
    draw: q ? `<path d="M160 3 C260 3 314 70 312 170 C310 250 268 333 170 333 C70 333 8 260 8 168 C8 70 60 3 160 3 Z" fill="${C.skin}"/>` : `<ellipse cx="160" cy="168" rx="152" ry="165" fill="${C.skin}"/>`,
  });
  add({ name: 'hair_back', w: 360, h: 320, pivot: [180, 150], parent: 'head', anchor: [160 - fx, 140], z: 1, draw: `<ellipse cx="180" cy="148" rx="176" ry="146" fill="${C.hair}"/><rect x="6" y="140" width="80" height="170" rx="40" fill="${C.hair}"/><rect x="274" y="140" width="80" height="170" rx="40" fill="${C.hair}"/>` });
  add({
    name: 'hair_front',
    w: 300,
    h: 150,
    pivot: [150, 70],
    parent: 'head',
    anchor: [160 + fx * 0.4, 70],
    z: 16,
    draw: `<path d="M6 126 Q6 -10 150 -8 Q294 -10 294 126 Q252 70 204 96 Q166 46 116 92 Q62 58 8 124 Z" fill="${C.hair}"/><path d="M60 40 Q150 16 240 40" fill="none" stroke="${C.hairLight}" stroke-width="10" stroke-linecap="round"/>`,
  });
  add({ name: 'ear_R', w: 60, h: 80, pivot: [30, 40], parent: 'head', anchor: [q ? 34 : 10, 182], z: 8, draw: `<ellipse cx="30" cy="40" rx="28" ry="38" fill="${C.skin}"/><ellipse cx="32" cy="40" rx="12" ry="20" fill="${C.skinShade}"/>` });
  add({ name: 'ear_L', w: 60, h: 80, pivot: [30, 40], parent: 'head', anchor: [q ? 296 : 310, 182], z: q ? 7 : 8, draw: `<ellipse cx="30" cy="40" rx="28" ry="38" fill="${C.skin}"/><ellipse cx="28" cy="40" rx="12" ry="20" fill="${C.skinShade}"/>` });

  const eyeX = { R: (q ? 118 : 100) + fx * 0, L: q ? 240 : 220 };
  for (const s of ['R', 'L']) {
    const w = eyeW[s];
    add({ name: `brow_${s}`, w: 70, h: 22, pivot: [35, 11], parent: 'head', anchor: [eyeX[s], 128], z: 15, draw: `<rect x="2" y="2" width="66" height="18" rx="9" fill="${C.hair}"/>` });
    add({ name: `eye_${s}`, w, h: 72, pivot: [w / 2, 36], parent: 'head', anchor: [eyeX[s], 180], z: 12, states: eyeStates(w) });
    add({ name: `pupil_${s}`, w: 30, h: 30, pivot: [15, 15], parent: `eye_${s}`, anchor: [w / 2 + (q ? 6 : 0), 40], z: 13, draw: `<circle cx="15" cy="15" r="14" fill="${C.ink}"/><circle cx="20" cy="9" r="4" fill="${C.white}"/>` });
    add({ name: `lid_${s}`, w, h: 72, pivot: [w / 2, 36], parent: `eye_${s}`, anchor: [w / 2, 36], z: 14, states: lidStates(w) });
    add({ name: `cheek_${s}`, w: 52, h: 30, pivot: [26, 15], parent: 'head', anchor: [eyeX[s] + (s === 'R' ? -12 : 12), 238], z: 10, draw: `<ellipse cx="26" cy="15" rx="24" ry="13" fill="${C.blush}" fill-opacity="0.7"/>` });
  }
  add({ name: 'nose', w: 44, h: 40, pivot: [22, 20], parent: 'head', anchor: [160 + fx * 1.6, 222], z: 11, draw: q ? `<path d="M10 4 Q20 2 38 30 Q30 38 12 34 Z" fill="${C.skinShade}"/>` : `<path d="M22 4 Q30 4 38 30 Q22 40 6 30 Q14 4 22 4 Z" fill="${C.skinShade}"/>` });
  add({ name: 'mouth', w: 120, h: 80, pivot: [60, 40], parent: 'head', anchor: [160 + fx * 1.2, 266], z: 11, states: MOUTHS });

  // arms: capsules, the round ends on the joints (shoulder, elbow); hands hang from the forearm's end centre
  const shoulder = { R: [q ? 26 : 18, 52], L: [q ? torsoW - 26 : torsoW - 18, 52] };
  for (const s of ['R', 'L']) {
    const sign = s === 'R' ? 1 : -1;
    const far = q && s === 'L';
    add({ name: `arm_upper_${s}`, w: 72, h: 210, pivot: [36, 36], parent: 'torso', anchor: shoulder[s], z: far ? 3 : 18, limits: sign > 0 ? [-60, 170] : [-170, 60], draw: capsule(72, 210, far ? C.shirtShade : C.shirt) });
    add({ name: `arm_lower_${s}`, w: 64, h: 200, pivot: [32, 32], parent: `arm_upper_${s}`, anchor: [36, 174], z: far ? 3.1 : 19, limits: sign > 0 ? [-150, 30] : [-30, 150], draw: capsule(64, 200, far ? C.skinShade : C.skin) });
    const hands = Object.fromEntries(Object.entries(HANDS).map(([k, v]) => [k, s === 'R' ? v : mirrorX(96, v)]));
    add({ name: `hand_${s}`, w: 96, h: 104, pivot: [48, 18], parent: `arm_lower_${s}`, anchor: [32, 168], z: far ? 3.2 : 20, limits: [-40, 40], states: hands });
    add({ name: `prop_hand_${s}`, pivot: [0, 0], parent: `hand_${s}`, anchor: [48, 60], z: far ? 3.3 : 21 });
  }

  // legs: capsules behind the hip; feet point outwards
  const hipJoint = { R: [q ? 60 : 62, 80], L: [q ? hipW - 56 : hipW - 62, 80] };
  for (const s of ['R', 'L']) {
    const sign = s === 'R' ? 1 : -1;
    const far = q && s === 'L';
    const zb = far ? 0.5 : 2;
    add({ name: `leg_upper_${s}`, w: 92, h: 230, pivot: [46, 46], parent: 'hip', anchor: hipJoint[s], z: zb, limits: sign > 0 ? [-25, 35] : [-35, 25], draw: capsule(92, 230, far ? C.pantsShade : C.pants) });
    add({ name: `leg_lower_${s}`, w: 84, h: 230, pivot: [42, 42], parent: `leg_upper_${s}`, anchor: [46, 184], z: zb + 0.1, limits: sign > 0 ? [-5, 25] : [-25, 5], draw: capsule(84, 230, far ? C.pantsShade : C.pants) });
    const shoe = `<path d="M50 4 L110 4 Q128 4 128 30 L128 44 Q128 62 108 62 L18 62 Q2 62 2 46 Q2 30 26 24 Z" fill="${C.shoe}"/>${stroke('M18 50 L120 50', 4, C.white)}`;
    add({ name: `foot_${s}`, w: 130, h: 64, pivot: [s === 'R' ? 82 : 48, 20], parent: `leg_lower_${s}`, anchor: [42, 188], z: zb + 0.2, limits: [-15, 15], draw: s === 'R' ? shoe : mirrorX(130, shoe) });
  }

  add({ name: 'accessory_head', pivot: [0, 0], parent: 'head', anchor: [160 + fx, 20], z: 17 });
  add({ name: 'accessory_body', pivot: [0, 0], parent: 'torso', anchor: [torsoW / 2, 120], z: 7 });
  return p;
}

export const VIEWS = ['front', 'three-quarter-L'];

// ---- composing the turnaround (rest pose, both views) -----------------------------------------------------------------

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];

function compose(parts, place, state = { eye: 'open', mouth: 'smile', hand: 'open', lid: 'open' }) {
  const by = new Map(parts.map((p) => [p.name, p]));
  const world = new Map();
  const m = (p) => {
    if (world.has(p.name)) return world.get(p.name);
    const local = mul(T(p.anchor[0], p.anchor[1]), T(-p.pivot[0], -p.pivot[1]));
    const w = p.parent ? mul(m(by.get(p.parent)), local) : mul(T(place.x, place.y), T(-p.pivot[0], -p.pivot[1]));
    world.set(p.name, w);
    return w;
  };
  return [...parts]
    .sort((a, b) => a.z - b.z)
    .map((p) => {
      const inner = p.states ? p.states[p.name.startsWith('eye_') ? state.eye : p.name.startsWith('lid_') ? state.lid : p.name === 'mouth' ? state.mouth : state.hand] : p.draw;
      if (!inner) return '';
      return `<g transform="matrix(${m(p).map((v) => +v.toFixed(3)).join(' ')})">${inner}</g>`;
    })
    .join('');
}

/** Builds the character folder (emptied first) and returns `{ dir, rig, files }`. */
export function buildRig(dir) {
  if (!dir) throw new Error('buildRig needs a character folder');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = [];
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
    files.push(rel);
    return rel;
  };
  const rigParts = [];
  const byView = {};
  for (const view of VIEWS) {
    const parts = partsFor(view);
    byView[view] = parts;
    for (const p of parts) {
      const rec = { name: p.name, view, parent: p.parent, pivot: p.pivot, anchor: p.anchor, z: p.z };
      if (p.draw !== undefined) rec.file = write(`parts/${view}/${p.name}.svg`, svg(p.w, p.h, p.draw));
      if (p.states) rec.states = Object.fromEntries(Object.entries(p.states).map(([s, inner]) => [s, write(`states/${view}/${p.name}-${s}.svg`, svg(p.w, p.h, inner))]));
      if (p.limits) rec.limits = { rot: p.limits };
      rigParts.push(rec);
    }
  }
  const sheet = svg(1500, 1300, `<rect width="1500" height="1300" fill="#F4EFE6"/>${compose(byView.front, { x: 420, y: 800 })}${compose(byView['three-quarter-L'], { x: 1080, y: 800 })}`);
  write('turnaround.svg', sheet);
  const rig = {
    format: 'cutout-rig/1',
    id: RIG_ID,
    views: VIEWS,
    unitPx: 1100,
    parts: rigParts,
    palette: [C.skin, C.hair, C.shirt, C.pants, C.shoe],
    turnaround: 'turnaround.svg',
  };
  writeFileSync(path.join(dir, 'rig.json'), `${JSON.stringify(rig, null, 2)}\n`);
  return { dir, rig, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node make-rig.mjs <character-folder>');
    process.exit(2);
  }
  const r = buildRig(path.resolve(out));
  console.log(`${r.dir} (${r.rig.parts.length} parts, ${r.files.length} files)`);
}
