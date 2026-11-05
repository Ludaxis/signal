// Server-only: the analyst's weekly report (design §8). Numbers come from code; the model only writes
// the narrative. The report is stored as memory/reports/<date>.json and shown in the dashboard.
import { rate } from '../analytics';
import { listCampaigns } from '../campaigns';
import { listPackages, type PackageView } from '../content';
import { rebuildMemory } from '../memory/graph';
import { listRuns } from '../memory/store';
import type { AgentRunRecord, BranchStatus, Learning } from '../memory/types';
import { currentProject } from '../projects';
import { todayInZone } from '@/lib/time';
import { AgentError } from '../claude-agent';
import { runRole, teamAllowed, type RunDeps } from './runtime';
import { REPORT_OUTPUT_SCHEMA, reportSchema, type Report, type StoredReport } from './schemas';
import { storeReport } from './tools';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface PeriodStats {
  from: string;
  to: string;
  posts: number;
  measured: number;
  totals: { views: number; reach: number; likes: number; comments: number; saves: number; shares: number };
  avg: { views: number | null; reach: number | null; saves: number | null; comments: number | null; rate: number | null };
  byFormat: { format: string; posts: number; avgViews: number | null; avgSaves: number | null; avgRate: number | null }[];
  top: { id: string; title: string; views: number | null; saves: number | null; rate: number | null }[];
}

const avg = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
};
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/** Stats for the posts that went out in [from, to). Exported for tests. */
export function periodStats(pkgs: PackageView[], from: number, to: number): PeriodStats {
  const posted = pkgs.filter((p) => p.posted && Date.parse(p.posted.posted_at) >= from && Date.parse(p.posted.posted_at) < to);
  const measured = posted.filter((p) => p.metrics?.metrics);
  const m = (p: PackageView) => p.metrics!.metrics!;
  const groups = new Map<string, PackageView[]>();
  for (const p of measured) {
    const f = p.source?.format ?? p.format;
    groups.set(f, [...(groups.get(f) ?? []), p]);
  }
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    posts: posted.length,
    measured: measured.length,
    totals: { views: sum(measured.map((p) => m(p).views)), reach: sum(measured.map((p) => m(p).reach)), likes: sum(measured.map((p) => m(p).likes)), comments: sum(measured.map((p) => m(p).comments)), saves: sum(measured.map((p) => m(p).saves)), shares: sum(measured.map((p) => m(p).shares)) },
    avg: { views: avg(measured.map((p) => m(p).views)), reach: avg(measured.map((p) => m(p).reach)), saves: avg(measured.map((p) => m(p).saves)), comments: avg(measured.map((p) => m(p).comments)), rate: avg(measured.map((p) => rate(m(p)))) },
    byFormat: [...groups.entries()].map(([format, ps]) => ({ format, posts: ps.length, avgViews: avg(ps.map((p) => m(p).views)), avgSaves: avg(ps.map((p) => m(p).saves)), avgRate: avg(ps.map((p) => rate(m(p)))) })).sort((a, b) => (b.avgRate ?? -1) - (a.avgRate ?? -1)),
    top: [...measured]
      .sort((a, b) => (rate(m(b)) ?? 0) - (rate(m(a)) ?? 0))
      .slice(0, 3)
      .map((p) => ({ id: p.id, title: p.title, views: m(p).views, saves: m(p).saves, rate: rate(m(p)) })),
  };
}

const learningRow = (l: Learning) => ({ id: l.id, text: l.text, metric: l.metric, effect: l.effect, interval: l.interval, n: l.n, nEff: Math.round(l.nEff * 100) / 100, confidence: Math.round(l.confidence * 100) / 100, status: l.status, lastEvidence: l.lastEvidence, updatedAt: l.updatedAt });

export interface WeeklyDeps extends RunDeps {
  /** Injected by tests; defaults to the memory module's rebuildMemory(). */
  rebuild?: typeof rebuildMemory;
}

/** Rebuilds memory, computes this week's numbers, has the analyst write the narrative, stores the report. */
export async function weeklyReport(deps: WeeklyDeps = {}): Promise<{ report: StoredReport; run: AgentRunRecord; file: string }> {
  // Gate first: the rebuild below writes memory files.
  const gate = await teamAllowed();
  if (!gate.enabled) throw new AgentError(403, gate.reason);
  const now = deps.now ?? Date.now();
  const rebuild = deps.rebuild ?? rebuildMemory;
  const { graph, learnings } = await rebuild(now);
  const pkgs = await listPackages();
  const project = currentProject();
  const thisWeek = periodStats(pkgs, now - WEEK, now);
  const lastWeek = periodStats(pkgs, now - 2 * WEEK, now - WEEK);
  const changed = learnings.learnings.filter((l) => Date.parse(l.updatedAt) >= now - WEEK).sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  const active = learnings.learnings.filter((l) => l.status !== 'retired').sort((a, b) => b.confidence - a.confidence).slice(0, 15);
  const byStatus: Partial<Record<BranchStatus, number>> = {};
  for (const n of graph.nodes) if (n.status) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
  const branches = graph.nodes.filter((n) => n.status && ['promising', 'winning', 'weak'].includes(n.status)).slice(0, 12).map((n) => ({ id: n.id, type: n.type, label: n.label, status: n.status, evidence: n.evidence.length }));
  const campaigns = (await listCampaigns()).filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, goal: c.goal, experiments: c.strategy?.experiments ?? [] }));
  const runs = (await listRuns(200)).filter((r) => Date.parse(r.startedAt) >= now - WEEK);
  const agentCostUsd = Math.round(runs.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 100) / 100;
  const upcoming = pkgs.filter((p) => ['approved', 'scheduled', 'ready'].includes(p.status)).length;

  const stats = {
    project: { id: project.id, name: project.name, handle: project.handle },
    thisWeek,
    lastWeek,
    learningsChanged: changed.map(learningRow),
    learningsActive: active.map(learningRow),
    branches: { byStatus, notable: branches },
    campaigns,
    pipeline: { postsWaiting: upcoming },
    agents: { runs: runs.length, costUsd: agentCostUsd },
    rules: { tooLittleData: 'nEff < 3', significant: 'nEff ≥ 3 and the interval excludes 1' },
  };

  const { value, run } = await runRole<Report>(
    'analyst',
    {
      label: 'weekly report',
      prompt: `Write this week's report for ${project.handle} from the numbers in "Stats" (this week versus last week, learnings that changed, notable branches, experiments). Every figure you mention must appear in the stats as given; mark learnings with nEff below 3 as "too little data". Recommendations are actions the planner can take tomorrow.`,
      extraContext: [{ title: 'Stats', text: JSON.stringify(stats, null, 2) }],
      schema: REPORT_OUTPUT_SCHEMA,
      validate: (v: unknown): Report => reportSchema.parse(v),
    },
    deps,
  );
  const report: StoredReport = { date: todayInZone(now), period: { from: thisWeek.from, to: thisWeek.to }, by: 'agent:analyst', run: run.id, model: run.model, costUsd: run.costUsd, stats, narrative: value };
  const file = await storeReport(report);
  return { report, run, file };
}
