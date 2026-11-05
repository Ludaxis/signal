// the statistics behind project memory (design section 4): decay, maturity, nEff, intervals,
// confidence caps, goal → metric, hook classification, Thompson sampling and branch status gates.
import { describe, expect, it } from 'vitest';
import {
  branchStatusFromStats,
  classifyHook,
  computeLearnings,
  confidenceCap,
  estimateEffect,
  halfLifeFor,
  hourBucket,
  maturity,
  metricValue,
  metricsFor,
  observationWeight,
  predictNext,
  primaryMetricFor,
  recencyWeight,
  seededRng,
  significance,
  thompsonPick,
  type PostObservation,
} from '@/lib/studio/memory/stats';
import type { BranchStatus, Learning } from '@/lib/studio/memory/types';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86_400_000;
const m = (reach: number, saves: number, comments = 1) => ({ views: reach * 2, reach, likes: 10, comments, saves, shares: 0 });

function post(id: string, daysAgo: number, metrics: ReturnType<typeof m> | null, extra: Partial<PostObservation> = {}): PostObservation {
  const postedAt = new Date(NOW - daysAgo * DAY).toISOString();
  return { id, postedAt, metricsAt: new Date(NOW).toISOString(), metrics, format: 'reel', campaign: null, pillar: null, hook: null, ...extra };
}

describe('decay and maturity', () => {
  it('halves the weight every half-life and never exceeds 1', () => {
    expect(recencyWeight(0, 14)).toBe(1);
    expect(recencyWeight(14, 14)).toBeCloseTo(0.5);
    expect(recencyWeight(28, 14)).toBeCloseTo(0.25);
    expect(recencyWeight(7, 7)).toBeCloseTo(0.5);
    expect(recencyWeight(-3, 14)).toBe(1); // a post dated in the future counts as fresh
  });
  it('matures over 48 hours', () => {
    expect(maturity(0)).toBe(0);
    expect(maturity(24)).toBeCloseTo(0.5);
    expect(maturity(48)).toBe(1);
    expect(maturity(500)).toBe(1);
  });
  it('uses 14 days by default and 7 for launches', () => {
    expect(halfLifeFor('engagement')).toBe(14);
    expect(halfLifeFor('awareness')).toBe(14);
    expect(halfLifeFor('launch')).toBe(7);
  });
  it('combines recency and maturity; maturity comes from the metrics fetch time when known', () => {
    const fresh = { postedAt: new Date(NOW - 26 * 3_600_000).toISOString(), metricsAt: new Date(NOW).toISOString() };
    expect(observationWeight(fresh, NOW, 14)).toBeCloseTo(recencyWeight(26 / 24, 14) * (26 / 48), 6);
    const stale = { postedAt: new Date(NOW - 10 * DAY).toISOString(), metricsAt: new Date(NOW - 10 * DAY + 12 * 3_600_000).toISOString() };
    expect(observationWeight(stale, NOW, 14)).toBeCloseTo(recencyWeight(10, 14) * 0.25, 6);
    expect(observationWeight({ postedAt: 'garbage', metricsAt: null }, NOW, 14)).toBe(0);
  });
});

describe('metrics and goals', () => {
  it('picks the primary metric per goal (design 5.3)', () => {
    expect(primaryMetricFor('awareness')).toBe('reach');
    expect(metricsFor('engagement')).toEqual({ primary: 'saves_per_reach', secondary: 'comments_per_reach' });
    expect(primaryMetricFor('installs')).toBe('saves_per_reach');
    expect(primaryMetricFor('traffic')).toBe('saves_per_reach');
    expect(primaryMetricFor('launch')).toBe('reach');
    expect(primaryMetricFor('community')).toBe('comments_per_reach');
  });
  it('computes per-reach ratios with views as the fallback and null when data is missing', () => {
    expect(metricValue(m(1000, 30), 'saves_per_reach')).toBeCloseTo(0.03);
    expect(metricValue({ views: 500, reach: null, likes: null, comments: null, saves: 10, shares: null }, 'saves_per_reach')).toBeCloseTo(0.02);
    expect(metricValue({ views: 500, reach: null, likes: null, comments: null, saves: 10, shares: null }, 'reach')).toBe(500);
    expect(metricValue({ views: null, reach: null, likes: 1, comments: 1, saves: 1, shares: 1 }, 'engagement_rate')).toBeNull();
    expect(metricValue(m(200, 4, 2), 'engagement_rate')).toBeCloseTo((10 + 2 + 4 + 0) / 200);
    expect(metricValue({ views: 100, reach: 100, likes: null, comments: null, saves: null, shares: null }, 'engagement_rate')).toBeNull();
    expect(metricValue(null, 'views')).toBeNull();
  });
});

describe('hook classifier and hour buckets', () => {
  it('classifies questions by a trailing ? or a question opener', () => {
    expect(classifyHook('Which 3 belong together?')).toBe('question');
    expect(classifyHook('Guess the link')).toBe('question');
    expect(classifyHook('🎯 Spot the impostor')).toBe('question');
    expect(classifyHook('Can you beat level 12')).toBe('question');
    expect(classifyHook('Most people miss #2')).toBe('statement');
    expect(classifyHook('Three frames from a cold morning.')).toBe('statement');
    expect(classifyHook('')).toBe('statement');
    expect(classifyHook(null)).toBe('statement');
  });
  it('groups posting hours in 3-hour buckets', () => {
    expect(hourBucket(18)).toBe(18);
    expect(hourBucket(19)).toBe(18);
    expect(hourBucket(23)).toBe(21);
    expect(hourBucket(0)).toBe(0);
  });
});

describe('computeLearnings', () => {
  const posts = [
    post('01', 1, m(1000, 60), { hook: 'Which 3 belong together?' }),
    post('02', 2, m(1000, 50), { hook: 'Guess the link' }),
    post('03', 3, m(1000, 55), { hook: 'Spot the odd one?' }),
    post('03b', 3.5, m(1000, 48), { hook: 'What links these three?' }),
    post('04', 4, m(1000, 20), { hook: 'Most people miss #2' }),
    post('05', 5, m(1000, 22), { hook: 'A calm puzzle for your evening' }),
    post('06', 6, m(1000, 18), { hook: 'Three new categories dropped' }),
    post('07', 7, m(1000, 25), { hook: 'New levels this week', format: 'carousel' }),
    post('08', 8, null, { hook: 'No results yet' }), // never measured: ignored
  ];

  it('finds that question hooks beat statement hooks, with an interval that excludes 1', () => {
    const ls = computeLearnings(posts, { now: NOW, goal: 'engagement', seed: 't' });
    const q = ls.find((l) => l.id === 'lr:project:saves_per_reach:hook:question')!;
    const s = ls.find((l) => l.id === 'lr:project:saves_per_reach:hook:statement')!;
    expect(q.n).toBe(4);
    expect(q.nEff).toBeGreaterThanOrEqual(3);
    expect(q.effect!).toBeGreaterThan(1.3);
    expect(q.interval![0]).toBeGreaterThan(1);
    expect(significance(q)).toBe(true);
    expect(q.text).toMatch(/^Question hooks get \d\.\d× more saves per reach than average \(n 4\)\./);
    expect(s.effect!).toBeLessThan(1);
    expect(s.interval![1]).toBeLessThan(1);
    expect(s.text).toMatch(/^Statement hooks get \d+% less saves per reach than average \(n 4\)\./);
    expect(q.confidence).toBeLessThanOrEqual(0.95); // capped until nEff ≥ 10
    expect(q.nEff).toBeCloseTo(
      posts
        .slice(0, 4)
        .map((p) => observationWeight(p, NOW, 14))
        .reduce((a, b) => a + b, 0),
      6,
    );
    // The baseline and the secondary metric are there too.
    expect(ls.find((l) => l.id === 'lr:project:saves_per_reach:baseline')!.n).toBe(8);
    expect(ls.some((l) => l.metric === 'comments_per_reach')).toBe(true);
    // Deterministic: same inputs, same numbers.
    expect(computeLearnings(posts, { now: NOW, goal: 'engagement', seed: 't' })).toEqual(ls);
  });

  it('marks scopes with nEff below 3 as too little data and gives a lone post no interval', () => {
    const ls = computeLearnings(posts, { now: NOW, goal: 'engagement', seed: 't' });
    const carousel = ls.find((l) => l.id === 'lr:project:saves_per_reach:format:carousel')!;
    expect(carousel.n).toBe(1);
    expect(carousel.status).toBe('too-little-data');
    expect(carousel.interval).toBeNull();
    expect(carousel.confidence).toBe(0.5);
    expect(carousel.text).toContain('Too little data yet');
    expect(significance(carousel)).toBe(false);
  });

  it('lets fresh posts barely count (maturity) and decays old ones (recency)', () => {
    const fresh = post('09', 0.25, m(1000, 200), { metricsAt: new Date(NOW).toISOString(), hook: 'Which one?' }); // 6 h old
    const ls = computeLearnings([...posts, fresh], { now: NOW, goal: 'engagement', seed: 't' });
    const q = ls.find((l) => l.id === 'lr:project:saves_per_reach:hook:question')!;
    expect(q.n).toBe(5);
    expect(q.nEff).toBeLessThan(4); // the 6-hour post adds only 6/48 of a weight
    const old = computeLearnings(
      posts.map((p) => ({ ...p, postedAt: new Date(Date.parse(p.postedAt) - 60 * DAY).toISOString() })),
      { now: NOW, goal: 'engagement', seed: 't' },
    );
    expect(old.find((l) => l.id === 'lr:project:saves_per_reach:hook:question')!.nEff).toBeLessThan(0.2);
  });

  it('builds campaign-scoped pillar and hypothesis learnings against the project baseline', () => {
    const camp = posts.map((p, i) => ({ ...p, campaign: 'c-20261101-ab12', pillar: i < 4 ? 'Guess the link' : 'Seasonal' }));
    const ls = computeLearnings(camp, { now: NOW, goal: 'engagement', campaign: 'c-20261101-ab12', seed: 't' });
    const pillar = ls.find((l) => l.id === 'lr:c-20261101-ab12:saves_per_reach:pillar:guess-the-link')!;
    expect(pillar.scope).toEqual({ campaign: 'c-20261101-ab12', branch: 'pl:c-20261101-ab12:guess-the-link' });
    expect(pillar.branch).toBe('pl:c-20261101-ab12:guess-the-link');
    expect(pillar.effect!).toBeGreaterThan(1);
    const hyp = ls.find((l) => l.scope.branch === 'hyp:c-20261101-ab12:guess-the-link:hook:question')!;
    expect(hyp.scope.hookStyle).toBe('question');
    expect(hyp.n).toBe(4);
    expect(ls.some((l) => l.scope.branch === 'hyp:c-20261101-ab12:seasonal:format:reel')).toBe(true);
    expect(ls.some((l) => Object.keys(l.scope).length === 0)).toBe(false); // no baseline row in campaign mode
    const project = computeLearnings(posts, { now: NOW, goal: 'engagement', seed: 't' });
    for (const l of ls) expect(l.baseline).toBe(project.find((b) => b.metric === l.metric && Object.keys(b.scope).length === 0)!.baseline);
  });

  it('is safe with no posts', () => {
    const ls = computeLearnings([], { now: NOW, goal: 'awareness' });
    expect(ls).toHaveLength(2); // reach + shares baselines
    expect(ls[0]).toMatchObject({ status: 'too-little-data', n: 0, effect: null, mean: null });
  });
});

describe('confidence', () => {
  it('caps at 0.95 until nEff reaches 10', () => {
    expect(confidenceCap(3)).toBe(0.95);
    expect(confidenceCap(9.99)).toBe(0.95);
    expect(confidenceCap(10)).toBe(0.99);
    expect(confidenceCap(1.5)).toBeCloseTo(0.725); // two immature posts cannot look sure
    expect(confidenceCap(0)).toBe(0.5);
    const scope = Array.from({ length: 12 }, (_, i) => ({ value: 10 + (i % 3), w: 1 }));
    const base = [...scope, ...Array.from({ length: 12 }, (_, i) => ({ value: 2 + (i % 3), w: 1 }))];
    const big = estimateEffect(scope, base, seededRng(1));
    expect(big.confidence).toBeGreaterThan(0.95);
    expect(big.confidence).toBeLessThanOrEqual(0.99);
    const small = estimateEffect(scope.slice(0, 4), base, seededRng(1));
    expect(small.confidence).toBeLessThanOrEqual(0.95);
  });
  it('is 0.5 and has no interval when nothing can be resampled', () => {
    expect(estimateEffect([{ value: 1, w: 1 }], [{ value: 1, w: 1 }], seededRng(1))).toEqual({ effect: 1, interval: null, confidence: 0.5 });
    expect(estimateEffect([], [{ value: 1, w: 1 }], seededRng(1))).toEqual({ effect: null, interval: null, confidence: 0.5 });
  });
});

describe('prediction and allocation', () => {
  it('shrinks a small sample toward the baseline', () => {
    expect(predictNext({ mean: 0.06, nEff: 1 }, 0.03)).toBeCloseTo((1 * 0.06 + 3 * 0.03) / 4);
    expect(predictNext({ mean: 0.06, nEff: 30 }, 0.03)).toBeGreaterThan(0.055);
    expect(predictNext({ mean: null, nEff: 0 }, 0.03)).toBe(0.03);
    expect(predictNext({ mean: 0.06, nEff: 5 }, null)).toBe(0.06);
    expect(predictNext(null, 0.03)).toBe(0.03);
  });

  it('exploits the best branch but keeps exploring at the floor, deterministically', () => {
    const branches = [
      { id: 'best', mean: 0.06, nEff: 40 },
      { id: 'mid', mean: 0.03, nEff: 40 },
      { id: 'poor', mean: 0.01, nEff: 40 },
    ];
    const count = (floor: number, seed: number) => {
      const rng = seededRng(seed);
      const c: Record<string, number> = { best: 0, mid: 0, poor: 0 };
      for (let i = 0; i < 3000; i++) c[thompsonPick(branches, rng, { exploreFloor: floor })!]!++;
      return c;
    };
    const a = count(0.2, 7);
    expect(a).toEqual(count(0.2, 7)); // seeded → reproducible
    expect(a.best!).toBeGreaterThan(2000);
    expect(a.poor! / 3000).toBeGreaterThan(0.045); // ≥ floor / branches, minus noise
    expect(a.poor! / 3000).toBeLessThan(0.1);
    const b = count(0, 7);
    expect(b.poor!).toBeLessThan(5);
    expect(thompsonPick([], seededRng(1))).toBeNull();
    // An untested branch gets wide draws and is picked sometimes even with no floor.
    const c = seededRng(3);
    let fresh = 0;
    for (let i = 0; i < 2000; i++) if (thompsonPick([{ id: 'known', mean: 0.03, nEff: 40 }, { id: 'new', mean: 0.03, nEff: 0 }], c, { exploreFloor: 0 }) === 'new') fresh++;
    expect(fresh).toBeGreaterThan(400);
  });
});

describe('decisions 15 and 16', () => {
  const L = (p: Partial<Learning>): Pick<Learning, 'nEff' | 'effect' | 'confidence' | 'n' | 'interval'> => ({ nEff: 5, effect: 1.5, confidence: 0.9, n: 5, interval: [1.1, 2], ...p });

  it('needs nEff ≥ 3 and an interval that excludes 1', () => {
    expect(significance(L({}))).toBe(true);
    expect(significance(L({ nEff: 2.9 }))).toBe(false);
    expect(significance(L({ interval: [0.9, 2] }))).toBe(false);
    expect(significance(L({ interval: [0.5, 0.9], effect: 0.7 }))).toBe(true);
    expect(significance(L({ interval: null }))).toBe(false);
  });

  it('walks proposed → exploring → promising → winning and exploring → weak → pruned, never exploring → pruned', () => {
    expect(branchStatusFromStats(L({ nEff: 0, n: 0, effect: null }), null)).toBe('proposed');
    expect(branchStatusFromStats(L({ nEff: 1, n: 1 }), 'proposed')).toBe('exploring');
    expect(branchStatusFromStats(L({ nEff: 2.5, n: 3 }), null)).toBe('exploring');
    expect(branchStatusFromStats(L({ nEff: 4, confidence: 0.75 }), 'exploring')).toBe('promising');
    expect(branchStatusFromStats(L({ nEff: 4, confidence: 0.6 }), 'exploring')).toBe('exploring');
    expect(branchStatusFromStats(L({ nEff: 7.9, confidence: 0.9 }), 'promising')).toBe('promising'); // nEff < 8
    expect(branchStatusFromStats(L({ nEff: 8, confidence: 0.85 }), 'promising')).toBe('winning');
    expect(branchStatusFromStats(L({ nEff: 8, confidence: 0.9 }), 'exploring')).toBe('winning'); // the gate is the stats, not the path
    const weakStats = L({ nEff: 6, effect: 0.6, confidence: 0.9 });
    expect(branchStatusFromStats(weakStats, 'exploring')).toBe('weak');
    expect(branchStatusFromStats(weakStats, 'weak')).toBe('pruned');
    expect(branchStatusFromStats(L({ nEff: 5.9, effect: 0.6, confidence: 0.9 }), 'weak')).toBe('weak');
    expect(branchStatusFromStats(L({ nEff: 6, effect: 0.6, confidence: 0.7 }), 'weak')).toBe('weak');
    expect(branchStatusFromStats(L({ effect: 1 }), 'promising')).toBe('exploring');
    expect(branchStatusFromStats(L({ nEff: 1, n: 1 }), 'winning')).toBe('exploring'); // evidence decayed away
    expect(branchStatusFromStats(L({ nEff: 9, effect: 2, confidence: 0.95 }), 'pruned')).toBe('pruned'); // pruned is final
    const all: BranchStatus[] = ['proposed', 'exploring', 'promising', 'winning', 'weak'];
    for (const prev of all) if (prev !== 'weak') expect(branchStatusFromStats(weakStats, prev)).not.toBe('pruned');
  });
});
