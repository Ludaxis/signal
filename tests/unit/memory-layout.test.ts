// Memory mindmap layout and replay helpers (app/studio/memory-layout.ts).
import { describe, expect, it } from 'vitest';
import { ancestorsOf, dayRange, endOfDay, filterCampaign, layoutTree, statusAt, visibleAt, visibleWithCollapse } from '@/app/studio/memory-layout';
import { demoPayload } from '@/lib/studio/memory/demo';
import type { GraphNode } from '@/lib/studio/memory/types';

const PROJECT = { id: 'demo', name: 'Demo', handle: '@signal.demo' };

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('layoutTree', () => {
  const graph = demoPayload(PROJECT).graph;

  it('places every node without overlaps and keeps the gaps', () => {
    const l = layoutTree(graph.nodes, { direction: 'lr', nodeGap: 12, levelGap: 48, size: (n) => ({ w: 120 + n.label.length * 3, h: 36 + (n.evidence.length % 5) * 3 }) });
    expect(l.nodes).toHaveLength(graph.nodes.length);
    for (let i = 0; i < l.nodes.length; i++)
      for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i]!;
        const b = l.nodes[j]!;
        expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
        if (a.depth === b.depth) expect(Math.abs(a.y - b.y) >= Math.min(a.h, b.h) + 12).toBe(true);
      }
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic for the same input', () => {
    const a = layoutTree(graph.nodes, { direction: 'lr' });
    const b = layoutTree([...graph.nodes], { direction: 'lr' });
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    expect(JSON.stringify(a.edges)).toBe(JSON.stringify(b.edges));
  });

  it('puts children to the right of their parent and centres the parent on them', () => {
    const l = layoutTree(graph.nodes, { direction: 'lr' });
    for (const n of l.nodes) {
      if (!n.parent) continue;
      const p = l.byId.get(n.parent)!;
      expect(n.x).toBeGreaterThan(p.x + p.w);
      expect(n.depth).toBe(p.depth + 1);
    }
    const strategy = l.byId.get('st:v1')!;
    const kids = strategy.children.map((id) => l.byId.get(id)!);
    const first = kids[0]!;
    const last = kids[kids.length - 1]!;
    expect(strategy.y + strategy.h / 2).toBeCloseTo((first.y + first.h / 2 + last.y + last.h / 2) / 2, 5);
    expect(l.edges.find((e) => e.to === 'pl:guess')?.path.startsWith('M')).toBe(true);
    expect(l.edges).toHaveLength(l.nodes.length - 1);
  });

  it('collapse hides descendants but keeps the collapsed node and counts its children', () => {
    const l = layoutTree(graph.nodes, { direction: 'lr', collapsed: ['pl:guess'] });
    const ids = new Set(l.nodes.map((n) => n.id));
    expect(ids.has('pl:guess')).toBe(true);
    expect(ids.has('hy:question')).toBe(false);
    expect(ids.has('var:pkg-12')).toBe(false);
    expect(ids.has('pl:odd')).toBe(true);
    expect(l.byId.get('pl:guess')!.hiddenChildren).toBe(2);
    expect(visibleWithCollapse(graph.nodes, ['st:v1']).map((n) => n.id)).toEqual(['goal:c1', 'st:v1', 'st:v2', 'pl2:guess', 'pl2:odd', 'pl2:music', 'hy:beatsync', 'var:pkg-20']);
  });

  it('lays out a forest and a single node', () => {
    const forest = layoutTree([{ id: 'a', parent: null }, { id: 'b', parent: null }, { id: 'c', parent: 'b' }], { direction: 'lr' });
    expect(forest.nodes.find((n) => n.id === 'b')!.y).toBeGreaterThan(forest.nodes.find((n) => n.id === 'a')!.y);
    const one = layoutTree([{ id: 'only', parent: null }], { direction: 'lr' });
    expect(one.nodes[0]).toMatchObject({ x: 0, y: 0, depth: 0 });
    expect(one.edges).toEqual([]);
  });
});

describe('replay helpers', () => {
  const graph = demoPayload(PROJECT).graph;
  const q = graph.nodes.find((n) => n.id === 'hy:question')!;

  it('statusAt follows meta.statusHistory', () => {
    expect(statusAt(q, endOfDay('2026-11-04'))).toBe('exploring');
    expect(statusAt(q, endOfDay('2026-11-09'))).toBe('exploring');
    expect(statusAt(q, endOfDay('2026-11-10'))).toBe('promising');
    expect(statusAt(q, endOfDay('2026-11-18'))).toBe('winning');
    expect(statusAt(q, '2026-11-01T00:00:00.000Z')).toBe('exploring'); // before any entry: the first known status
    const plain: GraphNode = { ...q, meta: {}, status: 'weak' };
    expect(statusAt(plain, endOfDay('2026-11-18'))).toBe('weak');
    const junk: GraphNode = { ...q, meta: { statusHistory: 'nope' }, status: 'pruned' };
    expect(statusAt(junk, endOfDay('2026-11-18'))).toBe('pruned');
  });

  it('visibleAt grows the map day by day with the status of that day', () => {
    const day0 = visibleAt(graph, endOfDay('2026-11-04'));
    const ids0 = new Set(day0.map((n) => n.id));
    expect(ids0.has('goal:c1')).toBe(true);
    expect(ids0.has('pl:seasonal')).toBe(true);
    expect(ids0.has('var:pkg-12')).toBe(true); // brief 12 was created on 4 Nov
    expect(ids0.has('var:pkg-15')).toBe(false);
    expect(ids0.has('st:v2')).toBe(false);
    expect(day0.find((n) => n.id === 'hy:question')!.status).toBe('exploring');

    const day10 = visibleAt(graph, endOfDay('2026-11-10'));
    expect(day10.find((n) => n.id === 'hy:question')!.status).toBe('promising');
    expect(day10.some((n) => n.id === 'pv:1')).toBe(false);

    const day14 = visibleAt(graph, endOfDay('2026-11-14'));
    expect(day14.find((n) => n.id === 'hy:statement')!.status).toBe('pruned');
    expect(day14.some((n) => n.id === 'st:v2')).toBe(true);
    expect(day14.find((n) => n.id === 'pv:1')!.status).toBeNull(); // approved

    const all = visibleAt(graph, endOfDay('2026-11-18'));
    expect(all).toHaveLength(graph.nodes.length);
    expect(visibleAt(graph, '2026-10-01T00:00:00.000Z')).toEqual([]);
  });

  it('visibleAt never shows a node without its parent', () => {
    const orphanGraph = { nodes: [{ ...q, id: 'late-parent', parent: null, created: '2026-11-20T00:00:00.000Z' }, { ...q, id: 'early-child', parent: 'late-parent', created: '2026-11-01T00:00:00.000Z' }] };
    expect(visibleAt(orphanGraph, endOfDay('2026-11-10'))).toEqual([]);
  });

  it('filterCampaign keeps the chosen campaign and its ancestors', () => {
    const c2 = filterCampaign(graph.nodes, 'c-20261110-b2f1').map((n) => n.id);
    expect(c2).toEqual(expect.arrayContaining(['goal:c1', 'st:v1', 'pl:seasonal', 'hy:sint', 'var:pkg-19', 'out:sint']));
    expect(c2).not.toContain('hy:question');
    expect(filterCampaign(graph.nodes, null)).toHaveLength(graph.nodes.length);
  });

  it('ancestorsOf, dayRange and endOfDay', () => {
    expect(ancestorsOf(graph.nodes, 'var:pkg-12')).toEqual(['hy:question', 'pl:guess', 'st:v1', 'goal:c1']);
    expect(dayRange('2026-11-28', '2026-12-02')).toEqual(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(dayRange('2026-11-05', '2026-11-04')).toEqual([]);
    expect(endOfDay('2026-11-04')).toBe('2026-11-04T23:59:59.999Z');
  });
});
