// Cost and time estimates before running. Quantities come from inputs (each executor's `estimate`), never
// from a model; `usdHigh` is what the ledger reserves. Time is the critical path over the planned nodes, bounded below
// by the per-run concurrency. The token is an HMAC of (recipe heads, scope, usdHigh), so Run proves the user saw this
// estimate; a mismatch answers 409 "Estimate changed" with the new estimate. Default run cap:
// ceil((usdHigh × 1.25) / 0.5) × 0.5.
import { createHmac, randomBytes } from 'node:crypto';
import { PostmakerError } from './errors';
import { NODES_PER_RUN } from './graph/scheduler';
import { canonicalize } from './store/objects';
import type { Estimate, EstimateNode, StepHead } from './types';

type G = typeof globalThis & { __signalPostmakerEstimateKey?: Buffer };
/** A per-process secret: a token is valid for the life of the server that issued it. */
const key = () => ((globalThis as G).__signalPostmakerEstimateKey ??= randomBytes(32));

const MICRO = 1_000_000;
const micro = (usd: number) => Math.round(usd * MICRO);
const usd = (m: number) => m / MICRO;

export function defaultCapUsd(usdHigh: number): number {
  return Math.ceil(micro(usdHigh * 1.25) / micro(0.5)) * 0.5;
}

export function estimateToken(input: { recipeId: string; heads: Record<string, Pick<StepHead, 'current' | 'locked' | 'skipped'>>; scope: string[]; usdHigh: number }): string {
  const heads = Object.fromEntries(Object.entries(input.heads).map(([id, h]) => [id, [h.current, h.locked, h.skipped]]));
  const body = canonicalize({ recipeId: input.recipeId, heads, scope: input.scope, usdHigh: micro(input.usdHigh) });
  return createHmac('sha256', key()).update(body).digest('hex');
}

export interface PlanEstimateInput {
  recipeId: string;
  plan: string[]; // topological order
  parents: (nodeId: string) => string[];
  heads: Record<string, Pick<StepHead, 'current' | 'locked' | 'skipped'>>;
  nodes: (EstimateNode & { unknown?: boolean })[];
}

export function estimatePlan(input: PlanEstimateInput): Estimate {
  const byId = new Map(input.nodes.map((n) => [n.nodeId, n]));
  let low = 0;
  let high = 0;
  let total = 0;
  const finish = new Map<string, number>();
  for (const id of input.plan) {
    const n = byId.get(id);
    if (!n) continue;
    low += micro(n.usdLow);
    high += micro(n.usdHigh);
    total += n.seconds;
    const start = Math.max(0, ...input.parents(id).map((p) => finish.get(p) ?? 0));
    finish.set(id, start + n.seconds);
  }
  const critical = Math.max(0, ...finish.values());
  const seconds = Math.ceil(Math.max(critical, total / NODES_PER_RUN));
  const usdHigh = usd(high);
  const nodes = input.plan.map((id) => byId.get(id)).filter((n): n is EstimateNode & { unknown?: boolean } => !!n);
  return {
    usdLow: usd(low),
    usdHigh,
    seconds,
    nodes: nodes.map(({ unknown: _u, ...n }) => (void _u, n)),
    unknown: nodes.filter((n) => n.unknown).map((n) => n.nodeId),
    token: estimateToken({ recipeId: input.recipeId, heads: input.heads, scope: input.plan, usdHigh }),
  };
}

/** Run requires the token of the estimate the user confirmed. */
export function assertEstimateToken(current: Estimate, token: string | undefined): void {
  if (!token || token !== current.token) {
    const e = new PostmakerError(409, 'estimate-changed', 'Estimate changed');
    (e as PostmakerError & { estimate?: Estimate }).estimate = current;
    throw e;
  }
}
