// @vitest-environment node
// Property test: random sequences (sequential and concurrent) of object puts, version commits, head moves, locks and
// reads never leave a head pointing at a missing or damaged version, or at a version whose output objects are
// missing. fast-check is not installed in this repository, so this uses a small seeded generator (mulberry32) with
// fixed seeds: every failure is reproducible from the printed seed and step.
import './guard';
import { describe, expect, it } from 'vitest';
import { commitVersion } from '@/lib/studio/postmaker/store/commit';
import { lockStep, readHead, setCurrent, setSkipped, unlockStep } from '@/lib/studio/postmaker/store/heads';
import { getBytes, hasObject, putBytes } from '@/lib/studio/postmaker/store/objects';
import { listVersionNumbers, readVersion } from '@/lib/studio/postmaker/store/versions';
import type { ArtifactRef, StepVersion } from '@/lib/studio/postmaker/types';
import { versionDraft } from './fixtures';
import { tmp } from './guard';

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

const RC = 'rc-20261106-0001';
const NODES = ['script', 'voice:fa', 'voice:en', 'art', 'captions:fa'];
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946];
const OPS_PER_SEED = 60;

async function checkInvariant(where: string): Promise<void> {
  for (const nodeId of NODES) {
    const head = await readHead(tmp.root, RC, nodeId);
    if (head.current === null) continue;
    let v: StepVersion | null = null;
    try {
      v = await readVersion(tmp.root, RC, nodeId, head.current);
    } catch (e) {
      throw new Error(`${where}: head of ${nodeId} points at damaged v${head.current}: ${String(e)}`);
    }
    expect(v, `${where}: head of ${nodeId} points at missing v${head.current}`).not.toBeNull();
    for (const o of v!.outputs) expect(await hasObject(tmp.root, o.sha256), `${where}: ${nodeId} v${v!.n} output ${o.name} missing`).toBe(true);
  }
}

describe('property: heads never point at a missing version', () => {
  it(`holds over ${SEEDS.length} seeds × ${OPS_PER_SEED} random operations (with concurrent batches)`, async () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const stored: string[] = [];
      const counts = { commits: 0, refused: 0 };

      const op = async (step: number): Promise<void> => {
        const nodeId = pick(NODES);
        const r = rnd();
        try {
          if (r < 0.2) {
            const p = await putBytes(tmp.root, `seed ${seed} blob ${Math.floor(rnd() * 12)}`);
            stored.push(p.sha256);
          } else if (r < 0.5) {
            const outputs: ArtifactRef[] = [];
            const n = Math.floor(rnd() * 3);
            for (let i = 0; i < n; i++) {
              // Sometimes name an object that was never stored: the commit must be refused.
              const sha = rnd() < 0.75 && stored.length ? pick(stored) : (rnd().toString(16).slice(2) + '0'.repeat(64)).slice(0, 64);
              outputs.push({ port: `p${i}`, name: `out-${i}.bin`, kind: 'json', mime: 'application/json', sha256: sha, bytes: 1 });
            }
            const status = pick(['ok', 'ok', 'ok', 'failed', 'needs-you', 'candidate'] as const);
            await commitVersion(tmp.root, versionDraft(RC, nodeId, { outputs, status, note: `s${seed}:${step}` }), { makeCurrent: rnd() < 0.2 ? false : undefined });
            counts.commits++;
          } else if (r < 0.72) {
            const max = (await listVersionNumbers(tmp.root, RC, nodeId)).at(-1) ?? 0;
            const target = rnd() < 0.1 ? null : Math.floor(rnd() * (max + 3)); // includes 0 and numbers past the end
            await setCurrent(tmp.root, RC, nodeId, target === 0 ? 1 : target, { allowCandidate: rnd() < 0.3 });
          } else if (r < 0.8) {
            await lockStep(tmp.root, RC, nodeId, 'tester@example.test');
          } else if (r < 0.88) {
            await unlockStep(tmp.root, RC, nodeId);
          } else if (r < 0.92) {
            await setSkipped(tmp.root, RC, nodeId, rnd() < 0.5);
          } else if (r < 0.96 && stored.length) {
            await getBytes(tmp.root, pick(stored), { verify: true });
          } else {
            const max = (await listVersionNumbers(tmp.root, RC, nodeId)).at(-1) ?? 0;
            if (max) await readVersion(tmp.root, RC, nodeId, 1 + Math.floor(rnd() * max));
          }
        } catch (e) {
          // Refusals are expected (locked node, missing version or object, candidate); they must not break the store.
          const code = (e as { code?: string }).code;
          if (!['locked', 'version-missing', 'object-missing', 'candidate', 'not_found'].includes(code ?? '')) throw new Error(`seed ${seed} step ${step}: ${String(e)}`);
          counts.refused++;
        }
      };

      for (let step = 0; step < OPS_PER_SEED; ) {
        if (rnd() < 0.3) {
          // A concurrent batch of 2-6 operations on the same recipe.
          const k = 2 + Math.floor(rnd() * 5);
          await Promise.all(Array.from({ length: k }, (_, i) => op(step + i)));
          step += k;
        } else {
          await op(step);
          step += 1;
        }
        await checkInvariant(`seed ${seed} step ${step}`);
      }
      // Every committed number is contiguous per node (no gaps, no duplicates under concurrency).
      for (const nodeId of NODES) {
        const ns = await listVersionNumbers(tmp.root, RC, nodeId);
        expect(ns, `seed ${seed} ${nodeId}`).toEqual(ns.map((_, i) => i + 1));
      }
      expect(counts.commits + counts.refused, `seed ${seed} did something`).toBeGreaterThan(0);
    }
  }, 60_000);
});
