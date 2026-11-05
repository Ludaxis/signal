// Analyst agent: numbers from code, narrative from the model, report stored under memory/reports.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listEvents, listRuns, memoryDir } from '@/lib/studio/memory/store';
import type { Graph, LearningsFile } from '@/lib/studio/memory/types';
import { periodStats, weeklyReport } from '@/lib/studio/team/analyst';
import { REPORT_OUTPUT_SCHEMA } from '@/lib/studio/team/schemas';
import { readReport, reportFile } from '@/lib/studio/team/tools';
import { listPackages } from '@/lib/studio/content';
import { SAMPLE_REPORT, cleanupTeamEnv, fakeQuery, makePackage, setupTeamRoot } from './team-helpers';

const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const DAY = 86_400_000;
let root = '';
afterEach(() => {
  cleanupTeamEnv();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

async function postedPackage(id: string, daysAgo: number, m: { views: number; reach: number; saves: number; comments: number }) {
  const dir = await makePackage(root, id);
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  writeFileSync(path.join(dir, 'approval.json'), JSON.stringify({ approved_by: 't', approved_at: at, hashes: {} }));
  writeFileSync(path.join(dir, 'posted.json'), JSON.stringify({ url: `https://www.instagram.com/p/abc${id}/`, posted_at: at, ai_label_confirmed: true, recorded_by: 't', via: 'manual' }));
  writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ fetched_at: at, metrics: { views: m.views, reach: m.reach, impressions: null, likes: 10, comments: m.comments, saves: m.saves, shares: 1 } }));
}

const LEARNINGS: LearningsFile = {
  version: 1,
  project: 'demo',
  updatedAt: new Date(NOW).toISOString(),
  learnings: [
    { id: 'lr:hook-question', text: 'Question hooks on Reels get more saves than statement hooks.', metric: 'saves_per_reach', scope: { format: 'reel' }, effect: 1.62, interval: [1.1, 2.3], mean: 0.02, baseline: 0.012, n: 6, nEff: 4.8, confidence: 0.71, status: 'active', lastEvidence: new Date(NOW - DAY).toISOString(), halfLifeDays: 14, branch: 'br_hook_question', updatedAt: new Date(NOW - DAY).toISOString() },
    { id: 'lr:time-1830', text: '18:30 beats 12:30.', metric: 'engagement_rate', scope: { hour: 18 }, effect: 1.2, interval: [0.8, 1.7], mean: null, baseline: null, n: 2, nEff: 1.4, confidence: 0.55, status: 'too-little-data', lastEvidence: null, halfLifeDays: 14, branch: null, updatedAt: new Date(NOW - 20 * DAY).toISOString() },
  ],
};
const GRAPH: Graph = { version: 1, project: 'demo', updatedAt: new Date(NOW).toISOString(), nodes: [{ id: 'br_hook_question', type: 'hypothesis', parent: null, label: 'Question hooks raise saves', campaign: null, status: 'promising', weight: null, created: '', updated: '', evidence: ['ev_1', 'ev_2'], learning: 'lr:hook-question', goalWeight: {}, meta: {} }] };

describe('weeklyReport', () => {
  it('rebuilds memory, computes the numbers in code, lets the model write the narrative, stores the report', async () => {
    root = setupTeamRoot();
    await postedPackage('01', 2, { views: 1200, reach: 900, saves: 18, comments: 7 });
    await postedPackage('02', 5, { views: 800, reach: 600, saves: 6, comments: 3 });
    await postedPackage('03', 10, { views: 500, reach: 400, saves: 2, comments: 1 }); // last week
    let rebuilt = 0;
    const rebuild = async () => {
      rebuilt++;
      return { graph: GRAPH, learnings: LEARNINGS };
    };
    const { queryFn, calls } = fakeQuery({ structured_output: SAMPLE_REPORT, total_cost_usd: 0.21, num_turns: 2 });
    const { report, run, file } = await weeklyReport({ queryFn, now: NOW, rebuild });
    expect(rebuilt).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema: REPORT_OUTPUT_SCHEMA });
    expect(calls[0]!.options.model).toBe('sonnet');
    expect(calls[0]!.options.maxBudgetUsd).toBe(0.8);
    // The prompt carries the code-computed stats, not raw packages.
    expect(calls[0]!.prompt).toContain('## Stats (trusted, from Signal)');
    expect(calls[0]!.prompt).toContain('"posts": 2');
    expect(calls[0]!.prompt).toContain('"saves": 24');
    expect(calls[0]!.prompt).toContain('lr:hook-question');
    expect(calls[0]!.prompt).toContain('"nEff": 4.8');
    // Stored report: date file under memory/reports, numbers from code, narrative from the model.
    expect(file).toBe(reportFile('2026-11-04'));
    expect(file.startsWith(path.join(memoryDir(), 'reports'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as typeof report;
    expect(onDisk.narrative).toEqual(report.narrative);
    expect(onDisk.narrative).toEqual(SAMPLE_REPORT);
    expect(onDisk.by).toBe('agent:analyst');
    expect(onDisk.run).toBe(run.id);
    expect(onDisk.costUsd).toBe(0.21);
    const stats = onDisk.stats as { thisWeek: { posts: number; totals: { saves: number } }; lastWeek: { posts: number }; learningsChanged: { id: string }[]; branches: { byStatus: Record<string, number> } };
    expect(stats.thisWeek.posts).toBe(2);
    expect(stats.thisWeek.totals.saves).toBe(24);
    expect(stats.lastWeek.posts).toBe(1);
    expect(stats.learningsChanged.map((l) => l.id)).toEqual(['lr:hook-question']);
    expect(stats.branches.byStatus).toEqual({ promising: 1 });
    expect(await readReport('2026-11-04')).toMatchObject({ date: '2026-11-04' });
    expect((await listRuns())[0]).toMatchObject({ role: 'analyst', status: 'done', costUsd: 0.21 });
    const notes = await listEvents({ types: ['note.added'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ kind: 'weekly-report', date: '2026-11-04', headline: SAMPLE_REPORT.headline });
  });
  it('uses the memory module when no rebuild is injected (stub reads graph/learnings from disk)', async () => {
    root = setupTeamRoot();
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(path.join(memoryDir(), 'learnings.json'), JSON.stringify(LEARNINGS));
    const { queryFn, calls } = fakeQuery({ structured_output: SAMPLE_REPORT });
    const { report } = await weeklyReport({ queryFn, now: NOW });
    expect(calls[0]!.prompt).toContain('lr:hook-question');
    expect((report.stats as { learningsActive: unknown[] }).learningsActive).toHaveLength(2);
  });
  it('periodStats counts only posts inside the window', async () => {
    root = setupTeamRoot();
    await postedPackage('01', 1, { views: 100, reach: 80, saves: 4, comments: 2 });
    await postedPackage('02', 8, { views: 300, reach: 200, saves: 8, comments: 1 });
    const pkgs = await listPackages();
    const week = periodStats(pkgs, NOW - 7 * DAY, NOW);
    expect(week.posts).toBe(1);
    expect(week.avg.views).toBe(100);
    expect(week.top[0]!.id).toBe('01');
    const prev = periodStats(pkgs, NOW - 14 * DAY, NOW - 7 * DAY);
    expect(prev.posts).toBe(1);
    expect(prev.totals.saves).toBe(8);
  });
});
