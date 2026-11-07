// Post maker (pipeline v2) shapes: every data shape of the data model, regeneration, context, estimate, cache,
// ledger, connectors and API payloads (kinds and node ids, line shape, merged voice profile, project time zone).
// Server-only data, type-imported by the UI. Generic core: no project, brand, character or font names here; those
// come from a project pack (outside the repository).

// ---- vocabulary --------------------------------------------------------------------------------------------------

/** A content language. Packs declare theirs; the core ships Persian and English rules. */
export type Lang = 'fa' | 'en';
export const LANGS = ['fa', 'en'] as const satisfies readonly Lang[];

/** the canonical step kinds (node ids are `<kind>`, `<kind>:<lang>` or `<kind>#<n>`). */
export const STEP_KINDS = [
  'analyse',
  'script',
  'narration-text',
  'voice',
  'art',
  'broll',
  'lipsync',
  'music',
  'motion',
  'captions',
  'compose',
  'mix',
  'render',
  'post-copy',
  'check',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** statuses. `out-of-date` is derived, never stored. */
export type StepStatus = 'not-run' | 'queued' | 'running' | 'done' | 'needs-you' | 'failed' | 'skipped' | 'off';

/** Every JSON file carries `schema: 'signal.pm.<entity>/<major>'`. */
export type SchemaId = `signal.pm.${string}/${number}`;

/** Minimal project fields the store reads (`timeZone`, `pack`). */
export interface ProjectLike {
  id: string;
  contentDir: string;
  timeZone?: string; // IANA, e.g. 'Asia/Tehran'; absent = the Studio default zone
  pack?: { dir: string };
}

// ---- project pack -------------------------------------------------------------------------------------------

export type RigTier = 'A' | 'B' | 'C';
export type MusicSource = 'library' | 'owner-upload' | 'elevenlabs-music' | 'browser-agent' | 'none';

export interface PackFont {
  family: string;
  file: string; // relative to the pack folder
  sha256: string;
  licence: string; // relative path of the licence file, e.g. 'library/fonts/<family>/OFL.txt'
  scripts: ('latin' | 'arabic')[];
  weights: number[];
}

export interface PackManifest {
  schema: 'signal.pack/1';
  id: string; // slug
  version: string; // semver of the pack content
  name: string;
  languages: Lang[];
  brand: string | null; // 'brand/brand.json', or null to use the project's brand/
  library: string; // 'library/library.json' (Asset[])
  fonts: PackFont[];
  voices: string; // 'voices.json' (VoiceProfile[]),
  lexicon: Partial<Record<Lang, string>>;
  glossary: string | null;
  style: Partial<Record<Lang, string>>;
  templates: string[]; // 'templates/<id>.json'
  claims: { allowed: string[]; denied: string[] };
  musicPolicy: { sources: MusicSource[]; attribution: boolean };
  rigTier: Record<string, RigTier>; // per character id
  requires: { signal: string }; // semver range
}

/** Persian projection settings of a voice, nested under `projection`. */
export interface VoiceProjection {
  diacritics: 'all' | 'homographs' | 'none';
  ezafe: 'kasra' | 'display';
  conjO: boolean;
  zwnj: 'keep' | 'space';
  ipaInline: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  testId: string | null;
}

/** measured speaking rate, set after the first approved take per voice. */
export interface MeasuredRate {
  wordsPerSec: number;
  syllablesPerSec: number;
  sampleLines: number;
}

/** One record in `pack/voices.json`: voice fields + Persian projection fields + measured rate. */
export interface VoiceProfile {
  id: string;
  lang: Lang;
  speaker: string; // character id or 'narrator'
  connector: 'elevenlabs' | 'azure-speech' | 'mock';
  model: string; // pinned, never omitted
  voiceId: string; // designed or consented voice only
  settings: Record<string, number | string | boolean>;
  consentRef: string | null;
  approvedBy: string | null;
  projection: VoiceProjection | null; // required for 'fa', null for languages without a projection
  measuredRate: MeasuredRate | null;
}

/** hashes of every file (or record) the manifest references, as read. */
export interface PackLock {
  schema: 'signal.pm.pack-lock/1';
  packId: string;
  version: string;
  readAt: string;
  /** ref ('asset:<id>', 'lexicon:<lang>', 'voice:<id>', 'font:<family>', 'glossary', 'style:<lang>', 'template:<id>', 'brand', 'manifest') → sha256 */
  entries: Record<string, string>;
  root: string; // sha256 over the sorted entries
}

// ---- asset record -----------------------------------------------------------------------------------------

export type AssetKind = 'character' | 'prop' | 'background' | 'sticker' | 'ui' | 'font' | 'sfx' | 'music' | 'voice' | 'broll';
export type AssetUse = 'organic' | 'paid-ads' | 'store-listing';
export type LicenceType = 'owned' | 'commissioned' | 'ofl-1.1' | 'cc-by-4.0' | 'cc0' | 'stock' | 'ai-generated' | 'vendor-output';

export interface AssetLicence {
  type: LicenceType;
  holder: string;
  source: string;
  author: string | null;
  acquiredAt: string;
  proof: string | null;
  allowedUses: AssetUse[];
  territories: string[] | 'worldwide';
  expiresAt: string | null;
  attribution: string | null;
  aiGenerated: boolean;
  vendor?: { name: string; model: string; requestId: string; promptRef: string; c2pa: boolean };
  consentRef?: string | null;
}

export interface Asset {
  id: string; // stable, never reused
  kind: AssetKind;
  file: string; // relative to the library folder
  sha256: string;
  dims?: { w: number; h: number };
  durationMs?: number;
  tags: string[];
  palette?: string[];
  licence: AssetLicence;
  status: 'draft' | 'approved' | 'retired';
  approvedBy: string | null;
}

// ---- artifacts, provenance --------------------------------------------------------------------------------

export interface ArtifactRef {
  port: string;
  name: string;
  kind: 'json' | 'text' | 'image' | 'audio' | 'video' | 'subtitle';
  mime: string;
  lang?: Lang;
  sha256: string;
  bytes: number;
  meta?: { width?: number; height?: number; durationMs?: number; sampleRate?: number; frames?: number; lufs?: number };
}

export interface Provenance {
  executor: string; // 'claude-cli' | 'agent-sdk' | 'codex' | 'connector' | 'local'
  connector: string | null;
  mode: 'live' | 'mock';
  model: string | null;
  tool: { name: string; version: string } | null;
  requests: { id: string; at: string; status: string; costUsd: number | null }[];
  seed: number | null;
  prompt: string | null; // sha256 of the stored prompt object
  startedAt: string;
  endedAt: string;
  by: string;
}

// ---- reference and recipe -----------------------------------------------------------------------------------

export interface Reference {
  schema: 'signal.pm.reference/1';
  id: string;
  kind: 'video' | 'image' | 'link' | 'page';
  file: string | null;
  sha256: string | null;
  url: string | null;
  probe: { durationMs: number; width: number; height: number; fps: number; hasAudio: boolean; codec: string } | null;
  rights: 'own' | 'third-party-structure-only';
  addedAt: string;
  addedBy: string;
}

export type Shape = '9:16' | '4:5' | '1:1';
export type Segment = 'hook' | 'story' | 'interrupt' | 'demo' | 'chant' | 'escalation' | 'reveal' | 'endcard' | 'other';

export interface RecipeBeat {
  id: string; // 'b01'…, stable across recipe versions
  start: number;
  end: number;
  segment: Segment;
  name: string;
  purpose: string;
  visual: string;
  techniques: string[];
  onScreenText: Partial<Record<Lang, string>>;
  audio: string;
  motion: string;
}

export interface Recipe {
  schema: 'signal.pm.recipe/1';
  id: string;
  version: number;
  referenceId: string;
  projectId: string;
  campaignId: string | null;
  packId: string | null;
  languages: Lang[];
  lengthSec: number;
  shape: Shape;
  fps: 30;
  capUsd: number;
  beats: RecipeBeat[];
  style: { captions: 'word-pop' | 'line' | 'karaoke'; pace: 'calm' | 'fast' | 'very-fast'; palette: string[]; type: string; voice: string; music: string };
  assets: { id: string; label: string; kind: 'image' | 'video' | 'audio' | 'font' | 'logo'; state: 'have' | 'make' | 'missing'; source: string | null; madeBy: string | null }[];
  tempo: { bpm: number; downbeatMs: number } | null;
  evidence: { sheets: string[]; cuts: number[]; silences: [number, number][]; loudnessLufs: number | null };
  stopAfterRecipe: boolean;
  /**
   * The campaign slot a "Make a post" fork was made for. Accept writes `slotId` into the
   * package's campaign.json and `at` into the lineage lock's `slotAt`. Missing on older recipes = none.
   */
  slot?: RecipeSlot | null;
}

/** The campaign slot a fork was made for (ids as campaigns.ts writes them; `name` for the Posts origin line). */
export interface RecipeSlot {
  campaignId: string;
  slotId: string;
  at: string | null;
  name: string | null;
}

/** `recipes/<id>/recipe.json`: the mutable index of one recipe workspace. */
export interface RecipeIndex {
  schema: 'signal.pm.recipe-index/1';
  id: string;
  projectId: string;
  current: number; // current recipe version
  pipeline: number | null; // current pipeline version
  forkOf: { templateId: string; variantId: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

// ---- pipeline ---------------------------------------------------------------------------------------------

/** contract keys (unchanged). */
export interface Contract {
  beatIds?: string[];
  beatFrames?: Record<string, [number, number]>;
  lineIds?: string[];
  lineMs?: Record<string, number>;
  wordTimings?: Record<string, { token: string; startMs: number; endMs: number }[]>;
  assetIds?: string[];
  anchors?: Record<string, { x: number; y: number; h: number }>;
  textZones?: Record<string, 'headline' | 'lower'>;
  tempo?: { bpm: number; downbeatMs: number; chantBeatsPerCard: 2 | 4 };
  cutFrames?: number[];
  totalFrames?: number;
  coverFrame?: number;
  /** the script's CTA text per language, kept by `post-copy` (`script.cta.exact`). */
  cta?: Partial<Record<Lang, string>>;
}

export interface ExpectRule {
  id: string;
  from: string; // upstream nodeId
  key: keyof Contract;
  tolerance: { pct?: number; ms?: number; frames?: number; px?: number; bpm?: number } | 'exact' | 'recompute';
  label: string;
  adapter: string | null;
}

export type GateId = 'fa-native-editor' | 'fa-native-listener' | 'storyboard' | 'draft-preview' | 'listen' | 'proof';
export interface HumanGate {
  id: GateId;
  blocks: 'before-paid-downstream' | 'before-accept';
}

export interface PipelineNode {
  id: string;
  kind: StepKind;
  lang: Lang | null;
  title: string;
  role: string | null;
  connectorChain: string[];
  params: Record<string, unknown>;
  instructions: string;
  inputs: { port: string; from: string; fromPort: string; required: boolean }[];
  expects: ExpectRule[];
  gate: HumanGate | null;
  attendance: 'any' | 'attended-only';
}

export interface Edge {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  soft: boolean;
}

export interface Pipeline {
  schema: 'signal.pm.pipeline/1';
  recipeId: string;
  version: number;
  builtFrom: { recipeVersion: number; builder: string };
  nodes: PipelineNode[];
  edges: Edge[];
}

/**
 * a sign-off bound to one exact version hash. `by` is a person; `by: 'mock'` is written by mock runs
 * and counts as unsigned.
 */
export interface SignOff {
  gate: GateId;
  nodeId: string;
  version: number;
  hash: string;
  by: string;
  name: string;
  at: string;
  verdict: 'pass' | 'fail';
  perLine?: { lineId: string; ok: boolean; note?: string }[];
}

// ---- step versions and heads --------------------------------------------------------------------------------

export interface StepCheck {
  id: string;
  ok: boolean;
  required: boolean;
  text: string;
  evidence?: string;
}

export interface StepVersion {
  schema: 'signal.pm.step-version/1';
  recipeId: string;
  nodeId: string;
  n: number;
  createdAt: string;
  source: 'run' | 'regenerate' | 'edit' | 'adapt' | 'fork';
  runId: string | null;
  key: string; // cache key
  implVersion: string;
  inputs: { port: string; nodeId: string; version: number; hash: string }[];
  packRefs: { ref: string; sha256: string }[];
  params: Record<string, unknown>;
  outputs: ArtifactRef[];
  provides: Contract;
  checks: StepCheck[];
  provenance: Provenance;
  cost: { actualUsd: number | null; upperBoundUsd: number | null };
  seconds: number;
  mode: 'live' | 'mock';
  note: string | null;
  editedByUser: boolean;
  status: 'ok' | 'needs-you' | 'failed' | 'candidate';
  signoffs: SignOff[];
  /**
   * Set on a `source: 'fork'` version, the template version it points at (same outputs, same
   * objects; only the recipe id, number and recorded input hashes differ). `gatesInherited` compares `hash`.
   */
  forkedFrom?: { recipeId: string; nodeId: string; n: number; hash: string };
  hash: string; // sha256(JCS(this without `hash`))
}

/** What a caller hands the store: the store assigns `n`, `createdAt` (unless given) and `hash`. */
export type StepVersionDraft = Omit<StepVersion, 'schema' | 'n' | 'hash' | 'createdAt'> & { createdAt?: string };

export interface StepHead {
  schema: 'signal.pm.step-head/1';
  current: number | null;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  skipped: boolean;
  pinnedBeats: string[];
  updatedAt: string;
}

/** `steps/<nodeId>/pending.json`: in-flight vendor jobs (crash recovery). */
export interface PendingJobs {
  schema: 'signal.pm.pending/1';
  runId: string;
  nodeId: string;
  jobs: { connector: string; requestId: string; submittedAt: string; idempotencyKey: string }[];
}

// ---- runs -------------------------------------------------------------------------------------------------

export interface RunStep {
  nodeId: string;
  version: number | null;
  status: StepStatus;
  usd: number;
  seconds: number;
  mode: 'live' | 'mock';
  error: string | null;
}

export interface Run {
  schema: 'signal.pm.run/1';
  id: string;
  recipeId: string;
  templateId: string | null;
  variantId: string | null;
  trigger: 'make-it' | 'run' | 'regenerate' | 'regenerate-from-here' | 'make-a-post' | 'campaign-slot' | 'repeat' | 'run-again';
  scope: { nodes: string[] };
  startedAt: string;
  finishedAt: string | null;
  by: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  estimate: Estimate;
  status: 'queued' | 'running' | 'needs-you' | 'done' | 'stopped' | 'failed';
  pausedFor: 'cap' | 'day-ceiling' | 'edit' | 'check' | 'gate' | 'attended' | null;
  steps: RunStep[];
  packageIds: string[];
  attended: boolean;
}

export type EventKind =
  | 'run.started'
  | 'step.queued'
  | 'step.started'
  | 'connector.request'
  | 'connector.response'
  | 'ledger.reserve'
  | 'ledger.settle'
  | 'check'
  | 'gate.waiting'
  | 'gate.signed'
  | 'step.done'
  | 'step.failed'
  | 'run.paused'
  | 'run.reestimate'
  | 'run.done'
  | 'cache.hit'
  | 'context.truncated';

/** One line of `runs/<runId>/events.jsonl` (without the store-assigned `seq`). */
export interface EventLine {
  at: string;
  kind: EventKind;
  nodeId?: string;
  text?: string;
  data?: Record<string, unknown>;
}

// ---- templates --------------------------------------------------------------------------------------------

/** The parameters a variant may change; nothing else. */
export type VariantParams = Partial<{ lang: Lang; lengthSec: number; shape: Shape; hook: string; voice: string; music: string; dualCaptions: boolean }>;
export const VARIANT_PARAMS = ['lang', 'lengthSec', 'shape', 'hook', 'voice', 'music', 'dualCaptions'] as const;

export interface TemplateVariant {
  id: string;
  label: string;
  params: VariantParams;
  status: 'draft' | 'proven';
  provenRunId: string | null;
  /**
   * (per template + variant): consecutive Premium live proofs of this variant with ≤ 2
   * regenerations and no hard-gate override. A variant written before per-variant streaks reads as 0.
   */
  premiumStreak: number;
  /** "Skip proof for repeat runs" for this variant; settable only at streak ≥ 3; missing reads as false. */
  skipProofForRepeats: boolean;
  /**
   * The narration-text and voice version hashes of the variant's accepted Premium proof (by node id); what
   * `gatesInherited` compares a fork with. Null until the variant is proven.
   */
  gateHashes?: Record<string, string> | null;
}

/** What a client sends to `template.variant.save`; status, streak and proof are the server's. */
export interface VariantDraft {
  id?: string;
  label: string;
  params: VariantParams;
}

/** The Repeat settings (the Pipelines editors moved here); off unless the person turns it on. */
export type RepeatSettings = NonNullable<Template['repeat']>;
export type RepeatInput = Omit<RepeatSettings, 'enabled'> & { enabled?: boolean };

export interface Template {
  schema: 'signal.pm.template/1';
  id: string;
  name: string;
  status: 'draft' | 'proven' | 'retired';
  recipeId: string;
  snapshot: {
    recipeVersion: number;
    pipelineVersion: number;
    heads: Record<string, { version: number; hash: string; locked: boolean }>;
    packId: string | null;
    packVersion: string | null;
  };
  provenRunId: string | null;
  provenAt: string | null;
  provenBy: string | null;
  builtIn: boolean;
  pack: string | null;
  campaignIds: string[];
  /** `list`: the topics a `topic-list` template repeats through, in order (a migrated pipeline's list). */
  inputs: { kind: 'brief' | 'campaign-slot' | 'topic-list' | 'website-page' | 'ideas'; lockedNodes: string[]; list?: string[] };
  variants: TemplateVariant[];
  repeat: null | { enabled: boolean; perWeek: number; days: number[]; times: string[]; makeAheadDays: number; dailyUsd: number; approve: 'ask' | 'trusted' };
  /** The default variant's "Skip proof for repeat runs" (variants carry their own). */
  skipProofForRepeats: boolean;
  /** Consecutive Premium live proofs with ≤ 2 regenerations, for the default variant. */
  premiumStreak: number;
  migratedFrom: string | null;
  /**
   * Set on a template moved from a v1 pipeline: its one-node `legacy-format` pipeline (the v1 post
   * generator for one format). Missing or null = a Post maker template.
   */
  legacy?: LegacyPipeline | null;
  /**
   * 1 when created, +1 on every write of the template (store/templates.ts sets it; callers cannot). A file
   * written before the counter reads as 1. A Post maker package records the revision its accept wrote.
   */
  revision: number;
}

/**
 * The one step of a moved v1 pipeline: the v1 post generator for one format, its connector chain, and
 * the pipeline's prompt template and caption style. Not an engine step kind: the daily run makes it (migrate/legacy.ts).
 */
export interface LegacyFormatNode {
  id: 'legacy-format';
  kind: 'legacy-format';
  title: string;
  connectorChain: string[];
  params: { format: string; template: string; captionStyle: string };
  attendance: 'any' | 'attended-only';
}

/** A moved pipeline's own copy of its format's built-in one-node pipeline, plus the v1 review flag. */
export interface LegacyPipeline {
  schema: 'signal.pm.legacy-pipeline/1';
  /** The built-in format template it copies (`format:<format>`). */
  builtIn: string;
  nodes: [LegacyFormatNode];
  /** v1 `review.enabled`: the reviewer runs on each made post, as before the move. */
  review: boolean;
}

// ---- lineage lock, pins ----------------------------------------------------------------------------------

export interface PostmakerMark {
  schema: 'signal.pm.mark/1';
  recipeId: string;
  templateId: string | null;
  variantId: string | null;
  runId: string;
  lang: Lang;
  lineageRoot: string;
  lineage: { nodeId: string; n: number; hash: string }[];
  files: Record<string, { sha256: string; fromNode: string; fromVersion: number; port: string }>;
  packId: string | null;
  packVersion: string | null;
  modes: { live: number; mock: number };
  signoffs: SignOff[];
  acceptedBy: string;
  acceptedAt: string;
  slotAt: string | null;
  pipeline: string | null;
  /**
   * The template the proof belongs to, for the Posts origin line "Post maker · ‹name› v‹version›".
   * `version` is the template's `revision` as this accept wrote it (before it was the recipe version).
   */
  template?: { name: string; version: number } | null;
  /** the check verdict at accept ('standard' packages carry the "below premium" note). */
  verdict?: 'premium' | 'standard';
  /**
   * Gates this skip-proof accept took from the template's named sign-offs. Each entry
   * names the template version the person signed; the matching record in `signoffs` is that person's own record
   * (bound to the template version's hash), never a record of the fork's version.
   */
  inherited?: { nodeId: string; fromRecipeId: string; fromVersion: number; fromHash: string }[];
}

/** `postmaker/pins.json`: objects an approved package depends on; a future clean-up never removes them. */
export interface Pins {
  schema: 'signal.pm.pins/1';
  objects: Record<string /* sha256 */, string[] /* who pinned it, e.g. 'package:12' */>;
  updatedAt: string;
}

/** `PmNote`: a note on a proof frame. */
export interface PmNote {
  id: string;
  runId: string;
  atSec: number;
  box?: [number, number, number, number];
  text: string;
  nodeId?: string;
  by: string;
  at: string;
}

// ---- regeneration, context, estimate, cache -----------------------------------------------------------------

export type ContractMode = 'keep-contracts' | 'allow-breaks';
export type ContractDiff = { key: string; from: unknown; to: unknown; dependents: string[] }[];

export interface ContextBundle {
  task: string;
  node: { id: string; kind: StepKind; lang: Lang | null; params: Record<string, unknown> };
  upstream: { port: string; nodeId: string; version: number; hash: string; locked: boolean; data: unknown | null; files: string[] }[];
  downstream: { nodeId: string; rules: { id: string; label: string; key: string; tolerance: unknown; current: unknown }[] }[];
  neighbours: { beatId: string; before: unknown | null; after: unknown | null }[] | null;
  pinned: unknown[];
  history: { version: number; note: string | null; editedByUser: boolean; diffSummary: string }[];
  rubric: { criterion: string; score: number; note: string }[];
  pack: { style?: string; glossary?: unknown; lexicon?: unknown; brand?: unknown; claims?: unknown };
  untrusted: { referenceText?: string; userNotes?: string[] };
  outputSpec: string;
}

export interface EstimateNode {
  nodeId: string;
  connector: string;
  mode: 'live' | 'mock';
  usdLow: number;
  usdHigh: number;
  seconds: number;
  basis: string;
  verified: boolean;
}

export interface Estimate {
  usdLow: number;
  usdHigh: number; // what the ledger reserves
  seconds: number;
  nodes: EstimateNode[];
  unknown: string[];
  token: string; // HMAC of (recipe heads, scope, usdHigh)
}

/** the inputs of a cache key. */
export interface CacheKeyInput {
  kind: StepKind;
  implVersion: string;
  connector: string;
  model: string | null;
  voiceId: string | null;
  settings: Record<string, unknown>;
  params: Record<string, unknown>;
  inputs: [port: string, hash: string][];
  packRefs: { ref: string; sha256: string }[];
  seed: number | null;
}

/** One line of `postmaker/cache/index.jsonl`; the last line per key wins. */
export interface CacheEntry {
  key: string;
  recipeId: string;
  nodeId: string;
  version: number;
  hash: string;
  at: string;
}

// ---- ledger -----------------------------------------------------------------------------------------------

export type LedgerLine =
  | { t: 'reserve'; id: string; at: string; project: string; runId: string; nodeId: string; connector: string; usd: number }
  | { t: 'settle'; id: string; at: string; usd: number; known: boolean; note?: string }
  | { t: 'release'; id: string; at: string };

// ---- connectors ---------------------------------------------------------------------------------------------

export type ConnectorKind = 'cli' | 'api' | 'browser-agent' | 'local';
export type CapabilityId =
  | 'llm.text'
  | 'llm.vision'
  | 'image.generate'
  | 'image.export'
  | 'video.i2v'
  | 'tts'
  | 'tts.timestamps'
  | 'lipsync'
  | 'music.generate'
  | 'music.import'
  | 'render.video'
  | 'render.audio'
  | 'audio.loudness';

export interface Capability {
  id: CapabilityId;
  langs?: Lang[];
  models?: string[];
  limits?: Record<string, number | string>;
  source?: string;
  readAt?: string;
}

export interface CostModel {
  unit: 'char' | 'second' | 'minute' | 'image' | 'request' | 'token' | 'none';
  usdPerUnit: number | null; // null = unknown ("~$?")
  minimumUsd: number;
  perCallCeilingUsd: number;
  billing: 'vendor-key' | 'owner-plan' | 'claude-plan' | 'none';
  verified: boolean;
  source: string | null;
  readAt: string | null;
  estimateEndpoint?: boolean;
}

export type ConnectorState = 'ready' | 'off' | 'needs-key' | 'not-allowed' | 'needs-sign-in' | 'error' | 'not-installed';

export interface ConnectorStatus {
  state: ConnectorState;
  line: string; // ≤ 8 words
  fix: 'connections' | 'install' | 'sign-in' | 'gate' | null;
  account?: string | null;
  version?: string | null;
  spentThisMonthUsd?: number;
}

export interface InvokeCtx {
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  workDir: string;
  onEvent: (e: { kind: string; text: string }) => void;
  idempotencyKey: string;
  deps: { fetch?: typeof fetch; spawn?: typeof import('node:child_process').spawn; sleep?: (ms: number) => Promise<void> };
}

export interface ConnectorEstimate {
  usdLow: number;
  usdHigh: number;
  seconds: number;
  basis: string;
}

export interface Connector<Req = unknown, Res = unknown> {
  id: string;
  title: string;
  kind: ConnectorKind;
  group: 'making' | 'publishing' | 'sources';
  capabilities: Capability[];
  costModel: CostModel;
  attendance: 'any' | 'attended-only';
  settingsGroup: string | null;
  feature: string;
  gates: string[];
  status(): Promise<ConnectorStatus>;
  /** Must be free: a connector with no free check returns { ok: true, text: 'Key saved. Not tested.' }. */
  test(): Promise<{ ok: boolean; text: string; costUsd: 0 }>;
  estimate(req: Req): ConnectorEstimate;
  invoke(req: Req, ctx: InvokeCtx): Promise<Res>;
  mock(req: Req, ctx: InvokeCtx): Promise<Res>;
  redact(text: string): string;
}

/** the single liveness decision, evaluated at each call. */
export interface ConnectorAllowed {
  live: boolean;
  state: ConnectorState;
  reason: string;
}

export interface ConnectorRow {
  id: string;
  title: string;
  group: 'making';
  status: ConnectorStatus;
  switchOn: boolean;
  attendance: 'any' | 'attended-only';
  costModel: Pick<CostModel, 'unit' | 'usdPerUnit' | 'verified' | 'source' | 'readAt'>;
}

// ---- the `check` node: rubric sheets, routes, the Proof projection (serves it) ------

/** the 12 criteria. C3, C8 and C11 are the hard gates. */
export type CriterionId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12';
export type Medium = 'feed' | 'carousel' | 'video';
/** the verdict pill. `unscored` = no reviewer was available (manual scoring on Proof, else Accept as draft). */
export type Verdict = 'premium' | 'standard' | 'regenerate' | 'unscored';
/** fallback chain, plus the owner's manual scores. */
export type ReviewerPath = 'agent-sdk' | 'claude-cli' | 'deterministic-only' | 'manual';
export type RubricScoreValue = 1 | 2 | 3 | 4 | 5;

export interface RubricEvidence {
  kind: 'frame' | 'measure' | 'report' | 'signoff' | 'text';
  ref: string;
  value?: string;
}

/** `RubricScore` (with who confirmed in which role; C8 in fa needs `native-editor-fa`). */
export interface RubricScore {
  criterion: CriterionId;
  applicable: boolean;
  score: RubricScoreValue | null; // null when not applicable, or not scored yet
  evidence: RubricEvidence[]; // at least 1 when applicable and scored
  draftedBy: 'qa-agent' | 'owner' | null;
  confirmedBy: string | null;
  confirmedRole: 'owner' | 'native-editor-fa' | null;
  owningStep: StepKind; // where a regenerate goes
  note: string; // at most 140 characters
}

/** The deterministic rows of Proof ("Checks (6)"). */
export type CheckId = 'loudness' | 'safe-zones' | 'caption-match' | 'ai-label' | 'fonts' | 'frame-count';
export interface DeterministicCheck {
  id: CheckId;
  ok: boolean;
  /** false = the input was not there to measure (the row still fails; nothing is assumed). */
  measured: boolean;
  reason: string | null; // one line, shown with "Needs you"
  evidence: RubricEvidence[];
}

/** One language's sheet (`RubricSheet`, one per package language). */
export interface RubricSheet {
  lang: Lang;
  medium: Medium;
  scores: RubricScore[];
  mean: number | null;
  verdict: Verdict;
  rubricVersion: 'qr-1.0';
  scoredBy: ReviewerPath;
  unscoredReason: string | null;
  checks: DeterministicCheck[];
  /** Lint findings with frame numbers (pacing, flash, lip-sync QA, tier ceiling). */
  findings: { id: string; frame: number | null; text: string }[];
}

/** `score.json`, the `check` node's `score` output. */
export interface CheckResult {
  schema: 'signal.pm.score/1';
  runId: string;
  reviewer: ReviewerPath;
  sheets: RubricSheet[];
  costUsd: number | null;
}

/** One routed fix: a failing criterion and the node that owns it. */
export interface CheckRoute {
  lang: Lang;
  criterion: CriterionId;
  score: number;
  kind: StepKind;
  nodeId: string;
  group: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8';
  note: string;
}

/** `routes.json`, the `check` node's `routes` output. */
export interface RoutesDoc {
  schema: 'signal.pm.routes/1';
  runId: string;
  routes: CheckRoute[];
}

/** preview strip (fixture shape until lands): sampled frames of a render, stored as objects. */
export interface PreviewStrip {
  lang: Lang;
  fps: number;
  width: number;
  height: number;
  frames: { frame: number; sha256: string; mime: 'image/png' | 'image/jpeg' }[];
}

/** What Proof shows for one language. serves it; accept logic stays in. */
export interface ProofProjection {
  lang: Lang;
  verdict: Verdict;
  scoredBy: ReviewerPath;
  /** Set when the verdict is `unscored`: why, in one line. */
  unscored: { reason: string } | null;
  /** Unscored: the owner may score the 12 criteria, each with an evidence note. */
  manualScoring: boolean;
  /** The verdict alone allows Accept (Premium or Standard); every other Accept condition is. */
  verdictAllowsAccept: boolean;
  mean: number | null;
  hardGates: { criterion: 'C3' | 'C8' | 'C11'; score: number | null; passed: boolean; confirmed: boolean; needs: 'owner' | 'native-editor-fa' | null }[];
  checks: { id: CheckId; ok: boolean; measured: boolean; reason: string | null }[];
  criteria: { criterion: CriterionId; applicable: boolean; score: number | null; evidence: RubricEvidence[]; confirmedBy: string | null; note: string; owningStep: StepKind }[];
  routes: CheckRoute[];
}

// ---- API payloads -----------------------------------------------------------------------------------------

export type Scope = { all: true } | { nodes: string[] } | { from: string };

export type GraphOp =
  | { op: 'add'; node: Omit<PipelineNode, 'attendance'>; after: string }
  | { op: 'remove'; nodeId: string }
  | { op: 'move'; nodeId: string; after: string }
  | { op: 'set-params'; nodeId: string; params: Record<string, unknown> }
  | { op: 'set-connector-chain'; nodeId: string; chain: string[] }
  | { op: 'set-instructions'; nodeId: string; text: string };

export type PostmakerAction =
  | { action: 'make-it'; referenceId: string; options: { languages: Lang[]; lengthSec: number; shape: Shape; campaignId?: string | null; capUsd?: number; stopAfterRecipe?: boolean } }
  | { action: 'analyse'; referenceId: string; options: { languages: Lang[]; lengthSec: number; shape: Shape } }
  | { action: 'recipe.update'; recipeId: string; baseVersion: number; patch: Partial<Pick<Recipe, 'beats' | 'style' | 'languages' | 'lengthSec' | 'shape' | 'capUsd' | 'campaignId'>> }
  | { action: 'recipe.regenerate-beat'; recipeId: string; beatId: string; note?: string }
  | { action: 'pipeline.build'; recipeId: string; recipeVersion: number }
  | { action: 'pipeline.edit'; recipeId: string; baseVersion: number; ops: GraphOp[] }
  /** `for`: the action the token is for; Regenerate costs exactly its node, Regenerate from here its own plan. Default 'run'. */
  /**
   * The estimate a run or a regenerate will check its token against. Options as step.regenerate (`exact`, a step's
   * own cost) and step.regenerate-from-here (`fromHere`) take them, with `nodeId` for the step (scope then optional);
   * `for` is the older spelling of the same choice.
   */
  | { action: 'estimate'; recipeId: string; scope?: Scope; nodeId?: string; exact?: boolean; fromHere?: boolean; capUsd?: number; for?: 'run' | 'regenerate' | 'regenerate-from-here' }
  | { action: 'run'; recipeId: string; scope: Scope; capUsd: number; estimateToken: string }
  | { action: 'step.regenerate'; recipeId: string; nodeId: string; mode: ContractMode; note?: string; beats?: string[]; uncheckedExpects?: string[]; overwriteEdit?: boolean; estimateToken: string }
  | { action: 'step.regenerate-from-here'; recipeId: string; nodeId: string; note?: string; overwriteEdit?: boolean; capUsd: number; estimateToken: string }
  | { action: 'step.edit'; recipeId: string; nodeId: string; baseVersion: number; output: { json?: unknown; replaceFile?: { port: string; uploadId: string } }; params?: Record<string, unknown>; instructions?: string }
  | { action: 'step.lock' | 'step.unlock' | 'step.skip' | 'step.unskip'; recipeId: string; nodeId: string }
  | { action: 'step.use-version'; recipeId: string; nodeId: string; version: number }
  | { action: 'step.choose-candidate'; recipeId: string; nodeId: string; version: number; accept: boolean }
  | { action: 'run.pause' | 'run.continue' | 'run.stop'; runId: string }
  | { action: 'run.raise-cap'; runId: string; capUsd: number }
  | { action: 'gate.sign-off'; recipeId: string; nodeId: string; version: number; gate: GateId; name: string; verdict: 'pass' | 'fail'; perLine?: { lineId: string; ok: boolean; note?: string }[] }
  | { action: 'note.add'; runId: string; atSec: number; box?: [number, number, number, number]; text: string; nodeId?: string }
  | { action: 'proof.accept'; runId: string; asDraft: boolean; templateName: string }
  /** the owner scores an Unscored live proof by hand, each score with an evidence note. */
  | { action: 'proof.score'; runId: string; lang: Lang; scores: { criterion: CriterionId; score: RubricScoreValue; note: string }[] }
  /** `brief` may be left out when `campaignSlot` prefills it. */
  | { action: 'template.make-post'; templateId: string; variantId?: string; brief?: { topic: string; hook?: string; notes?: string }; campaignSlot?: { campaignId: string; slotId: string }; capUsd?: number }
  | { action: 'template.variant.save'; templateId: string; variant: VariantDraft }
  | { action: 'template.repeat.set'; templateId: string; repeat: RepeatInput }
  /** VariantId null = the default variant. */
  | { action: 'template.skip-proof.set'; templateId: string; variantId: string | null; on: boolean }
  | { action: 'template.campaign.attach' | 'template.campaign.detach'; templateId: string; campaignId: string }
  | { action: 'template.duplicate'; templateId: string; name?: string }
  | { action: 'template.retire'; templateId: string }
  /** Moves every pipeline into a template with Repeat (started by the person; once; backup first). */
  | { action: 'postmaker.migrate' }
  /** Undoes the last move (or `migrationId`): templates go to a dated folder, pipelines come back from the backup. */
  | { action: 'postmaker.migrate.undo'; migrationId?: string };

/** The template as Home and the Recipe screen show it (variants, streaks, Repeat summary). */
export interface TemplateSummary {
  id: string;
  name: string;
  status: Template['status'];
  recipeId: string;
  provenRunId: string | null;
  premiumStreak: number;
  skipProofForRepeats: boolean;
  /** Skip proof may be turned on for the default variant (streak ≥ 3, not retired). */
  skipProofAllowed: boolean;
  campaignIds: string[];
  revision: number;
  variants: (Pick<TemplateVariant, 'id' | 'label' | 'params' | 'status' | 'provenRunId' | 'premiumStreak' | 'skipProofForRepeats'> & { skipProofAllowed: boolean })[];
  repeat: RepeatSettings | null;
  /** The `pl-…` id of the pipeline this template was moved from (null for a Post maker template). */
  migratedFrom?: string | null;
}

export interface RecipeViewNode extends PipelineNode {
  status: StepStatus;
  outOfDate: boolean;
  lockedButChanged: boolean;
  reasons: string[];
  head: StepHead;
  current: StepVersion | null;
  versions: { n: number; at: string; source: StepVersion['source']; note: string | null; usd: number | null; mode: 'live' | 'mock'; /**: for A/B and the word diff (objects through the media route). */ outputs: ArtifactRef[] }[];
  estimate: { usd: number; seconds: number };
  gateState: { kind: 'off' | 'paused' | 'not-allowed' | 'needs-sign-off'; reason: string; fix: 'connections' | null } | null;
}

export interface RecipeView {
  recipe: Recipe;
  pipeline: Pipeline;
  nodes: RecipeViewNode[];
  estimate: Estimate;
  run: Run | null;
  connectors: ConnectorRow[];
  /** what the screens read beside the graph (reference card, Proof gate rows, notes, verdict block). */
  reference: Reference | null;
  /** Person-made sign-offs of this recipe, oldest first (mock and agent records never appear). */
  signoffs: SignOff[];
  notes: PmNote[];
  /** One per language from the current `check` version (empty before the check ran). */
  proof: ProofProjection[];
  /** The run verdict Accept reads: the weakest language of the current check (manual sheets on Unscored). */
  verdict: Verdict;
  /** The project's IANA time zone: every date on the screens is shown in it. */
  timeZone: string;
  /** The template this recipe was made from (a fork) or proved (its source); null when there is none. */
  template?: TemplateSummary | null;
  /** Set on a fork made by "Make a post": the template and variant it came from. */
  forkOf?: RecipeIndex['forkOf'];
}

/** `GET recipes/[id]?only=recipe`, for a recipe stopped before its pipeline was built. */
export interface RecipeOnlyView {
  recipe: Recipe;
  reference: Reference | null;
  pipeline: null;
}

export interface RunView {
  run: Run;
  events: (EventLine & { seq: number })[];
  nextSeq: number;
}
