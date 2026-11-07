// Downstream requirement validators and contract diffs. One pure validator per `ExpectRule.key`:
// (what the dependent relied on, the new upstream contract, tolerance) → { ok, text, measured }. Tolerances are the
// quality doc's table: lineMs ±8 % or ±250 ms (whichever is larger), beatFrames ±6 frames per beat and ±15
// frames total, anchors ±40 px, tempo ±1 BPM, wordTimings always recompute.
import { canonicalize } from '../store/objects';
import type { Contract, ContractDiff, ExpectRule } from '../types';

export interface RuleResult {
  ok: boolean;
  text: string;
  measured: unknown;
}

const BEAT_TOTAL_FRAMES = 15;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const same = (a: unknown, b: unknown) => canonicalize(a ?? null) === canonicalize(b ?? null);
const tol = (r: ExpectRule) => (typeof r.tolerance === 'object' ? r.tolerance : {});

/** The allowed band for a line of `ms`: ±pct % or ±ms, whichever is larger. */
export function lineBand(ms: number, t: { pct?: number; ms?: number }): [number, number] {
  const d = Math.max((ms * (t.pct ?? 0)) / 100, t.ms ?? 0);
  return [ms - d, ms + d];
}

function checkLineMs(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  const a = after.lineMs ?? {};
  const t = tol(r);
  if (r.id.endsWith('.maxMs')) {
    const over = Object.entries(a).filter(([, ms]) => ms > (t.ms ?? Infinity));
    return over.length
      ? { ok: false, text: over.map(([id, ms]) => `Line ${id} must be at most ${fmt(t.ms!)} ms; your take was ${fmt(ms)} ms`).join('. '), measured: Object.fromEntries(over) }
      : { ok: true, text: r.label, measured: null };
  }
  const b = before.lineMs ?? {};
  const bad: string[] = [];
  const measured: Record<string, number | null> = {};
  for (const [id, ms] of Object.entries(b)) {
    const now = a[id];
    if (now === undefined) {
      bad.push(`Line ${id} is missing`);
      measured[id] = null;
      continue;
    }
    const [lo, hi] = lineBand(ms, t);
    if (now < lo || now > hi) {
      bad.push(`Line ${id} must be ${fmt(lo)}-${fmt(hi)} ms; your take was ${fmt(now)} ms`);
      measured[id] = now;
    }
  }
  return bad.length ? { ok: false, text: bad.join('. '), measured } : { ok: true, text: r.label, measured: null };
}

const beatLen = (f: [number, number]) => f[1] - f[0];

function checkBeatFrames(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  const b = before.beatFrames ?? {};
  const a = after.beatFrames ?? {};
  const per = tol(r).frames ?? 6;
  const bad: string[] = [];
  let total = 0;
  for (const [id, f] of Object.entries(b)) {
    const g = a[id];
    if (!g) {
      bad.push(`Beat ${id} is missing`);
      continue;
    }
    const d = beatLen(g) - beatLen(f);
    total += d;
    if (Math.abs(d) > per) bad.push(`Beat ${id} must stay within ${per} frames; it moved ${d} frames`);
  }
  if (Math.abs(total) > BEAT_TOTAL_FRAMES) bad.push(`The length must stay within ${BEAT_TOTAL_FRAMES} frames; it moved ${total} frames`);
  return bad.length ? { ok: false, text: bad.join('. '), measured: { total } } : { ok: true, text: r.label, measured: { total } };
}

function checkAnchors(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  const px = tol(r).px ?? 40;
  const bad: string[] = [];
  for (const [id, p] of Object.entries(before.anchors ?? {})) {
    const q = after.anchors?.[id];
    if (!q) {
      bad.push(`Placement ${id} is missing`);
      continue;
    }
    const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y), Math.abs(q.h - p.h));
    if (d > px) bad.push(`Placement ${id} must stay within ${px} px; it moved ${fmt(d)} px`);
  }
  return bad.length ? { ok: false, text: bad.join('. '), measured: null } : { ok: true, text: r.label, measured: null };
}

function checkTempo(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  if (!before.tempo) return { ok: true, text: r.label, measured: null };
  if (!after.tempo) return { ok: false, text: 'The tempo is missing', measured: null };
  const bpm = tol(r).bpm ?? 1;
  const d = after.tempo.bpm - before.tempo.bpm;
  return Math.abs(d) > bpm ? { ok: false, text: `Tempo must stay within ${bpm} BPM of ${before.tempo.bpm}; it is ${after.tempo.bpm}`, measured: d } : { ok: true, text: r.label, measured: d };
}

function checkFrames(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  if (before.totalFrames === undefined) return { ok: true, text: r.label, measured: null };
  const allowed = r.tolerance === 'exact' ? 0 : (tol(r).frames ?? 0);
  const d = (after.totalFrames ?? NaN) - before.totalFrames;
  return Math.abs(d) <= allowed ? { ok: true, text: r.label, measured: d } : { ok: false, text: `The length must stay at ${before.totalFrames} frames; it is ${after.totalFrames ?? 'missing'}`, measured: d };
}

function checkExact(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  if (before[r.key] === undefined) return { ok: true, text: r.label, measured: null };
  return same(before[r.key], after[r.key]) ? { ok: true, text: r.label, measured: null } : { ok: false, text: `${r.label}: this changed`, measured: after[r.key] ?? null };
}

/** Validates one rule: `before` is the upstream contract the dependent was made from, `after` the new one. */
export function checkRule(r: ExpectRule, before: Contract, after: Contract): RuleResult {
  if (r.tolerance === 'recompute') return { ok: true, text: r.label, measured: null };
  switch (r.key) {
    case 'lineMs':
      return checkLineMs(r, before, after);
    case 'beatFrames':
      return checkBeatFrames(r, before, after);
    case 'anchors':
      return checkAnchors(r, before, after);
    case 'tempo':
      return checkTempo(r, before, after);
    case 'totalFrames':
      return checkFrames(r, before, after);
    default:
      return checkExact(r, before, after);
  }
}

/**
 * The contract diff between two versions of one node: one entry per changed sub-key (`lineMs.l03`,
 * `beatFrames.b02` when that beat's length changed, `totalFrames`, `tempo.bpm`, …). `dependents` is filled by the
 * caller (`dependentsOf(key)`).
 */
export function contractDiff(before: Contract, after: Contract, dependentsOf: (key: string) => string[] = () => []): ContractDiff {
  const out: ContractDiff = [];
  const push = (key: string, from: unknown, to: unknown) => out.push({ key, from: from ?? null, to: to ?? null, dependents: dependentsOf(key) });
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort() as (keyof Contract)[];
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (same(b, a)) continue;
    if (key === 'beatFrames') {
      const bb = (b ?? {}) as Record<string, [number, number]>;
      const aa = (a ?? {}) as Record<string, [number, number]>;
      for (const id of [...new Set([...Object.keys(bb), ...Object.keys(aa)])].sort()) {
        if (!bb[id] || !aa[id] || beatLen(bb[id]) !== beatLen(aa[id])) push(`beatFrames.${id}`, bb[id], aa[id]);
      }
      continue;
    }
    if ((key === 'lineMs' || key === 'anchors' || key === 'wordTimings' || key === 'textZones' || key === 'cta') && (b || a)) {
      const bb = (b ?? {}) as Record<string, unknown>;
      const aa = (a ?? {}) as Record<string, unknown>;
      for (const id of [...new Set([...Object.keys(bb), ...Object.keys(aa)])].sort()) if (!same(bb[id], aa[id])) push(`${key}.${id}`, bb[id], aa[id]);
      continue;
    }
    if (key === 'tempo') {
      const tb = b as Contract['tempo'];
      const ta = a as Contract['tempo'];
      if (tb?.bpm !== ta?.bpm) push('tempo.bpm', tb?.bpm, ta?.bpm);
      else push('tempo', tb, ta);
      continue;
    }
    push(key, b, a);
  }
  return out;
}
