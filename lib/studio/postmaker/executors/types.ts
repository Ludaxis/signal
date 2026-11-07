// The executor interface the runner drives: one executor per step kind, chosen by kind, given its node, its
// upstream versions and data, the resolved connector and mode, and returning outputs (JSON or bytes), the contract it
// provides, checks and cost. Vendor executors with long jobs also expose `job` (submit, then collect) so a pending
// request id survives a restart and Resume collects instead of paying again.
import type { ArtifactRef, Contract, ContextBundle, Lang, PipelineNode, Provenance, Recipe, SignOff, StepCheck, StepKind, StepVersion } from '../types';

export interface ExecUpstream {
  port: string;
  nodeId: string;
  version: StepVersion;
  /** The JSON content of the port it reads (null for media ports). */
  data: unknown;
  refs: ArtifactRef[];
}

export interface ExecInput {
  recipe: Recipe;
  node: PipelineNode;
  lang: Lang | null;
  inputs: ExecUpstream[];
  /** `inputs` by port: the JSON data (or null). */
  byPort: Record<string, unknown>;
  params: Record<string, unknown>;
  seed: number;
  mode: 'live' | 'mock';
  connector: string;
  note: string | null;
  beats: string[] | null;
  pinnedBeats: string[];
  previous: { version: StepVersion; data: Record<string, unknown> } | null;
  /** Contract violations from the last take ("Line l03 must be …"), appended to the context on a retry. */
  violations: string[];
  take: number;
  context: ContextBundle | null;
  runId: string;
  now: () => number;
  signal: AbortSignal;
}

export interface ExecOutput {
  port: string;
  name: string;
  kind: ArtifactRef['kind'];
  mime: string;
  lang?: Lang;
  /** JSON value (stored canonically) or bytes. */
  data: unknown;
  bytes?: Uint8Array;
  meta?: ArtifactRef['meta'];
}

export interface ExecResult {
  outputs: ExecOutput[];
  provides: Contract;
  checks?: StepCheck[];
  status?: 'ok' | 'needs-you' | 'failed';
  /** Real cost; null = unknown (settled at the reservation). */
  costUsd: number | null;
  model?: string | null;
  requests?: Provenance['requests'];
  /** Extra gate records (mock mode writes `by: 'mock'`). */
  signoffs?: Omit<SignOff, 'version' | 'hash'>[];
}

export interface EstimateInput {
  recipe: Recipe;
  node: PipelineNode;
  connector: string;
  mode: 'live' | 'mock';
  /** Upstream JSON by port when already made (quantities come from inputs, never from a model). */
  byPort: Record<string, unknown>;
}

export interface ExecEstimate {
  usdLow: number;
  usdHigh: number;
  seconds: number;
  basis: string;
  verified: boolean;
  /** No price known ("~$?"): `usdHigh` is the connector's per-call ceiling. */
  unknown?: boolean;
}

export interface Executor {
  kind: StepKind;
  /** `<kind>@<n>`; bumping it marks existing versions "Signal updated this step". */
  implVersion: string;
  deterministic: boolean;
  estimate(input: EstimateInput): ExecEstimate;
  run(input: ExecInput): Promise<ExecResult>;
  job?: {
    submit(input: ExecInput): Promise<{ requestId: string }>;
    collect(requestId: string, input: ExecInput): Promise<ExecResult>;
  };
  /** The contract of a user-edited output (`step.edit`). */
  contractOf?(data: Record<string, unknown>, node: PipelineNode): Contract;
}

export type ExecutorRegistry = Record<StepKind, Executor>;
