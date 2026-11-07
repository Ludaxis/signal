// Pure layout and replay helpers for the Memory mindmap. No React, no DOM: everything here is
// deterministic and unit-tested (tests/unit/memory-layout.test.ts).
//
// layoutTree: a tidy left-to-right tree (Reingold–Tilford style). Each subtree is packed against
// its previous sibling's per-depth contour, so branches nest as tightly as the node gap allows and
// never overlap; a parent sits at the midpoint of its first and last child. Columns are aligned
// per depth (width of the widest node in that depth). Input order decides sibling order.
import type { BranchStatus, Graph, GraphNode } from '@/lib/studio/memory/types';
import { zonedToUtc } from '@/lib/time';

export interface TreeInput { id: string; parent: string | null }
export interface Size { w: number; h: number }
export interface LayoutOptions<N extends TreeInput> {
  direction: 'lr';
  nodeGap?: number; // vertical space between sibling subtrees
  levelGap?: number; // horizontal space between depth columns
  size?: (node: N) => Size; // default 180 × 40
  collapsed?: Iterable<string>; // ids whose descendants are hidden
}
export interface LayoutNode<N extends TreeInput = TreeInput> { id: string; node: N; x: number; y: number; w: number; h: number; depth: number; parent: string | null; children: string[]; hiddenChildren: number }
export interface LayoutEdge { id: string; from: string; to: string; path: string; x1: number; y1: number; x2: number; y2: number }
export interface Layout<N extends TreeInput = TreeInput> { nodes: LayoutNode<N>[]; edges: LayoutEdge[]; width: number; height: number; byId: Map<string, LayoutNode<N>> }

const DEFAULT_SIZE: Size = { w: 180, h: 40 };

/** Smooth horizontal bezier from (x1,y1) to (x2,y2). */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, (x2 - x1) / 2);
  const r = (n: number) => Math.round(n * 100) / 100;
  return `M${r(x1)} ${r(y1)} C${r(x1 + dx)} ${r(y1)}, ${r(x2 - dx)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

/** Ids of nodes still shown when `collapsed` branches hide their descendants (the collapsed nodes stay). */
export function visibleWithCollapse<N extends TreeInput>(nodes: N[], collapsed: Iterable<string>): N[] {
  const col = new Set(collapsed);
  if (col.size === 0) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, boolean>();
  const hidden = (n: N): boolean => {
    const m = memo.get(n.id);
    if (m !== undefined) return m;
    const p = n.parent ? byId.get(n.parent) : undefined;
    const h = p ? col.has(p.id) || hidden(p) : false;
    memo.set(n.id, h);
    return h;
  };
  return nodes.filter((n) => !hidden(n));
}

export function layoutTree<N extends TreeInput>(input: N[], opts: LayoutOptions<N>): Layout<N> {
  const nodeGap = opts.nodeGap ?? 14;
  const levelGap = opts.levelGap ?? 56;
  const sizeOf = opts.size ?? (() => DEFAULT_SIZE);
  const shown = visibleWithCollapse(input, opts.collapsed ?? []);
  const shownIds = new Set(shown.map((n) => n.id));
  const collapsed = new Set(opts.collapsed ?? []);

  // Children in input order; roots are nodes whose parent is missing or not shown.
  const children = new Map<string, N[]>();
  const roots: N[] = [];
  for (const n of shown) {
    const p = n.parent && shownIds.has(n.parent) ? n.parent : null;
    if (p === null) roots.push(n);
    else children.set(p, [...(children.get(p) ?? []), n]);
  }
  const hiddenChildren = (id: string) => (collapsed.has(id) ? input.filter((n) => n.parent === id).length : 0);

  // Depth and per-depth column widths.
  const depthOf = new Map<string, number>();
  const colWidth: number[] = [];
  const sizes = new Map<string, Size>();
  const walkDepth = (n: N, d: number) => {
    depthOf.set(n.id, d);
    const s = sizeOf(n);
    sizes.set(n.id, s);
    colWidth[d] = Math.max(colWidth[d] ?? 0, s.w);
    for (const c of children.get(n.id) ?? []) walkDepth(c, d + 1);
  };
  for (const r of roots) walkDepth(r, 0);
  const colX: number[] = [];
  for (let d = 0, x = 0; d < colWidth.length; d++) {
    colX[d] = x;
    x += (colWidth[d] ?? 0) + levelGap;
  }

  // Relative vertical layout: each subtree returns its node centres (relative to its root's centre
  // = 0) and a contour: per depth offset, the [top, bottom] extent occupied.
  interface Sub { rel: Map<string, number>; contour: [number, number][] }
  const place = (n: N): Sub => {
    const h = (sizes.get(n.id) ?? DEFAULT_SIZE).h;
    const kids = children.get(n.id) ?? [];
    const rel = new Map<string, number>([[n.id, 0]]);
    if (kids.length === 0) return { rel, contour: [[-h / 2, h / 2]] };
    const subs = kids.map(place);
    const shifts: number[] = [];
    // Running contour of the siblings placed so far (relative to the first child's centre = 0).
    let merged: [number, number][] = [];
    subs.forEach((s, i) => {
      let shift = 0;
      if (i > 0) {
        shift = -Infinity;
        for (let d = 0; d < Math.min(merged.length, s.contour.length); d++) shift = Math.max(shift, (merged[d]![1] ?? 0) + nodeGap - (s.contour[d]![0] ?? 0));
        if (shift === -Infinity) shift = 0;
      }
      shifts.push(shift);
      s.contour.forEach(([t, b], d) => {
        const cur = merged[d];
        merged[d] = cur ? [Math.min(cur[0], t + shift), Math.max(cur[1], b + shift)] : [t + shift, b + shift];
      });
    });
    // Parent at the midpoint between the first and last child centres; re-base everything on it.
    const mid = ((shifts[0] ?? 0) + (shifts[shifts.length - 1] ?? 0)) / 2;
    subs.forEach((s, i) => {
      const off = (shifts[i] ?? 0) - mid;
      for (const [id, y] of s.rel) rel.set(id, y + off);
    });
    merged = merged.map(([t, b]) => [t - mid, b - mid]);
    const contour: [number, number][] = [[-h / 2, h / 2], ...merged];
    return { rel, contour };
  };

  // Stack root subtrees top to bottom.
  const abs = new Map<string, number>();
  let cursor = 0;
  for (const r of roots) {
    const s = place(r);
    const top = Math.min(...s.contour.map((c) => c[0]));
    const base = cursor - top;
    for (const [id, y] of s.rel) abs.set(id, base + y);
    cursor = base + Math.max(...s.contour.map((c) => c[1])) + nodeGap * 2;
  }

  const nodes: LayoutNode<N>[] = shown.map((n) => {
    const d = depthOf.get(n.id) ?? 0;
    const s = sizes.get(n.id) ?? DEFAULT_SIZE;
    const cy = abs.get(n.id) ?? 0;
    return { id: n.id, node: n, x: colX[d] ?? 0, y: cy - s.h / 2, w: s.w, h: s.h, depth: d, parent: n.parent && shownIds.has(n.parent) ? n.parent : null, children: (children.get(n.id) ?? []).map((c) => c.id), hiddenChildren: hiddenChildren(n.id) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = [];
  for (const n of nodes) {
    if (!n.parent) continue;
    const p = byId.get(n.parent);
    if (!p) continue;
    const x1 = p.x + p.w;
    const y1 = p.y + p.h / 2;
    const x2 = n.x;
    const y2 = n.y + n.h / 2;
    edges.push({ id: `${p.id}->${n.id}`, from: p.id, to: n.id, path: edgePath(x1, y1, x2, y2), x1, y1, x2, y2 });
  }
  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
  const height = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0);
  return { nodes, edges, width, height, byId };
}

// ---- replay --------------------------------------------------------------------------------------
export interface StatusChange { at: string; status: BranchStatus | null }

/** meta.statusHistory when present and well-formed, oldest first. */
export function statusHistory(node: Pick<GraphNode, 'meta' | 'created' | 'status'>): StatusChange[] {
  const raw = (node.meta as { statusHistory?: unknown } | undefined)?.statusHistory;
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter((r): r is StatusChange => !!r && typeof r === 'object' && typeof (r as StatusChange).at === 'string').map((r) => ({ at: r.at, status: r.status ?? null }));
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The branch status a node had at `iso` (end of that instant). Falls back to node.status when there is no history. */
export function statusAt(node: Pick<GraphNode, 'meta' | 'created' | 'status'>, iso: string): BranchStatus | null {
  const hist = statusHistory(node);
  if (hist.length === 0) return node.status;
  let cur: BranchStatus | null | undefined;
  for (const h of hist) {
    if (h.at <= iso) cur = h.status;
    else break;
  }
  return cur === undefined ? (hist[0]?.status ?? node.status) : cur;
}

/**
 * `YYYY-MM-DD` → the last instant of that day, so a day slider includes everything created on it. With a time
 * zone the day is the project's own (project.timeZone); without one, or on a clock-change edge, the UTC day.
 */
export function endOfDay(date: string, tz?: string): string {
  if (tz) {
    const r = zonedToUtc(date.slice(0, 10), '23:59', tz);
    if (r.ok) return new Date(Date.parse(r.iso) + 59_999).toISOString();
  }
  return `${date.slice(0, 10)}T23:59:59.999Z`;
}

/** Nodes that existed at `iso`, with the status they had then. */
export function visibleAt(graph: Pick<Graph, 'nodes'>, iso: string): GraphNode[] {
  const ids = new Set(graph.nodes.filter((n) => n.created <= iso).map((n) => n.id));
  // A node is only shown when its whole ancestry existed too (keeps the tree connected).
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ok = (n: GraphNode): boolean => {
    if (!ids.has(n.id)) return false;
    const p = n.parent ? byId.get(n.parent) : undefined;
    return n.parent === null || !p ? true : ok(p);
  };
  return graph.nodes.filter(ok).map((n) => ({ ...n, status: statusAt(n, iso) }));
}

/** Nodes of the chosen campaign (campaign-less nodes included), plus their ancestors so the tree stays connected. */
export function filterCampaign(nodes: GraphNode[], campaign: string | null): GraphNode[] {
  if (!campaign) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.campaign !== campaign && n.campaign !== null) continue;
    let cur: GraphNode | undefined = n;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return nodes.filter((n) => keep.has(n.id));
}

/** Ancestor ids of `id`, nearest first. */
export function ancestorsOf(nodes: Pick<GraphNode, 'id' | 'parent'>[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cur = byId.get(id);
  while (cur && cur.parent) {
    out.push(cur.parent);
    cur = byId.get(cur.parent);
  }
  return out;
}

/** Inclusive list of `YYYY-MM-DD` days from `from` to `to`. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  for (let t = a; t <= b; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
