// The example memory payload (lib/studio/memory/demo.ts) must be a valid, self-consistent MemoryPayload.
import { describe, expect, it } from 'vitest';
import { demoPayload } from '@/lib/studio/memory/demo';
import type { BranchStatus, DecisionId, EventType, NodeType } from '@/lib/studio/memory/types';

const PROJECT = { id: 'demo', name: 'Demo', handle: '@signal.demo' };
const STATUSES: (BranchStatus | null)[] = ['proposed', 'exploring', 'promising', 'winning', 'weak', 'pruned', null];
const NODE_TYPES: NodeType[] = ['goal', 'strategy', 'pillar', 'hypothesis', 'variant', 'outcome', 'learning', 'pivot'];
const EVENT_TYPES: EventType[] = ['brief.created', 'post.made', 'post.reviewed', 'post.approved', 'post.rejected', 'post.edited', 'post.scheduled', 'post.published', 'post.failed', 'post.discarded', 'post.label-confirmed', 'metrics.snapshot', 'account.snapshot', 'comments.theme', 'comment.question', 'campaign.created', 'campaign.status', 'strategy.proposed', 'strategy.approved', 'plan.made', 'pivot.proposed', 'pivot.approved', 'pivot.rejected', 'research.finding', 'note.added', 'brand.updated', 'catalog.updated', 'agent.run', 'decision.made'];
const DECISIONS: DecisionId[] = ['file-branch', 'new-or-variant', 'comment-kind', 'comment-theme', 'research-relevant', 'pack-areas', 'learning-valid', 'similar-posts', 'catalog-fit', 'brief-match', 'answer-unambiguous', 'brand-rules', 'visual-quality', 'ai-label', 'significant-change', 'branch-status', 'explore-exploit', 'pivot-needed', 'experiment-goal', 'slot-format', 'hook-style', 'hook-too-similar', 'best-time', 'prompt-injection', 'personal-data'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('demoPayload', () => {
  const p = demoPayload(PROJECT);

  it('is deterministic and carries the project', () => {
    expect(JSON.stringify(demoPayload(PROJECT))).toBe(JSON.stringify(p));
    expect(p.project).toEqual(PROJECT);
    expect(p.enabled).toBe(true);
    expect(p.graph.project).toBe('demo');
    expect(p.campaigns.length).toBeGreaterThanOrEqual(2);
  });

  it('has a connected tree with valid types, statuses and dates', () => {
    const ids = new Set(p.graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(p.graph.nodes.length);
    const roots = p.graph.nodes.filter((n) => n.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.type).toBe('goal');
    for (const n of p.graph.nodes) {
      if (n.parent !== null) expect(ids.has(n.parent), `${n.id} parent ${n.parent}`).toBe(true);
      expect(NODE_TYPES).toContain(n.type);
      expect(STATUSES).toContain(n.status);
      expect(n.created).toMatch(ISO);
      expect(n.updated >= n.created).toBe(true);
      if (n.weight !== null) expect(n.weight).toBeGreaterThan(0);
      const hist = (n.meta as { statusHistory?: { at: string; status: BranchStatus | null }[] }).statusHistory;
      if (hist) {
        for (const h of hist) {
          expect(h.at).toMatch(ISO);
          expect(STATUSES).toContain(h.status);
          expect(h.at >= n.created).toBe(true);
        }
        expect(hist[hist.length - 1]!.status).toBe(n.status);
      }
    }
    const campaignIds = new Set(p.campaigns.map((c) => c.id));
    for (const n of p.graph.nodes) if (n.campaign) expect(campaignIds.has(n.campaign)).toBe(true);
  });

  it('covers the design: four weighted pillars, both hook hypotheses, a pivot and strategy v2', () => {
    const byId = new Map(p.graph.nodes.map((n) => [n.id, n]));
    const pillars = p.graph.nodes.filter((n) => n.type === 'pillar' && n.parent === 'st:v1');
    expect(pillars.map((n) => n.weight)).toEqual([40, 25, 20, 15]);
    expect(byId.get('hy:question')!.status).toBe('winning');
    expect(byId.get('hy:statement')!.status).toBe('pruned');
    expect(byId.get('pv:1')!.type).toBe('pivot');
    expect(byId.get('st:v2')!.type).toBe('strategy');
    expect(p.graph.nodes.some((n) => n.status === 'proposed' || ((n.meta as { statusHistory?: { status: string | null }[] }).statusHistory ?? []).some((h) => h.status === 'proposed'))).toBe(true);
    const created = p.graph.nodes.map((n) => n.created.slice(0, 10)).sort();
    expect(created[0]).toBe('2026-11-04');
    expect(new Set(created).size).toBeGreaterThan(6); // growth across many days for the replay
  });

  it('references only events and learnings that exist', () => {
    const eventIds = new Set(p.events.map((e) => e.id));
    const learningIds = new Set(p.learnings.map((l) => l.id));
    expect(eventIds.size).toBe(p.events.length);
    for (const n of p.graph.nodes) {
      for (const ev of n.evidence) expect(eventIds.has(ev), `${n.id} evidence ${ev}`).toBe(true);
      if (n.learning) expect(learningIds.has(n.learning), `${n.id} learning ${n.learning}`).toBe(true);
    }
    for (const l of p.learnings) if (l.branch) expect(p.graph.nodes.some((n) => n.id === l.branch)).toBe(true);
    expect(p.graph.nodes.filter((n) => n.evidence.length > 0).length).toBeGreaterThan(10);
  });

  it('events are valid, newest first, of many types, with branch refs pointing at nodes', () => {
    expect(p.events.length).toBeGreaterThanOrEqual(40);
    const ids = new Set(p.graph.nodes.map((n) => n.id));
    const decisionIds = new Set(p.decisions.map((d) => d.id));
    const runIds = new Set(p.runs.map((r) => r.id));
    for (let i = 1; i < p.events.length; i++) expect(p.events[i - 1]!.at >= p.events[i]!.at).toBe(true);
    for (const e of p.events) {
      expect(EVENT_TYPES).toContain(e.type);
      expect(e.at).toMatch(ISO);
      expect(e.project).toBe('demo');
      if (e.refs.branch) expect(ids.has(e.refs.branch), `${e.id} branch ${e.refs.branch}`).toBe(true);
      if (e.refs.decision) expect(decisionIds.has(e.refs.decision), `${e.id} decision ${e.refs.decision}`).toBe(true);
      if (e.refs.run) expect(runIds.has(e.refs.run), `${e.id} run ${e.refs.run}`).toBe(true);
      if (e.type === 'decision.made') expect(e.refs.decision).toBeTruthy();
    }
    const groups = new Set(p.events.map((e) => e.type.split('.')[0]));
    expect([...groups].sort()).toEqual(['account', 'agent', 'brand', 'brief', 'campaign', 'catalog', 'comment', 'comments', 'decision', 'metrics', 'note', 'pivot', 'plan', 'post', 'research', 'strategy']);
  });

  it('decisions use every routing path with sane probabilities and costs', () => {
    expect(p.decisions.length).toBeGreaterThanOrEqual(30);
    const via = new Set(p.decisions.map((d) => d.via));
    expect([...via].sort()).toEqual(['cache', 'escalated', 'judge', 'rule']);
    for (const d of p.decisions) {
      expect(DECISIONS).toContain(d.decision);
      expect(['predicate', 'choice', 'score']).toContain(d.kind);
      if (d.probabilities) {
        const sum = Object.values(d.probabilities).reduce((s, v) => s + v, 0);
        expect(sum).toBeGreaterThan(0.98);
        expect(sum).toBeLessThan(1.02);
      }
      if (d.via === 'judge') {
        expect(d.judge).toBeTruthy();
        expect(d.costUsd).toBeGreaterThan(0);
      } else expect(d.judge).toBeNull();
      if (d.confidence !== null) {
        expect(d.confidence).toBeGreaterThanOrEqual(0);
        expect(d.confidence).toBeLessThanOrEqual(1);
      }
      if (d.outcome !== null) expect(['right', 'wrong']).toContain(d.outcome);
    }
    expect(p.stats.decisions).toBe(p.decisions.length);
    expect(p.stats.events).toBe(p.events.length);
    expect(p.stats.judgeCostUsd).toBeCloseTo(p.decisions.reduce((s, d) => s + (d.costUsd ?? 0), 0), 3);
  });

  it('learnings and runs are complete', () => {
    for (const l of p.learnings) {
      expect(l.confidence).toBeGreaterThanOrEqual(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
      expect(l.nEff).toBeLessThanOrEqual(l.n + 3); // nEff cannot exceed n by much (maturity ≤ 1, weights ≤ 1)
      if (l.status === 'too-little-data') expect(l.nEff).toBeLessThan(3);
      if (l.interval) expect(l.interval[0]).toBeLessThanOrEqual(l.interval[1]);
    }
    expect(p.learnings.some((l) => l.status === 'too-little-data')).toBe(true);
    expect(p.learnings.some((l) => l.status === 'retired')).toBe(true);
    expect(p.runs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(p.runs.map((r) => r.status))).toEqual(new Set(['done', 'error', 'stopped-budget', 'running']));
    for (const r of p.runs) {
      if (r.endedAt) expect(r.endedAt >= r.startedAt).toBe(true);
      if (r.status === 'running') expect(r.endedAt).toBeNull();
    }
    expect(p.stats.agentCostUsd).toBeCloseTo(p.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0), 2);
  });
});
