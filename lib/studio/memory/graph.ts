// Server-only: the decision map (design section 3.2) and learnings (3.3), rebuilt from what already
// exists on disk: campaigns, their approved strategies and plans, post packages with their results,
// and the timeline. Rebuilding is idempotent: node ids are stable (ids.ts), `created` is preserved,
// status changes are appended to meta.statusHistory, and nothing is ever removed (pruned branches and
// old strategy versions stay). Callers check the feature switch; this module does not.
import { getPlan, listCampaigns, type Campaign, type Slot } from '../campaigns';
import { listPackages, type PackageView } from '../content';
import { currentProject } from '../projects';
import { goalNodeId, hookHypothesisId, learningId, learningNodeId, pillarNodeId, pivotNodeId, strategyNodeId, variantNodeId, formatHypothesisId } from './ids';
import { branchStatusFromStats, classifyHook, computeLearnings, hookFromCaption, metricValue, observationWeight, primaryMetricFor, halfLifeFor, type PostObservation } from './stats';
import { listEvents, readGraph, readLearnings, writeGraph, writeLearnings } from './store';
import type { BranchStatus, Goal, Graph, GraphNode, Learning, LearningsFile, MemEvent } from './types';

export const GOAL_LABEL: Record<Goal, string> = { awareness: 'Awareness', engagement: 'Engagement', installs: 'Installs', traffic: 'Traffic', launch: 'Launch', community: 'Community' };

export interface StatusChange { at: string; status: BranchStatus }

/** meta.statusHistory of a node, tolerant of hand-edited files. */
export function statusHistory(n: Pick<GraphNode, 'meta'>): StatusChange[] {
  const raw = n.meta.statusHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is StatusChange => Boolean(h) && typeof h === 'object' && typeof (h as StatusChange).at === 'string' && typeof (h as StatusChange).status === 'string');
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Packages that count as variants: made from a campaign slot or actually posted, and not thrown away. */
export function isVariant(p: PackageView): boolean {
  return p.status !== 'discarded' && p.status !== 'invalid' && (p.campaign != null || p.posted != null);
}

/** What the statistics see for one package (null when it was never posted). */
export function toObservation(p: PackageView, slot: Slot | null): PostObservation | null {
  if (!p.posted) return null;
  return {
    id: p.id,
    postedAt: p.posted.posted_at,
    metricsAt: p.metrics?.metrics ? p.metrics.fetched_at : null,
    metrics: p.metrics?.metrics ?? null,
    format: slot?.format ?? p.source?.format ?? p.format ?? null,
    campaign: p.campaign?.id ?? null,
    pillar: slot?.pillar || null,
    hook: slot?.hook || hookFromCaption(p.caption),
  };
}

/** The goal the project-wide learnings use: the most common goal of active campaigns, else the first campaign's, else engagement. */
export function projectGoal(campaigns: Campaign[]): Goal {
  const counts = new Map<Goal, number>();
  for (const c of campaigns) if (c.status === 'active') counts.set(c.goal, (counts.get(c.goal) ?? 0) + 1);
  let best: Goal | null = null;
  for (const [g, n] of counts) if (best == null || n > (counts.get(best) ?? 0)) best = g;
  return best ?? campaigns[0]?.goal ?? 'engagement';
}

// ---- node merging --------------------------------------------------------------------------------
interface NodeInput {
  id: string;
  type: GraphNode['type'];
  parent: string | null;
  label: string;
  campaign: string | null;
  status: BranchStatus | null;
  weight?: number | null;
  evidence?: string[];
  learning?: string | null;
  goalWeight?: Partial<Record<Goal, number>>;
  meta?: Record<string, unknown>;
  /** When the thing this node stands for happened (approval, posting, event); a new node is dated from it so replay works for old projects. */
  at?: string | null;
  /** When the status itself was decided (an event's time); stats-driven changes are stamped with the rebuild time. */
  statusAt?: string | null;
}

class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  constructor(private readonly prev: Map<string, GraphNode>, private readonly nowIso: string) {}

  /** The node as it stands now: touched in this pass, or as the previous graph had it. */
  get(id: string): GraphNode | undefined {
    return this.nodes.get(id) ?? this.prev.get(id);
  }

  /** Previous status of a branch (what decision 16 transitions from). */
  prevStatus(id: string): BranchStatus | null {
    return this.get(id)?.status ?? null;
  }

  /** Creates or refreshes a node: keeps `created`, appends to statusHistory, bumps `updated` only on change. */
  upsert(input: NodeInput): GraphNode {
    const prev = this.nodes.get(input.id) ?? this.prev.get(input.id);
    const clamp = (iso: string | null | undefined) => {
      const ms = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(ms) && ms < Date.parse(this.nowIso) ? new Date(ms).toISOString() : this.nowIso; // never in the future
    };
    const created = prev?.created ?? clamp(input.at);
    const history = prev ? statusHistory(prev) : [];
    const last = history.at(-1)?.status ?? prev?.status ?? null;
    if (input.status && input.status !== last) history.push({ at: prev ? clamp(input.statusAt) : created, status: input.status });
    const { statusHistory: _ignored, ...prevMeta } = prev?.meta ?? {};
    void _ignored;
    const meta = { ...prevMeta, ...(input.meta ?? {}), ...(history.length ? { statusHistory: history } : {}) };
    const evidence = [...new Set([...(prev?.evidence ?? []), ...(input.evidence ?? [])])].sort();
    const next: GraphNode = {
      id: input.id,
      type: input.type,
      parent: input.parent,
      label: input.label,
      campaign: input.campaign,
      status: input.status,
      weight: input.weight ?? null,
      created,
      updated: prev?.updated ?? created,
      evidence,
      learning: input.learning ?? null,
      goalWeight: input.goalWeight ?? prev?.goalWeight ?? {},
      meta,
    };
    if (prev && !sameNode(prev, next)) next.updated = this.nowIso;
    this.nodes.set(next.id, next);
    return next;
  }

  /** Nodes from the previous graph that this rebuild did not touch are kept as they were. */
  finish(): GraphNode[] {
    for (const [id, n] of this.prev) if (!this.nodes.has(id)) this.nodes.set(id, n);
    return [...this.nodes.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }
}

function sameNode(a: GraphNode, b: GraphNode): boolean {
  const pick = (n: GraphNode) => JSON.stringify({ ...n, updated: null, created: null });
  return pick(a) === pick(b);
}

// ---- rebuild -------------------------------------------------------------------------------------
type Stats = Pick<Learning, 'nEff' | 'effect' | 'confidence' | 'n'>;
const NO_DATA: Stats = { nEff: 0, effect: null, confidence: 0, n: 0 };

/**
 * Rebuilds graph.json and learnings.json from campaigns, plans, packages and the timeline.
 * Safe with no campaigns (empty, valid graph). Does not check the feature switch: callers do.
 */
export async function rebuildMemory(now: number = Date.now()): Promise<{ graph: Graph; learnings: LearningsFile }> {
  const project = currentProject();
  const nowIso = new Date(now).toISOString();
  const campaigns = await listCampaigns();
  const plans = new Map<string, Slot[]>();
  for (const c of campaigns) plans.set(c.id, (await getPlan(c.id)).slots);
  const packages = (await listPackages()).filter(isVariant);
  const events = await listEvents();
  const prevGraph = await readGraph();
  const prevLearnings = await readLearnings();

  // Slot for each package (by campaign.json → plan slot id).
  const slotOf = (p: PackageView): Slot | null => (p.campaign ? (plans.get(p.campaign.id)?.find((s) => s.id === p.campaign!.slot || s.packageId === p.id) ?? null) : null);
  const observations = packages.map((p) => toObservation(p, slotOf(p))).filter((o): o is PostObservation => o != null);

  // ---- learnings (statistics first; the graph reads their verdicts) ----
  const goal = projectGoal(campaigns);
  const seed = `memory:${project.id}`;
  const fresh: Learning[] = computeLearnings(observations, { now, goal, seed });
  for (const c of campaigns) fresh.push(...computeLearnings(observations, { now, goal: c.goal, campaign: c.id, seed }));
  const freshIds = new Set(fresh.map((l) => l.id));
  const retired = prevLearnings.learnings.filter((l) => !freshIds.has(l.id)).map((l) => (l.status === 'retired' ? l : { ...l, status: 'retired' as const, updatedAt: nowIso }));
  const learningsFile: LearningsFile = { version: 1, project: project.id, learnings: [...fresh, ...retired], updatedAt: nowIso };
  const byId = new Map(fresh.map((l) => [l.id, l]));
  const statsFor = (id: string): Stats => byId.get(id) ?? NO_DATA;

  // ---- graph ----
  const b = new GraphBuilder(new Map(prevGraph.nodes.map((n) => [n.id, n])), nowIso);
  const evidenceWhere = (pred: (e: MemEvent) => boolean) => events.filter(pred).map((e) => e.id);
  const branchEvidence = (id: string) => evidenceWhere((e) => e.refs.branch === id);
  const campaignOf = new Map(campaigns.map((c) => [c.id, c]));

  for (const c of campaigns) {
    const metric = primaryMetricFor(c.goal);
    const goalId = goalNodeId(c.id);
    b.upsert({
      id: goalId,
      type: 'goal',
      parent: null,
      label: `${GOAL_LABEL[c.goal]}: ${c.name}`,
      campaign: c.id,
      status: null,
      goalWeight: { [c.goal]: 1 },
      at: c.createdAt,
      evidence: evidenceWhere((e) => e.campaign === c.id && (e.type === 'campaign.created' || e.type === 'campaign.status' || e.type === 'strategy.approved' || e.type === 'plan.made')),
      meta: { goal: c.goal, name: c.name, campaignStatus: c.status, brief: clip(c.brief, 300), startDate: c.startDate, endDate: c.endDate, primaryMetric: metric, halfLifeDays: halfLifeFor(c.goal) },
    });

    // Strategy versions: every approved strategy gets its own node; older versions stay from the previous graph.
    let strategyId: string | null = null;
    if (c.strategy) {
      strategyId = strategyNodeId(c.id, c.strategy.approvedAt);
      const versions = new Set([...prevGraph.nodes.filter((n) => n.type === 'strategy' && n.campaign === c.id).map((n) => String(n.meta.approvedAt ?? n.created)), c.strategy.approvedAt]);
      const version = [...versions].sort().indexOf(c.strategy.approvedAt) + 1;
      b.upsert({
        id: strategyId,
        type: 'strategy',
        parent: goalId,
        label: `Strategy v${version}: ${clip(c.strategy.summary, 90)}`,
        campaign: c.id,
        status: null,
        at: c.strategy.approvedAt,
        evidence: evidenceWhere((e) => e.campaign === c.id && e.refs.strategy === strategyId),
        meta: { version, approvedAt: c.strategy.approvedAt, approvedBy: c.strategy.approvedBy, summary: c.strategy.summary, positioning: c.strategy.positioning, pillars: c.strategy.pillars, experiments: c.strategy.experiments, kpis: c.strategy.kpis },
      });
    }

    // Pillars: from the approved strategy (with weight) and from plan slots (a planner may name one the strategy lacks).
    const slots = (plans.get(c.id) ?? []).filter((s) => s.status !== 'skipped');
    const pillarNames = new Map<string, number | null>();
    for (const p of c.strategy?.pillars ?? []) pillarNames.set(p.name, p.weight);
    for (const s of slots) if (s.pillar && !pillarNames.has(s.pillar)) pillarNames.set(s.pillar, null);
    for (const [name, weight] of pillarNames) {
      const id = pillarNodeId(c.id, name);
      const st = statsFor(learningId(c.id, metric, 'pillar', name));
      b.upsert({
        id,
        type: 'pillar',
        parent: strategyId ?? goalId,
        label: weight == null ? name : `${name} (${weight}%)`,
        campaign: c.id,
        status: branchStatusFromStats(st, b.prevStatus(id)),
        weight,
        at: c.strategy?.approvedAt ?? c.createdAt,
        evidence: branchEvidence(id),
        learning: byId.has(learningId(c.id, metric, 'pillar', name)) ? learningId(c.id, metric, 'pillar', name) : null,
        goalWeight: { [c.goal]: 1 },
        meta: { why: c.strategy?.pillars.find((p) => p.name === name)?.why ?? null, stats: summary(st) },
      });
    }

    // Hypotheses: hook styles and formats used within a pillar (from slots and made packages).
    const used = new Map<string, { pillar: string; kind: 'hook' | 'format'; value: string }>();
    const firstUse = new Map<string, string>(); // hypothesis id → earliest slot instant (dates a new node)
    const note = (pillar: string | null, hook: string | null, format: string | null, at: string | null) => {
      if (!pillar) return;
      const mark = (id: string, h: { pillar: string; kind: 'hook' | 'format'; value: string }) => {
        used.set(id, h);
        if (at && (!firstUse.has(id) || at < firstUse.get(id)!)) firstUse.set(id, at);
      };
      if (hook) {
        const style = classifyHook(hook);
        mark(hookHypothesisId(c.id, pillar, style), { pillar, kind: 'hook', value: style });
      }
      if (format) mark(formatHypothesisId(c.id, pillar, format), { pillar, kind: 'format', value: format });
    };
    for (const s of slots) note(s.pillar, s.hook, s.format, s.at);
    for (const p of packages) {
      if (p.campaign?.id !== c.id) continue;
      const s = slotOf(p);
      note(s?.pillar ?? null, s?.hook ?? hookFromCaption(p.caption), s?.format ?? p.source?.format ?? p.format, s?.at ?? p.posted?.posted_at ?? null);
    }
    for (const [id, h] of used) {
      const lrId = learningId(c.id, metric, h.kind === 'hook' ? 'hyp-hook' : 'hyp-format', `${h.pillar}\u0000${h.value}`);
      const st = statsFor(lrId);
      b.upsert({
        id,
        type: 'hypothesis',
        parent: pillarNodeId(c.id, h.pillar),
        label: h.kind === 'hook' ? `${titleCase(h.value)} hooks` : `${h.value} posts`,
        campaign: c.id,
        status: branchStatusFromStats(st, b.prevStatus(id)),
        at: firstUse.get(id) ?? c.strategy?.approvedAt ?? c.createdAt,
        evidence: branchEvidence(id),
        learning: byId.has(lrId) ? lrId : null,
        goalWeight: { [c.goal]: 1 },
        meta: { pillar: h.pillar, kind: h.kind, [h.kind === 'hook' ? 'hookStyle' : 'format']: h.value, stats: summary(st) },
      });
    }
  }

  // Variants: one per made/posted package, with its outcome rolled up from metrics.
  const baselines = new Map<string, number | null>();
  for (const l of fresh) if (l.scope.campaign === undefined && !l.branch && Object.keys(l.scope).length === 0) baselines.set(l.metric, l.baseline);
  for (const p of packages) {
    const slot = slotOf(p);
    const c = p.campaign ? campaignOf.get(p.campaign.id) ?? null : null;
    const obs = toObservation(p, slot);
    const hook = slot?.hook || hookFromCaption(p.caption);
    const style = hook ? classifyHook(hook) : null;
    const format = slot?.format ?? p.source?.format ?? p.format;
    const pillar = slot?.pillar || null;
    const metric = primaryMetricFor(c?.goal ?? goal);
    const value = obs ? metricValue(obs.metrics, metric) : null;
    const baseline = baselines.get(metric) ?? null;
    const w = obs ? observationWeight(obs, now, halfLifeFor(c?.goal ?? goal)) : 0;
    const st: Stats = { n: value == null ? 0 : 1, nEff: value == null ? 0 : w, effect: value != null && baseline ? value / baseline : null, confidence: 0.5 };
    const id = variantNodeId(p.id);
    const parent = c && pillar ? (style ? hookHypothesisId(c.id, pillar, style) : pillarNodeId(c.id, pillar)) : c ? goalNodeId(c.id) : null;
    const m = p.metrics?.metrics ?? null;
    b.upsert({
      id,
      type: 'variant',
      parent,
      label: clip(hook ?? p.title, 80),
      campaign: p.campaign?.id ?? null,
      status: p.posted ? branchStatusFromStats(st, b.prevStatus(id)) : (b.prevStatus(id) ?? 'proposed'),
      at: p.posted?.posted_at ?? p.approval?.approved_at ?? p.plannedFor ?? null,
      evidence: evidenceWhere((e) => e.refs.package === p.id),
      goalWeight: c ? { [c.goal]: 1 } : {},
      meta: {
        packageId: p.id,
        title: p.title,
        hook,
        hookStyle: style,
        format,
        pillar,
        slot: slot?.id ?? p.campaign?.slot ?? null,
        packageStatus: p.status,
        postedAt: p.posted?.posted_at ?? null,
        permalink: p.posted?.url ?? null,
        plannedFor: p.plannedFor,
        metrics: m ? { views: m.views, reach: m.reach, likes: m.likes, comments: m.comments, saves: m.saves, shares: m.shares, fetchedAt: p.metrics!.fetched_at } : null,
        outcome: value == null ? null : { metric, value, baseline, effect: st.effect, weight: w },
      },
    });
  }

  // Learning nodes: one per learning with measured posts, attached to its branch (project-wide ones sit at the root).
  for (const l of fresh) {
    if (l.n === 0 || Object.keys(l.scope).length === 0) continue;
    b.upsert({
      id: learningNodeId(l.id),
      type: 'learning',
      parent: l.branch,
      label: l.text,
      campaign: l.scope.campaign ?? null,
      status: null,
      learning: l.id,
      at: l.lastEvidence,
      evidence: branchEvidence(learningNodeId(l.id)),
      meta: { metric: l.metric, effect: l.effect, interval: l.interval, n: l.n, nEff: l.nEff, confidence: l.confidence, learningStatus: l.status, lastEvidence: l.lastEvidence },
    });
  }

  // Pivots: proposed → approved / rejected, joined by data.pivot (or the proposing event's id).
  const pivotStatus: Record<string, BranchStatus> = { 'pivot.proposed': 'proposed', 'pivot.approved': 'exploring', 'pivot.rejected': 'pruned' };
  for (const e of events) {
    const st = pivotStatus[e.type];
    if (!st) continue;
    const key = typeof e.data.pivot === 'string' ? e.data.pivot : typeof e.data.pivotId === 'string' ? e.data.pivotId : e.id;
    const id = pivotNodeId(key);
    const label = [e.data.summary, e.data.text, e.data.label, e.data.title].find((x): x is string => typeof x === 'string' && x.trim() !== '');
    const prevNode = b.get(id);
    b.upsert({
      id,
      type: 'pivot',
      parent: e.campaign ? goalNodeId(e.campaign) : null,
      label: clip(label ?? prevNode?.label ?? 'Pivot', 120),
      campaign: e.campaign,
      status: st,
      at: e.at,
      statusAt: e.at,
      evidence: [e.id],
      meta: { decision: e.type.slice('pivot.'.length), decidedAt: e.at, by: e.by, reason: typeof e.data.reason === 'string' ? e.data.reason : null },
    });
  }

  const graph: Graph = { version: 1, project: project.id, nodes: b.finish(), updatedAt: nowIso };
  await writeGraph(graph);
  await writeLearnings(learningsFile);
  return { graph, learnings: learningsFile };
}

function summary(st: Stats) {
  return { n: st.n, nEff: Math.round(st.nEff * 100) / 100, effect: st.effect == null ? null : Math.round(st.effect * 1000) / 1000, confidence: Math.round(st.confidence * 1000) / 1000 };
}

/** Replay: the graph as it looked on a date (nodes created by then, status as of then). */
export function graphAt(graph: Graph, isoDate: string): Graph {
  const cut = /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? `${isoDate}T23:59:59.999Z` : isoDate;
  const nodes = graph.nodes
    .filter((n) => n.created <= cut)
    .map((n) => {
      const then = statusHistory(n).filter((h) => h.at <= cut);
      const status = n.status == null ? null : (then.at(-1)?.status ?? n.status);
      return { ...n, status, meta: then.length ? { ...n.meta, statusHistory: then } : n.meta };
    });
  return { ...graph, nodes, updatedAt: cut };
}
