// Pipeline validation on save: unique well-formed ids whose kind matches the node, at most 40 nodes,
// at most 8 parallel branches, every required input connected to an existing node's declared output port, every
// connector in a chain registered for the kind, stored edges equal to the edges derived from the inputs, and no
// cycle (Kahn's algorithm). Every message names the node it is about.
import { PostmakerError } from '../errors';
import { NODE_ID_RE } from '../store/paths';
import { LANGS, STEP_KINDS, type Edge, type Pipeline, type PipelineNode } from '../types';
import { KINDS } from './kinds';

export const MAX_NODES = 40;
export const MAX_BRANCHES = 8;

export interface ValidationIssue {
  nodeId: string | null;
  code: 'duplicate' | 'bad-id' | 'too-many-nodes' | 'too-many-branches' | 'dangling' | 'bad-port' | 'connector' | 'cycle' | 'edges' | 'self';
  text: string;
}

/** Edges derived from node inputs ("derived from node inputs; stored for readability and checked on load"). */
export function edgesOf(nodes: Pick<PipelineNode, 'id' | 'inputs'>[]): Edge[] {
  const out: Edge[] = [];
  for (const n of nodes) for (const i of n.inputs) out.push({ from: i.from, fromPort: i.fromPort, to: n.id, toPort: i.port, soft: !i.required });
  return out;
}

const edgeKey = (e: Edge) => `${e.from}.${e.fromPort}>${e.to}.${e.toPort}:${e.soft ? 's' : 'h'}`;

/**
 * Topological order by Kahn's algorithm over the input edges (ties broken by the nodes' listed order, so the order is
 * stable). Returns the order and the nodes left on a cycle (empty when acyclic). Inputs naming unknown nodes are ignored.
 */
export function topoOrder(nodes: Pick<PipelineNode, 'id' | 'inputs'>[]): { order: string[]; cyclic: string[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const n of nodes) {
    const parents = new Set(n.inputs.map((i) => i.from).filter((f) => ids.has(f)));
    indeg.set(n.id, parents.size);
    for (const p of parents) children.get(p)!.push(n.id);
  }
  const rank = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) ready.push(c);
    }
  }
  const done = new Set(order);
  return { order, cyclic: nodes.map((n) => n.id).filter((id) => !done.has(id)) };
}

/**
 * Parallel branches = the widest level when every node sits at its longest-path depth from the roots. Nodes on the
 * same level have no path between them, so they can all run at once. (Acyclic input only.)
 */
export function branchWidth(nodes: Pick<PipelineNode, 'id' | 'inputs'>[]): { width: number; level: string[] } {
  const { order } = topoOrder(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const id of order) {
    const parents = byId.get(id)!.inputs.map((i) => depth.get(i.from)).filter((d): d is number => d !== undefined);
    depth.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const levels = new Map<number, string[]>();
  for (const [id, d] of depth) levels.set(d, [...(levels.get(d) ?? []), id]);
  let level: string[] = [];
  for (const l of levels.values()) if (l.length > level.length) level = l;
  return { width: level.length, level };
}

export function pipelineIssues(p: Pick<Pipeline, 'nodes' | 'edges'>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = p.nodes;
  if (nodes.length > MAX_NODES) issues.push({ nodeId: nodes[MAX_NODES]!.id, code: 'too-many-nodes', text: `Too many steps: ${nodes.length} (at most ${MAX_NODES}). ${nodes[MAX_NODES]!.id} is over the limit.` });
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) issues.push({ nodeId: n.id, code: 'duplicate', text: `${n.id} appears twice.` });
    seen.add(n.id);
    const m = NODE_ID_RE.exec(n.id);
    const kindOk = (STEP_KINDS as readonly string[]).includes(n.kind);
    if (!m || !kindOk || m[1] !== n.kind || (m[2] ?? null) !== (n.lang ?? null) || (n.lang !== null && !(LANGS as readonly string[]).includes(n.lang))) {
      issues.push({ nodeId: n.id, code: 'bad-id', text: `${n.id} does not match its kind and language.` });
      continue;
    }
    for (const c of n.connectorChain) {
      if (!KINDS[n.kind].registered.includes(c)) issues.push({ nodeId: n.id, code: 'connector', text: `${n.id} cannot use ${c}.` });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const ports = new Set<string>();
    for (const i of n.inputs) {
      if (ports.has(i.port)) issues.push({ nodeId: n.id, code: 'bad-port', text: `${n.id} has two inputs named ${i.port}.` });
      ports.add(i.port);
      if (i.from === n.id) {
        issues.push({ nodeId: n.id, code: 'self', text: `${n.id} cannot read its own output.` });
        continue;
      }
      const up = byId.get(i.from);
      if (!up) {
        if (i.required) issues.push({ nodeId: n.id, code: 'dangling', text: `${n.id} needs ${i.port} from ${i.from}, which is not in the pipeline.` });
        continue;
      }
      const declared = (STEP_KINDS as readonly string[]).includes(up.kind) ? KINDS[up.kind].outputs : [];
      if (!declared.includes(i.fromPort)) issues.push({ nodeId: n.id, code: 'dangling', text: `${n.id} needs ${i.fromPort} from ${i.from}, which does not make it.` });
    }
  }
  const { cyclic } = topoOrder(nodes);
  if (cyclic.length) issues.push({ nodeId: cyclic[0]!, code: 'cycle', text: `Steps form a loop at ${cyclic[0]} (${cyclic.join(', ')}).` });
  else {
    const { width, level } = branchWidth(nodes);
    if (width > MAX_BRANCHES) issues.push({ nodeId: level[MAX_BRANCHES]!, code: 'too-many-branches', text: `Too many parallel steps: ${width} (at most ${MAX_BRANCHES}), at ${level.join(', ')}.` });
  }
  const want = new Set(edgesOf(nodes).map(edgeKey));
  const have = new Set(p.edges.map(edgeKey));
  const missing = [...want].filter((e) => !have.has(e));
  const extra = [...have].filter((e) => !want.has(e));
  if (missing.length || extra.length) {
    const first = (missing[0] ?? extra[0])!;
    const nodeId = first.split('>')[1]!.split('.')[0]!;
    issues.push({ nodeId, code: 'edges', text: `The stored links of ${nodeId} do not match its inputs.` });
  }
  return issues;
}

/** Refuses an invalid pipeline with 400 and the first issue's message (which names the node). */
export function validatePipeline(p: Pick<Pipeline, 'nodes' | 'edges'>): void {
  const issues = pipelineIssues(p);
  if (issues.length) {
    const e = new PostmakerError(400, 'pipeline-invalid', issues[0]!.text);
    (e as PostmakerError & { issues?: ValidationIssue[] }).issues = issues;
    throw e;
  }
}
