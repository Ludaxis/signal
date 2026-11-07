// @vitest-environment node
// property test on the 22-node fixture: random sequences of edit / regenerate / regenerate-from-here / lock /
// unlock / use-version / skip / unskip / run keep `outOfDate` equal to a brute-force recomputation (written
// independently of graph/status.ts: path search over unlocked nodes), never write a version to a locked node, and
// never leave a head pointing at a missing version. fast-check is not installed in this repository (made the
// same call), so this uses a seeded generator (mulberry32) with fixed seeds; a failure prints seed and step.
import './guard';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveStatus, type GraphState } from '@/lib/studio/postmaker/graph/status';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { hashJson } from '@/lib/studio/postmaker/store/objects';
import { getJson } from '@/lib/studio/postmaker/store/objects';
import { listVersionNumbers, readVersion } from '@/lib/studio/postmaker/store/versions';
import type { Pipeline } from '@/lib/studio/postmaker/types';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';

afterEach(() => {
  _resetSchedulerState();
  _resetEngineState();
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent recomputation: direct reasons by plain comparison, propagation by path search through unlocked nodes. */
function bruteForce(s: GraphState, p: Pipeline): Set<string> {
  const usable = (id: string) => !s.heads[id]!.locked && !s.heads[id]!.skipped && s.current[id] !== null;
  const direct = new Set<string>();
  for (const n of p.nodes) {
    const v = s.current[n.id];
    if (!v || s.heads[n.id]!.skipped) continue;
    const parents = [...new Set(n.inputs.map((i) => i.from))];
    let d = false;
    for (const pid of parents) {
      const rec = v.inputs.find((i) => i.nodeId === pid);
      const up = s.current[pid];
      if (rec ? !up || up.hash !== rec.hash : !!up) d = true;
    }
    if (v.inputs.some((i) => !parents.includes(i.nodeId))) d = true;
    if (hashJson(n.params) !== hashJson(v.params)) d = true;
    if (s.implVersions[n.kind] && s.implVersions[n.kind] !== v.implVersion) d = true;
    if (d) direct.add(n.id);
  }
  const children = new Map<string, string[]>();
  for (const n of p.nodes) for (const i of n.inputs) children.set(i.from, [...new Set([...(children.get(i.from) ?? []), n.id])]);
  const out = new Set<string>();
  for (const a of direct) {
    if (!usable(a)) continue;
    const stack = [a];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      out.add(x);
      for (const c of children.get(x) ?? []) if (usable(c)) stack.push(c);
    }
  }
  return out;
}

const SEEDS = [3, 7, 11, 19, 42, 101, 2026, 31337];
const OPS = 24;

describe('property: derived out-of-date equals brute force on the 22-node graph; locked nodes never change', () => {
  it(`holds over ${SEEDS.length} seeds × ${OPS} random actions`, { timeout: 120_000 }, async () => {
    let checked = 0;
    let staleSteps = 0;
    const ok: Record<string, number> = {};
    for (const seed of SEEDS) {
      const { engine, recipeId, pipeline } = await setup({ id: `rc-20261106-${seed.toString(16).padStart(4, '0').slice(-4)}` });
      expect(pipeline.nodes).toHaveLength(22);
      await runAll(engine, recipeId);
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const ids = pipeline.nodes.map((n) => n.id);
      for (let step = 0; step < OPS; step++) {
        const where = `seed ${seed} step ${step}`;
        const before = await engine.state(recipeId);
        const locked = ids.filter((id) => before.heads[id]!.locked);
        const lockedVersions = Object.fromEntries(await Promise.all(locked.map(async (id) => [id, await listVersionNumbers(tmp.root, recipeId, id)] as const)));
        const id = pick(ids);
        const r = rnd();
        let op = '';
        try {
          if (r < 0.2) {
            op = 'regenerate';
            await engine.regenerate({ recipeId, nodeId: id, mode: rnd() < 0.5 ? 'keep-contracts' : 'allow-breaks', overwriteEdit: true });
          } else if (r < 0.3) {
            op = 'from-here';
            await (await engine.regenerateFromHere({ recipeId, nodeId: id, overwriteEdit: true })).done;
          } else if (r < 0.45) {
            op = 'edit';
            const cur = before.current[id];
            if (cur) {
              const json: Record<string, unknown> = {};
              for (const o of cur.outputs) if (o.kind === 'json' && !(o.port in json)) json[o.port] = await getJson(tmp.root, o.sha256);
              await engine.edit({ recipeId, nodeId: id, baseVersion: cur.n, output: { json }, by: 'tester@example.test' });
            }
          } else if (r < 0.6) {
            op = before.heads[id]!.locked ? 'unlock' : 'lock';
            if (before.heads[id]!.locked) await engine.unlock(recipeId, id);
            else await engine.lock(recipeId, id, 'tester@example.test');
          } else if (r < 0.75) {
            op = 'use-version';
            const ns = await listVersionNumbers(tmp.root, recipeId, id);
            if (ns.length) await engine.useVersion(recipeId, id, pick(ns));
          } else if (r < 0.85) {
            op = before.heads[id]!.skipped ? 'unskip' : 'skip';
            await engine.skip(recipeId, id, !before.heads[id]!.skipped);
          } else {
            op = 'run';
            await runAll(engine, recipeId);
          }
          ok[op] = (ok[op] ?? 0) + 1;
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status !== 409 && status !== 404) throw new Error(`${where} ${op} ${id}: ${String(e)}`);
        }
        const s = await engine.state(recipeId);
        const derived = new Set(Object.values(deriveStatus(s)).filter((x) => x.outOfDate).map((x) => x.nodeId));
        expect([...derived].sort(), `${where} after ${op} ${id}`).toEqual([...bruteForce(s, pipeline)].sort());
        if (derived.size) staleSteps++;
        for (const l of locked) {
          if (!s.heads[l]!.locked) continue; // unlocked by this very action
          expect(await listVersionNumbers(tmp.root, recipeId, l), `${where}: ${op} wrote to locked ${l}`).toEqual(lockedVersions[l]);
        }
        for (const n of ids) {
          const h = s.heads[n]!;
          if (h.current !== null) expect(await readVersion(tmp.root, recipeId, n, h.current), `${where}: head of ${n}`).not.toBeNull();
        }
        checked++;
      }
    }
    expect(checked).toBe(SEEDS.length * OPS);
    // the sequences exercised the interesting states, not only the trivial "all current" one
    expect(staleSteps).toBeGreaterThan(checked / 4);
    for (const op of ['regenerate', 'from-here', 'edit', 'lock', 'unlock', 'use-version', 'skip', 'run']) expect(ok[op] ?? 0, op).toBeGreaterThan(0);
  });
});
