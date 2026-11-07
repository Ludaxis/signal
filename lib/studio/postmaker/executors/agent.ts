// The agent call of a Post maker step: one ContextBundle (built by code) becomes one prompt with the built-in role
// prompt (override: <SIGNAL_PROMPTS_DIR>/<role>/prompt.md), the trusted bundle as data and the untrusted material
// inside <untrusted_data>; one call through an injected `AgentCall` within the role's fixed envelope; one JSON answer
// checked by the executor's zod validator. The answer is a proposal: it never names a file Signal reads or a command
// Signal runs, and nothing in it can change the task text, the envelope or the tool arguments.
//
// Two adapters: `runnerCall` over claude-agent.ts `Runner` (for fake Runners in tests; a real CLI runner such as
// `claudeCliRunner` is refused unless the agents switch is on), and `connectorCall` over the claude-cli connector (the engine's live path, through
// callConnector with requireLive, so the single decision point allowed.ts decides).
import { agentEnvelope, buildPrompt, claudeAgentsAllowed, extractJson, isClaudeCliRunner, type AgentEnvelope, type PostmakerAgentId, type Runner, type VisionFile } from '../../claude-agent';
import { callConnector, type CallOptions } from '../connectors/allowed';
import type { RegisteredConnector } from '../connectors/base';
import type { LlmRequest, LlmResult } from '../connectors/cli';
import { buildContext, CONTEXT_BUDGET, type ContextInput } from '../context';
import { PostmakerError } from '../errors';
import { hashJson } from '../store/objects';
import type { ContextBundle, InvokeCtx, StepKind } from '../types';

export interface AgentCallRequest {
  agent: PostmakerAgentId;
  kind: StepKind;
  prompt: string;
  envelope: AgentEnvelope;
  /** Vision mode (analyse only): the contact sheets and the text timeline. */
  files?: VisionFile[];
}
export interface AgentCallResult {
  text: string;
  costUsd: number | null;
  model: string | null;
}
export type AgentCall = (req: AgentCallRequest, signal: AbortSignal) => Promise<AgentCallResult>;

/** estimate of an agent step: $0 in mock mode and on the Claude plan; up to the role cap on API-key billing. */
export function agentEstimate(mode: 'live' | 'mock', billing: 'subscription' | 'api-key' | undefined, capUsd: number, seconds: number) {
  if (mode === 'mock') return { usdLow: 0, usdHigh: 0, seconds: 1, basis: 'mock', verified: true };
  if (billing === 'api-key') return { usdLow: 0, usdHigh: capUsd, seconds, basis: `role cap $${capUsd.toFixed(2)}`, verified: true };
  return { usdLow: 0, usdHigh: 0, seconds, basis: 'Your Claude plan', verified: true };
}

/**
 * An AgentCall over a claude-agent Runner. Meant for fake runners in tests; the engine's live path is connectorCall.
 * A real CLI runner (makeClaudeCliRunner) is still refused unless the agents switch is on, the same gate runAgent
 * and the connector registry apply, so this adapter can never bypass it.
 */
export function runnerCall(runner: Runner): AgentCall {
  return async (req) => {
    if (isClaudeCliRunner(runner)) {
      const allowed = await claudeAgentsAllowed();
      if (!allowed.enabled) throw new PostmakerError(403, 'forbidden', allowed.reason);
    }
    const r = await runner(req.prompt, { web: false, agent: req.agent, kind: req.kind, ...(req.files ? { vision: { files: req.files } } : {}) });
    return { text: r.text, costUsd: r.costUsd ?? null, model: r.model ?? null };
  };
}

/** An AgentCall over the claude-cli connector (live only: a refused call fails the step, it never turns to mock). */
export function connectorCall(c: RegisteredConnector<LlmRequest, LlmResult>, ctx: Omit<InvokeCtx, 'signal'>, o: CallOptions = {}): AgentCall {
  return async (req, signal) => {
    const llm: LlmRequest = { prompt: req.prompt, kind: req.kind, maxTurns: req.envelope.maxTurns, budgetUsd: req.envelope.budgetUsd, model: req.envelope.model, ...(req.files ? { vision: true, files: req.files } : {}) };
    const out = await callConnector(c, llm, { ...ctx, signal }, { ...o, requireLive: true });
    return { text: out.result.text, costUsd: out.result.costUsd, model: out.result.model };
  };
}

/** The trusted part of a bundle, passed as data (everything except the task, the untrusted material and the spec). */
export function trustedInput(b: ContextBundle): Omit<ContextBundle, 'task' | 'untrusted' | 'outputSpec'> {
  const { task: _t, untrusted: _u, outputSpec: _o, ...rest } = b;
  void _t;
  void _u;
  void _o;
  return rest;
}

const hasUntrusted = (u: ContextBundle['untrusted']) => Boolean(u.referenceText) || (u.userNotes?.length ?? 0) > 0;

/** The full prompt of an agent step: shared rules, the role prompt, the fixed task, the bundle, the untrusted frame. */
export function agentPrompt(agent: PostmakerAgentId, b: ContextBundle): Promise<string> {
  return buildPrompt(agent, { task: b.task, input: trustedInput(b), ...(hasUntrusted(b.untrusted) ? { untrusted: b.untrusted } : {}), outputSpec: b.outputSpec, heading: 'Signal Post maker', compact: true });
}

const EMPTY: Pick<ContextBundle, 'upstream' | 'downstream' | 'neighbours' | 'pinned' | 'history' | 'rubric' | 'pack' | 'untrusted'> = { upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {} };

/**
 * The prompt within the whole 120,000-character budget: the bundle is re-fitted with the budget minus
 * the fixed text (shared rules, role prompt, task, output spec), so the builder's truncation order applies
 * (history → neighbours.after → pack.style → upstream summaries → reference text); escaped untrusted text that still
 * overflows is cut last. Returns the prompt and what was cut.
 */
export async function fittedPrompt(agent: PostmakerAgentId, b: ContextBundle, budget = CONTEXT_BUDGET): Promise<{ prompt: string; bundle: ContextBundle; truncated: string[] }> {
  const fixed = (await agentPrompt(agent, { ...b, ...EMPTY })).length;
  let room = Math.max(1_000, budget - fixed);
  let last = { prompt: '', bundle: b, truncated: [] as string[] };
  // Escaping (`<` → \u003c) makes the prompt longer than the bundle the builder measured; when trusted text holds
  // many angle brackets, fit again with the room reduced by the overflow (a few rounds at most).
  for (let round = 0; round < 6; round++) {
    const fit = buildContext(b as ContextInput, room);
    let bundle = fit.bundle;
    const truncated: string[] = [...fit.truncated];
    let prompt = await agentPrompt(agent, bundle);
    for (let i = 0; prompt.length > budget && i < 40; i++) {
      const u = { ...bundle.untrusted };
      const over = prompt.length - budget + 64;
      if (u.referenceText) u.referenceText = u.referenceText.slice(0, Math.max(0, u.referenceText.length - over));
      else if (u.userNotes?.some((n) => n.length > 0)) u.userNotes = u.userNotes!.map((n) => n.slice(0, Math.max(0, n.length - Math.ceil(over / u.userNotes!.length))));
      else break;
      bundle = { ...bundle, untrusted: u };
      if (!truncated.includes('untrusted')) truncated.push('untrusted');
      prompt = await agentPrompt(agent, bundle);
    }
    last = { prompt, bundle, truncated };
    if (prompt.length <= budget || room <= 1_000) break;
    room = Math.max(1_000, room - (prompt.length - budget) - 256);
  }
  if (last.prompt.length > budget) throw new PostmakerError(422, 'too-large', 'The step input is too large for one agent call.');
  return last;
}

export interface AgentStepResult<T> {
  value: T;
  costUsd: number | null;
  model: string | null;
  /** sha256 of the exact prompt text (provenance; "prompts are stored as objects"). */
  promptHash: string;
  /** What the context fit cut (the runner logs `context.truncated`). */
  truncated: string[];
}

/** Runs one agent step: prompt, call within the envelope, JSON extraction, validation. */
export async function callAgent<T>(o: { agent: PostmakerAgentId; kind: StepKind; bundle: ContextBundle; call: AgentCall | null; signal: AbortSignal; files?: VisionFile[]; validate: (v: unknown) => T }): Promise<AgentStepResult<T>> {
  if (!o.call) throw new PostmakerError(503, 'not_configured', 'Claude Code is not connected to Post maker.');
  const { prompt, truncated } = await fittedPrompt(o.agent, o.bundle);
  const envelope = agentEnvelope(o.agent, o.kind);
  const r = await o.call({ agent: o.agent, kind: o.kind, prompt, envelope: { ...envelope }, ...(o.files ? { files: o.files } : {}) }, o.signal);
  let raw: unknown;
  try {
    raw = extractJson(r.text);
  } catch {
    throw Object.assign(new PostmakerError(502, 'invalid-answer', 'The agent did not return valid JSON.'), { costUsd: r.costUsd });
  }
  try {
    return { value: o.validate(raw), costUsd: r.costUsd, model: r.model, promptHash: hashJson(prompt), truncated };
  } catch (e) {
    // The call was billed even though its answer is unusable: the cost travels with the error.
    if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = r.costUsd;
    throw e;
  }
}
