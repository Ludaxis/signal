// Derived status: `out-of-date` is computed from the data, never stored. A node is directly out of
// date when an input's current version differs from the one recorded in its version, its settings changed, a pack
// entry it read changed, or Signal updated its implementation. Staleness propagates along edges through unlocked nodes
// only: a locked node stops propagation and its dependents treat its current version as valid ("Out of date · locked").
// Also the gate state of a version (a `by: 'mock'` record counts as unsigned) and the accept
// blockers (last bullet).
import { PostmakerError } from '../errors';
import { packRefReason } from '../pack/load';
import { readHead } from '../store/heads';
import { hashJson } from '../store/objects';
import { readPackLock, readPipeline, readRecipe } from '../store/recipes';
import { readVersion } from '../store/versions';
import type { HumanGate, PackLock, Pipeline, PipelineNode, Recipe, SignOff, StepHead, StepKind, StepStatus, StepVersion } from '../types';
import { topoOrder } from './validate';

export const REASON_IMPL = 'Signal updated this step';
export const REASON_SETTINGS = 'Settings changed';
export const REASON_MISSING = 'Missing input';
export const REASON_RECIPE = 'The recipe changed';

/** The step kinds that read the recipe's beats directly (every other step reads them through `script`). */
export const RECIPE_READERS: ReadonlySet<StepKind> = new Set<StepKind>(['script']);

/** The hash of the recipe's beats a recipe-reading step records (`StepVersion.recipe.beats`). */
export const recipeBeatsHash = (r: Pick<Recipe, 'beats'>): string => hashJson(r.beats);
export const changedReason = (nodeId: string) => `${nodeId} changed`;

export interface GraphState {
  pipeline: Pick<Pipeline, 'nodes'>;
  heads: Record<string, StepHead>;
  /** The version each head points at (null when not run). */
  current: Record<string, StepVersion | null>;
  packLock: PackLock | null;
  /** The executors' implementation versions (`<kind>@<n>`); a kind without an entry is never "updated". */
  implVersions: Partial<Record<StepKind, string>>;
  /** Nodes a run has queued or is running now, or whose last attempt failed without a new version since. */
  running?: Record<string, 'queued' | 'running' | 'failed'>;
  /** True when the node's whole connector chain is switched off (it runs as mock when run). */
  connectorOff?: (node: PipelineNode) => boolean;
  /** Sign-off records kept outside the version files; merged with each version's own records. */
  signoffs?: SignOff[];
  /** `recipeBeatsHash` of the recipe now; null or absent = not compared. */
  recipeBeats?: string | null;
}

export interface GateState {
  gate: HumanGate;
  signed: boolean;
  /** Only mock records exist: reported, and unsigned. */
  mock: boolean;
}

export interface NodeStatus {
  nodeId: string;
  status: StepStatus;
  outOfDate: boolean;
  lockedButChanged: boolean;
  direct: boolean;
  reasons: string[];
  /** A required input comes from a skipped or missing node ("Needs you · missing input"). */
  missingInput: boolean;
  gate: GateState | null;
}

/** The content hash a mock gate record carries (a version cannot contain its own hash). */
export const outputsHash = (v: Pick<StepVersion, 'outputs'>) => hashJson(v.outputs.map((o) => [o.port, o.name, o.sha256]));

/** signed = a pass by a named person (not 'mock') for this exact version. */
export function gateStateOf(node: Pick<PipelineNode, 'id' | 'gate'>, v: StepVersion | null, extra: SignOff[] = []): GateState | null {
  if (!node.gate) return null;
  if (!v) return { gate: node.gate, signed: false, mock: false };
  const records = [...v.signoffs, ...extra].filter((s) => s.gate === node.gate!.id && s.nodeId === node.id && s.version === v.n && (s.hash === v.hash || s.hash === outputsHash(v)));
  const real = records.filter((s) => s.by !== 'mock' && s.name.trim() !== '' && s.name !== 'mock');
  const signed = real.length > 0 && real.at(-1)!.verdict === 'pass';
  return { gate: node.gate, signed, mock: !signed && records.some((s) => s.by === 'mock') };
}

/** The direct out-of-date reasons of one node's current version. */
export function directReasons(node: PipelineNode, v: StepVersion, s: GraphState): string[] {
  const reasons: string[] = [];
  const recorded = new Map(v.inputs.map((i) => [i.nodeId, i]));
  const ids = new Set(s.pipeline.nodes.map((n) => n.id));
  const parents = [...new Set(node.inputs.map((i) => i.from))];
  for (const p of parents) {
    if (!ids.has(p)) continue;
    const up = s.current[p] ?? null;
    const rec = recorded.get(p);
    if (!rec) {
      if (up) reasons.push(changedReason(p));
      continue;
    }
    if (!up || up.hash !== rec.hash) reasons.push(changedReason(p));
  }
  for (const rec of v.inputs) if (!parents.includes(rec.nodeId)) reasons.push(changedReason(rec.nodeId)); // an input was removed
  if (hashJson(node.params ?? {}) !== hashJson(v.params ?? {})) reasons.push(REASON_SETTINGS);
  if (v.recipe && s.recipeBeats && v.recipe.beats !== s.recipeBeats) reasons.push(REASON_RECIPE);
  for (const ref of v.packRefs) {
    const now = s.packLock?.entries[ref.ref];
    if (now !== ref.sha256) reasons.push(packRefReason(ref.ref));
  }
  const impl = s.implVersions[node.kind];
  if (impl && impl !== v.implVersion) reasons.push(REASON_IMPL);
  return [...new Set(reasons)];
}

/** `deriveStatus`, in topological order. */
export function deriveStatus(s: GraphState): Record<string, NodeStatus> {
  const nodes = s.pipeline.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Record<string, NodeStatus> = {};
  for (const id of topoOrder(nodes).order) {
    const node = byId.get(id)!;
    const head = s.heads[id];
    const v = s.current[id] ?? null;
    const missingInput = node.inputs.some((i) => i.required && byId.has(i.from) && (s.heads[i.from]?.skipped || false));
    const base = { nodeId: id, outOfDate: false, lockedButChanged: false, direct: false, reasons: [] as string[], missingInput, gate: gateStateOf(node, v, s.signoffs) };
    if (head?.skipped) {
      out[id] = { ...base, status: 'skipped' };
      continue;
    }
    const run = s.running?.[id];
    if (!v) {
      const status: StepStatus = run ?? (s.connectorOff?.(node) ? 'off' : 'not-run');
      out[id] = { ...base, status, reasons: missingInput ? [REASON_MISSING] : [] };
      continue;
    }
    const reasons = directReasons(node, v, s);
    const direct = reasons.length > 0;
    const locked = head?.locked ?? false;
    const upstream = [...new Set(node.inputs.map((i) => i.from))].some((p) => out[p]?.outOfDate);
    const outOfDate = (direct || upstream) && !locked;
    if (missingInput) reasons.push(REASON_MISSING);
    let status: StepStatus = v.status === 'needs-you' ? 'needs-you' : v.status === 'failed' ? 'failed' : 'done';
    if (missingInput) status = 'needs-you';
    if (run) status = run;
    out[id] = { ...base, status, outOfDate, lockedButChanged: locked && direct, direct, reasons };
  }
  return out;
}

/** Reads every head, current version and the last pack lock of a recipe. */
export async function loadGraphState(root: string, recipeId: string, o: Omit<GraphState, 'pipeline' | 'heads' | 'current' | 'packLock'> & { pipeline?: Pipeline; packLock?: PackLock | null }): Promise<GraphState & { pipeline: Pipeline }> {
  const pipeline = o.pipeline ?? (await readPipeline(root, recipeId));
  if (!pipeline) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
  const heads: Record<string, StepHead> = {};
  const current: Record<string, StepVersion | null> = {};
  for (const n of pipeline.nodes) {
    const h = await readHead(root, recipeId, n.id);
    heads[n.id] = h;
    current[n.id] = h.current === null ? null : await readVersion(root, recipeId, n.id, h.current);
  }
  const packLock = o.packLock !== undefined ? o.packLock : await readPackLock(root);
  const recipeBeats = o.recipeBeats !== undefined ? o.recipeBeats : await readRecipe(root, recipeId).then((r) => (r ? recipeBeatsHash(r) : null), () => null);
  return { ...o, pipeline, heads, current, packLock, recipeBeats };
}

// ---- accept ------------------------------------------------------------------------------------------------------

export interface AcceptBlocker {
  nodeId: string;
  why: 'out-of-date' | 'failed' | 'needs-you' | 'not-run' | 'unsigned' | 'mock';
  text: string;
}

/**
 * What stops Accept. Every node except `check`'s own proof gate counts.
 * Out of date, failed, needs-you or not run always block. Clean Accept also needs every required gate signed by a
 * named person and no mock step; "Accept as draft" waives those two. "Signal updated this step" alone does not block a
 * locked or signed node.
 */
export function acceptBlockers(s: GraphState, o: { asDraft: boolean }): AcceptBlocker[] {
  const status = deriveStatus(s);
  const out: AcceptBlocker[] = [];
  for (const n of s.pipeline.nodes) {
    const st = status[n.id]!;
    const v = s.current[n.id] ?? null;
    if (st.status === 'skipped') continue;
    if (st.status === 'failed') out.push({ nodeId: n.id, why: 'failed', text: `${n.id} failed.` });
    else if (st.status === 'needs-you') out.push({ nodeId: n.id, why: 'needs-you', text: `${n.id} needs you.` });
    else if (!v) out.push({ nodeId: n.id, why: 'not-run', text: `${n.id} has not run.` });
    const signedGate = st.gate?.signed ?? false;
    const locked = s.heads[n.id]?.locked ?? false;
    const onlyImpl = st.reasons.length > 0 && st.reasons.every((r) => r === REASON_IMPL);
    // A locked node is never out of date (its dependents treat it as valid); an unlocked one blocks, except when
    // Signal's own update is the only reason and the node's gate is signed.
    if (st.outOfDate && !(onlyImpl && (locked || signedGate))) out.push({ nodeId: n.id, why: 'out-of-date', text: `${n.id} is out of date.` });
    if (!o.asDraft) {
      if (n.gate && n.gate.id !== 'proof' && !signedGate) out.push({ nodeId: n.id, why: 'unsigned', text: `${n.id} needs a named sign-off.` });
      if (v && v.mode === 'mock') out.push({ nodeId: n.id, why: 'mock', text: `${n.id} has mock output.` });
    }
  }
  return out;
}

/** 409 while anything blocks Accept (the API maps the status directly). */
export function assertAcceptable(s: GraphState, o: { asDraft: boolean }): void {
  const b = acceptBlockers(s, o);
  if (b.length) {
    const e = new PostmakerError(409, 'accept-blocked', b.some((x) => x.why === 'out-of-date') ? 'Some steps are out of date.' : b[0]!.text);
    (e as PostmakerError & { blockers?: AcceptBlocker[] }).blockers = b;
    throw e;
  }
}
