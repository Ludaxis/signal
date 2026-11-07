// @vitest-environment node
// context and estimate: (the bundle never exceeds 120,000 characters on a 300 KB script; truncation
// order history → neighbours.after → style), the default run cap of and the estimate token of.
import './guard';
import { describe, expect, it } from 'vitest';
import { buildContext, CONTEXT_BUDGET, projectUpstream, UPSTREAM_VERBATIM, type ContextInput } from '@/lib/studio/postmaker/context';
import { assertEstimateToken, defaultCapUsd, estimatePlan, estimateToken } from '@/lib/studio/postmaker/estimate';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { emptyHead } from '@/lib/studio/postmaker/store/heads';

const big = (n: number, ch = 'x') => ch.repeat(n);

function script300k() {
  const beats = Array.from({ length: 60 }, (_, i) => ({ id: `b${String(i + 1).padStart(2, '0')}`, segment: 'story', targetMs: 2000, onScreen: { fa: big(400, 'ب'), en: big(400, 'e') } }));
  const lines = Array.from({ length: 300 }, (_, i) => ({ id: `l${i + 1}`, beatId: beats[i % 60]!.id, speaker: 'narrator', langs: ['fa', 'en'], fa: { display: big(400, 'ف') }, en: { display: big(400, 'e') } }));
  return { beats, lines, tempo: { bpm: 100 }, cta: { en: 'Go' } };
}

const input = (o: { history?: number; after?: number; style?: number; before?: number }): ContextInput => ({
  task: 'Script.',
  node: { id: 'script', kind: 'script', lang: 'en', params: {} },
  upstream: [{ port: 'script', nodeId: 'script', version: 1, hash: 'a'.repeat(64), locked: false, data: script300k(), files: [] }],
  downstream: [],
  neighbours: [{ beatId: 'b03', before: big(o.before ?? 1000), after: big(o.after ?? 0) }],
  pinned: [],
  history: o.history ? [{ version: 1, note: big(o.history), editedByUser: false, diffSummary: '' }] : [],
  rubric: [],
  pack: { style: `# House style\n${big(o.style ?? 0)}\n## Register\nmore text\n` },
  untrusted: { userNotes: ['Make it warmer'] },
  outputSpec: 'script as JSON',
});

describe('context budget', () => {
  it('a 300 KB script is projected (beats and own-language lines, or a summary) to at most 40,000 characters', () => {
    const s = script300k();
    expect(JSON.stringify(s).length).toBeGreaterThan(300_000);
    const p = projectUpstream(s, 'en');
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(UPSTREAM_VERBATIM);
    const small = { beats: [], lines: [] };
    expect(projectUpstream(small, 'en')).toBe(small); // verbatim when it fits
  });

  it('never exceeds 120,000 characters; cuts history, then neighbours.after, then the style guide to headings, in that order', () => {
    const all = buildContext(input({ history: 50_000, after: 50_000, style: 100_000, before: 30_000 }));
    expect(all.chars).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(all.truncated).toEqual(['history', 'neighbours.after', 'pack.style']);
    expect(all.bundle.pack.style).toBe('# House style\n## Register');
    expect(all.bundle.untrusted.userNotes).toEqual(['Make it warmer']);
    const one = buildContext(input({ history: 130_000 }));
    expect(one.truncated).toEqual(['history']);
    expect(one.bundle.neighbours![0]!.before).toHaveLength(1000);
    const two = buildContext(input({ history: 50_000, after: 125_000 }));
    expect(two.truncated).toEqual(['history', 'neighbours.after']);
    const none = buildContext(input({}));
    expect(none.truncated).toEqual([]);
    expect(none.chars).toBeLessThanOrEqual(CONTEXT_BUDGET);
    const ref = buildContext({ ...input({}), untrusted: { referenceText: big(300_000, '"') } });
    expect(ref.chars).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(ref.truncated).toEqual(['pack.style', 'upstream', 'untrusted.referenceText']); // the reference text is cut last
  });
});

describe('estimate', () => {
  it('default cap = ceil(usdHigh × 1.25 / 0.5) × 0.5', () => {
    expect(defaultCapUsd(8.2)).toBe(10.5);
    expect(defaultCapUsd(0)).toBe(0);
    expect(defaultCapUsd(0.01)).toBe(0.5);
    expect(defaultCapUsd(0.4)).toBe(0.5);
    expect(defaultCapUsd(0.41)).toBe(1);
  });

  it('sums the plan, takes the critical path for time, and binds the token to heads, scope and usdHigh', () => {
    const heads = { a: emptyHead(0), b: emptyHead(0), c: emptyHead(0) };
    const node = (nodeId: string, usd: number, seconds: number, unknown = false) => ({ nodeId, connector: 'x', mode: 'live' as const, usdLow: usd / 2, usdHigh: usd, seconds, basis: '', verified: !unknown, unknown });
    const e = estimatePlan({ recipeId: 'rc-20261106-0001', plan: ['a', 'b', 'c'], parents: (id) => (id === 'c' ? ['a', 'b'] : []), heads, nodes: [node('a', 0.1, 10), node('b', 0.2, 30, true), node('c', 0.3, 5)] });
    expect(e).toMatchObject({ usdLow: 0.3, usdHigh: 0.6, seconds: 35, unknown: ['b'] });
    expect(e.token).toBe(estimateToken({ recipeId: 'rc-20261106-0001', heads, scope: ['a', 'b', 'c'], usdHigh: 0.6 }));
    expect(e.token).not.toBe(estimateToken({ recipeId: 'rc-20261106-0001', heads: { ...heads, a: { ...heads.a, current: 1 } }, scope: ['a', 'b', 'c'], usdHigh: 0.6 }));
    expect(e.token).not.toBe(estimateToken({ recipeId: 'rc-20261106-0001', heads, scope: ['a', 'b'], usdHigh: 0.6 }));
    expect(e.token).not.toBe(estimateToken({ recipeId: 'rc-20261106-0001', heads, scope: ['a', 'b', 'c'], usdHigh: 0.7 }));
    expect(() => assertEstimateToken(e, e.token)).not.toThrow();
    try {
      assertEstimateToken(e, 'stale');
      throw new Error('expected 409');
    } catch (err) {
      expect(isPostmakerError(err, 'estimate-changed')).toBe(true);
      expect((err as { estimate: unknown }).estimate).toBe(e);
    }
  });
});
