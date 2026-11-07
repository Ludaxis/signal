// The Post maker engine (-4.8, 5.6-5.8): the actions Run, Regenerate (keep-contracts / allow-breaks, with
// retries, candidate versions and free adapters), Regenerate from here, Edit (with pause-for-edit during a run),
// Lock / Unlock, Use version, Skip / Unskip, Choose candidate, Continue / Raise cap / Stop, crash recovery and Resume
// (vendor jobs listed in pending.json are collected, never submitted twice).
// Every write action takes the recipe mutex `rc:<recipeId>`; a run takes it only around each commit, so an edit made
// during a run lands between steps. The store's own locks use `pm-*` keys, so the store is safe to call inside it.
// Spend: before every paid call the upper bound is reserved against the run cap, the project's day ceiling and the
// connector's own day cap (its record); a call that would pass any of them pauses the run
// before the node (`pausedFor: 'cap' | 'day-ceiling'`, the event names the limit) and reserves nothing.
// Re-estimate: once the script and the narration texts in the plan are done (the line counts voice and lip-sync cost
// from exist), the rest of the plan is estimated again. When the run uses the default cap of its confirmed estimate,
// the cap is raised to the default cap of the new total (spent so far + new upper bounds, × 1.25, rounded up to $0.50)
// but never above the project's day ceiling, and never lowered; a cap the person chose (or raised) is kept, so the
// run still pauses before an over-cap node. The event `run.reestimate` records both totals and both caps.
// No network here: executors are injected (the default registry is the real narration-text step plus fakes).
import { PostmakerError } from './errors';
import { buildContext } from './context';
import { assertEstimateToken, defaultCapUsd, estimatePlan } from './estimate';
import { defaultExecutors, implVersionsOf } from './executors';
import type { ExecEstimate, ExecInput, ExecResult, ExecUpstream, Executor, ExecutorRegistry } from './executors/types';
import { ADAPTERS, type AdapterArgs, type ScriptDoc } from './graph/adapters';
import { lineMsOf } from './executors/render-chain';
import type { FontFile } from './render/fonts';
import { checkRule, contractDiff } from './graph/contracts';
import { AGENT_KINDS, KINDS, LOCAL_CONNECTORS } from './graph/kinds';
import { acquireConnector, holdsRunSlot, PlanExecutor, takeRunSlot, type EditHold, type StartOutcome } from './graph/scheduler';
import { deriveStatus, gateStateOf, loadGraphState, outputsHash, type GraphState, type NodeStatus } from './graph/status';
import { topoOrder } from './graph/validate';
import { cacheKey, lookupCache, recordCache } from './store/cache';
import { commitVersion } from './store/commit';
import { lockStep, readHead, setCurrent, setSkipped, unlockStep, updateHead } from './store/heads';
import { DAY_CEILING_USD_DEFAULT, ledgerTotals, openReservations, release, reserve, settle } from './store/ledger';
import { withLock } from './store/mutex';
import { getJson, putBytes, putJson } from './store/objects';
import { newRunId } from './store/paths';
import { readPipeline, readRecipe, readRecipeIndex } from './store/recipes';
import { appendEvent, createRun, listRunIds, readPending, readRun, updateRun, writePending } from './store/runs';
import { listVersionNumbers, readVersion } from './store/versions';
import type {
  ArtifactRef,
  Contract,
  ContractDiff,
  ContractMode,
  Estimate,
  EventLine,
  GateId,
  Lang,
  PackLock,
  Pipeline,
  PipelineNode,
  ProjectLike,
  Recipe,
  Run,
  RunStep,
  Scope,
  SignOff,
  StepHead,
  StepVersion,
  StepVersionDraft,
} from './types';

export const recipeMutexKey = (recipeId: string) => `rc:${recipeId}`;

/** Voice may try 3 takes; agent steps get 2 retries; other steps run once (Q S2). */
const maxTakes = (kind: PipelineNode['kind']) => (kind === 'voice' ? 3 : AGENT_KINDS.has(kind) ? 3 : 1);

export interface EngineDeps {
  root: string;
  project: Pick<ProjectLike, 'id' | 'timeZone'>;
  executors?: ExecutorRegistry;
  /** Is a non-local connector switched on, keyed and allowed (`connectorAllowed`)? Default: none is. */
  allowed?: (connector: string, node: PipelineNode) => boolean;
  /** Sign-off records kept outside the version files. */
  signoffs?: (recipeId: string, nodeId: string) => Promise<SignOff[]>;
  /** The pack lock to compare against; default: the store's last pack lock. */
  packLock?: PackLock | null;
  /** Pack data agent steps may read (only the entries a kind reads go into the context). */
  pack?: { style?: Partial<Record<Lang, string>>; glossary?: unknown; lexicon?: unknown; brand?: unknown; claims?: unknown };
  dayCeilingUsd?: number;
  /**
   * The bundled faces the free adapters measure with: set when the real render chain runs, so
   * `captions.recompute` and `compose.rebuild` call builders. Default: none (the fakes' document functions).
   */
  adapterFonts?: () => FontFile[];
  /** The connector's own day cap (signal.config.json postmaker.dayCapUsd); null = none. Default: none. */
  connectorDayCapUsd?: (connector: string) => Promise<number | null> | number | null;
  /**
   * A repeat run's gate that its own records leave unsigned still lets paid steps below
   * it run when this answers true: the version is the very text or voice a named person passed on the template
   * (verified by origin hash in signoffs.ts). Only the daily run's repeat engine sets it; it writes no sign-off.
   */
  inheritedGate?: (recipeId: string, nodeId: string, gate: GateId, v: StepVersion) => Promise<boolean>;
  now?: () => number;
}

/** A simulated process kill (tests): the runner stops without writing anything more, like a real crash. */
export class CrashSignal extends Error {
  constructor() {
    super('simulated crash');
  }
}

interface Controller {
  runId: string;
  recipeId: string;
  plan: string[];
  executor: PlanExecutor | null;
  abort: AbortController;
  /** Stop was asked for: no new step or take starts; the step in progress finishes and settles its own spend. */
  stopRequested: boolean;
}

type G = typeof globalThis & { __signalPostmakerActive?: Map<string, Controller> };
const active = () => ((globalThis as G).__signalPostmakerActive ??= new Map());

/** Test hook: forget the in-process run controllers (simulates a restart; pair with `_resetSchedulerState`). */
export const _resetEngineState = () => void ((globalThis as G).__signalPostmakerActive = new Map());

export interface RunHandle {
  run: Run;
  done: Promise<Run>;
}

export type RegenerateResult =
  | { outcome: 'ok'; runId: string; version: number; diff: ContractDiff; adapted: string[]; outOfDate: string[] }
  | { outcome: 'contract-break'; runId: string; candidate: number; diff: ContractDiff; violations: string[] }
  | { outcome: 'paused'; runId: string; pausedFor: 'cap' | 'day-ceiling' | 'gate' }
  | { outcome: 'failed'; runId: string; error: string };

interface Produced {
  outputs: ArtifactRef[];
  data: Record<string, unknown>;
  result: ExecResult;
  seed: number;
  connector: string;
  mode: 'live' | 'mock';
  inputs: StepVersion['inputs'];
  key: string;
  packRefs: StepVersion['packRefs'];
  startedAt: number;
  endedAt: number;
  promptHash: string | null;
}

interface ExecCtx {
  runId: string;
  recipe: Recipe;
  pipeline: Pipeline;
  capUsd: () => number;
  signal: AbortSignal;
  steps: Map<string, RunStep>;
  by: string;
  stopped: () => boolean;
}

interface ExecOpts {
  regenerate?: { note: string | null; beats: string[] | null; mode: ContractMode; unchecked: string[] };
}

type NodeOutcome =
  | { kind: 'done'; version: number | null; produced?: Produced; adapted?: string[]; diff?: ContractDiff }
  | { kind: 'failed'; error: string }
  | { kind: 'needs-you'; error: string }
  | { kind: 'pause'; pausedFor: 'cap' | 'day-ceiling' | 'gate' }
  | { kind: 'contract-break'; candidate: number; diff: ContractDiff; violations: string[] };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class PostmakerEngine {
  readonly executors: ExecutorRegistry;
  constructor(private deps: EngineDeps) {
    this.executors = deps.executors ?? defaultExecutors({ check: { root: deps.root, signoffs: deps.signoffs } });
  }

  private now = () => (this.deps.now ? this.deps.now() : Date.now());
  private iso = () => new Date(this.now()).toISOString();
  private get root() {
    return this.deps.root;
  }

  // ---- reads -----------------------------------------------------------------------------------------------------

  /** The connector a node runs on: the first allowed entry of its chain; local entries are always allowed; else mock. */
  resolveConnector(node: PipelineNode): string {
    for (const c of node.connectorChain) {
      if (c === 'mock') return 'mock';
      if (LOCAL_CONNECTORS.has(c) || this.deps.allowed?.(c, node)) return c;
    }
    return 'mock';
  }

  private async pipelineOf(recipeId: string): Promise<Pipeline> {
    const p = await readPipeline(this.root, recipeId);
    if (!p) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
    return p;
  }

  private async recipeOf(recipeId: string): Promise<Recipe> {
    const r = await readRecipe(this.root, recipeId);
    if (!r) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
    return r;
  }

  /** Heads, current versions, pack lock and run overlay (queued/running/failed) of a recipe. */
  async state(recipeId: string, pipeline?: Pipeline, o: { overlay?: boolean } = {}): Promise<GraphState & { pipeline: Pipeline }> {
    const p = pipeline ?? (await this.pipelineOf(recipeId));
    const signoffs: SignOff[] = [];
    if (this.deps.signoffs) for (const n of p.nodes) signoffs.push(...(await this.deps.signoffs(recipeId, n.id)));
    const s = await loadGraphState(this.root, recipeId, {
      pipeline: p,
      implVersions: implVersionsOf(this.executors),
      connectorOff: (n) => this.resolveConnector(n) === 'mock',
      signoffs,
      ...(this.deps.packLock !== undefined ? { packLock: this.deps.packLock } : {}),
    });
    if (o.overlay !== false) s.running = await this.runOverlay(recipeId, s);
    return s;
  }

  async status(recipeId: string): Promise<Record<string, NodeStatus>> {
    return deriveStatus(await this.state(recipeId));
  }

  private async runOverlay(recipeId: string, s: GraphState): Promise<Record<string, 'queued' | 'running' | 'failed'>> {
    const out: Record<string, 'queued' | 'running' | 'failed'> = {};
    const ids = (await listRunIds(this.root)).reverse();
    const seen = new Set<string>();
    for (const id of ids.slice(0, 50)) {
      const run = await readRun(this.root, id);
      if (!run || run.recipeId !== recipeId) continue;
      for (const st of run.steps) {
        if (seen.has(st.nodeId)) continue;
        seen.add(st.nodeId);
        const live = (run.status === 'running' || run.status === 'stopped') && holdsRunSlot(run.id);
        if (live && (st.status === 'queued' || st.status === 'running')) out[st.nodeId] = st.status;
        else if (st.status === 'failed' && (s.heads[st.nodeId]?.current ?? null) === st.version) out[st.nodeId] = 'failed';
      }
    }
    return out;
  }

  private parentsOf = (p: Pipeline) => {
    const m = new Map(p.nodes.map((n) => [n.id, [...new Set(n.inputs.map((i) => i.from))]]));
    return (id: string) => m.get(id) ?? [];
  };

  private descendantsOf(p: Pipeline, id: string): string[] {
    const children = new Map<string, string[]>();
    for (const n of p.nodes) for (const i of n.inputs) children.set(i.from, [...(children.get(i.from) ?? []), n.id]);
    const out = new Set<string>();
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop()!;
      if (out.has(c)) continue;
      out.add(c);
      stack.push(...(children.get(c) ?? []));
    }
    const order = topoOrder(p.nodes).order;
    return order.filter((n) => out.has(n));
  }

  private ancestorsOf(p: Pipeline, id: string): string[] {
    const parents = this.parentsOf(p);
    const out = new Set<string>();
    const stack = [...parents(id)];
    while (stack.length) {
      const c = stack.pop()!;
      if (out.has(c)) continue;
      out.add(c);
      stack.push(...parents(c));
    }
    return [...out];
  }

  private scopeNodes(p: Pipeline, scope: Scope): string[] {
    if ('all' in scope) return p.nodes.map((n) => n.id);
    if ('nodes' in scope) {
      for (const id of scope.nodes) if (!p.nodes.some((n) => n.id === id)) throw new PostmakerError(404, 'not_found', `Unknown step ${id}.`);
      return scope.nodes;
    }
    if (!p.nodes.some((n) => n.id === scope.from)) throw new PostmakerError(404, 'not_found', `Unknown step ${scope.from}.`);
    return [scope.from, ...this.descendantsOf(p, scope.from)];
  }

  /** Run: every node in scope that is not run, off, failed or out of date, and not locked or skipped. */
  planRun(s: GraphState & { pipeline: Pipeline }, scope: string[]): string[] {
    const st = deriveStatus(s);
    const want = new Set(scope);
    return topoOrder(s.pipeline.nodes).order.filter((id) => {
      if (!want.has(id)) return false;
      const h = s.heads[id];
      const x = st[id]!;
      if (h?.locked || h?.skipped || x.missingInput) return false;
      return x.status === 'not-run' || x.status === 'off' || x.status === 'failed' || x.outOfDate;
    });
  }

  /** Regenerate from here: the node, then every unlocked, unskipped downstream node in order. */
  planFromHere(s: GraphState & { pipeline: Pipeline }, nodeId: string): string[] {
    return [nodeId, ...this.descendantsOf(s.pipeline, nodeId).filter((id) => !s.heads[id]?.locked && !s.heads[id]?.skipped)];
  }

  private async jsonPorts(v: StepVersion): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const o of v.outputs) if (o.kind === 'json' && !(o.port in out)) out[o.port] = await getJson(this.root, o.sha256, { verify: true });
    return out;
  }

  private async upstreamOf(node: PipelineNode, s: GraphState): Promise<{ ups: ExecUpstream[]; missing: string | null }> {
    const ups: ExecUpstream[] = [];
    for (const i of node.inputs) {
      const v = s.current[i.from] ?? null;
      const skipped = s.heads[i.from]?.skipped ?? false;
      if (!v || skipped) {
        if (i.required) return { ups, missing: `${i.from} has no output yet` };
        continue;
      }
      const refs = v.outputs.filter((o) => o.port === i.fromPort);
      const jsonRef = refs.find((o) => o.kind === 'json');
      ups.push({ port: i.port, nodeId: i.from, version: v, data: jsonRef ? await getJson(this.root, jsonRef.sha256, { verify: true }) : null, refs });
    }
    return { ups, missing: null };
  }

  private estimateNode(recipe: Recipe, node: PipelineNode, byPort: Record<string, unknown>, upstreamMock: boolean): ExecEstimate & { connector: string; mode: 'live' | 'mock' } {
    const connector = this.resolveConnector(node);
    const mode = connector === 'mock' || upstreamMock ? 'mock' : 'live';
    const e = this.executors[node.kind].estimate({ recipe, node, connector, mode, byPort });
    return { ...e, connector, mode };
  }

  /** the estimate of a plan (quantities from the current upstream outputs). */
  async estimate(recipeId: string, scope: Scope, o: { fromHere?: boolean; exact?: boolean } = {}): Promise<{ estimate: Estimate; plan: string[]; capUsd: number }> {
    const recipe = await this.recipeOf(recipeId);
    const s = await this.state(recipeId);
    // Run plans the stale nodes in scope; Regenerate (`exact`) costs exactly the nodes named; from-here its own plan.
    const plan = o.fromHere && 'from' in scope ? this.planFromHere(s, scope.from) : o.exact && 'nodes' in scope ? this.scopeNodes(s.pipeline, scope) : this.planRun(s, this.scopeNodes(s.pipeline, scope));
    const nodes = [];
    for (const id of plan) {
      const node = s.pipeline.nodes.find((n) => n.id === id)!;
      const { ups } = await this.upstreamOf(node, s);
      const byPort = Object.fromEntries(ups.map((u) => [u.port, u.data]));
      const e = this.estimateNode(recipe, node, byPort, ups.some((u) => u.version.mode === 'mock'));
      nodes.push({ nodeId: id, connector: e.connector, mode: e.mode, usdLow: e.usdLow, usdHigh: e.usdHigh, seconds: e.seconds, basis: e.basis, verified: e.verified, unknown: e.unknown });
    }
    const estimate = estimatePlan({ recipeId, plan, parents: this.parentsOf(s.pipeline), heads: s.heads, nodes });
    return { estimate, plan, capUsd: defaultCapUsd(estimate.usdHigh) };
  }

  // ---- runs ------------------------------------------------------------------------------------------------------

  private event(runId: string, e: Omit<EventLine, 'at'>): Promise<number> {
    return appendEvent(this.root, runId, { at: this.iso(), ...e });
  }

  /** Run: requires the token of the confirmed estimate; a third run in the project waits (`queued`). */
  /** `fixedCap` (the daily run): the cap is a budget's remainder and is never raised by the re-estimate. */
  async run(o: { recipeId: string; scope: Scope; capUsd?: number; estimateToken: string; trigger?: Run['trigger']; by?: string; attended?: boolean; fixedCap?: boolean }): Promise<RunHandle> {
    const { estimate, plan, capUsd } = await this.estimate(o.recipeId, o.scope);
    assertEstimateToken(estimate, o.estimateToken);
    return this.launch({ recipeId: o.recipeId, plan, scope: plan, estimate, capUsd: o.capUsd ?? capUsd, trigger: o.trigger ?? 'run', by: o.by ?? 'signal-postmaker', attended: o.attended ?? true, fixedCap: o.fixedCap });
  }

  /** Regenerate from here: the node, then every unlocked downstream node in order. */
  async regenerateFromHere(o: { recipeId: string; nodeId: string; note?: string; overwriteEdit?: boolean; capUsd?: number; estimateToken?: string; by?: string }): Promise<RunHandle> {
    const s = await this.state(o.recipeId);
    this.assertRegenerable(s, o.nodeId, o.overwriteEdit);
    const { estimate, plan, capUsd } = await this.estimate(o.recipeId, { from: o.nodeId }, { fromHere: true });
    if (o.estimateToken !== undefined) assertEstimateToken(estimate, o.estimateToken);
    return this.launch({
      recipeId: o.recipeId,
      plan,
      scope: plan,
      estimate,
      capUsd: o.capUsd ?? capUsd,
      trigger: 'regenerate-from-here',
      by: o.by ?? 'signal-postmaker',
      attended: true,
      regenerate: new Map([[o.nodeId, { note: o.note ?? null, beats: null, mode: 'allow-breaks' as const, unchecked: [] }]]),
    });
  }

  private assertRegenerable(s: GraphState & { pipeline: Pipeline }, nodeId: string, overwriteEdit?: boolean): PipelineNode {
    const node = s.pipeline.nodes.find((n) => n.id === nodeId);
    if (!node) throw new PostmakerError(404, 'not_found', 'Unknown step.');
    const h = s.heads[nodeId];
    if (h?.locked) throw new PostmakerError(409, 'locked', 'Unlock to regenerate');
    if (h?.skipped) throw new PostmakerError(409, 'skipped', 'This step is skipped.');
    if (s.current[nodeId]?.editedByUser && !overwriteEdit) throw new PostmakerError(409, 'edited', 'Edited by you. Confirm to replace your edit.');
    return node;
  }

  /**
   * Regenerate one step. `keep-contracts`: the new output must satisfy the downstream `expects`; free
   * adapters absorb changes within tolerance; a violation retries with the violation text, then saves a `candidate`
   * and answers `contract-break` with a diff, changing no head. `allow-breaks`: saved as current; the diff lists what
   * the change affects and those dependents become out of date.
   */
  async regenerate(o: { recipeId: string; nodeId: string; mode?: ContractMode; note?: string; beats?: string[]; uncheckedExpects?: string[]; overwriteEdit?: boolean; capUsd?: number; estimateToken?: string; by?: string; onStarted?: (runId: string) => void }): Promise<RegenerateResult> {
    const s = await this.state(o.recipeId);
    this.assertRegenerable(s, o.nodeId, o.overwriteEdit);
    const { estimate, capUsd } = await this.estimate(o.recipeId, { nodes: [o.nodeId] }, { exact: true });
    if (o.estimateToken !== undefined) assertEstimateToken(estimate, o.estimateToken);
    const outcomes = new Map<string, NodeOutcome>();
    const h = await this.launch({
      recipeId: o.recipeId,
      plan: [o.nodeId],
      scope: [o.nodeId],
      estimate,
      capUsd: o.capUsd ?? capUsd,
      trigger: 'regenerate',
      by: o.by ?? 'signal-postmaker',
      attended: true,
      regenerate: new Map([[o.nodeId, { note: o.note ?? null, beats: o.beats ?? null, mode: o.mode ?? 'keep-contracts', unchecked: o.uncheckedExpects ?? [] }]]),
      outcomes,
    });
    o.onStarted?.(h.run.id); //: the API answers 202 with this id while the step runs
    await h.done;
    const r = outcomes.get(o.nodeId);
    const runId = h.run.id;
    if (!r) return { outcome: 'failed', runId, error: 'The step did not run.' };
    if (r.kind === 'contract-break') return { outcome: 'contract-break', runId, candidate: r.candidate, diff: r.diff, violations: r.violations };
    if (r.kind === 'pause') return { outcome: 'paused', runId, pausedFor: r.pausedFor };
    if (r.kind === 'failed' || r.kind === 'needs-you') return { outcome: 'failed', runId, error: r.error };
    const after = deriveStatus(await this.state(o.recipeId));
    return { outcome: 'ok', runId, version: r.version!, diff: r.diff ?? [], adapted: r.adapted ?? [], outOfDate: Object.values(after).filter((x) => x.outOfDate).map((x) => x.nodeId) };
  }

  private async launch(o: {
    recipeId: string;
    plan: string[];
    scope: string[];
    estimate: Estimate;
    capUsd: number;
    trigger: Run['trigger'];
    by: string;
    attended: boolean;
    fixedCap?: boolean;
    regenerate?: Map<string, NonNullable<ExecOpts['regenerate']>>;
    outcomes?: Map<string, NodeOutcome>;
    existing?: Run;
  }): Promise<RunHandle> {
    const recipe = await this.recipeOf(o.recipeId);
    const pipeline = await this.pipelineOf(o.recipeId);
    const runId = o.existing?.id ?? newRunId(this.deps.project, this.now());
    // Every run on a fork records the template and variant it was made from (Accept reads the recipe's forkOf).
    const forkOf = o.existing ? null : ((await readRecipeIndex(this.root, o.recipeId))?.forkOf ?? null);
    const slot = takeRunSlot(runId, this.deps.project.id, o.recipeId);
    const steps = new Map<string, RunStep>(o.plan.map((id) => [id, { nodeId: id, version: null, status: 'queued', usd: 0, seconds: 0, mode: 'mock', error: null }]));
    let run: Run;
    if (o.existing) {
      run = await updateRun(this.root, runId, (r) => ({ ...r, status: slot.queued ? 'queued' : 'running', pausedFor: null, finishedAt: null, scope: { nodes: o.scope }, steps: mergeSteps(r.steps, steps) }));
    } else {
      run = await createRun(this.root, {
        schema: 'signal.pm.run/1',
        id: runId,
        recipeId: o.recipeId,
        templateId: forkOf?.templateId ?? null,
        variantId: forkOf?.variantId ?? null,
        trigger: o.trigger,
        scope: { nodes: o.scope },
        startedAt: this.iso(),
        finishedAt: null,
        by: o.by,
        capUsd: o.capUsd,
        spentUsd: 0,
        reservedUsd: 0,
        estimate: o.estimate,
        status: slot.queued ? 'queued' : 'running',
        pausedFor: null,
        steps: [...steps.values()],
        packageIds: [],
        attended: o.attended,
      });
    }
    const ctrl: Controller = { runId, recipeId: o.recipeId, plan: o.plan, executor: null, abort: new AbortController(), stopRequested: false };
    active().set(runId, ctrl);
    let cap = run.capUsd;
    const ctx: ExecCtx = { runId, recipe, pipeline, capUsd: () => cap, signal: ctrl.abort.signal, steps, by: o.by, stopped: () => ctrl.stopRequested };
    const crashed = () => ctrl.abort.signal.reason instanceof CrashSignal;
    // Re-estimate once after the script (and the narration texts it feeds) when the plan writes a script.
    const kindOf = (id: string) => pipeline.nodes.find((n) => n.id === id)?.kind;
    const textSteps = o.plan.includes('script') ? o.plan.filter((id) => kindOf(id) === 'script' || kindOf(id) === 'narration-text') : [];
    let reestimated = textSteps.length === 0;

    const done = (async (): Promise<Run> => {
      try {
        await slot.ready;
        if (slot.queued && !ctrl.stopRequested) await updateRun(this.root, runId, (r) => (r.status === 'stopped' ? r : { ...r, status: 'running' }));
        await this.event(runId, { kind: 'run.started', text: `${o.plan.length} steps`, data: { trigger: o.trigger, nodes: o.plan } });
        for (const id of o.plan) await this.event(runId, { kind: 'step.queued', nodeId: id });
        const exec = new PlanExecutor(o.plan, {
          parents: this.parentsOf(pipeline),
          start: async (id): Promise<StartOutcome> => {
            if (crashed()) throw ctrl.abort.signal.reason;
            cap = (await readRun(this.root, runId))?.capUsd ?? cap;
            const r = await this.execNode(ctx, id, { regenerate: o.regenerate?.get(id) });
            o.outcomes?.set(id, r);
            if (!reestimated && r.kind === 'done' && textSteps.includes(id) && textSteps.every((x) => steps.get(x)?.status === 'done')) {
              reestimated = true;
              cap = await this.reestimate(ctx, o.plan, o.estimate, cap, id, o.fixedCap === true);
            }
            if (r.kind === 'pause') return { pause: r.pausedFor };
            return r.kind === 'done' || r.kind === 'contract-break' ? 'done' : r.kind;
          },
        });
        ctrl.executor = exec;
        if (ctrl.stopRequested) exec.stop(); // stopped while it waited for a run slot: nothing starts
        const res = await exec.execute();
        if (crashed()) return run;
        const stopped = res.stopped || ctrl.stopRequested;
        // Every step has finished and settled its own reservation; anything still open never made a call.
        if (stopped) await this.closeReservations(o.recipeId, runId);
        const totals = await ledgerTotals(this.root, { project: this.deps.project, runId, now: this.now() });
        const status: Run['status'] = stopped ? 'stopped' : res.pause ? 'needs-you' : res.failed.length ? 'failed' : res.needsYou.length ? 'needs-you' : 'done';
        for (const id of [...res.pausedForEdit, ...res.notStarted]) {
          const st = steps.get(id)!;
          if (st.status === 'queued' || st.status === 'running') steps.set(id, { ...st, status: 'queued' });
        }
        const final = await updateRun(this.root, runId, (r) => ({
          ...r,
          status,
          pausedFor: stopped ? null : (res.pause ?? (res.needsYou.length ? 'check' : null)),
          finishedAt: status === 'needs-you' ? null : this.iso(),
          spentUsd: totals.run?.spentUsd ?? 0,
          reservedUsd: totals.run?.reservedUsd ?? 0,
          steps: mergeSteps(r.steps, steps),
        }));
        if (res.pause && !stopped) await this.event(runId, { kind: 'run.paused', nodeId: res.pausedAt ?? undefined, text: pauseText(res.pause), data: { pausedFor: res.pause, held: res.pausedForEdit } });
        else await this.event(runId, { kind: 'run.done', text: status });
        return final;
      } catch (e) {
        if (crashed()) return run;
        throw e;
      } finally {
        if (!crashed()) {
          slot.release();
          active().delete(runId);
        }
      }
    })();
    return { run, done };
  }

  /**
   * The re-estimate after the script (see the header): done steps count at what they cost, the others at a fresh
   * upper bound from the outputs that exist now. Raises the run cap within the day ceiling; returns the cap in force.
   */
  private async reestimate(ctx: ExecCtx, plan: string[], confirmed: Estimate, cap: number, after: string, fixedCap = false): Promise<number> {
    const s = await this.state(ctx.recipe.id, ctx.pipeline, { overlay: false });
    let spent = 0;
    let rest = 0;
    const nodes: { nodeId: string; usdHigh: number; basis: string }[] = [];
    for (const id of plan) {
      const st = ctx.steps.get(id);
      if (st && st.status !== 'queued' && st.status !== 'running') {
        spent += Math.round(st.usd * 1e6);
        continue;
      }
      const node = ctx.pipeline.nodes.find((n) => n.id === id);
      if (!node) continue;
      const { ups } = await this.upstreamOf(node, s);
      const e = this.estimateNode(ctx.recipe, node, Object.fromEntries(ups.map((u) => [u.port, u.data])), ups.some((u) => u.version.mode === 'mock'));
      rest += Math.round(e.usdHigh * 1e6);
      nodes.push({ nodeId: id, usdHigh: e.usdHigh, basis: e.basis });
    }
    const usdHigh = (spent + rest) / 1e6;
    const ceiling = this.deps.dayCeilingUsd ?? DAY_CEILING_USD_DEFAULT;
    const wanted = defaultCapUsd(usdHigh);
    const chosen = fixedCap || cap !== defaultCapUsd(confirmed.usdHigh);
    const capUsd = chosen || wanted <= cap ? cap : Math.max(cap, Math.min(wanted, ceiling));
    if (capUsd !== cap) await updateRun(this.root, ctx.runId, (r) => ({ ...r, capUsd: Math.max(r.capUsd, capUsd) }));
    await this.event(ctx.runId, {
      kind: 'run.reestimate',
      nodeId: after,
      text: capUsd > cap ? `Cap raised to $${capUsd.toFixed(2)}` : 'Cap unchanged',
      data: { usdHighBefore: confirmed.usdHigh, usdHighAfter: usdHigh, spentUsd: spent / 1e6, capBefore: cap, capAfter: capUsd, wantedCapUsd: wanted, dayCeilingUsd: ceiling, chosenCap: chosen, limitedByDayCeiling: !chosen && wanted > capUsd, nodes },
    });
    return capUsd;
  }

  /** Test hook: kill a run the way a process crash would (nothing more is written; slots stay held). */
  _crash(runId: string): void {
    active().get(runId)?.abort.abort(new CrashSignal());
  }

  /** Continue run: re-derives the plan inside the run's scope and runs it under the same id. */
  async continueRun(runId: string): Promise<RunHandle> {
    const run = await readRun(this.root, runId);
    if (!run) throw new PostmakerError(404, 'not_found', 'Unknown run.');
    if (active().has(runId)) throw new PostmakerError(409, 'running', 'This run is still going.');
    if (run.status === 'done' || run.status === 'stopped') throw new PostmakerError(409, 'finished', 'This run has finished.');
    const s = await this.state(run.recipeId);
    const plan = this.planRun(s, run.scope.nodes);
    return this.launch({ recipeId: run.recipeId, plan, scope: run.scope.nodes, estimate: run.estimate, capUsd: run.capUsd, trigger: run.trigger, by: run.by, attended: true, existing: run });
  }

  /** Resume after a restart: same as Continue; pending vendor jobs are collected, never submitted again. */
  resume(runId: string): Promise<RunHandle> {
    return this.continueRun(runId);
  }

  async raiseCap(runId: string, capUsd: number): Promise<Run> {
    return updateRun(this.root, runId, (r) => {
      if (!(capUsd > r.capUsd)) throw new PostmakerError(400, 'validation', 'The new cap must be higher.');
      return { ...r, capUsd };
    });
  }

  /**
   * Stop: no new step or retry starts. A step in progress finishes, settles its own reservation at
   * the real cost and is saved; the run's completion then writes `stopped` with `finishedAt` and closes what is left.
   * A run that is not going (paused, failed) is closed at once.
   */
  async stopRun(runId: string): Promise<Run> {
    const run = await readRun(this.root, runId);
    if (!run) throw new PostmakerError(404, 'not_found', 'Unknown run.');
    if (run.status === 'done' || run.status === 'stopped') throw new PostmakerError(409, 'finished', 'This run has finished.');
    const c = active().get(runId);
    if (c) {
      c.stopRequested = true;
      c.executor?.stop();
      return updateRun(this.root, runId, (r) => ({ ...r, status: 'stopped', pausedFor: null }));
    }
    await this.closeReservations(run.recipeId, runId);
    const totals = await ledgerTotals(this.root, { project: this.deps.project, runId, now: this.now() });
    const final = await updateRun(this.root, runId, (r) => ({ ...r, status: 'stopped', pausedFor: null, finishedAt: this.iso(), spentUsd: totals.run?.spentUsd ?? r.spentUsd, reservedUsd: totals.run?.reservedUsd ?? 0 }));
    await this.event(runId, { kind: 'run.done', text: 'stopped' });
    return final;
  }

  /**
   * Closes the open reservations of a run that no step is working on: one whose vendor job was submitted (listed in
   * pending.json) is settled at its upper bound, because the call may be billed; the others never made a call and
   * are released.
   */
  private async closeReservations(recipeId: string, runId: string): Promise<void> {
    const open = await openReservations(this.root, runId);
    for (const r of open) {
      const pending = await readPending(this.root, recipeId, r.nodeId);
      if (pending?.jobs.length) {
        const st = await settle(this.root, r.id, { usd: 0, known: false, note: 'stopped with a vendor job pending', now: this.now() });
        await this.event(runId, { kind: 'ledger.settle', nodeId: r.nodeId, data: { id: r.id, usd: st.usd, known: false } });
      } else {
        await release(this.root, r.id, { now: this.now() });
      }
    }
  }

  /** On start: a run left `running`/`queued` that this process does not hold was interrupted. */
  async recoverInterrupted(): Promise<string[]> {
    const out: string[] = [];
    for (const id of await listRunIds(this.root)) {
      const run = await readRun(this.root, id);
      if (!run || (run.status !== 'running' && run.status !== 'queued') || holdsRunSlot(id) || active().has(id)) continue;
      await updateRun(this.root, id, (r) => ({
        ...r,
        status: 'failed',
        finishedAt: this.iso(),
        steps: r.steps.map((st) => (st.status === 'running' || st.status === 'queued' ? { ...st, status: st.status === 'running' ? 'failed' : st.status, error: st.status === 'running' ? 'Signal stopped while this run was going' : st.error } : st)),
      }));
      await this.event(id, { kind: 'run.done', text: 'Signal stopped while this run was going' });
      out.push(id);
    }
    return out;
  }

  // ---- one node ----------------------------------------------------------------------------------------------------

  private setStep(ctx: ExecCtx, id: string, patch: Partial<RunStep>): Promise<Run> {
    if (ctx.signal.reason instanceof CrashSignal) return Promise.reject(ctx.signal.reason);
    const st = { ...ctx.steps.get(id)!, ...patch };
    ctx.steps.set(id, st);
    return updateRun(this.root, ctx.runId, (r) => ({ ...r, steps: mergeSteps(r.steps, new Map([[id, st]])) }));
  }

  private async gateBlocks(p: Pipeline, s: GraphState, recipeId: string, nodeId: string): Promise<string | null> {
    for (const a of this.ancestorsOf(p, nodeId)) {
      const n = p.nodes.find((x) => x.id === a)!;
      if (n.gate?.blocks !== 'before-paid-downstream') continue;
      const g = gateStateOf(n, s.current[a] ?? null, s.signoffs);
      if (g?.signed) continue;
      const v = s.current[a] ?? null;
      if (v && n.gate && this.deps.inheritedGate && (await this.deps.inheritedGate(recipeId, a, n.gate.id, v))) continue;
      return a;
    }
    return null;
  }

  private packRefsFor(node: PipelineNode, lock: PackLock | null): StepVersion['packRefs'] {
    if (!lock) return [];
    const wanted: string[] = [];
    if (node.kind === 'narration-text' && node.lang) wanted.push(`lexicon:${node.lang}`, 'glossary');
    if (node.kind === 'script' || node.kind === 'post-copy') wanted.push(...Object.keys(lock.entries).filter((k) => k.startsWith('style:')), 'brand');
    return wanted.filter((r) => r in lock.entries).map((ref) => ({ ref, sha256: lock.entries[ref]! }));
  }

  private async execNode(ctx: ExecCtx, nodeId: string, o: ExecOpts): Promise<NodeOutcome> {
    const crashed = () => ctx.signal.reason instanceof CrashSignal;
    const p = ctx.pipeline;
    const node = p.nodes.find((n) => n.id === nodeId)!;
    const s = await this.state(ctx.recipe.id, p, { overlay: false });
    if (s.heads[nodeId]?.locked) {
      await this.setStep(ctx, nodeId, { status: 'done', version: s.heads[nodeId]!.current, error: null });
      return { kind: 'done', version: s.heads[nodeId]!.current };
    }
    const { ups, missing } = await this.upstreamOf(node, s);
    if (missing) {
      await this.setStep(ctx, nodeId, { status: 'needs-you', error: 'missing input' });
      return { kind: 'needs-you', error: missing };
    }
    const ex = this.executors[node.kind];
    const prev = s.current[nodeId] ?? null;
    const regen = o.regenerate;
    const byPort = Object.fromEntries(ups.map((u) => [u.port, u.data]));
    const est = this.estimateNode(ctx.recipe, node, byPort, ups.some((u) => u.version.mode === 'mock'));
    const { connector, mode } = est;
    const packRefs = this.packRefsFor(node, s.packLock);
    const inputs = ups.map((u) => ({ port: u.port, nodeId: u.nodeId, version: u.version.n, hash: u.version.hash }));
    const baseSeed = regen ? (prev?.provenance.seed ?? 0) + 1 : (prev?.provenance.seed ?? 1);
    const keyOf = (seed: number) =>
      cacheKey({ kind: node.kind, implVersion: ex.implVersion, connector, model: null, voiceId: null, settings: {}, params: node.params, inputs: inputs.map((i) => [i.port, i.hash]), packRefs, seed: ex.deterministic ? null : seed });

    // Run reuses an unchanged version; a deterministic node reuses any version with the same key.
    if (!regen) {
      const key = keyOf(baseSeed);
      if (prev && prev.key === key && prev.status === 'ok') {
        await this.event(ctx.runId, { kind: 'cache.hit', nodeId, data: { version: prev.n } });
        await this.setStep(ctx, nodeId, { status: 'done', version: prev.n, mode: prev.mode, error: null });
        return { kind: 'done', version: prev.n };
      }
      if (ex.deterministic) {
        const hit = await lookupCache(this.root, key);
        if (hit && hit.recipeId === ctx.recipe.id && hit.nodeId === nodeId) {
          await withLock(recipeMutexKey(ctx.recipe.id), () => setCurrent(this.root, ctx.recipe.id, nodeId, hit.version, { now: this.now() }));
          await this.event(ctx.runId, { kind: 'cache.hit', nodeId, data: { version: hit.version } });
          await this.setStep(ctx, nodeId, { status: 'done', version: hit.version, mode, error: null });
          return { kind: 'done', version: hit.version };
        }
      }
    }

    const paid = mode === 'live' && est.usdHigh > 0;
    if (paid) {
      const gate = await this.gateBlocks(p, s, ctx.recipe.id, nodeId);
      if (gate) {
        await this.event(ctx.runId, { kind: 'gate.waiting', nodeId, text: `Waiting for the sign-off of ${gate}` });
        return { kind: 'pause', pausedFor: 'gate' };
      }
    }

    const pending = ex.job ? await readPending(this.root, ctx.recipe.id, nodeId) : null;
    let pendingJob = pending?.jobs[0] ?? null;
    const reserveTake = async (): Promise<{ id: string | null } | { pause: 'cap' | 'day-ceiling'; limit: string }> => {
      if (!paid) return { id: null };
      if (pendingJob) {
        const open = (await openReservations(this.root, ctx.runId)).find((r) => r.nodeId === nodeId);
        if (open) return { id: open.id };
      }
      const connectorDayCapUsd = (await this.deps.connectorDayCapUsd?.(connector)) ?? null;
      const r = await reserve(this.root, { project: this.deps.project, runId: ctx.runId, nodeId, connector, usd: est.usdHigh, runCapUsd: ctx.capUsd(), dayCeilingUsd: this.deps.dayCeilingUsd, connectorDayCapUsd, now: this.now() });
      if (!r.ok) return { pause: r.pausedFor, limit: r.limit };
      await this.event(ctx.runId, { kind: 'ledger.reserve', nodeId, data: { id: r.id, usd: est.usdHigh } });
      return { id: r.id };
    };

    const releaseSlot = await acquireConnector(connector);
    let reservation: string | null = null;
    const takes = regen?.mode === 'keep-contracts' ? maxTakes(node.kind) : 1;
    let violations: string[] = [];
    let produced: Produced | null = null;
    let failures: { dependent: string; ruleId: string; text: string }[] = [];
    try {
      const prevData = prev ? await this.jsonPorts(prev) : null;
      const pinned = s.heads[nodeId]?.pinnedBeats ?? [];
      for (let take = 1; take <= takes; take++) {
        if (take > 1 && ctx.stopped()) break; // Stop: no new paid take; the last one is kept as a candidate
        const r = await reserveTake();
        if ('pause' in r) {
          await this.event(ctx.runId, { kind: 'run.paused', nodeId, text: pauseText(r.pause), data: { pausedFor: r.pause, limit: r.limit, connector, usdHigh: est.usdHigh } });
          return { kind: 'pause', pausedFor: r.pause };
        }
        reservation = r.id;
        if (take === 1) {
          await this.setStep(ctx, nodeId, { status: 'running', mode, error: null });
          await this.event(ctx.runId, { kind: 'step.started', nodeId, data: { connector, mode } });
        }
        const seed = baseSeed + take - 1;
        const context = AGENT_KINDS.has(node.kind) ? this.contextFor(node, ups, prev, regen?.note ?? null, violations, pinned, prevData) : null;
        if (context?.truncated.length) await this.event(ctx.runId, { kind: 'context.truncated', nodeId, data: { cut: context.truncated, chars: context.chars } });
        const input: ExecInput = {
          recipe: ctx.recipe,
          node,
          lang: node.lang,
          inputs: ups,
          byPort,
          params: node.params,
          seed,
          mode,
          connector,
          note: regen?.note ?? null,
          beats: regen?.beats ?? null,
          pinnedBeats: pinned,
          previous: prev && prevData ? { version: prev, data: prevData } : null,
          violations,
          take,
          context: context?.bundle ?? null,
          runId: ctx.runId,
          now: this.now,
          signal: ctx.signal,
        };
        const startedAt = this.now();
        let result: ExecResult;
        if (ex.job) {
          if (!pendingJob) {
            await this.event(ctx.runId, { kind: 'connector.request', nodeId, data: { connector } });
            const { requestId } = await ex.job!.submit(input);
            pendingJob = { connector, requestId, submittedAt: this.iso(), idempotencyKey: `${ctx.runId}:${nodeId}:${take}` };
            // Written right after the vendor accepted the job: from here on, Resume collects instead of submitting.
            await writePending(this.root, ctx.recipe.id, nodeId, { schema: 'signal.pm.pending/1', runId: ctx.runId, nodeId, jobs: [pendingJob] });
          }
          result = await ex.job!.collect(pendingJob.requestId, input);
          if (crashed()) throw ctx.signal.reason;
          await writePending(this.root, ctx.recipe.id, nodeId, { schema: 'signal.pm.pending/1', runId: ctx.runId, nodeId, jobs: [] });
          pendingJob = null;
          await this.event(ctx.runId, { kind: 'connector.response', nodeId, data: { connector } });
        } else {
          result = await ex.run(input);
        }
        if (crashed()) throw ctx.signal.reason;
        if (reservation) {
          const known = result.costUsd !== null;
          const st = await settle(this.root, reservation, { usd: known ? result.costUsd! : 0, known, now: this.now() });
          await this.event(ctx.runId, { kind: 'ledger.settle', nodeId, data: { id: reservation, usd: st.usd, known } });
          reservation = null;
        }
        produced = await this.produce(node, result, { prevData, pinned, ex, seed, connector, mode, inputs, packRefs, startedAt, key: keyOf(seed), prompt: context?.bundle ?? null });
        if (regen?.mode !== 'keep-contracts') break;
        failures = await this.violations(ctx.recipe.id, p, s, nodeId, produced.result.provides, regen.unchecked);
        if (!failures.length) break;
        violations = failures.map((f) => f.text);
      }
    } catch (e) {
      if (crashed()) throw e;
      if (reservation) await settle(this.root, reservation, { usd: 0, known: false, now: this.now() }).catch(() => undefined); // a started call is counted at its upper bound
      const error = e instanceof Error ? e.message : String(e);
      await this.setStep(ctx, nodeId, { status: 'failed', version: prev?.n ?? null, error });
      await this.event(ctx.runId, { kind: 'step.failed', nodeId, text: error });
      return { kind: 'failed', error };
    } finally {
      releaseSlot();
    }
    if (!produced) return { kind: 'failed', error: 'No output.' };

    if (crashed()) throw ctx.signal.reason;
    const candidate = regen?.mode === 'keep-contracts' && failures.length > 0;
    const status = candidate ? 'candidate' : (produced.result.status ?? 'ok');
    const committed = await withLock(recipeMutexKey(ctx.recipe.id), async () => {
      const draft = await this.draftOf(ctx, node, produced!, { status, source: regen ? 'regenerate' : 'run', note: regen?.note ?? null });
      return commitVersion(this.root, draft, { now: this.now() });
    }).catch(async (e) => {
      const error = e instanceof Error ? e.message : String(e);
      await this.setStep(ctx, nodeId, { status: 'failed', version: prev?.n ?? null, error });
      await this.event(ctx.runId, { kind: 'step.failed', nodeId, text: error });
      return null;
    });
    if (!committed) return { kind: 'failed', error: 'Could not save the step.' };
    const v = committed.version;
    if (v.status === 'ok') await recordCache(this.root, { key: v.key, recipeId: v.recipeId, nodeId, version: v.n, hash: v.hash, at: v.createdAt });
    const usd = round6(produced.result.costUsd ?? (paid ? est.usdHigh : 0));
    await this.setStep(ctx, nodeId, { status: v.status === 'failed' ? 'failed' : v.status === 'needs-you' ? 'needs-you' : 'done', version: v.n, usd, seconds: v.seconds, mode, error: null });
    await this.event(ctx.runId, { kind: 'step.done', nodeId, data: { version: v.n, status: v.status } });

    if (candidate) {
      const diff = await this.candidateDiff(ctx.recipe.id, p, s, nodeId, prev, v);
      return { kind: 'contract-break', candidate: v.n, diff, violations: failures.map((f) => f.text) };
    }
    if (v.status === 'needs-you') return { kind: 'needs-you', error: 'Needs you' };
    if (regen?.mode === 'keep-contracts') {
      const adapted = await this.runAdapters(ctx.recipe.id, p, [nodeId], regen.unchecked, ctx.runId);
      return { kind: 'done', version: v.n, produced, adapted, diff: prev ? contractDiff(prev.provides, v.provides, this.dependentsByKey(p, nodeId)) : [] };
    }
    if (regen?.mode === 'allow-breaks') return { kind: 'done', version: v.n, produced, diff: prev ? contractDiff(prev.provides, v.provides, this.dependentsByKey(p, nodeId)) : [] };
    return { kind: 'done', version: v.n, produced };
  }

  private contextFor(node: PipelineNode, ups: ExecUpstream[], prev: StepVersion | null, note: string | null, violations: string[], pinned: string[], prevData: Record<string, unknown> | null) {
    const pinnedBeats = node.kind === 'script' && prevData?.script ? (prevData.script as ScriptDoc).beats.filter((b) => pinned.includes(b.id)) : [];
    const pack = this.deps.pack ?? {};
    return buildContext({
      task: `${KINDS[node.kind].title}.${node.instructions ? `\n${node.instructions}` : ''}${violations.length ? `\nKeep these: ${violations.join('. ')}` : ''}`,
      node: { id: node.id, kind: node.kind, lang: node.lang, params: node.params },
      upstream: ups.map((u) => ({ port: u.port, nodeId: u.nodeId, version: u.version.n, hash: u.version.hash, locked: false, data: u.data, files: [] })),
      downstream: [],
      neighbours: null,
      pinned: pinnedBeats,
      history: prev ? [{ version: prev.n, note: prev.note, editedByUser: prev.editedByUser, diffSummary: '' }] : [],
      rubric: [],
      pack: {
        ...(node.lang && pack.style?.[node.lang] ? { style: pack.style[node.lang] } : {}),
        ...(node.kind === 'script' || node.kind === 'post-copy' ? { claims: pack.claims, brand: pack.brand, glossary: pack.glossary } : {}),
      },
      untrusted: { userNotes: note ? [note] : [] },
      outputSpec: `${KINDS[node.kind].outputs.join(', ')} as JSON`,
    });
  }

  /** Stores the outputs as objects; for `script`, pinned beats and their lines are restored byte for byte. */
  private async produce(
    node: PipelineNode,
    result: ExecResult,
    o: { prevData: Record<string, unknown> | null; pinned: string[]; ex: Executor; seed: number; connector: string; mode: 'live' | 'mock'; inputs: StepVersion['inputs']; packRefs: StepVersion['packRefs']; startedAt: number; key: string; prompt: unknown },
  ): Promise<Produced> {
    let outputs = result.outputs;
    let provides = result.provides;
    if (node.kind === 'script' && o.pinned.length && o.prevData?.script) {
      const prev = o.prevData.script as ScriptDoc;
      const out = outputs.find((x) => x.port === 'script');
      if (out) {
        const doc = out.data as ScriptDoc;
        const pin = new Set(o.pinned);
        const beats = doc.beats.map((b) => (pin.has(b.id) ? (prev.beats.find((x) => x.id === b.id) ?? b) : b));
        const lines = [...prev.lines.filter((l) => pin.has(l.beatId)), ...doc.lines.filter((l) => !pin.has(l.beatId))];
        const order = new Map(beats.map((b, i) => [b.id, i]));
        lines.sort((a, b) => (order.get(a.beatId) ?? 0) - (order.get(b.beatId) ?? 0) || (a.id < b.id ? -1 : 1));
        const fixed: ScriptDoc = { ...doc, beats, lines };
        outputs = outputs.map((x) => (x === out ? { ...x, data: fixed } : x));
        provides = o.ex.contractOf ? o.ex.contractOf({ script: fixed }, node) : provides;
      }
    }
    const refs: ArtifactRef[] = [];
    const data: Record<string, unknown> = {};
    for (const x of outputs) {
      const put = x.bytes ? await putBytes(this.root, x.bytes) : await putJson(this.root, x.data);
      if (!x.bytes && !(x.port in data)) data[x.port] = x.data;
      refs.push({ port: x.port, name: x.name, kind: x.kind, mime: x.mime, ...(x.lang ? { lang: x.lang } : {}), sha256: put.sha256, bytes: put.bytes, ...(x.meta ? { meta: x.meta } : {}) });
    }
    const promptHash = o.prompt ? (await putJson(this.root, o.prompt)).sha256 : null;
    return { outputs: refs, data, result: { ...result, provides }, seed: o.seed, connector: o.connector, mode: o.mode, inputs: o.inputs, key: o.key, packRefs: o.packRefs, startedAt: o.startedAt, endedAt: this.now(), promptHash };
  }

  private async draftOf(ctx: { recipe: Recipe; by: string; runId: string }, node: PipelineNode, p: Produced, o: { status: StepVersion['status']; source: StepVersion['source']; note: string | null }): Promise<StepVersionDraft> {
    const n = ((await listVersionNumbers(this.root, ctx.recipe.id, node.id)).at(-1) ?? 0) + 1;
    const contentHash = outputsHash({ outputs: p.outputs });
    const signoffs: SignOff[] = (p.result.signoffs ?? []).map((x) => ({ ...x, version: n, hash: contentHash }));
    if (node.gate && (node.gate.id === 'fa-native-editor' || node.gate.id === 'fa-native-listener') && p.mode === 'mock' && !signoffs.some((x) => x.gate === node.gate!.id)) {
      signoffs.push({ gate: node.gate.id, nodeId: node.id, version: n, hash: contentHash, by: 'mock', name: 'mock', at: new Date(p.endedAt).toISOString(), verdict: 'pass' });
    }
    const ex = this.executors[node.kind];
    return {
      recipeId: ctx.recipe.id,
      nodeId: node.id,
      createdAt: new Date(p.endedAt).toISOString(),
      source: o.source,
      runId: ctx.runId,
      key: p.key,
      implVersion: ex.implVersion,
      inputs: p.inputs,
      packRefs: p.packRefs,
      params: node.params,
      outputs: p.outputs,
      provides: p.result.provides,
      checks: p.result.checks ?? [],
      provenance: {
        executor: p.connector === 'mock' ? 'local' : LOCAL_CONNECTORS.has(p.connector) ? 'local' : AGENT_KINDS.has(node.kind) ? p.connector : 'connector',
        connector: p.connector,
        mode: p.mode,
        model: p.result.model ?? null,
        tool: null,
        requests: p.result.requests ?? [],
        seed: p.seed,
        prompt: p.promptHash,
        startedAt: new Date(p.startedAt).toISOString(),
        endedAt: new Date(p.endedAt).toISOString(),
        by: ctx.by,
      },
      cost: { actualUsd: p.result.costUsd, upperBoundUsd: null },
      seconds: Math.max(0, Math.round((p.endedAt - p.startedAt) / 100) / 10),
      mode: p.mode,
      note: o.note,
      editedByUser: false,
      status: o.status,
      signoffs,
    };
  }

  // ---- contracts and adapters ----------------------------------------------------------------------------------

  private dependentsByKey(p: Pipeline, nodeId: string): (key: string) => string[] {
    const deps = p.nodes.filter((n) => n.inputs.some((i) => i.from === nodeId));
    return (key) => {
      const top = key.split('.')[0];
      const withRule = deps.filter((n) => n.expects.some((r) => r.from === nodeId && r.key === top));
      return (withRule.length ? withRule : deps).map((n) => n.id);
    };
  }

  /** keep-contracts validation: the downstream rules a new contract of `nodeId` breaks. */
  private async violations(recipeId: string, p: Pipeline, s: GraphState, nodeId: string, after: Contract, unchecked: string[]): Promise<{ dependent: string; ruleId: string; text: string }[]> {
    const out: { dependent: string; ruleId: string; text: string }[] = [];
    for (const d of p.nodes) {
      const rules = d.expects.filter((r) => r.from === nodeId && !unchecked.includes(r.id));
      if (!rules.length) continue;
      const cv = s.current[d.id];
      if (!cv || s.heads[d.id]?.skipped) continue;
      const rec = cv.inputs.find((i) => i.nodeId === nodeId);
      const before = rec ? (await readVersion(this.root, recipeId, nodeId, rec.version))?.provides : undefined;
      if (!before) continue;
      for (const r of rules) {
        if (r.adapter && ADAPTERS[r.adapter]?.follows) continue;
        const res = checkRule(r, before, after);
        if (!res.ok) out.push({ dependent: d.id, ruleId: r.id, text: res.text });
      }
    }
    return out;
  }

  /** The diff a candidate would cause: its own contract changes plus what the free adapters would change next. */
  private async candidateDiff(recipeId: string, p: Pipeline, s: GraphState, nodeId: string, prev: StepVersion | null, cand: StepVersion): Promise<ContractDiff> {
    const diff = prev ? contractDiff(prev.provides, cand.provides, this.dependentsByKey(p, nodeId)) : [];
    const candData = await this.jsonPorts(cand);
    for (const d of p.nodes) {
      const rule = d.expects.find((r) => r.from === nodeId && r.adapter && ADAPTERS[r.adapter]);
      const cv = s.current[d.id];
      if (!rule || !cv) continue;
      const inputs: Record<string, unknown> = {};
      for (const i of d.inputs) {
        if (i.from === nodeId) inputs[i.port] = candData[i.fromPort] ?? null;
        else {
          const v = s.current[i.from];
          const ref = v?.outputs.find((x) => x.port === i.fromPort && x.kind === 'json');
          inputs[i.port] = ref ? await getJson(this.root, ref.sha256) : null;
        }
      }
      try {
        const predicted = ADAPTERS[rule.adapter!]!.run(await this.adapterArgs(recipeId, d, await this.jsonPorts(cv), inputs, { seed: cv.provenance.seed, mock: cv.mode === 'mock' }));
        for (const e of contractDiff(cv.provides, predicted.provides, this.dependentsByKey(p, d.id))) if (!diff.some((x) => x.key === e.key)) diff.push(e);
      } catch {
        // a prediction that cannot run adds nothing; the candidate's own diff stands
      }
    }
    return diff;
  }

  /**
   * Runs the free adapters downstream of `changed`: a dependent is adapted when an adapter rule names one of
   * its changed inputs, every input that changed comes from a node changed or adapted here, and every rule
   * from a changed input passes (rules of "follows" adapters are absorbed). Locked and skipped nodes are never touched.
   * `runId` is the run whose step triggered the adapters (null after a plain Edit); it is recorded on each version.
   */
  async runAdapters(recipeId: string, p: Pipeline, changed: string[], unchecked: string[] = [], runId: string | null = null): Promise<string[]> {
    const done = new Set(changed);
    const adapted: string[] = [];
    for (const id of topoOrder(p.nodes).order) {
      if (done.has(id)) continue;
      const d = p.nodes.find((n) => n.id === id)!;
      const adapterRule = d.expects.find((r) => r.adapter && ADAPTERS[r.adapter]);
      if (!adapterRule) continue;
      const r = await withLock(recipeMutexKey(recipeId), async () => {
        const s = await this.state(recipeId, p, { overlay: false });
        const head = s.heads[id];
        const cv = s.current[id];
        if (!cv || head?.locked || head?.skipped || cv.status !== 'ok') return null;
        const changedIn = cv.inputs.filter((i) => s.current[i.nodeId]?.hash !== i.hash);
        if (!changedIn.length || changedIn.some((i) => !done.has(i.nodeId))) return null;
        // the adapter absorbs changes of the inputs it is declared for: at least one changed input must carry it
        if (!changedIn.some((i) => d.expects.some((x) => x.from === i.nodeId && x.adapter && ADAPTERS[x.adapter]))) return null;
        // ...and none of the changed inputs may arrive on a port the adapter cannot absorb (mix: the voice stems)
        const absorbs = ADAPTERS[adapterRule.adapter!]!.absorbs;
        if (absorbs && changedIn.some((i) => !absorbs.includes(i.port))) return null;
        if (d.inputs.some((i) => i.required && !cv.inputs.some((x) => x.port === i.port))) return null;
        for (const i of changedIn) {
          for (const rule of d.expects.filter((x) => x.from === i.nodeId)) {
            if (unchecked.includes(rule.id)) return null;
            if (rule.adapter && ADAPTERS[rule.adapter]?.follows) continue;
            const before = (await readVersion(this.root, recipeId, i.nodeId, i.version))?.provides ?? {};
            if (!checkRule(rule, before, s.current[i.nodeId]!.provides).ok) return null;
          }
        }
        const { ups, missing } = await this.upstreamOf(d, s);
        if (missing) return null;
        const inputs = Object.fromEntries(ups.map((u) => [u.port, u.data]));
        const currentData = await this.jsonPorts(cv);
        const lineageMode = ups.some((u) => u.version.mode === 'mock') ? 'mock' : cv.mode;
        const out = ADAPTERS[adapterRule.adapter!]!.run(await this.adapterArgs(recipeId, d, currentData, inputs, { seed: cv.provenance.seed, mock: lineageMode === 'mock', lineMs: lineMsOf(ups) }));
        const refs: ArtifactRef[] = [];
        for (const o of cv.outputs) {
          if (o.kind === 'json' && o.port in out.data) {
            const put = await putJson(this.root, out.data[o.port]);
            refs.push({ ...o, sha256: put.sha256, bytes: put.bytes });
          } else refs.push(o);
        }
        const inputsRec = ups.map((u) => ({ port: u.port, nodeId: u.nodeId, version: u.version.n, hash: u.version.hash }));
        const mode = ups.some((u) => u.version.mode === 'mock') ? 'mock' : cv.mode;
        const ex = this.executors[d.kind];
        const now = this.iso();
        const key = cacheKey({ kind: d.kind, implVersion: ex.implVersion, connector: `adapter:${adapterRule.adapter}`, model: null, voiceId: null, settings: {}, params: d.params, inputs: inputsRec.map((i) => [i.port, i.hash]), packRefs: cv.packRefs, seed: null });
        const n = ((await listVersionNumbers(this.root, recipeId, id)).at(-1) ?? 0) + 1;
        const contentHash = outputsHash({ outputs: refs });
        const draft: StepVersionDraft = {
          recipeId,
          nodeId: id,
          createdAt: now,
          source: 'adapt',
          runId,
          key,
          implVersion: ex.implVersion,
          inputs: inputsRec,
          packRefs: cv.packRefs,
          params: d.params,
          outputs: refs,
          provides: { ...cv.provides, ...out.provides },
          checks: out.checks ?? cv.checks,
          provenance: { executor: 'local', connector: `adapter:${adapterRule.adapter}`, mode, model: null, tool: null, requests: [], seed: null, prompt: null, startedAt: now, endedAt: now, by: 'signal-postmaker' },
          cost: { actualUsd: 0, upperBoundUsd: 0 },
          seconds: 0,
          mode,
          note: null,
          editedByUser: false,
          status: out.checks?.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
          signoffs: cv.signoffs.filter((x) => x.by === 'mock').map((x) => ({ ...x, version: n, hash: contentHash })),
        };
        return commitVersion(this.root, draft, { now: this.now() });
      });
      if (r) {
        done.add(id);
        adapted.push(id);
      }
    }
    return adapted;
  }

  /** What an adapter reads beside the documents: the recipe, the bundled faces, params, seed, mock, lineMs. */
  private async adapterArgs(recipeId: string, node: PipelineNode, current: Record<string, unknown>, inputs: Record<string, unknown>, o: { seed: number | null; mock: boolean; lineMs?: Record<string, number> }): Promise<AdapterArgs> {
    const fonts = this.deps.adapterFonts?.();
    return {
      node,
      current,
      inputs,
      ...(fonts?.length ? { fonts, recipe: await this.recipeOf(recipeId) } : {}),
      params: node.params,
      seed: o.seed ?? 1,
      mock: o.mock,
      ...(o.lineMs ? { lineMs: o.lineMs } : {}),
    };
  }

  // ---- step actions ------------------------------------------------------------------------------------------------

  private async nodeOf(recipeId: string, nodeId: string): Promise<{ p: Pipeline; node: PipelineNode }> {
    const p = await this.pipelineOf(recipeId);
    const node = p.nodes.find((n) => n.id === nodeId);
    if (!node) throw new PostmakerError(404, 'not_found', 'Unknown step.');
    return { p, node };
  }

  /**
   * Edit: writes version n+1 `source: 'edit'`, `editedByUser: true`; free adapters run; during a run the
   * steps downstream of the edited one are paused after the step in progress finishes.
   */
  async edit(o: { recipeId: string; nodeId: string; baseVersion: number; output: { json?: Record<string, unknown> }; by: string }): Promise<{ version: StepVersion; adapted: string[]; paused: string[] }> {
    const { p, node } = await this.nodeOf(o.recipeId, o.nodeId);
    // Held before the write (a descendant must not start on the old output meanwhile); a refused edit lifts the hold.
    const holds = this.pauseForEdit(o.recipeId, p, o.nodeId);
    const paused = holds.flatMap((h) => h.held);
    let version: StepVersion;
    try {
      version = await withLock(recipeMutexKey(o.recipeId), async () => {
      const head = await readHead(this.root, o.recipeId, o.nodeId);
      if (head.current !== o.baseVersion) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
      const prev = await readVersion(this.root, o.recipeId, o.nodeId, o.baseVersion);
      if (!prev) throw new PostmakerError(404, 'version-missing', 'That version does not exist.');
      const data = { ...(await this.jsonPorts(prev)), ...(o.output.json ?? {}) };
      const refs: ArtifactRef[] = [];
      for (const x of prev.outputs) {
        if (x.kind === 'json' && o.output.json && x.port in o.output.json) {
          const put = await putJson(this.root, o.output.json[x.port]);
          refs.push({ ...x, sha256: put.sha256, bytes: put.bytes });
        } else refs.push(x);
      }
      const ex = this.executors[node.kind];
      const provides = ex.contractOf ? ex.contractOf(data, node) : prev.provides;
      const now = this.iso();
      return (
        await commitVersion(
          this.root,
          {
            ...stripVersion(prev),
            createdAt: now,
            source: 'edit',
            runId: null,
            key: cacheKey({ kind: node.kind, implVersion: ex.implVersion, connector: 'edit', model: null, voiceId: null, settings: {}, params: node.params, inputs: prev.inputs.map((i) => [i.port, i.hash]), packRefs: prev.packRefs, seed: Date.parse(now) }),
            outputs: refs,
            provides,
            provenance: { ...prev.provenance, executor: 'local', connector: 'edit', model: null, requests: [], prompt: null, startedAt: now, endedAt: now, by: o.by },
            cost: { actualUsd: 0, upperBoundUsd: 0 },
            seconds: 0,
            note: null,
            editedByUser: true,
            status: 'ok',
            signoffs: [],
          },
          { now: this.now() },
        )
      ).version;
      });
    } catch (e) {
      for (const h of holds) h.settle(false);
      throw e;
    }
    for (const h of holds) h.settle(true);
    const adapted = await this.runAdapters(o.recipeId, p, [o.nodeId]);
    return { version, adapted, paused };
  }

  /** Holds the edited node and its not-yet-started descendants in the recipe's active run until the edit settles. */
  private pauseForEdit(recipeId: string, p: Pipeline, nodeId: string): EditHold[] {
    const holds: EditHold[] = [];
    for (const c of active().values()) {
      if (c.recipeId !== recipeId || !c.executor) continue;
      holds.push(c.executor.hold([nodeId, ...this.descendantsOf(p, nodeId)]));
    }
    return holds;
  }

  private headAction<T>(recipeId: string, fn: () => Promise<T>): Promise<T> {
    return withLock(recipeMutexKey(recipeId), fn);
  }

  async lock(recipeId: string, nodeId: string, by: string): Promise<StepHead> {
    await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, () => lockStep(this.root, recipeId, nodeId, by, this.now()));
  }

  async unlock(recipeId: string, nodeId: string): Promise<StepHead> {
    await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, () => unlockStep(this.root, recipeId, nodeId, this.now()));
  }

  async skip(recipeId: string, nodeId: string, skipped = true): Promise<StepHead> {
    await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, () => setSkipped(this.root, recipeId, nodeId, skipped, this.now()));
  }

  /** Use this version: moves the pointer; dependents whose recorded input differs become out of date. */
  async useVersion(recipeId: string, nodeId: string, version: number): Promise<StepHead> {
    await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, async () => {
      const head = await readHead(this.root, recipeId, nodeId);
      if (head.locked) throw new PostmakerError(409, 'locked', 'Unlock to change the version.');
      return setCurrent(this.root, recipeId, nodeId, version, { now: this.now() });
    });
  }

  async setPinnedBeats(recipeId: string, nodeId: string, beats: string[]): Promise<StepHead> {
    await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, () => updateHead(this.root, recipeId, nodeId, { pinnedBeats: beats }, { now: this.now() }));
  }

  /** Choose candidate: accept makes it current with allow-breaks semantics (and returns the diff); discard keeps it as history. */
  async chooseCandidate(recipeId: string, nodeId: string, version: number, accept: boolean): Promise<{ head: StepHead; diff: ContractDiff }> {
    const { p } = await this.nodeOf(recipeId, nodeId);
    return this.headAction(recipeId, async () => {
      const v = await readVersion(this.root, recipeId, nodeId, version);
      if (!v || v.status !== 'candidate') throw new PostmakerError(404, 'not_found', 'Unknown candidate.');
      const head = await readHead(this.root, recipeId, nodeId);
      if (!accept) return { head, diff: [] };
      if (head.locked) throw new PostmakerError(409, 'locked', 'Unlock to regenerate');
      const prev = head.current ? await readVersion(this.root, recipeId, nodeId, head.current) : null;
      const next = await setCurrent(this.root, recipeId, nodeId, version, { now: this.now(), allowCandidate: true });
      return { head: next, diff: prev ? contractDiff(prev.provides, v.provides, this.dependentsByKey(p, nodeId)) : [] };
    });
  }
}

function stripVersion(v: StepVersion): Omit<StepVersionDraft, 'createdAt'> {
  const { schema: _s, n: _n, hash: _h, createdAt: _c, ...rest } = v;
  void _s;
  void _n;
  void _h;
  void _c;
  return rest;
}

function mergeSteps(old: RunStep[], next: Map<string, RunStep>): RunStep[] {
  const out = old.map((s) => next.get(s.nodeId) ?? s);
  for (const [id, s] of next) if (!old.some((x) => x.nodeId === id)) out.push(s);
  return out;
}

/**
 * Run bar texts of a pause, one per `pausedFor`. "Needs you · cap reached" and "Paused for your edit" are the screen's
 * dictionary's; the day-limit and sign-off phrases follow its "Needs you · <reason>" form (as "Needs you · missing
 * input") and are not in the dictionary yet. shows them through app/studio/copy/en.ts, keyed by `pausedFor`.
 */
export const PAUSE_TEXT: Record<'cap' | 'day-ceiling' | 'gate' | 'edit', string> = {
  cap: 'Needs you · cap reached',
  'day-ceiling': 'Needs you · day limit reached',
  gate: 'Needs you · waiting for a sign-off',
  edit: 'Paused for your edit',
};

const pauseText = (p: keyof typeof PAUSE_TEXT): string => PAUSE_TEXT[p];
