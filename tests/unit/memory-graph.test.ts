// the decision map grows from campaigns, plans, packages and the timeline, idempotently.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A, B, DAY, T0, root, seedProject, setupMemoryProject, teardownMemoryProject } from './memory-helpers';
import { graphAt, rebuildMemory } from '@/lib/studio/memory/graph';
import { appendEvent, readGraph, readLearnings } from '@/lib/studio/memory/store';

beforeEach(setupMemoryProject);
afterEach(teardownMemoryProject);

describe('rebuildMemory', () => {
  it('is a safe no-op without campaigns or posts', async () => {
    const { graph, learnings } = await rebuildMemory(T0);
    expect(graph).toMatchObject({ version: 1, project: 'demo', nodes: [] });
    expect(learnings.learnings.every((l) => l.status === 'too-little-data' && Object.keys(l.scope).length === 0)).toBe(true);
    expect(existsSync(path.join(root, 'memory', 'graph.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, 'memory', 'learnings.json'), 'utf8')).version).toBe(1);
  });

  it('grows goals, strategies, pillars, hypotheses, variants and learnings from two campaigns', async () => {
    seedProject();
    const { graph, learnings } = await rebuildMemory(T0);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get(`goal:${A}`)).toMatchObject({ type: 'goal', label: 'Engagement: Grow saves', parent: null, status: null, goalWeight: { engagement: 1 }, created: '2026-10-30T10:00:00.000Z' });
    expect(byId.get(`goal:${B}`)).toMatchObject({ type: 'goal', label: 'Awareness: Reach' });
    const strat = graph.nodes.find((n) => n.type === 'strategy' && n.campaign === A)!;
    expect(strat).toMatchObject({ parent: `goal:${A}`, label: expect.stringMatching(/^Strategy v1: Daily bite-size/), meta: { version: 1, approvedAt: '2026-10-31T09:00:00.000Z' } });
    expect(byId.get(`pl:${A}:guess-the-link`)).toMatchObject({ type: 'pillar', parent: strat.id, weight: 60, label: 'Guess the link (60%)', status: 'promising', learning: `lr:${A}:saves_per_reach:pillar:guess-the-link` });
    expect(byId.get(`pl:${A}:seasonal`)).toMatchObject({ type: 'pillar', weight: 40, status: 'exploring' }); // two posts: nEff < 3
    const hyp = byId.get(`hyp:${A}:guess-the-link:hook:question`)!;
    expect(hyp).toMatchObject({ type: 'hypothesis', parent: `pl:${A}:guess-the-link`, label: 'Question hooks', status: 'promising', campaign: A });
    expect((hyp.meta.stats as { n: number }).n).toBe(4);
    expect(byId.get(`hyp:${A}:guess-the-link:format:higgsfield-reel`)).toMatchObject({ type: 'hypothesis', label: 'higgsfield-reel posts' });
    expect(byId.get(`hyp:${A}:seasonal:hook:statement`)).toMatchObject({ status: 'exploring' });
    const v1 = byId.get('var:pkg-01')!;
    expect(v1).toMatchObject({ type: 'variant', parent: hyp.id, status: 'exploring', created: '2026-10-28T17:00:00.000Z', label: 'Which 3 belong together?' });
    expect(v1.meta).toMatchObject({ packageId: '01', hook: 'Which 3 belong together?', hookStyle: 'question', format: 'higgsfield-reel', pillar: 'Guess the link', permalink: 'https://www.instagram.com/reel/abc01xyz/', metrics: { reach: 1000, saves: 50 } });
    expect((v1.meta.outcome as { metric: string; effect: number }).metric).toBe('saves_per_reach');
    expect((v1.meta.outcome as { effect: number }).effect).toBeGreaterThan(1);
    expect(byId.get('var:pkg-07')).toMatchObject({ type: 'variant', campaign: B, status: 'proposed', parent: `hyp:${B}:launch-moments:hook:statement` }); // made, not posted
    expect(byId.get('var:pkg-08')).toMatchObject({ type: 'variant', campaign: null, parent: null, status: 'exploring' }); // outside campaigns
    const learn = graph.nodes.filter((n) => n.type === 'learning');
    expect(learn.some((n) => n.parent === hyp.id && n.learning === hyp.learning)).toBe(true);
    expect(learn.some((n) => n.parent === null && n.learning === 'lr:project:saves_per_reach:hook:question')).toBe(true);
    expect(learnings.learnings.find((l) => l.id === 'lr:project:saves_per_reach:baseline')!.n).toBe(7);
    const ql = learnings.learnings.find((l) => l.id === hyp.learning)!;
    expect(ql.effect!).toBeGreaterThan(1.2);
    expect(ql.status).toBe('active');
    expect(ql.text).toMatch(/^Question hooks in "Guess the link" get/);
    // Every node has a status history entry when it has a status, dated from when it happened.
    for (const n of graph.nodes) if (n.status) expect((n.meta.statusHistory as { at: string; status: string }[])[0]).toEqual({ at: n.created, status: expect.any(String) });
    expect((await readGraph()).nodes).toHaveLength(graph.nodes.length);
    expect((await readLearnings()).learnings.length).toBe(learnings.learnings.length);
  });

  it('rebuilds idempotently, keeps created, records status changes and replays them', async () => {
    seedProject({ questionPosts: 2 });
    const first = await rebuildMemory(T0 - 2 * DAY);
    const hypId = `hyp:${A}:guess-the-link:hook:question`;
    const h1 = first.graph.nodes.find((n) => n.id === hypId)!;
    expect(h1.status).toBe('exploring');
    const again = await rebuildMemory(T0 - 2 * DAY);
    expect(again.graph.nodes).toEqual(first.graph.nodes);

    // Two more question posts land and mature: the branch becomes promising; nothing is lost.
    rmSync(path.join(root, 'campaigns', A), { recursive: true });
    for (const id of ['01', '02']) rmSync(path.join(root, 'posts', id), { recursive: true });
    seedProject({ questionPosts: 4 });
    const second = await rebuildMemory(T0);
    const h2 = second.graph.nodes.find((n) => n.id === hypId)!;
    expect(h2.created).toBe(h1.created);
    expect(h2.status).toBe('promising');
    expect(h2.meta.statusHistory).toEqual([
      { at: h1.created, status: 'exploring' },
      { at: new Date(T0).toISOString(), status: 'promising' },
    ]);
    for (const n of first.graph.nodes) expect(second.graph.nodes.find((x) => x.id === n.id)?.created).toBe(n.created);
    expect(second.graph.nodes.length).toBeGreaterThan(first.graph.nodes.length);

    // Replay: before the campaign existed nothing is there; the day before the change the branch was still exploring.
    expect(graphAt(second.graph, '2026-10-01').nodes).toEqual([]);
    const yesterday = graphAt(second.graph, new Date(T0 - DAY).toISOString());
    expect(yesterday.nodes.find((n) => n.id === hypId)).toMatchObject({ status: 'exploring' });
    expect(second.graph.nodes.find((n) => n.id === 'var:pkg-08')).toMatchObject({ created: '2026-11-03T17:00:00.000Z' }); // a new node is dated from its posting time
    expect(graphAt(second.graph, '2026-11-02').nodes.find((n) => n.id === 'var:pkg-08')).toBeUndefined(); // not yet posted then
    expect(graphAt(second.graph, '2026-11-02').nodes.find((n) => n.id === 'var:pkg-01')).toBeDefined();
    expect(graphAt(second.graph, '2026-11-04').nodes.find((n) => n.id === hypId)!.status).toBe('promising');
  });

  it('keeps pruned and old nodes, and turns pivot events into pivot nodes', async () => {
    seedProject();
    const g0 = await rebuildMemory(T0);
    // A hand-pruned branch stays pruned, and a node of a campaign that disappeared is kept.
    const pruned = g0.graph.nodes.find((n) => n.id === `hyp:${A}:seasonal:hook:statement`)!;
    pruned.status = 'pruned';
    writeFileSync(path.join(root, 'memory', 'graph.json'), JSON.stringify({ ...g0.graph, nodes: [...g0.graph.nodes, { ...pruned, id: 'pl:c-20250101-dead:old', type: 'pillar', campaign: 'c-20250101-dead', parent: null, status: 'weak' }] }));
    const ev1 = await appendEvent({ type: 'pivot.proposed', by: 'agent:lead', campaign: A, refs: {}, data: { pivot: 'more-guess', summary: 'Move 10% from Seasonal to Guess the link' }, at: '2026-11-03T09:00:00.000Z' });
    const ev2 = await appendEvent({ type: 'pivot.approved', by: 'owner', campaign: A, refs: {}, data: { pivot: 'more-guess' }, at: '2026-11-03T10:00:00.000Z' });
    const { graph } = await rebuildMemory(T0 + DAY);
    expect(graph.nodes.find((n) => n.id === pruned.id)!.status).toBe('pruned');
    expect(graph.nodes.find((n) => n.id === 'pl:c-20250101-dead:old')).toMatchObject({ status: 'weak' });
    const pivot = graph.nodes.find((n) => n.type === 'pivot')!;
    expect(pivot).toMatchObject({ id: 'pivot:more-guess', parent: `goal:${A}`, label: 'Move 10% from Seasonal to Guess the link', status: 'exploring', created: '2026-11-03T09:00:00.000Z', evidence: [ev1.id, ev2.id].sort() });
    expect(pivot.meta.statusHistory).toEqual([
      { at: '2026-11-03T09:00:00.000Z', status: 'proposed' },
      { at: '2026-11-03T10:00:00.000Z', status: 'exploring' },
    ]);
    expect(pivot.meta.decision).toBe('approved');
  });
});
