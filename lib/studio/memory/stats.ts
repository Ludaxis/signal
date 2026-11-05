// Pure, deterministic statistics for project memory (design section 4 and 5.3). No clock, no I/O:
// every function takes `now` and a seedable RNG where randomness is involved, so the same inputs
// always give the same learnings. The model routes and judges; these numbers decide how sure we are.
//
//   recency weight  w = 0.5^(age / halfLife)         yesterday counts more than last month
//   maturity        m = min(1, ageHours / 48)         Instagram numbers settle over ~48 h
//   nEff            Σ w·m                             effective sample size; < 3 = too little data
//   effect          weighted mean in scope / baseline (project weighted mean, same weights)
//   interval        deterministic weighted bootstrap, 400 resamples, 5th–95th percentile (90 %)
//   confidence      share of bootstrap ratios on the claimed side of 1, capped at 0.95 until
//                   nEff ≥ 10 (0.99 after that) and lower still below nEff 3; 0.5 when there is
//                   nothing to resample (n < 2)
import { zonedParts } from '@/lib/time';
import { formatHypothesisId, hookHypothesisId, learningId, pillarNodeId } from './ids';
import type { BranchStatus, Goal, Learning, MetricKey } from './types';

// ---- inputs --------------------------------------------------------------------------------------
export interface MetricsLike { views: number | null; reach: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null }

/** One posted package as the statistics see it (built by graph.ts from PackageView + plan slot). */
export interface PostObservation {
  id: string;
  postedAt: string; // ISO instant
  metricsAt: string | null; // ISO instant the metrics were fetched (maturity uses it)
  metrics: MetricsLike | null;
  format: string | null;
  campaign: string | null;
  pillar: string | null; // pillar name from the plan slot
  hook: string | null; // hook text (plan slot) or first caption line
}

export type HookStyle = 'question' | 'statement';

export const DEFAULT_HALF_LIFE_DAYS = 14;
export const LAUNCH_HALF_LIFE_DAYS = 7;
export const MATURITY_HOURS = 48;
export const MIN_NEFF = 3; // below this a learning is "too little data"
export const BOOTSTRAP_RESAMPLES = 400;
export const SHRINK_K = 3; // pseudo-observations pulling a small-sample prediction toward the baseline

// ---- decay and goals -----------------------------------------------------------------------------
/** w = 0.5^(age / halfLife). Future or negative ages count as fresh (w = 1). */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0) || !Number.isFinite(ageDays)) return 1;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/** m = min(1, ageHours / 48): very fresh metrics do not swing decisions. */
export function maturity(ageHours: number): number {
  if (!Number.isFinite(ageHours)) return 0;
  return Math.min(1, Math.max(0, ageHours) / MATURITY_HOURS);
}

export function halfLifeFor(goal: Goal): number {
  return goal === 'launch' ? LAUNCH_HALF_LIFE_DAYS : DEFAULT_HALF_LIFE_DAYS;
}

/** Design 5.3: which metric each goal optimises (secondary is reported next to it). */
export function metricsFor(goal: Goal): { primary: MetricKey; secondary: MetricKey | null } {
  switch (goal) {
    case 'awareness':
      return { primary: 'reach', secondary: 'shares_per_reach' };
    case 'engagement':
      return { primary: 'saves_per_reach', secondary: 'comments_per_reach' };
    case 'installs':
    case 'traffic':
      return { primary: 'saves_per_reach', secondary: null }; // proxy: link taps are not measured yet
    case 'launch':
      return { primary: 'reach', secondary: null };
    case 'community':
      return { primary: 'comments_per_reach', secondary: 'saves_per_reach' };
  }
}
export const primaryMetricFor = (goal: Goal): MetricKey => metricsFor(goal).primary;

export const METRIC_LABEL: Record<MetricKey, string> = {
  views: 'views',
  reach: 'reach',
  saves_per_reach: 'saves per reach',
  engagement_rate: 'engagement per reach',
  comments_per_reach: 'comments per reach',
  shares_per_reach: 'shares per reach',
  likes_per_reach: 'likes per reach',
};

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Per-reach ratios divide by reach, or views when reach is missing; null when anything needed is missing. */
export function metricValue(m: MetricsLike | null, key: MetricKey): number | null {
  if (!m) return null;
  const base = num(m.reach) ?? num(m.views);
  const perReach = (x: number | null | undefined) => {
    const v = num(x);
    return v == null || base == null || base <= 0 ? null : v / base;
  };
  switch (key) {
    case 'views':
      return num(m.views);
    case 'reach':
      return base;
    case 'saves_per_reach':
      return perReach(m.saves);
    case 'comments_per_reach':
      return perReach(m.comments);
    case 'shares_per_reach':
      return perReach(m.shares);
    case 'likes_per_reach':
      return perReach(m.likes);
    case 'engagement_rate': {
      const parts = [m.likes, m.comments, m.saves, m.shares].map(num);
      if (parts.every((p) => p == null)) return null;
      return perReach(parts.reduce<number>((a, b) => a + (b ?? 0), 0));
    }
  }
}

// ---- classification ------------------------------------------------------------------------------
const QUESTION_STARTS = new Set(['which', 'what', 'who', 'can', 'guess', 'spot']);

/** Simple rule: ends with '?' or starts with which/what/who/can/guess/spot → question; else statement. */
export function classifyHook(text: string | null | undefined): HookStyle {
  const t = (text ?? '').trim();
  if (!t) return 'statement';
  if (/\?\s*$/.test(t)) return 'question';
  const first = t.toLowerCase().replace(/^[^a-z]+/, '').split(/[^a-z']/)[0] ?? '';
  return QUESTION_STARTS.has(first) ? 'question' : 'statement';
}

/** The hook of a caption is its first non-empty line. */
export function hookFromCaption(caption: string | null | undefined): string | null {
  const line = (caption ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? null;
}

export const HOUR_BUCKET = 3;
/** Posting hours are grouped in 3-hour buckets keyed by the bucket's first hour (0, 3, 6, … 21). */
export function hourBucket(hour: number): number {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return h - (h % HOUR_BUCKET);
}
export function hourBucketLabel(bucket: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(bucket)}:00–${pad((bucket + HOUR_BUCKET) % 24)}:00`;
}
/** Local (Studio time zone) posting hour of an instant (null when unparsable). */
export function postingHour(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? zonedParts(ms).hour : null;
}

// ---- weights -------------------------------------------------------------------------------------
export interface Sample { value: number; w: number }

/** Recency × maturity for one post. Maturity age = metrics fetched_at − posted_at, or now − posted_at. */
export function observationWeight(obs: Pick<PostObservation, 'postedAt' | 'metricsAt'>, now: number, halfLifeDays: number): number {
  const posted = Date.parse(obs.postedAt);
  if (!Number.isFinite(posted)) return 0;
  const fetched = obs.metricsAt ? Date.parse(obs.metricsAt) : NaN;
  const matureMs = (Number.isFinite(fetched) ? fetched : now) - posted;
  return recencyWeight((now - posted) / 86_400_000, halfLifeDays) * maturity(matureMs / 3_600_000);
}

export function weightedMean(samples: Sample[]): number | null {
  let sw = 0;
  let swv = 0;
  for (const s of samples) {
    if (!(s.w > 0)) continue;
    sw += s.w;
    swv += s.w * s.value;
  }
  return sw > 0 ? swv / sw : null;
}

export const effectiveN = (samples: Sample[]): number => samples.reduce((a, s) => a + (s.w > 0 ? s.w : 0), 0);

// ---- RNG and bootstrap ---------------------------------------------------------------------------
/** Seeded mulberry32: a small, fast PRNG in [0, 1). Strings are hashed (FNV-1a) into the seed. */
export function seededRng(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal draw (Box–Muller). */
export function normalDraw(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Draws one sample index with probability proportional to its weight (cumulative table + binary search). */
function weightedPicker(samples: Sample[]): ((u: number) => number) | null {
  const cum: number[] = [];
  let total = 0;
  for (const s of samples) {
    total += s.w > 0 ? s.w : 0;
    cum.push(total);
  }
  if (!(total > 0)) return null;
  return (u: number) => {
    const target = u * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/**
 * Weighted bootstrap of effect = mean(scope) / mean(baseline). Each resample redraws both sets with
 * probability ∝ weight (n draws each), so posts that are old or immature rarely appear. Returns the
 * sorted ratios (empty when either side cannot be resampled).
 */
export function bootstrapRatios(scope: Sample[], baseline: Sample[], rng: () => number, resamples = BOOTSTRAP_RESAMPLES): number[] {
  const pickS = weightedPicker(scope);
  const pickB = weightedPicker(baseline);
  if (!pickS || !pickB || scope.length < 2) return [];
  const out: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let ms = 0;
    for (let i = 0; i < scope.length; i++) ms += scope[pickS(rng())]!.value;
    let mb = 0;
    for (let i = 0; i < baseline.length; i++) mb += baseline[pickB(rng())]!.value;
    ms /= scope.length;
    mb /= baseline.length;
    if (mb > 0) out.push(ms / mb);
  }
  return out.sort((a, b) => a - b);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Confidence cap: three posts never look certain. 0.95 until nEff ≥ 10 (0.99 after); below nEff 3 the
 * cap falls linearly to 0.5 at nEff 0, so one or two posts can never read as "sure" even when every
 * bootstrap draw lands on the same side.
 */
export function confidenceCap(nEff: number): number {
  if (nEff >= 10) return 0.99;
  if (nEff >= MIN_NEFF) return 0.95;
  return 0.5 + (0.45 * Math.max(0, nEff)) / MIN_NEFF;
}

export interface EffectEstimate { effect: number | null; interval: [number, number] | null; confidence: number }

/** Effect, 90 % interval and P(effect on its claimed side of 1), from a deterministic bootstrap. */
export function estimateEffect(scope: Sample[], baseline: Sample[], rng: () => number, resamples = BOOTSTRAP_RESAMPLES): EffectEstimate {
  const mean = weightedMean(scope);
  const base = weightedMean(baseline);
  if (mean == null || base == null || base <= 0) return { effect: null, interval: null, confidence: 0.5 };
  const effect = mean / base;
  const ratios = bootstrapRatios(scope, baseline, rng, resamples);
  if (ratios.length < 10) return { effect, interval: null, confidence: 0.5 };
  const interval: [number, number] = [percentile(ratios, 0.05), percentile(ratios, 0.95)];
  const onSide = effect >= 1 ? ratios.filter((r) => r > 1).length : ratios.filter((r) => r < 1).length;
  const confidence = Math.min(confidenceCap(effectiveN(scope)), onSide / ratios.length);
  return { effect, interval, confidence };
}

// ---- learnings -----------------------------------------------------------------------------------
export interface LearningOptions {
  now: number;
  goal: Goal;
  halfLifeDays?: number;
  /** When set, only this campaign's pillar and hypothesis learnings are produced (baseline is still project-wide). */
  campaign?: string | null;
  /** Seed for the bootstrap; the learning id is mixed in, so each learning has its own stream. */
  seed?: string;
}

interface Group {
  id: string;
  subject: string; // "Question hooks", "reel posts", …
  scope: Learning['scope'];
  branch: string | null;
  members: number[]; // indices into posts
}

function groupBy(posts: PostObservation[], indices: number[], keyOf: (p: PostObservation) => string | null, make: (key: string, sample: PostObservation) => Omit<Group, 'members'>): Group[] {
  const map = new Map<string, Group>();
  for (const i of indices) {
    const p = posts[i]!;
    const key = keyOf(p);
    if (key == null) continue;
    let g = map.get(key);
    if (!g) {
      g = { ...make(key, p), members: [] };
      map.set(key, g);
    }
    g.members.push(i);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const fmtEffect = (e: number) => (Math.round(e * 10) / 10).toFixed(1);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-English sentence for a learning, e.g. "Question hooks get 1.6× more saves per reach than average (n 6)." */
export function learningText(subject: string, metric: MetricKey, est: { effect: number | null; n: number; nEff: number }): string {
  const label = METRIC_LABEL[metric];
  const s = titleCase(subject);
  let text: string;
  if (est.effect == null || est.n === 0) text = `${s}: no measured results yet.`;
  else if (est.effect >= 1.05) text = `${s} get ${fmtEffect(est.effect)}× more ${label} than average (n ${est.n}).`;
  else if (est.effect <= 0.95) text = `${s} get ${Math.round((1 - est.effect) * 100)}% less ${label} than average (n ${est.n}).`;
  else text = `${s} get about the same ${label} as average (n ${est.n}).`;
  if (est.n > 0 && est.nEff < MIN_NEFF) text += ` Too little data yet (nEff ${est.nEff.toFixed(1)}).`;
  return text;
}

/**
 * Learnings for one project (campaign = null: baseline, format, hook style, posting hour) or one
 * campaign (pillar and hypothesis branches). Deterministic for the same inputs, `now` and seed.
 */
export function computeLearnings(posts: PostObservation[], opts: LearningOptions): Learning[] {
  const halfLife = opts.halfLifeDays ?? halfLifeFor(opts.goal);
  const campaign = opts.campaign ?? null;
  const nowIso = new Date(opts.now).toISOString();
  const weights = posts.map((p) => observationWeight(p, opts.now, halfLife));
  const { primary, secondary } = metricsFor(opts.goal);
  const metrics: MetricKey[] = secondary ? [primary, secondary] : [primary];
  const all = posts.map((_, i) => i);
  const inCampaign = campaign ? all.filter((i) => posts[i]!.campaign === campaign) : [];

  const groups: Group[] = campaign
    ? [
        ...groupBy(posts, inCampaign, (p) => p.pillar, (pillar) => ({ id: `pillar:${pillar}`, subject: `"${pillar}" posts`, scope: { campaign, branch: pillarNodeId(campaign, pillar) }, branch: pillarNodeId(campaign, pillar) })),
        ...groupBy(posts, inCampaign, (p) => (p.pillar && p.hook ? `${p.pillar}\u0000${classifyHook(p.hook)}` : null), (key, p) => {
          const style = classifyHook(p.hook);
          const id = hookHypothesisId(campaign, p.pillar!, style);
          return { id: `hyp-hook:${key}`, subject: `${style} hooks in "${p.pillar}"`, scope: { campaign, branch: id, hookStyle: style }, branch: id };
        }),
        ...groupBy(posts, inCampaign, (p) => (p.pillar && p.format ? `${p.pillar}\u0000${p.format}` : null), (key, p) => {
          const id = formatHypothesisId(campaign, p.pillar!, p.format!);
          return { id: `hyp-format:${key}`, subject: `${p.format} posts in "${p.pillar}"`, scope: { campaign, branch: id, format: p.format! }, branch: id };
        }),
      ]
    : [
        ...groupBy(posts, all, (p) => p.format, (format) => ({ id: `format:${format}`, subject: `${format} posts`, scope: { format }, branch: null })),
        ...groupBy(posts, all, (p) => (p.hook ? classifyHook(p.hook) : null), (style) => ({ id: `hook:${style}`, subject: `${style} hooks`, scope: { hookStyle: style }, branch: null })),
        ...groupBy(posts, all, (p) => {
          const h = postingHour(p.postedAt);
          return h == null ? null : String(hourBucket(h));
        }, (bucket) => ({ id: `hour:${bucket}`, subject: `posts between ${hourBucketLabel(Number(bucket))}`, scope: { hour: Number(bucket) }, branch: null })),
      ];

  const out: Learning[] = [];
  for (const metric of metrics) {
    const values = posts.map((p) => metricValue(p.metrics, metric));
    const sampleOf = (i: number): Sample | null => (values[i] == null || !(weights[i]! > 0) ? null : { value: values[i]!, w: weights[i]! });
    const baseSamples = all.map(sampleOf).filter((s): s is Sample => s != null);
    const baseMean = weightedMean(baseSamples);
    const baseNEff = effectiveN(baseSamples);
    const lastEvidenceOf = (idx: number[]) => idx.filter((i) => values[i] != null).map((i) => posts[i]!.postedAt).sort().at(-1) ?? null;

    if (!campaign) {
      const n = baseSamples.length;
      out.push({
        id: learningId(null, metric, 'baseline'),
        text: baseMean == null ? `Project average ${METRIC_LABEL[metric]}: no measured posts yet.` : `Project average ${METRIC_LABEL[metric]}: ${formatValue(metric, baseMean)} over ${n} measured post${n === 1 ? '' : 's'} (nEff ${baseNEff.toFixed(1)}).`,
        metric,
        scope: {},
        effect: baseMean == null ? null : 1,
        interval: null,
        mean: baseMean,
        baseline: baseMean,
        n,
        nEff: baseNEff,
        confidence: 0,
        status: baseNEff < MIN_NEFF ? 'too-little-data' : 'active',
        lastEvidence: lastEvidenceOf(all),
        halfLifeDays: halfLife,
        branch: null,
        updatedAt: nowIso,
      });
    }

    for (const g of groups) {
      const samples = g.members.map(sampleOf).filter((s): s is Sample => s != null);
      const id = learningId(campaign, metric, kindOf(g.id), g.id.slice(g.id.indexOf(':') + 1));
      const rng = seededRng(`${opts.seed ?? 'signal'}:${id}`);
      const est = estimateEffect(samples, baseSamples, rng);
      const nEff = effectiveN(samples);
      out.push({
        id,
        text: learningText(g.subject, metric, { effect: est.effect, n: samples.length, nEff }),
        metric,
        scope: g.scope,
        effect: est.effect,
        interval: est.interval,
        mean: weightedMean(samples),
        baseline: baseMean,
        n: samples.length,
        nEff,
        confidence: est.confidence,
        status: nEff < MIN_NEFF ? 'too-little-data' : 'active',
        lastEvidence: lastEvidenceOf(g.members),
        halfLifeDays: halfLife,
        branch: g.branch,
        updatedAt: nowIso,
      });
    }
  }
  return out;
}

function kindOf(groupId: string): 'format' | 'hook' | 'hour' | 'pillar' | 'hyp-hook' | 'hyp-format' {
  const k = groupId.slice(0, groupId.indexOf(':'));
  if (k === 'format' || k === 'hook' || k === 'hour' || k === 'pillar' || k === 'hyp-hook' || k === 'hyp-format') return k;
  throw new Error(`Unknown learning group ${groupId}`);
}

export function formatValue(metric: MetricKey, v: number): string {
  if (metric === 'views' || metric === 'reach') return Math.round(v).toLocaleString('en-GB');
  return `${(v * 100).toFixed(2)}%`;
}

// ---- prediction, allocation, decisions -----------------------------------------------------------
/**
 * Expected value of the next post on a branch: the branch mean shrunk toward the baseline by its
 * effective sample size, (nEff·mean + k·baseline) / (nEff + k). Small samples stay close to average.
 */
export function predictNext(branch: Pick<Learning, 'mean' | 'nEff'> | null, baseline: number | null, k = SHRINK_K): number | null {
  if (!branch || branch.mean == null) return baseline;
  if (baseline == null) return branch.mean;
  const n = Math.max(0, branch.nEff);
  return (n * branch.mean + k * baseline) / (n + k);
}

export interface ThompsonBranch { id: string; mean: number; nEff: number }
export interface ThompsonOptions {
  /** Share of picks made uniformly at random so new ideas keep getting tested (design: ~20 %). */
  exploreFloor?: number;
  /** Nominal spread of a branch's posterior on the log scale when nEff = 0 (we carry no per-branch variance). */
  spread?: number;
}

/**
 * Decision 17: samples each branch's posterior (log-normal around its mean, sd = spread / √(nEff+1))
 * and returns the best draw. A fraction `exploreFloor` of calls ignore the posteriors and pick any
 * branch uniformly. Deterministic for a given rng.
 */
export function thompsonPick(branches: ThompsonBranch[], rng: () => number, opts: ThompsonOptions = {}): string | null {
  if (!branches.length) return null;
  const floor = Math.min(1, Math.max(0, opts.exploreFloor ?? 0.2));
  const spread = opts.spread ?? 0.5;
  if (rng() < floor) return branches[Math.min(branches.length - 1, Math.floor(rng() * branches.length))]!.id;
  let best: ThompsonBranch | null = null;
  let bestDraw = -Infinity;
  for (const b of branches) {
    const mean = Math.max(b.mean, 1e-9);
    const draw = mean * Math.exp((normalDraw(rng) * spread) / Math.sqrt(Math.max(0, b.nEff) + 1));
    if (draw > bestDraw) [best, bestDraw] = [b, draw];
  }
  return best!.id;
}

/** Decision 15: a change is significant when nEff ≥ 3 and the interval excludes 1. */
export function significance(l: Pick<Learning, 'nEff' | 'interval'>): boolean {
  if (l.nEff < MIN_NEFF || !l.interval) return false;
  const [lo, hi] = l.interval;
  return lo > 1 || hi < 1;
}

export const STATUS_THRESHOLDS = { promising: { confidence: 0.7 }, winning: { confidence: 0.85, nEff: 8 }, weak: { confidence: 0.7 }, pruned: { confidence: 0.85, nEff: 6 } } as const;

/**
 * Decision 16, stats gate only (a judge may explain, never decide):
 *   proposed/exploring (nEff < 3) → promising (conf ≥ 0.7, effect > 1) → winning (conf ≥ 0.85, nEff ≥ 8)
 *                                 → weak (conf ≥ 0.7, effect < 1)      → pruned (conf ≥ 0.85, nEff ≥ 6, only from weak)
 * Pruned is final. A branch never jumps from exploring straight to pruned.
 */
export function branchStatusFromStats(l: Pick<Learning, 'nEff' | 'effect' | 'confidence' | 'n'>, prev: BranchStatus | null): BranchStatus {
  if (prev === 'pruned') return 'pruned';
  if (l.nEff < MIN_NEFF || l.effect == null) return l.n > 0 || (prev && prev !== 'proposed') ? 'exploring' : 'proposed';
  const t = STATUS_THRESHOLDS;
  if (l.effect > 1) {
    if (l.confidence >= t.winning.confidence && l.nEff >= t.winning.nEff) return 'winning';
    if (l.confidence >= t.promising.confidence) return 'promising';
    return 'exploring';
  }
  if (l.effect < 1) {
    if (l.confidence >= t.pruned.confidence && l.nEff >= t.pruned.nEff && prev === 'weak') return 'pruned';
    if (l.confidence >= t.weak.confidence) return 'weak';
    return 'exploring';
  }
  return 'exploring';
}
