// Post maker screens: pure helpers shared by the six screens.
// No fetching and no React here, so every rule the screens show (status words, lane grouping, "Run n steps", the
// Accept state, the Persian gate rows, beat ownership, the word diff, the URL) is unit-tested on its own.
// Types are the server's (type-only imports); generic core: no project, brand or character names.
import type { StatusWord } from '../ui/status';
import { KINDS, LOCAL_CONNECTOR_LABELS, roleLabel } from '@/lib/studio/postmaker/graph/kinds';
import { runVerdict } from '@/lib/studio/postmaker/verdict-rule';
import { CORE_TEMPLATE_LIMITS, REPEAT_LIMITS } from '@/lib/studio/postmaker/template-rules';
import type { ConnectorRow, Lang, PmNote, ProofProjection, RecipeBeat, RecipeView, RecipeViewNode, RepeatInput, RepeatSettings, Run, Shape, SignOff, StepKind, TemplateSummary, VariantParams } from '@/lib/studio/postmaker/types';

// ---- URL state -----------------------------------------------------------------------------------------

export const SCREENS = ['reference', 'recipe', 'pipeline', 'proof'] as const;
export type Screen = (typeof SCREENS)[number];
export const HOME_VIEWS = ['drafts', 'proven', 'runs'] as const;
export type HomeView = (typeof HOME_VIEWS)[number];

export interface PmLocation {
  /** recipe id (`r`) */
  r: string | null;
  /** screen (`s`) */
  s: Screen | null;
  /** node id of the open step drawer (`step`) */
  step: string | null;
  /** home segment (`view`) */
  view: HomeView;
  /** run id of the open run drawer (`run`) */
  run: string | null;
  /** Template id of the Proven screen (`t`) */
  t?: string | null;
}

const RECIPE_RE = /^rc-\d{8}-[0-9a-f]{4}$/;
const RUN_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;
const NODE_RE = /^[a-z][a-z-]{1,23}(?::[a-z]{2})?(?:#[1-9]\d{0,2})?$/;
const TEMPLATE_RE = /^tpl-\d{8}-[0-9a-f]{4}$/;

/** Reads the Post maker part of a query string; malformed values are dropped (never echoed into a fetch). */
export function pmLocation(search: string): PmLocation {
  const q = new URLSearchParams(search);
  const r = q.get('r');
  const s = q.get('s');
  const step = q.get('step');
  const view = q.get('view');
  const run = q.get('run');
  const tpl = q.get('t');
  return {
    r: r && RECIPE_RE.test(r) ? r : null,
    s: (SCREENS as readonly string[]).includes(s ?? '') ? (s as Screen) : null,
    step: step && NODE_RE.test(step) ? step : null,
    view: (HOME_VIEWS as readonly string[]).includes(view ?? '') ? (view as HomeView) : 'drafts',
    run: run && RUN_RE.test(run) ? run : null,
    t: tpl && TEMPLATE_RE.test(tpl) && !(r && RECIPE_RE.test(r)) ? tpl : null,
  };
}

/** The `params` for navigateTo('postmaker', …): only what is set, in 's order. */
export function pmParams(l: Partial<PmLocation>): Record<string, string> {
  // The Proven screen is its own place (`&t=<templateId>`): nothing else rides along.
  if (l.t && !l.r) return { t: l.t };
  const p: Record<string, string> = {};
  if (l.view && l.view !== 'drafts' && !l.r) p.view = l.view;
  if (l.run && !l.r) p.run = l.run;
  if (l.r) p.r = l.r;
  if (l.s) p.s = l.s;
  if (l.step && l.r) p.step = l.step;
  return p;
}

// ---- words ------------------------------------------------------------------------------------------------------

const STEP_WORD: Record<RecipeViewNode['status'], StatusWord> = {
  'not-run': 'Not run',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  'needs-you': 'Needs you',
  failed: 'Failed',
  skipped: 'Skipped',
  off: 'Off',
};

/** The one status word of a lane: Out of date wins over Done; Off when the step would run as mock. */
export function laneWord(n: Pick<RecipeViewNode, 'status' | 'outOfDate'>): StatusWord {
  if (n.outOfDate && (n.status === 'done' || n.status === 'not-run')) return 'Out of date';
  return STEP_WORD[n.status];
}

/** The modifier pills of a lane: Mock (its output came from a mock), Locked. */
export function laneModifiers(n: Pick<RecipeViewNode, 'current' | 'head'>): StatusWord[] {
  const out: StatusWord[] = [];
  if (n.current?.mode === 'mock') out.push('Mock');
  if (n.head.locked) out.push('Locked');
  return out;
}

const RUN_WORD: Record<Run['status'], StatusWord> = { queued: 'Queued', running: 'Running', 'needs-you': 'Needs you', done: 'Done', stopped: 'Stopped', failed: 'Failed' };
export const runWord = (s: Run['status']): StatusWord => RUN_WORD[s];

export const templateWord = (s: 'draft' | 'proven' | 'retired'): StatusWord => (s === 'proven' ? 'Proven' : s === 'retired' ? 'Retired' : 'Draft');

/** `$0.07`; null (unknown price) is `$?`. */
export const money = (usd: number | null | undefined): string => (usd === null || usd === undefined || !Number.isFinite(usd) ? '$?' : `$${usd.toFixed(2)}`);

/** `0:34`, `1:25` (LTR timecode). */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `40 s`, `3 min`. */
export const duration = (sec: number): string => (sec < 90 ? `${Math.max(0, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

/** `1.2 MB`. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- template limits -------------------------------------------------------------------------------------

/** The core template's limits when no pack template says otherwise (story-spine@1, see docs/project-pack-format.md). */
export const CORE_TEMPLATE = { id: CORE_TEMPLATE_LIMITS.builder, durationSec: CORE_TEMPLATE_LIMITS.durationSec, canvases: CORE_TEMPLATE_LIMITS.canvases };
export const LENGTH_CHIPS = [15, 30, 60] as const;
export const SHAPES: Shape[] = ['9:16', '4:5', '1:1'];

/** Whether the template can make `sec` seconds. */
export const lengthAllowed = (sec: number, t = CORE_TEMPLATE): boolean => sec >= t.durationSec.min && sec <= t.durationSec.max;

/** The first length the template can make: the reference length when it fits, else 30 s, else the minimum. */
export function defaultLength(refSec: number | null, t = CORE_TEMPLATE): number {
  if (refSec !== null && lengthAllowed(Math.round(refSec), t)) return Math.round(refSec);
  return lengthAllowed(30, t) ? 30 : t.durationSec.min;
}

/** Estimate × 1.25 rounded up to the next $0.50 (0 stays 0). */
export const capFor = (usdHigh: number): number => (usdHigh <= 0 ? 0 : Math.ceil((usdHigh * 1.25) / 0.5) * 0.5);

// ---- cards and lanes -------------------------------------------------------------------------------------

export interface StepCardModel {
  kind: StepKind;
  title: string;
  lanes: RecipeViewNode[];
}

/** One card per kind in pipeline order; language nodes are lanes, fa before en (the order the recipe lists). */
export function cardsOf(nodes: RecipeViewNode[], languages: Lang[]): StepCardModel[] {
  const cards: StepCardModel[] = [];
  for (const n of nodes) {
    let c = cards.find((x) => x.kind === n.kind);
    if (!c) {
      c = { kind: n.kind, title: n.title, lanes: [] };
      cards.push(c);
    }
    c.lanes.push(n);
  }
  const rank = (n: RecipeViewNode) => (n.lang ? languages.indexOf(n.lang) : -1);
  for (const c of cards) c.lanes.sort((a, b) => rank(a) - rank(b));
  return cards;
}

/** Whether "Run" would run this node: Not run, Out of date or Failed, and not Locked or Skipped. */
export const runnable = (n: Pick<RecipeViewNode, 'status' | 'outOfDate' | 'head'>): boolean =>
  !n.head.locked && !n.head.skipped && n.status !== 'running' && n.status !== 'queued' && (n.status === 'not-run' || n.status === 'failed' || n.outOfDate);

/** "Run ‹n› steps (‹m› mock)": n counts nodes (lanes), m those whose estimate runs as mock. */
export function runCount(v: Pick<RecipeView, 'nodes' | 'estimate'>): { n: number; mock: number; usd: number; seconds: number } {
  const ids = v.nodes.filter(runnable).map((n) => n.id);
  const est = v.estimate.nodes.filter((e) => ids.includes(e.nodeId));
  return { n: ids.length, mock: est.filter((e) => e.mode === 'mock').length, usd: est.reduce((a, e) => a + e.usdHigh, 0), seconds: est.reduce((a, e) => a + e.seconds, 0) };
}

/** Every node downstream of `nodeId` (through edges), in pipeline order. */
export function descendants(v: Pick<RecipeView, 'pipeline'>, nodeId: string): string[] {
  const out = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of v.pipeline.edges) if (e.from === id && !out.has(e.to)) {
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return v.pipeline.nodes.map((n) => n.id).filter((id) => out.has(id));
}

/** The direct inputs of a node with the version each one uses now ("Keeps" chips, "Uses" in the rail). */
export function usesOf(v: Pick<RecipeView, 'nodes'>, node: RecipeViewNode): { nodeId: string; title: string; version: number | null; locked: boolean }[] {
  const seen = new Set<string>();
  const out: { nodeId: string; title: string; version: number | null; locked: boolean }[] = [];
  for (const i of node.inputs) {
    if (seen.has(i.from)) continue;
    seen.add(i.from);
    const up = v.nodes.find((n) => n.id === i.from);
    out.push({ nodeId: i.from, title: up ? laneTitle(up) : i.from, version: up?.head.current ?? null, locked: up?.head.locked ?? false });
  }
  return out;
}

/** The downstream `expects` rules that read from `nodeId` (the uncheckable constraint chips). */
export function expectsOn(v: Pick<RecipeView, 'nodes'>, nodeId: string): { id: string; label: string; nodeId: string; title: string }[] {
  const out: { id: string; label: string; nodeId: string; title: string }[] = [];
  for (const n of v.nodes) for (const e of n.expects) if (e.from === nodeId && !out.some((x) => x.id === e.id)) out.push({ id: e.id, label: e.label, nodeId: n.id, title: laneTitle(n) });
  return out;
}

const LANG_NAME: Record<Lang, string> = { fa: 'Persian', en: 'English' };
export const langName = (l: Lang): string => LANG_NAME[l];

/** "Voice · Persian"; a node without a language is its title. */
export const laneTitle = (n: Pick<RecipeViewNode, 'title' | 'lang'>): string => (n.lang ? `${n.title} · ${langName(n.lang)}` : n.title);

/**
 * The title of a node known only by its id (a run's steps): the kind's catalogue title and the language, e.g.
 * "Voice · Persian"; "Step" for a kind the catalogue does not know (never the id).
 */
export function stepTitle(nodeId: string): string {
  const [kind = '', rest = ''] = nodeId.split(':');
  const lang = rest.split('#')[0] as Lang;
  const title = (KINDS as Record<string, { title: string } | undefined>)[kind.split('#')[0]!]?.title ?? 'Step';
  return lang === 'fa' || lang === 'en' ? `${title} · ${langName(lang)}` : title;
}

/**
 * The step card's provider line: the first connector of the chain by its registry title and the role by
 * its registry label, e.g. "ElevenLabs · Sound designer". An unknown id is left out, never shown.
 */
export function providerLine(n: Pick<RecipeViewNode, 'connectorChain' | 'role' | 'lang'>, connectors: Pick<ConnectorRow, 'id' | 'title'>[] = []): string {
  const id = n.connectorChain[0] ?? '';
  const connector = connectors.find((c) => c.id === id)?.title ?? LOCAL_CONNECTOR_LABELS[id] ?? null;
  return [connector, roleLabel(n.role, n.lang)].filter(Boolean).join(' · ');
}

// ---- Persian gate rows -----------------------------------------------------------------------

export interface GateRow {
  nodeId: 'narration-text:fa' | 'voice:fa';
  kind: 'text' | 'voice';
  /** The named person who passed the current version (hash-bound), or null. */
  signer: string | null;
  /** The node is in the pipeline and has a current version. */
  present: boolean;
}

/** The person's pass on exactly the current version and hash of `nodeId`, if any (fail or older hash: null). */
export function signerOf(v: Pick<RecipeView, 'nodes' | 'signoffs'>, nodeId: string): SignOff | null {
  const n = v.nodes.find((x) => x.id === nodeId);
  const cur = n?.current;
  if (!n?.gate || !cur) return null;
  const recs = v.signoffs.filter((s) => s.nodeId === nodeId && s.gate === n.gate!.id && s.version === cur.n && s.hash === cur.hash && s.name.trim().toLowerCase() !== 'mock' && s.by.trim().toLowerCase() !== 'mock');
  const last = recs.at(-1) ?? null;
  return last && last.verdict === 'pass' ? last : null;
}

/** The two read-only rows Proof shows when the recipe has Persian (empty otherwise). */
export function gateRows(v: Pick<RecipeView, 'recipe' | 'nodes' | 'signoffs'>): GateRow[] {
  if (!v.recipe.languages.includes('fa')) return [];
  return (['narration-text:fa', 'voice:fa'] as const).map((nodeId) => ({
    nodeId,
    kind: nodeId === 'voice:fa' ? 'voice' : 'text',
    signer: signerOf(v, nodeId)?.name ?? null,
    present: !!v.nodes.find((n) => n.id === nodeId)?.current,
  }));
}

// ---- Accept ------------------------------------------------------------------

export type AcceptReason = 'no-run' | 'running' | 'accepted' | 'regenerate' | 'unsigned' | 'out-of-date' | 'check';

export interface AcceptState {
  /** "Accept as draft" when any step is mock or the proof is Unscored; "Accept" otherwise. */
  asDraft: boolean;
  disabled: boolean;
  reason: AcceptReason | null;
  mock: boolean;
}

/** The run is waiting at Proof (or finished there without a package). */
export const atProof = (run: Pick<Run, 'status' | 'pausedFor' | 'packageIds'> | null): boolean => !!run && run.packageIds.length === 0 && (run.status === 'done' || (run.status === 'needs-you' && run.pausedFor === 'check'));

/** Any step of the run, or any current version, came from a mock (`modes.mock > 0`). */
export function hasMock(v: Pick<RecipeView, 'nodes' | 'run'>): boolean {
  return (v.run?.steps ?? []).some((s) => s.mode === 'mock') || v.nodes.some((n) => n.current?.mode === 'mock');
}

/** The Proof primary, decided from the same facts the server checks (the server stays the authority). */
export function acceptState(v: Pick<RecipeView, 'recipe' | 'nodes' | 'signoffs' | 'run' | 'proof'> & { verdict?: RecipeView['verdict'] }): AcceptState {
  const mock = hasMock(v);
  // The run verdict is the server's (the one Accept reads); without it, the same rule over the per-language sheets.
  const verdict = v.verdict ?? runVerdict(v.proof);
  const unscored = verdict === 'unscored';
  const asDraft = mock || unscored;
  const base = { asDraft, mock };
  if (!v.run) return { ...base, disabled: true, reason: 'no-run' };
  if (v.run.status === 'running' || v.run.status === 'queued') return { ...base, disabled: true, reason: 'running' };
  if (v.run.packageIds.length) return { ...base, disabled: true, reason: 'accepted' };
  if (!atProof(v.run)) return { ...base, disabled: true, reason: 'no-run' };
  const blocked = v.nodes.some((n) => !n.head.skipped && (n.status === 'failed' || n.status === 'needs-you' || (n.outOfDate && !n.head.locked) || !n.current));
  if (blocked) return { ...base, disabled: true, reason: 'out-of-date' };
  if (asDraft) return { ...base, disabled: false, reason: null };
  if (verdict === 'regenerate') return { ...base, disabled: true, reason: 'regenerate' };
  if (gateRows(v).some((g) => !g.signer)) return { ...base, disabled: true, reason: 'unsigned' };
  if (v.proof.some((p) => p.checks.some((c) => !c.ok) || p.hardGates.some((h) => !h.passed))) return { ...base, disabled: true, reason: 'check' };
  return { ...base, disabled: false, reason: null };
}

// ---- beats and notes ------------------------------------------------------------------------------

/** The beat that holds `sec` (the last one also holds its end time). */
export function beatAt(beats: RecipeBeat[], sec: number): RecipeBeat | null {
  return beats.find((b, i) => sec >= b.start && (sec < b.end || (i === beats.length - 1 && sec <= b.end))) ?? null;
}

/**
 * The step that owns a beat on this language's proof: Captions when the beat carries on-screen text, otherwise
 * Animation; then Compose and Script when the pipeline has neither. The person can change it before saving.
 */
export function ownerOf(beat: RecipeBeat | null, lang: Lang | null, nodes: Pick<RecipeViewNode, 'id'>[]): string | null {
  const has = (id: string) => nodes.some((n) => n.id === id);
  const sfx = lang ? `:${lang}` : '';
  const text = !!beat && !!lang && !!(beat.onScreenText[lang] ?? '').trim();
  const order = text ? [`captions${sfx}`, `motion${sfx}`] : [`motion${sfx}`, `captions${sfx}`];
  for (const id of [...order, `compose${sfx}`, 'script']) if (has(id)) return id;
  return nodes[0]?.id ?? null;
}

/** The notes of one run, by time. */
export const notesOf = (notes: PmNote[], runId: string | null): PmNote[] => notes.filter((n) => n.runId === runId).sort((a, b) => a.atSec - b.atSec);

// ---- versions --------------------------------------------------------------------------------------------

export type DiffPart = { op: 'same' | 'add' | 'del'; text: string };

/** A word-level diff (LCS over whitespace-separated words; inputs are short step texts). */
export function wordDiff(a: string, b: string): DiffPart[] {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  if (x.length * y.length > 250_000) return [{ op: 'del', text: x.join(' ') }, { op: 'add', text: y.join(' ') }];
  const L: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (op: DiffPart['op'], w: string) => {
    const last = out.at(-1);
    if (last && last.op === op) last.text += ` ${w}`;
    else out.push({ op, text: w });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push('same', x[i]!);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) push('del', x[i++]!);
    else push('add', y[j++]!);
  }
  while (i < x.length) push('del', x[i++]!);
  while (j < y.length) push('add', y[j++]!);
  return out;
}

/** Plain text of a JSON step output for the diff: every string leaf, in order. */
export function textOf(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map((v) => textOf(v, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map((v) => textOf(v, depth + 1)).filter(Boolean).join(' ');
  return '';
}

// ---- home --------------------------------------------------------------------------------------------------

/** How far a draft got: Recipe (no pipeline), Proof (a run waits there or finished), else Pipeline. */
export function furthest(recipe: { id: string; pipeline: number | null }, runs: Pick<Run, 'recipeId' | 'status' | 'pausedFor' | 'packageIds'>[]): Screen {
  if (recipe.pipeline === null) return 'recipe';
  const mine = runs.filter((r) => r.recipeId === recipe.id);
  return mine.some((r) => atProof(r)) ? 'proof' : 'pipeline';
}

/** Runs that need the person (Today › Needs you): at Proof, at the cap or day limit, waiting for a sign-off or an edit, or failed. */
export const runNeedsYou = (r: Pick<Run, 'status' | 'packageIds'>): boolean => (r.status === 'needs-you' && r.packageIds.length === 0) || r.status === 'failed';

/**
 * Runs that need the person now: the latest run of each recipe (runs newest first, as Home lists them) when it needs
 * them. An older run of a recipe that ran again is superseded: its Proof is no longer the recipe's.
 */
export function runsNeedingYou<R extends Pick<Run, 'recipeId' | 'status' | 'packageIds'>>(runs: readonly R[]): R[] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    const latest = !seen.has(r.recipeId);
    seen.add(r.recipeId);
    return latest && runNeedsYou(r);
  });
}

/** The proof projection of one language, or the first. */
export const proofFor = (proof: ProofProjection[], lang: Lang | null): ProofProjection | null => proof.find((p) => p.lang === lang) ?? proof[0] ?? null;

// ---- Proven ------------------------------------------------------------------------------------

/**
 * A template moved from a pipeline that has no Post maker proof of its own yet. It is stored as
 * Proven, but it makes posts on its schedule only (Make a post and variants are refused), so it is shown as Moved.
 */
export const isMoved = (x: Pick<TemplateSummary, 'status' | 'migratedFrom' | 'provenRunId'>): boolean => !!x.migratedFrom && x.status === 'proven' && !x.provenRunId;

/** The template's status word: Moved stands where Proven would for a moved pipeline. */
export const templateStatusWord = (x: Pick<TemplateSummary, 'status' | 'migratedFrom' | 'provenRunId'>): StatusWord => (isMoved(x) ? 'Moved' : templateWord(x.status));

/** The template's pills: its status word, plus Repeats while Repeat is on (Repeats is a modifier). */
export function templatePills(x: Pick<TemplateSummary, 'status' | 'repeat'> & Partial<Pick<TemplateSummary, 'migratedFrom' | 'provenRunId'>>): StatusWord[] {
  const out: StatusWord[] = [templateStatusWord({ status: x.status, migratedFrom: x.migratedFrom ?? null, provenRunId: x.provenRunId ?? null })];
  if (x.status !== 'retired' && x.repeat?.enabled) out.push('Repeats');
  return out;
}

// ---- Move my pipelines and the nav ---------------------------

/** What the Post maker home says about pipelines (`PostmakerHome.migration`). */
export type MigrationState = { pending: number; kept?: number; undo: string | null } | null | undefined;

/**
 * Whether the nav still shows Pipelines: while any live pipeline is left (one a move would take, or one that makes
 * posts from a template and stays), and whenever Post maker cannot say (switch off, not loaded, an older
 * server): release 1 keeps the tab.
 */
export const pipelinesInNav = (m: MigrationState): boolean => !m || m.pending + (m.kept ?? 0) > 0;

/** The nav: 4 groups; Pipelines sits after Post maker in Work while it is shown. */
export type NavGroup = 'work' | 'plan' | 'learn' | 'setup';
export type NavView = 'today' | 'postmaker' | 'pipelines' | 'posts' | 'calendar' | 'campaigns' | 'brand' | 'results' | 'comments' | 'memory' | 'connections';
export function navGroups(o: { postmaker: boolean; pipelines: boolean }): { group: NavGroup; items: NavView[] }[] {
  const work: NavView[] = ['today', ...(o.postmaker ? (['postmaker'] as NavView[]) : []), ...(o.pipelines ? (['pipelines'] as NavView[]) : []), 'posts', 'calendar'];
  return [
    { group: 'work', items: work },
    { group: 'plan', items: ['campaigns', 'brand'] },
    { group: 'learn', items: ['results', 'comments', 'memory'] },
    { group: 'setup', items: ['connections'] },
  ];
}

/**
 * A moved pipeline keeps the pipeline ranges: its daily budget may be $0 to $20 (equal to the server's
 * LEGACY_REPEAT_LIMITS.dailyUsd.min; a test pins it). A Post maker template starts at REPEAT_LIMITS.dailyUsd.min.
 */
export const MOVED_MIN_USD = 0;

/** What a variant makes when a parameter is left out: the template's own (its source recipe). */
export interface VariantBase {
  languages: Lang[];
  lengthSec: number | null;
  shape: Shape | null;
}

/** "Persian · 30 s · 9:16": the language, length and shape a variant (or the default, `{}`) makes. */
export function variantLine(params: VariantParams, base: VariantBase): string {
  const langs = params.lang ? [params.lang] : base.languages;
  const length = params.lengthSec ?? base.lengthSec;
  const shape = params.shape ?? base.shape;
  return [langs.map(langName).join(' + '), length !== null ? duration(length) : null, shape].filter(Boolean).join(' · ');
}

/** The length chips of Add variant: 15, 30, 60 s and the template's own length, each with whether it can be made. */
export function variantLengths(baseSec: number | null, t = CORE_TEMPLATE): { sec: number; ok: boolean }[] {
  const all = [...new Set([...LENGTH_CHIPS, ...(baseSec !== null ? [Math.round(baseSec)] : [])])].sort((a, b) => a - b);
  return all.map((sec) => ({ sec, ok: lengthAllowed(sec, t) }));
}

/** The Repeat drawer's form: numbers stay text while typed, so a range error can be shown under its field. */
export interface RepeatForm {
  enabled: boolean;
  perWeek: string;
  /** 0 = Monday … 6 = Sunday (the Pipelines convention, so a moved pipeline keeps its days). */
  days: number[];
  times: string[];
  makeAheadDays: string;
  dailyUsd: string;
  approve: 'ask' | 'trusted';
}
export type RepeatField = 'perWeek' | 'days' | 'times' | 'makeAheadDays' | 'dailyUsd';

/** Off, 3 a week on Mon, Wed and Fri at 18:00, 3 days ahead, $2.00 a day, Ask me. */
export const REPEAT_DEFAULT: RepeatForm = { enabled: false, perWeek: '3', days: [0, 2, 4], times: ['18:00'], makeAheadDays: '3', dailyUsd: '2.00', approve: 'ask' };

export function repeatForm(r: RepeatSettings | null): RepeatForm {
  if (!r) return { ...REPEAT_DEFAULT, days: [...REPEAT_DEFAULT.days], times: [...REPEAT_DEFAULT.times] };
  return { enabled: r.enabled, perWeek: String(r.perWeek), days: [...r.days], times: [...r.times], makeAheadDays: String(r.makeAheadDays), dailyUsd: r.dailyUsd.toFixed(2), approve: r.approve };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const whole = (s: string, lo: number, hi: number): number | null => {
  const t = s.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
};
const dollars = (s: string, min: number = REPEAT_LIMITS.dailyUsd.min): number | null => {
  const t = s.trim().replace(/^\$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= REPEAT_LIMITS.dailyUsd.max ? n : null;
};

/** The fields that are out of range (the server checks the same ranges, template-rules.checkRepeat). */
export function repeatErrors(f: RepeatForm, o: { moved?: boolean } = {}): Partial<Record<RepeatField, true>> {
  const L = REPEAT_LIMITS;
  const e: Partial<Record<RepeatField, true>> = {};
  if (whole(f.perWeek, L.perWeek.min, L.perWeek.max) === null) e.perWeek = true;
  if (f.days.length < 1 || f.days.length > 7 || new Set(f.days).size !== f.days.length || !f.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) e.days = true;
  if (f.times.length < 1 || f.times.length > L.times || new Set(f.times).size !== f.times.length || !f.times.every((x) => HHMM.test(x))) e.times = true;
  if (whole(f.makeAheadDays, L.makeAheadDays.min, L.makeAheadDays.max) === null) e.makeAheadDays = true;
  if (dollars(f.dailyUsd, o.moved ? MOVED_MIN_USD : undefined) === null) e.dailyUsd = true;
  return e;
}

/** The `template.repeat.set` body, or null while a field is out of range. */
export function repeatInput(f: RepeatForm, o: { moved?: boolean } = {}): RepeatInput | null {
  if (Object.keys(repeatErrors(f, o)).length) return null;
  return { enabled: f.enabled, perWeek: Number(f.perWeek.trim()), days: [...f.days].sort((a, b) => a - b), times: [...f.times].sort(), makeAheadDays: Number(f.makeAheadDays.trim()), dailyUsd: dollars(f.dailyUsd, o.moved ? MOVED_MIN_USD : undefined)!, approve: f.approve };
}

/** Same settings (a saved drawer re-opens with equal values). */
export const sameRepeat = (a: RepeatInput | null, b: RepeatSettings | null): boolean =>
  !!a && !!b && a.enabled === b.enabled && a.perWeek === b.perWeek && a.makeAheadDays === b.makeAheadDays && a.dailyUsd === b.dailyUsd && a.approve === b.approve && a.days.join() === b.days.join() && a.times.join() === b.times.join();

/** A planned campaign slot as the campaigns list sends it (only what Make a post reads). */
export interface PlannedSlot {
  id: string;
  at: string;
  status: 'planned' | 'made' | 'skipped';
  templateId?: string | null;
  angle?: string;
  hook?: string;
  pillar?: string;
  captionLead?: string;
}

/**
 * The next planned slot of the campaigns a template is attached to (Make a post prefills from it): planned,
 * not yet passed, naming no other template; the earliest first. Null when there is none.
 */
export function nextSlot(templateId: string, campaignIds: readonly string[], plans: Record<string, { slots: PlannedSlot[] } | undefined>, now: number): { campaignId: string; slot: PlannedSlot; topic: string } | null {
  let best: { campaignId: string; slot: PlannedSlot; topic: string } | null = null;
  for (const cid of campaignIds) {
    for (const s of plans[cid]?.slots ?? []) {
      if (s.status !== 'planned' || (s.templateId && s.templateId !== templateId)) continue;
      const at = Date.parse(s.at);
      if (!Number.isFinite(at) || at < now) continue;
      if (best && Date.parse(best.slot.at) <= at) continue;
      const topic = (s.angle || s.hook || s.pillar || s.captionLead || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      best = { campaignId: cid, slot: s, topic };
    }
  }
  return best;
}
