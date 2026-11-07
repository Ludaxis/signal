// The Post maker API service (-7.3): one engine per request on the project's store, the action dispatcher behind
// POST /api/studio/postmaker, and the read models (home, RecipeView, RunView). Routes stay thin: auth, origin,
// project and body parsing happen there; everything that touches the store happens here.
// Long actions (make-it, run, step.regenerate*, run.continue) answer 202 with the run id at once and keep running in
// this process; the UI polls GET runs/[id]. A run that finishes with the check done waits at Proof: it is written
// `needs-you` with `pausedFor: 'check'` until Accept.
// No network and no vendor call happens here: connectors are only live when switched on, keyed and allowed.
// The executors are wired in wiring.ts: script and post-copy, check, render chain (when Remotion
// is installed for the render child; fakes otherwise), the real narration-text step. Make it / Analyse read the
// reference with analyse (mock mode: beats at the detected cuts, $0); its detected text is stored under
// refs/<id>/, never in the recipe.
// The template actions (Make a post, variants, Repeat settings, skip-proof, campaign attach, duplicate,
// retire) answer through template-actions.ts; Make a post forks the template and starts its run like Make it.
import { agentBilling } from '../claude-agent';
import { getCampaign, markSlotMade } from '../campaigns';
import { campaignAction, duplicateAction, makePostFork, retireAction, saveVariantAction, setRepeatAction, setSkipProofAction, templateCard, templateOfRecipe, type TemplateCard } from './template-actions';
import { templateSummary, type TemplateLimits } from './template-rules';
import { connectorAllowed, connectorById, connectorRows, CONNECTORS, vendorDayCapUsd } from './connectors';
import { postmakerPaused } from './connectors/features';
import { PostmakerError } from './errors';
import { acceptProof, type AcceptResult } from './accept';
import { readManualScore, runVerdictOf, scoreProof, withManual } from './manual-score';
import { connectorCall, type AgentCall } from './executors/agent';
import { analyseReference, recipeFields, type AnalyseTools } from './executors/analyse';
import type { ExecutorRegistry } from './executors/types';
import type { RegisteredConnector } from './connectors/base';
import type { LlmRequest, LlmResult } from './connectors/cli';
import { resolveFonts } from './render/fonts';
import { defaultRenderChain, type RenderChain } from './render/renderer';
import { serviceExecutors } from './wiring';
import { campaignSlotHolder, recipeStillMaking, recordCampaignSlot, SLOT_TAKEN_TEXT } from './repeat-state';
import { buildPipeline, facesOf, type BuildOptions } from './graph/build';
import { LOCAL_CONNECTORS } from './graph/kinds';
import { deriveStatus } from './graph/status';
import { edgesOf, validatePipeline } from './graph/validate';
import { loadProjectPack } from './pack/load';
import { packPolicy } from './pack/policy';
import { readReference, referenceSource, saveDetectedText } from './references';
import { readUpload } from './uploads';
import { mergeBeat } from './regenerate-beat';
import { PostmakerEngine, type RunHandle } from './runner';
import { inheritedSignOff, readSignOffs, recordSignOff, signoffsDep } from './signoffs';
import { proofProjections } from './checks/proof';
import { listDir, pretty, readJsonFile, writeReplace } from './store/fs';
import { withLock } from './store/mutex';
import { NODE_ID_RE, notesFile, objectPath, postmakerRoot, recipeDir } from './store/paths';
import { createRecipe, listRecipeIds, openStore, readPipeline, readRecipe, readRecipeIndex, writePipelineVersion, writeRecipeVersion, type RecipeDraft } from './store/recipes';
import { appendEvent, listRunIds, readEvents, readRun, updateRun } from './store/runs';
import { listTemplates } from './store/templates';
import { listVersions, readVersion } from './store/versions';
import { getJson } from './store/objects';
import type { ArtifactRef, CheckResult, ConnectorRow, GateId, GraphOp, Pipeline, PipelineNode, PmNote, PostmakerAction, ProjectLike, ProofProjection, Recipe, RecipeOnlyView, RecipeView, RecipeViewNode, Reference, RoutesDoc, Run, RunView, Scope, StepVersion, TemplateSummary } from './types';
import { projectTimeZone } from '../time';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- dependencies (tests inject fakes here; production uses the defaults) -------------------------------------

export interface DeconstructInput {
  reference: Reference;
  options: { languages: Recipe['languages']; lengthSec: number; shape: Recipe['shape']; campaignId?: string | null; capUsd?: number; stopAfterRecipe?: boolean };
  project: ServiceProject;
  /* * `recipe.regenerate-beat`: the beat read again and the person's note (untrusted data for the agent). */
  beat?: { id: string; note: string | null };
}
/** Turns a reference into a recipe draft (the `analyse` step; deconstructor replaces the mock default). */
export type Deconstruct = (i: DeconstructInput) => Promise<Omit<RecipeDraft, 'projectId' | 'referenceId'>>;

export interface ServiceDeps {
  executors?: ExecutorRegistry;
  /** Overrides the connector liveness decision (tests flag stub connectors live). */
  allowed?: (connector: string, node: PipelineNode) => boolean;
  deconstruct?: Deconstruct;
  buildOptions?: (recipe: Recipe) => Promise<BuildOptions> | BuildOptions;
  dayCeilingUsd?: number;
  /** Overrides each connector's own day cap (default: its record, read at each reservation). */
  connectorDayCapUsd?: (connector: string) => Promise<number | null> | number | null;
  now?: () => number;
  /** The render child chain; undefined = defaultRenderChain() (null when Remotion is not installed); null = fakes. */
  render?: RenderChain | null;
  /** ffmpeg tools for the analyse pre-processing (tests inject an allow-listed spawn). */
  analyseTools?: AnalyseTools;
  /** What every template can make; default the core builder's limits. */
  templateLimits?: TemplateLimits;
}

type G = typeof globalThis & { __signalPostmakerServiceDeps?: ServiceDeps };
const deps = (): ServiceDeps => (globalThis as G).__signalPostmakerServiceDeps ?? {};
/** Test hook: inject fakes for the next requests (pass {} to reset). */
export const _setServiceDeps = (d: ServiceDeps) => void ((globalThis as G).__signalPostmakerServiceDeps = d);

export type ServiceProject = Pick<ProjectLike, 'id' | 'contentDir' | 'timeZone' | 'pack'> & { handle: string };
export interface Actor {
  email: string;
}

export const rootOf = (p: Pick<ProjectLike, 'contentDir'>) => postmakerRoot(p);

/** The liveness of every registered connector, decided once per request (connectorAllowed is async). */
async function allowedNow(attended: boolean): Promise<Map<string, Awaited<ReturnType<typeof connectorAllowed>>>> {
  const m = new Map<string, Awaited<ReturnType<typeof connectorAllowed>>>();
  for (const c of CONNECTORS) m.set(c.id, await connectorAllowed(c, { attended }));
  return m;
}

/** A registered connector's day cap from signal.config.json (postmaker.dayCapUsd); null when none is set. */
const connectorDayCap = async (id: string): Promise<number | null> => {
  const c = connectorById(id);
  return c ? vendorDayCapUsd(c) : null;
};

/** An attended-only connector (Codex, a browser agent): never live in a run nobody pressed. */
export const attendedOnlyConnector = (id: string): boolean => id === 'codex' || id.startsWith('browser-agent') || CONNECTORS.find((c) => c.id === id)?.attendance === 'attended-only';

/**
 * The engine for one request.: `attended: false` is the daily run's engine: connectors are decided for an
 * unattended run and an attended-only connector is never live, whatever a test hook says; `inheritGates` lets a
 * repeat run's paid steps go on below a gate a named person passed on the template (signoffs.ts).
 */
export async function engineFor(project: ServiceProject, o: { attended?: boolean; inheritGates?: boolean } = {}): Promise<{ engine: PostmakerEngine; root: string; decisions: Map<string, Awaited<ReturnType<typeof connectorAllowed>>> }> {
  const root = rootOf(project);
  await openStore(root);
  const d = deps();
  const attended = o.attended ?? true;
  const decisions = await allowedNow(attended);
  const base = d.allowed ?? ((c: string) => decisions.get(c)?.live ?? false);
  const policy = d.executors ? null : await packPolicy(project, root);
  const render = d.executors ? null : d.render === undefined ? defaultRenderChain() : d.render;
  const engine = new PostmakerEngine({
    root,
    project: { id: project.id, timeZone: project.timeZone },
    executors: d.executors ?? serviceExecutors({ root, render, billing: await agentBilling(), pack: policy }),
    // Ruling 8: with the real render chain, the free adapters rebuild captions and the timeline with builders.
    ...(render ? { adapterFonts: () => resolveFonts().fonts } : {}),
    ...(policy?.claims ? { pack: { claims: policy.claims } } : {}),
    allowed: attended ? base : (c, n) => !attendedOnlyConnector(c) && base(c, n),
    signoffs: signoffsDep(root),
    ...(o.inheritGates ? { inheritedGate: async (_recipeId: string, _nodeId: string, gate: GateId, v: StepVersion) => (await inheritedSignOff(root, v, gate)) !== null } : {}),
    ...(d.dayCeilingUsd !== undefined ? { dayCeilingUsd: d.dayCeilingUsd } : {}),
    connectorDayCapUsd: d.connectorDayCapUsd ?? connectorDayCap,
    ...(d.now ? { now: d.now } : {}),
  });
  return { engine, root, decisions };
}

/**
 * The mock deconstruction (offline, $0): an evenly timed hook / story / demo / end-card structure with no text, so a
 * mock run reaches Proof without inventing copy. deconstructor replaces it through `ServiceDeps.deconstruct`.
 */
export const mockDeconstruct: Deconstruct = async ({ options }) => {
  const len = options.lengthSec;
  const cuts = [0, Math.round(len * 0.2), Math.round(len * 0.55), Math.round(len * 0.85), len];
  const segs = ['hook', 'story', 'demo', 'endcard'] as const;
  return {
    campaignId: options.campaignId ?? null,
    packId: null,
    languages: options.languages,
    lengthSec: len,
    shape: options.shape,
    fps: 30,
    capUsd: options.capUsd ?? 0,
    beats: segs.map((segment, i) => ({ id: `b0${i + 1}`, start: cuts[i]!, end: cuts[i + 1]!, segment, name: segment, purpose: '', visual: '', techniques: [], onScreenText: Object.fromEntries(options.languages.map((l) => [l, ''])), audio: '', motion: '' })),
    style: { captions: 'word-pop', pace: 'fast', palette: [], type: 'display', voice: 'narrator', music: 'library' },
    assets: [],
    tempo: null,
    evidence: { sheets: [], cuts: cuts.slice(1, -1), silences: [], loudnessLufs: null },
    stopAfterRecipe: options.stopAfterRecipe ?? false,
  };
};

/** Plain note stored beside the reference when a live read could not use vision (no spend, no hard failure). */
export const VISION_FALLBACK_NOTE = 'Read on this computer only: reading the video with Claude needs its security review first.';

/** Whether the claude-cli connector may run vision now (its llm.vision capability carries no pending review). */
export function connectorCanSee(c: Pick<RegisteredConnector<LlmRequest, LlmResult>, 'capabilities'> | null): boolean {
  const v = c?.capabilities.find((x) => x.id === 'llm.vision');
  return !!v && !/security review/i.test(String(v.limits?.status ?? ''));
}

const visionRefused = (e: unknown) => e instanceof PostmakerError && e.status === 403 && /vision/i.test(e.message);

/**
 * analyse as the deconstruction: a dropped video is pre-processed on this computer (cuts, contact sheets, audio
 * stats) and read by the deconstructor (live: the claude-cli connector, vision envelope; mock: beats at the detected
 * cuts). Until vision passes its security review the read stays on this computer (mock, $0) even when the connector is
 * live, and a vision refusal falls back the same way; the note is stored beside the reference. Detected text goes to
 * refs/<id>/. Images, links and pages have no video to read and use the even mock structure.
 */
export function analyseDeconstruct(o: { root: string; live: boolean; vision?: boolean; call: AgentCall | null; tools?: AnalyseTools }): Deconstruct {
  return async (input) => {
    const { reference, options } = input;
    const src = reference.kind === 'video' ? referenceSource(o.root, reference) : null;
    if (!src) return mockDeconstruct(input);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-pm-analyse-'));
    try {
      const userNotes = input.beat?.note ? [input.beat.note] : undefined;
      const read = (mode: 'live' | 'mock') => analyseReference({ src, workDir, languages: options.languages, lengthSec: options.lengthSec, shape: options.shape, mode, call: o.call, root: o.root, tools: o.tools, ...(userNotes ? { userNotes } : {}) });
      let note: string | null = o.live && o.vision === false ? VISION_FALLBACK_NOTE : null;
      let r;
      if (o.live && !note) {
        try {
          r = await read('live');
        } catch (e) {
          if (!visionRefused(e)) throw e;
          note = VISION_FALLBACK_NOTE;
        }
      }
      r ??= await read('mock');
      await saveDetectedText(o.root, reference.id, r.detectedText, Date.now(), note);
      return { campaignId: options.campaignId ?? null, packId: null, languages: options.languages, lengthSec: options.lengthSec, shape: options.shape, fps: 30, capUsd: options.capUsd ?? 0, ...recipeFields(r), stopAfterRecipe: options.stopAfterRecipe ?? false };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  };
}

async function defaultDeconstruct(root: string): Promise<Deconstruct> {
  const cli = connectorById('claude-cli') as RegisteredConnector<LlmRequest, LlmResult> | null;
  const live = cli ? (await connectorAllowed(cli, { attended: true })).live : false;
  const call = cli ? connectorCall(cli, { runId: 'postmaker', nodeId: 'analyse', workDir: os.tmpdir(), onEvent: () => {}, idempotencyKey: `pm-${randomBytes(6).toString('hex')}`, deps: {} }) : null;
  return analyseDeconstruct({ root, live, vision: connectorCanSee(cli), call, tools: deps().analyseTools });
}

async function buildOptionsFor(project: ServiceProject, root: string, recipe: Recipe): Promise<BuildOptions> {
  const d = deps();
  if (d.buildOptions) return d.buildOptions(recipe);
  try {
    const pack = await loadProjectPack(project, root);
    return pack ? { faces: facesOf(pack.library) } : {};
  } catch {
    return {}; // a pack problem is shown on the pack screen; the default pipeline still builds
  }
}

// ---- Proof --------------------------------------------------------------------------------------------

export const AT_PROOF_TEXT = 'This run is at Proof. Accept it or regenerate a step.';

/** A run that finished with the check done waits at Proof until Accept. */
export async function markAtProof(root: string, run: Run): Promise<Run> {
  const check = run.steps.find((s) => s.nodeId === 'check');
  if (run.status !== 'done' || !check || check.status !== 'done' || run.packageIds.length) return run;
  const next = await updateRun(root, run.id, (r) => (r.status === 'done' && r.packageIds.length === 0 ? { ...r, status: 'needs-you', pausedFor: 'check', finishedAt: null } : r));
  if (next.status === 'needs-you') await appendEvent(root, run.id, { at: new Date().toISOString(), kind: 'gate.waiting', nodeId: 'check', text: 'Proof' });
  return next;
}

function watch(root: string, h: RunHandle): void {
  void h.done.then((run) => markAtProof(root, run)).catch((e: unknown) => console.error('[postmaker] run', h.run.id, e instanceof Error ? e.name : 'error'));
}

// ---- pipeline.edit (GraphOp) -----------------------------------------------------------------------------------

/** Applies graph ops in order to a copy of the pipeline; the result is validated by the caller (validatePipeline). */
export function applyGraphOps(p: Pick<Pipeline, 'nodes'>, ops: GraphOp[]): Pick<Pipeline, 'nodes' | 'edges'> {
  const nodes: PipelineNode[] = p.nodes.map((n) => ({ ...n }));
  const at = (id: string) => {
    const i = nodes.findIndex((n) => n.id === id);
    if (i < 0) throw new PostmakerError(404, 'not_found', `Unknown step ${id}.`);
    return i;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        if (nodes.some((n) => n.id === op.node.id)) throw new PostmakerError(400, 'validation', `${op.node.id} appears twice.`);
        const attendance = op.node.connectorChain.some((c) => CONNECTORS.find((x) => x.id === c)?.attendance === 'attended-only') ? 'attended-only' : 'any';
        nodes.splice(at(op.after) + 1, 0, { ...op.node, attendance });
        break;
      }
      case 'remove':
        nodes.splice(at(op.nodeId), 1);
        break;
      case 'move': {
        const [n] = nodes.splice(at(op.nodeId), 1);
        nodes.splice(at(op.after) + 1, 0, n!);
        break;
      }
      case 'set-params':
        nodes[at(op.nodeId)] = { ...nodes[at(op.nodeId)]!, params: op.params };
        break;
      case 'set-connector-chain': {
        const n = nodes[at(op.nodeId)]!;
        const attendance = op.chain.some((c) => CONNECTORS.find((x) => x.id === c)?.attendance === 'attended-only') ? 'attended-only' : 'any';
        nodes[at(op.nodeId)] = { ...n, connectorChain: op.chain, attendance };
        break;
      }
      case 'set-instructions':
        nodes[at(op.nodeId)] = { ...nodes[at(op.nodeId)]!, instructions: op.text };
        break;
    }
  }
  return { nodes, edges: edgesOf(nodes) };
}

// ---- read models -----------------------------------------------------------------------------------------------

export interface PostmakerHome {
  recipes: { id: string; referenceId: string | null; languages: Recipe['languages']; lengthSec: number; shape: Recipe['shape']; pipeline: number | null; forkOf: { templateId: string; variantId: string | null } | null; updatedAt: string }[];
  /** With variants, per-variant streaks, skip-proof and the Repeat settings. */
  templates: TemplateSummary[];
  /** Per template id, what its card and the Proven screen show (steps, cost and time of its proof, cover). */
  templateCards?: Record<string, TemplateCard>;
  runs: (Pick<Run, 'id' | 'recipeId' | 'templateId' | 'trigger' | 'status' | 'pausedFor' | 'startedAt' | 'finishedAt' | 'spentUsd' | 'packageIds'> & {
    stepsDone: number;
    stepsTotal: number;
    /** sha256 of the run's first rendered cover (render's `cover` port), for Today's thumbnail; null without one. */
    cover: string | null;
  })[];
  connectors: ConnectorRow[];
  paused: boolean;
  /** The project's IANA time zone: Runs, drafts and Today show dates in it. */
  timeZone: string;
  /**
   * Pipelines a move would take (`postmaker.migrate`), and the move Undo would revert (null: none).
   * `kept` counts the live pipelines a move leaves (they make posts from a template).
   */
  migration?: { pending: number; kept?: number; undo: string | null };
}

export async function home(project: ServiceProject): Promise<PostmakerHome> {
  const root = rootOf(project);
  const recipes: PostmakerHome['recipes'] = [];
  for (const id of (await listRecipeIds(root)).reverse().slice(0, 50)) {
    const index = await readRecipeIndex(root, id).catch(() => null);
    const r = index ? await readRecipe(root, id).catch(() => null) : null;
    if (!index || !r) continue;
    recipes.push({ id, referenceId: r.referenceId, languages: r.languages, lengthSec: r.lengthSec, shape: r.shape, pipeline: index.pipeline, forkOf: index.forkOf, updatedAt: index.updatedAt });
  }
  const runs: PostmakerHome['runs'] = [];
  const full: Run[] = [];
  for (const id of (await listRunIds(root)).reverse().slice(0, 20)) {
    const r = await readRun(root, id).catch(() => null);
    if (r) full.push(r);
    if (r) runs.push({ id: r.id, recipeId: r.recipeId, templateId: r.templateId, trigger: r.trigger, status: r.status, pausedFor: r.pausedFor, startedAt: r.startedAt, finishedAt: r.finishedAt, spentUsd: r.spentUsd, packageIds: r.packageIds, stepsDone: r.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length, stepsTotal: r.steps.length, cover: await coverOf(root, r) });
  }
  const stored = await listTemplates(root);
  const templates = stored.map(templateSummary);
  const templateCards: Record<string, TemplateCard> = {};
  for (const t of stored) templateCards[t.id] = await templateCard(root, t, full);
  const moves = await (await import('./migrate/pipelines')).pendingPipelines(project).catch(() => ({ pending: [] as string[], kept: [] as string[], undo: null }));
  return { recipes, templates, templateCards, runs, connectors: await connectorRows({ attended: true }), paused: postmakerPaused(), timeZone: projectTimeZone(project.timeZone), migration: { pending: moves.pending.length, kept: moves.kept.length, undo: moves.undo } };
}

/** The first rendered cover of a run that waits for the person (Today › Needs you shows it); null otherwise. */
async function coverOf(root: string, r: Run): Promise<string | null> {
  const waits = (r.status === 'needs-you' && r.packageIds.length === 0) || r.status === 'failed';
  if (!waits) return null;
  for (const st of r.steps) {
    if (!st.nodeId.startsWith('render') || st.version === null) continue;
    const v = await readVersion(root, r.recipeId, st.nodeId, st.version).catch(() => null);
    const ref = v?.outputs.find((o) => o.port === 'cover' && o.kind === 'image');
    if (ref) return ref.sha256;
  }
  return null;
}

async function latestRunOf(root: string, recipeId: string): Promise<Run | null> {
  for (const id of (await listRunIds(root)).reverse()) {
    const r = await readRun(root, id).catch(() => null);
    if (r?.recipeId === recipeId) return r;
  }
  return null;
}

export async function recipeView(project: ServiceProject, recipeId: string): Promise<RecipeView> {
  const { engine, root, decisions } = await engineFor(project);
  const recipe = await readRecipe(root, recipeId);
  if (!recipe) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
  const pipeline = await readPipeline(root, recipeId);
  if (!pipeline) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
  const s = await engine.state(recipeId, pipeline);
  const status = deriveStatus(s);
  const { estimate } = await engine.estimate(recipeId, { all: true });
  const paused = postmakerPaused();
  const nodes: RecipeViewNode[] = [];
  for (const n of pipeline.nodes) {
    const st = status[n.id]!;
    const versions = await listVersions(root, recipeId, n.id);
    const est = estimate.nodes.find((x) => x.nodeId === n.id);
    const vendor = n.connectorChain.find((c) => c !== 'mock' && !LOCAL_CONNECTORS.has(c)) ?? null;
    const decision = vendor ? decisions.get(vendor) : undefined;
    let gateState: RecipeViewNode['gateState'] = null;
    if (vendor && paused) gateState = { kind: 'paused', reason: 'Post maker is paused.', fix: 'connections' };
    else if (vendor && engine.resolveConnector(n) === 'mock' && decision) gateState = { kind: decision.state === 'not-allowed' ? 'not-allowed' : 'off', reason: decision.reason, fix: decision.state === 'not-allowed' ? null : 'connections' };
    else if (st.gate && st.gate.gate.id !== 'proof' && s.current[n.id] && !st.gate.signed) gateState = { kind: 'needs-sign-off', reason: 'Needs a named sign-off', fix: null };
    nodes.push({
      ...n,
      status: st.status,
      outOfDate: st.outOfDate,
      lockedButChanged: st.lockedButChanged,
      reasons: st.reasons,
      head: s.heads[n.id]!,
      current: s.current[n.id] ?? null,
      versions: versions.map((v) => ({ n: v.n, at: v.createdAt, source: v.source, note: v.note, usd: v.cost.actualUsd, mode: v.mode, outputs: v.outputs })),
      estimate: { usd: est?.usdHigh ?? 0, seconds: est?.seconds ?? 0 },
      gateState,
    });
  }
  const used = new Set(pipeline.nodes.flatMap((n) => n.connectorChain));
  const connectors = (await connectorRows({ attended: true, list: CONNECTORS.filter((c) => used.has(c.id)) })) as ConnectorRow[];
  const last = await latestRunOf(root, recipeId);
  const forkOf = (await readRecipeIndex(root, recipeId))?.forkOf ?? null;
  return {
    recipe,
    pipeline,
    nodes,
    estimate,
    run: last,
    connectors,
    reference: await readReference(root, recipe.referenceId).catch(() => null),
    signoffs: await readSignOffs(root, recipeId),
    notes: await readNotes(root, recipeId),
    proof: await proofOf(root, s.current.check ?? null, last?.id ?? null),
    verdict: await runVerdictOf(root, last?.id ?? null, s.current.check ?? null),
    timeZone: projectTimeZone(project.timeZone),
    template: await templateOfRecipe(root, recipeId, forkOf),
    forkOf,
  };
}

/** The notes of a recipe (oldest first); a missing or unreadable file is no notes. */
export async function readNotes(root: string, recipeId: string): Promise<PmNote[]> {
  const all = await readJsonFile<PmNote[]>(notesFile(root, recipeId)).catch(() => null);
  return Array.isArray(all) ? all : [];
}

/**
 * the Proof projection of a `check` version (its `score` and `routes` ports), with the person's manual sheets of
 * `runId` when they were made on this exact check version; empty when unreadable.
 */
export async function proofOf(root: string, check: StepVersion | null, runId: string | null = null): Promise<ProofProjection[]> {
  const ref = (port: string) => check?.outputs.find((o) => o.port === port && o.kind === 'json') ?? null;
  const score = ref('score');
  if (!score) return [];
  try {
    const doc = await getJson<CheckResult>(root, score.sha256, { verify: true });
    if (!doc || !Array.isArray(doc.sheets)) return [];
    const routesRef = ref('routes');
    const routes = routesRef ? await getJson<RoutesDoc>(root, routesRef.sha256, { verify: true }).catch(() => null) : null;
    const manual = runId ? await readManualScore(root, runId, check) : null;
    return proofProjections(withManual(doc, manual), routes && Array.isArray(routes.routes) ? routes : null);
  } catch {
    return [];
  }
}

/** a recipe without its pipeline (Make it with "Stop after the recipe"), for the Recipe screen. */
export async function recipeOnlyView(project: ServiceProject, recipeId: string): Promise<RecipeOnlyView> {
  const root = rootOf(project);
  const recipe = await readRecipe(root, recipeId);
  if (!recipe) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
  return { recipe, reference: await readReference(root, recipe.referenceId).catch(() => null), pipeline: null };
}

export async function runView(project: ServiceProject, runId: string, since: number): Promise<RunView> {
  const root = rootOf(project);
  const run = await readRun(root, runId);
  if (!run) throw new PostmakerError(404, 'not_found', 'Unknown run.');
  const { events, nextSeq } = await readEvents(root, runId, since);
  return { run, events, nextSeq };
}

// ---- media --------------------------------------------------------------------------------------------

/** Types the media route may send as they are; anything else is served as a download (never rendered by the browser). */
const INLINE_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'application/json', 'text/plain', 'text/vtt']);

/**
 * The object `sha` when some version of some step of this recipe references it; otherwise 404, also for a
 * hash that exists but belongs to another recipe. Returns the file path and the type to send.
 */
export async function recipeObject(project: ServiceProject, recipeId: string, sha: string): Promise<{ file: string; mime: string; inline: boolean; ref: ArtifactRef }> {
  const root = rootOf(project);
  if (!(await readRecipeIndex(root, recipeId))) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
  for (const nodeId of await listDir(path.join(recipeDir(root, recipeId), 'steps'))) {
    if (!NODE_ID_RE.test(nodeId)) continue;
    for (const v of await listVersions(root, recipeId, nodeId).catch(() => [])) {
      const ref = v.outputs.find((o) => o.sha256 === sha);
      if (ref) {
        const mime = ref.mime.toLowerCase();
        const inline = INLINE_MIME.has(mime);
        return { file: objectPath(root, sha), mime: inline ? mime : 'application/octet-stream', inline, ref };
      }
    }
  }
  throw new PostmakerError(404, 'not_found', 'Not found.');
}

// ---- actions ---------------------------------------------------------------------------------------------------

export type ActionAnswer = { status: 200 | 202; body: Record<string, unknown> };

/** Starts a long action and answers with its run id as soon as it exists; errors before the start are thrown. */
async function startRegenerate(engine: PostmakerEngine, root: string, o: Parameters<PostmakerEngine['regenerate']>[0]): Promise<string> {
  let started!: (id: string) => void;
  const ready = new Promise<string>((r) => (started = r));
  const p = engine.regenerate({ ...o, onStarted: (id) => started(id) });
  const first = await Promise.race([ready, p.then(() => null)]);
  const runId = first ?? (await ready);
  void p
    .then(async (r) => {
      const run = await readRun(root, runId);
      if (run) await markAtProof(root, run);
      if (r.outcome === 'contract-break') await appendEvent(root, runId, { at: new Date().toISOString(), kind: 'check', nodeId: o.nodeId, text: 'contract-break', data: { candidate: r.candidate, diff: r.diff, violations: r.violations } });
    })
    .catch((e: unknown) => console.error('[postmaker] regenerate', runId, e instanceof Error ? e.name : 'error'));
  return runId;
}

async function makeRecipe(project: ServiceProject, root: string, referenceId: string, options: DeconstructInput['options']): Promise<Recipe> {
  // A campaign named in the options must exist (404 before anything is read or made).
  if (options.campaignId) await getCampaign(options.campaignId);
  const reference = await readReference(root, referenceId);
  const draft = await (deps().deconstruct ?? (await defaultDeconstruct(root)))({ reference, options, project });
  const now = deps().now?.() ?? Date.now();
  const { recipe } = await createRecipe(root, project, { ...draft, projectId: project.id, referenceId, campaignId: options.campaignId ?? draft.campaignId ?? null, languages: options.languages, lengthSec: options.lengthSec, shape: options.shape, capUsd: options.capUsd ?? draft.capUsd, stopAfterRecipe: options.stopAfterRecipe ?? false }, { now });
  return recipe;
}

async function buildFor(project: ServiceProject, root: string, recipe: Recipe): Promise<Pipeline> {
  const built = buildPipeline(recipe, await buildOptionsFor(project, root, recipe));
  validatePipeline(built);
  return writePipelineVersion(root, recipe.id, built);
}

/**
 * The `estimate` action takes the options step.regenerate (`exact`) and step.regenerate-from-here
 * (`fromHere`) use, with `nodeId` for the step, so the confirm flow is one step: the token it returns is the one the
 * action recomputes. `nodeId` alone is a step's own cost (exact). A scope that cannot carry the option is refused
 * rather than silently planned as a run.
 */
export function estimateOptions(a: Extract<PostmakerAction, { action: 'estimate' }>): { scope: Scope; exact: boolean; fromHere: boolean } {
  const bad = (m: string) => new PostmakerError(400, 'validation', m);
  if (a.for === 'run' && (a.exact || a.fromHere)) throw bad('An estimate for a run is neither exact nor from here.');
  const fromHere = a.fromHere === true || a.for === 'regenerate-from-here';
  const exact = a.exact === true || a.for === 'regenerate' || (!!a.nodeId && !fromHere && a.for !== 'run');
  if (exact && fromHere) throw bad('Choose exact or from here, not both.');
  let scope = a.scope;
  if (a.nodeId) {
    const own: Scope = fromHere ? { from: a.nodeId } : { nodes: [a.nodeId] };
    if (scope && JSON.stringify(scope) !== JSON.stringify(own)) throw bad('The scope and the step disagree.');
    scope = own;
  }
  if (!scope) throw bad('Name a scope or a step.');
  if (fromHere && !('from' in scope)) throw bad('From here needs a step to start from.');
  if (exact && !('nodes' in scope)) throw bad('An exact estimate needs the steps it costs.');
  return { scope, exact, fromHere };
}

export async function handleAction(project: ServiceProject, actor: Actor, a: PostmakerAction): Promise<ActionAnswer> {
  const { engine, root } = await engineFor(project);
  const by = actor.email;
  const ok = (body: Record<string, unknown>): ActionAnswer => ({ status: 200, body });
  const started = (runId: string, extra: Record<string, unknown> = {}): ActionAnswer => ({ status: 202, body: { runId, ...extra } });
  const launched = async (h: RunHandle, extra: Record<string, unknown> = {}) => {
    watch(root, h);
    return started(h.run.id, { status: h.run.status, ...extra });
  };
  switch (a.action) {
    case 'make-it': {
      const recipe = await makeRecipe(project, root, a.referenceId, a.options);
      if (a.options.stopAfterRecipe) return ok({ recipeId: recipe.id, recipe });
      await buildFor(project, root, recipe);
      const { estimate, capUsd } = await engine.estimate(recipe.id, { all: true });
      const h = await engine.run({ recipeId: recipe.id, scope: { all: true }, estimateToken: estimate.token, capUsd: a.options.capUsd ?? capUsd, trigger: 'make-it', by, attended: true });
      return launched(h, { recipeId: recipe.id });
    }
    case 'analyse': {
      const recipe = await makeRecipe(project, root, a.referenceId, { ...a.options, stopAfterRecipe: true });
      return ok({ recipeId: recipe.id, recipe });
    }
    case 'recipe.update': {
      const cur = await readRecipe(root, a.recipeId);
      if (!cur) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
      const { schema: _s, id: _i, version: _v, ...rest } = cur;
      void _s;
      void _i;
      void _v;
      const recipe = await writeRecipeVersion(root, a.recipeId, { ...rest, ...a.patch }, { baseVersion: a.baseVersion });
      return ok({ recipe });
    }
    case 'recipe.regenerate-beat': {
      // The deconstructor reads the reference again; only this beat takes the new content (regenerate-beat.ts).
      const cur = await readRecipe(root, a.recipeId);
      if (!cur) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
      if (!cur.beats.some((b) => b.id === a.beatId)) throw new PostmakerError(404, 'not_found', 'Unknown beat.');
      const reference = await readReference(root, cur.referenceId);
      const options = { languages: cur.languages, lengthSec: cur.lengthSec, shape: cur.shape, stopAfterRecipe: true };
      const fresh = await (deps().deconstruct ?? (await defaultDeconstruct(root)))({ reference, options, project, beat: { id: a.beatId, note: a.note ?? null } });
      const beats = mergeBeat(cur.beats, fresh.beats, a.beatId, cur.languages);
      const changed = JSON.stringify(beats) !== JSON.stringify(cur.beats);
      const { schema: _s, id: _i, version: _v, ...rest } = cur;
      void _s;
      void _i;
      void _v;
      const recipe = changed ? await writeRecipeVersion(root, a.recipeId, { ...rest, beats }, { baseVersion: cur.version }) : cur;
      const outOfDate = (await readPipeline(root, a.recipeId)) ? Object.values(await engine.status(a.recipeId)).filter((x) => x.outOfDate).map((x) => x.nodeId) : [];
      return ok({ recipe, beatId: a.beatId, changed, outOfDate });
    }
    case 'pipeline.build': {
      const recipe = await readRecipe(root, a.recipeId);
      if (!recipe) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
      if (recipe.version !== a.recipeVersion) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
      return ok({ pipeline: await buildFor(project, root, recipe) });
    }
    case 'pipeline.edit': {
      const p = await readPipeline(root, a.recipeId);
      if (!p) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
      if (p.version !== a.baseVersion) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
      const next = applyGraphOps(p, a.ops);
      validatePipeline(next);
      return ok({ pipeline: await writePipelineVersion(root, a.recipeId, { builtFrom: p.builtFrom, ...next }, { baseVersion: a.baseVersion }) });
    }
    case 'estimate': {
      // The token must be the one the action recomputes: Regenerate costs exactly its node(s), from-here its own plan.
      const o = estimateOptions(a);
      const r = await engine.estimate(a.recipeId, o.scope, { exact: o.exact, fromHere: o.fromHere });
      return ok({ estimate: r.estimate, plan: r.plan, capUsd: a.capUsd ?? r.capUsd });
    }
    case 'run':
      return launched(await engine.run({ recipeId: a.recipeId, scope: a.scope, capUsd: a.capUsd, estimateToken: a.estimateToken, trigger: 'run', by, attended: true }));
    case 'step.regenerate':
      return started(await startRegenerate(engine, root, { recipeId: a.recipeId, nodeId: a.nodeId, mode: a.mode, note: a.note, beats: a.beats, uncheckedExpects: a.uncheckedExpects, overwriteEdit: a.overwriteEdit, estimateToken: a.estimateToken, by }));
    case 'step.regenerate-from-here':
      return launched(await engine.regenerateFromHere({ recipeId: a.recipeId, nodeId: a.nodeId, note: a.note, overwriteEdit: a.overwriteEdit, capUsd: a.capUsd, estimateToken: a.estimateToken, by }));
    case 'step.edit': {
      // Replace file: an upload (uploads.ts) replaces one media output; the port type is checked by the engine.
      if (a.output.replaceFile && a.output.json) throw new PostmakerError(400, 'validation', 'Replace the file or edit the text, one at a time.');
      const up = a.output.replaceFile ? await readUpload(root, a.output.replaceFile.uploadId) : null;
      if (a.params !== undefined || a.instructions !== undefined) {
        const p = await readPipeline(root, a.recipeId);
        if (!p) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
        const ops: GraphOp[] = [];
        if (a.params !== undefined) ops.push({ op: 'set-params', nodeId: a.nodeId, params: a.params });
        if (a.instructions !== undefined) ops.push({ op: 'set-instructions', nodeId: a.nodeId, text: a.instructions });
        const next = applyGraphOps(p, ops);
        validatePipeline(next);
        await writePipelineVersion(root, a.recipeId, { builtFrom: p.builtFrom, ...next }, { baseVersion: p.version });
      }
      if (!a.output.json && !up) return ok({ version: null, adapted: [], paused: [] });
      const file = up && a.output.replaceFile ? { port: a.output.replaceFile.port, source: up.path, sha256: up.upload.sha256, kind: up.upload.kind, mime: up.upload.mime, ext: up.upload.ext, meta: up.upload.meta } : undefined;
      const r = await engine.edit({ recipeId: a.recipeId, nodeId: a.nodeId, baseVersion: a.baseVersion, output: file ? { file } : { json: a.output.json as Record<string, unknown> }, by });
      return ok({ version: r.version, adapted: r.adapted, paused: r.paused });
    }
    case 'step.lock':
      return ok({ head: await engine.lock(a.recipeId, a.nodeId, by) });
    case 'step.unlock':
      return ok({ head: await engine.unlock(a.recipeId, a.nodeId) });
    case 'step.skip':
      return ok({ head: await engine.skip(a.recipeId, a.nodeId, true) });
    case 'step.unskip':
      return ok({ head: await engine.skip(a.recipeId, a.nodeId, false) });
    case 'step.use-version':
      return ok({ head: await engine.useVersion(a.recipeId, a.nodeId, a.version) });
    case 'step.choose-candidate':
      return ok(await engine.chooseCandidate(a.recipeId, a.nodeId, a.version, a.accept));
    case 'run.pause':
      // No new step starts; the steps in progress finish; Continue run resumes without running a step twice.
      return ok({ run: await engine.pauseRun(a.runId) });
    case 'run.continue': {
      // A run waiting at Proof has nothing left to run; Continue would only relaunch an empty plan.
      const r = await readRun(root, a.runId);
      if (r && r.status === 'needs-you' && r.pausedFor === 'check') throw new PostmakerError(409, 'at-proof', AT_PROOF_TEXT);
      return launched(await engine.continueRun(a.runId));
    }
    case 'run.stop':
      return ok({ run: await engine.stopRun(a.runId) });
    case 'run.raise-cap':
      return ok({ run: await engine.raiseCap(a.runId, a.capUsd) });
    case 'gate.sign-off': {
      const { signoff } = await recordSignOff(root, { recipeId: a.recipeId, nodeId: a.nodeId, version: a.version, gate: a.gate, name: a.name, verdict: a.verdict, perLine: a.perLine, by, now: deps().now?.() });
      const last = await latestRunOf(root, a.recipeId);
      if (last && last.status === 'needs-you') await appendEvent(root, last.id, { at: signoff.at, kind: 'gate.signed', nodeId: a.nodeId, text: signoff.verdict, data: { gate: a.gate, version: a.version } });
      const st = (await engine.status(a.recipeId))[a.nodeId];
      return ok({ signoff, gate: st?.gate ?? null });
    }
    case 'note.add': {
      const run = await readRun(root, a.runId);
      if (!run) throw new PostmakerError(404, 'not_found', 'Unknown run.');
      const file = notesFile(root, run.recipeId);
      const note: PmNote = { id: `note-${randomBytes(4).toString('hex')}`, runId: a.runId, atSec: a.atSec, ...(a.box ? { box: a.box } : {}), text: a.text, ...(a.nodeId ? { nodeId: a.nodeId } : {}), by, at: new Date().toISOString() };
      await withLock(`pm-notes:${file}`, async () => {
        const all = (await readJsonFile<PmNote[]>(file)) ?? [];
        if (all.length >= 500) throw new PostmakerError(409, 'conflict', 'This recipe has too many notes.');
        await writeReplace(file, pretty([...all, note]));
      });
      return ok({ note });
    }
    case 'proof.score':
      return ok(await scoreProof({ engine, root, runId: a.runId, lang: a.lang, scores: a.scores, by, now: deps().now?.() }));
    case 'proof.accept': {
      const r: AcceptResult = await acceptProof({ engine, root, project, runId: a.runId, asDraft: a.asDraft, templateName: a.templateName, by, now: deps().now });
      // A post made for a planned campaign slot marks the slot made, so it is never made twice. The slot is also
      // reserved at fork time (template.make-post), so a second make-post on it is refused while this one runs.
      const slot = !r.asDraft && r.packageIds.length ? (await readRecipe(root, (await readRun(root, a.runId))!.recipeId))?.slot : null;
      if (slot) await markSlotMade(slot.campaignId, slot.slotId, r.packageIds[0]!).catch((e: unknown) => console.error('[postmaker] slot', e instanceof Error ? e.name : 'error'));
      return ok({ ...r });
    }
    case 'template.make-post': {
      const make = async () => {
        const now = deps().now?.() ?? Date.now();
        const fork = await makePostFork({ root, project, templateId: a.templateId, variantId: a.variantId, brief: a.brief, campaignSlot: a.campaignSlot, capUsd: a.capUsd, by, now });
        const { estimate, capUsd } = await engine.estimate(fork.recipe.id, { all: true });
        const h = await engine.run({ recipeId: fork.recipe.id, scope: { all: true }, estimateToken: estimate.token, capUsd: a.capUsd ?? capUsd, trigger: fork.slot ? 'campaign-slot' : 'make-a-post', by, attended: true });
        if (a.campaignSlot) await recordCampaignSlot(root, a.campaignSlot.campaignId, a.campaignSlot.slotId, { slotAt: fork.slot?.at ?? '', slotId: a.campaignSlot.slotId, recipeId: fork.recipe.id, runId: h.run.id, packageIds: [], autopilotRun: '', at: new Date(now).toISOString() });
        return launched(h, { recipeId: fork.recipe.id, templateId: fork.template.id, variantId: fork.variant?.id ?? null, forked: fork.forked, locked: fork.locked });
      };
      if (!a.campaignSlot) return make();
      // A planned campaign slot is reserved by the post on its way, so two "Make a post" on one slot cannot both
      // run; a post that stopped, failed or was kept as a draft frees the slot again.
      const cs = a.campaignSlot;
      return withLock(`pm-campaign-slot:${root}:${cs.campaignId}:${cs.slotId}`, async () => {
        const held = await campaignSlotHolder(root, cs.campaignId, cs.slotId);
        if (held && (await recipeStillMaking(root, held.recipeId))) throw new PostmakerError(409, 'conflict', SLOT_TAKEN_TEXT);
        return make();
      });
    }
    case 'template.variant.save': {
      const r = await saveVariantAction(root, a.templateId, a.variant, deps().templateLimits);
      return ok({ template: templateSummary(r.template), variant: r.variant });
    }
    case 'template.repeat.set':
      return ok({ template: templateSummary(await setRepeatAction(root, a.templateId, a.repeat)) });
    case 'template.skip-proof.set':
      return ok({ template: templateSummary(await setSkipProofAction(root, a.templateId, a.variantId, a.on)) });
    case 'template.campaign.attach':
    case 'template.campaign.detach':
      return ok({ template: templateSummary(await campaignAction(root, a.templateId, a.campaignId, a.action === 'template.campaign.attach')) });
    case 'template.duplicate':
      return ok({ template: templateSummary(await duplicateAction(root, project, a.templateId, a.name, deps().now?.() ?? Date.now())) });
    case 'template.retire':
      return ok({ template: templateSummary(await retireAction(root, a.templateId)) });
    // The person's one-time move of the pipelines into templates, and its undo (never a run, never a timer).
    case 'postmaker.migrate':
      return ok({ ...(await (await import('./migrate/pipelines')).migratePipelines(project, { by, now: deps().now?.() })) });
    case 'postmaker.migrate.undo':
      return ok({ ...(await (await import('./migrate/pipelines')).undoMigration(project, { by, migrationId: a.migrationId, now: deps().now?.() })) });
  }
}
