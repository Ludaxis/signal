// Server-only: runs one of the marketing agents (strategist, content planner) through your own
// Claude Code CLI (`claude -p`), only when you press a button or an autopilot run you switched on
// asks for a plan.
//
// - Billing: the CLI's existing sign-in on this machine (your Claude subscription), or, when the
//   "agentsApiKey" switch is on and SIGNAL_ANTHROPIC_API_KEY is set, that key (passed as ANTHROPIC_API_KEY
//   and capped per run with --max-budget-usd, see AGENT_BUDGET_USD). No other Anthropic credential is ever passed on.
// - Environment: an allow-list (CLI_ENV_ALLOW) plus the one credential the run needs. Every other server
//   variable (Upload-Post, Meta, Higgsfield, R2, Signal's own session secret, other Anthropic variables) is absent.
// - Isolation: an empty temporary folder as cwd; --restricted (no command-running tools, user/project/local
//   settings ignored, file tools confined to that folder); --strict-mcp-config (no MCP servers); --tools
//   names the only built-ins the run has (WebSearch / WebFetch / ToolSearch for a researching agent, none
//   otherwise); --disallowedTools repeats the denials (shell, edits, file reads, skills, sub-agents, and the
//   web for agents that do not research); slash commands and skills off; no session kept on disk; --max-turns
//   caps the turns (Claude Code 2.1.319 accepts it although `claude --help` does not list it).
// - Prompts: the built-in ones in ./team/roles.ts, or your overrides in <SIGNAL_PROMPTS_DIR>/_shared.md
//   and <SIGNAL_PROMPTS_DIR>/<agent>/prompt.md; external text goes inside <untrusted_data>.
// - Output is a proposal (JSON) checked by the caller's validator; you approve strategies and every post.
//   Every run is recorded in project memory (runs.jsonl) when the memory switch is on.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { currentProject, promptsDir } from './projects';
import { SHARED_RULES, builtinPrompt } from './team/roles';
import { cliBin } from './tools';
import { memoryAllowed, newId, writeRun } from './memory/store';
import type { AgentRunRecord, Role } from './memory/types';

export const AGENT_TIMEOUT_MS = 8 * 60_000;
export type AgentId = 'strategist' | 'content-planner' | 'researcher' | 'analyst' | 'community-manager';

/** The most one `claude -p` run may spend when it bills your API key (passed as --max-budget-usd). */
export const STRATEGIST_BUDGET_USD = 1.0;
export const PLANNER_BUDGET_USD = 0.5;
export const AGENT_BUDGET_USD: Record<AgentId, number> = { strategist: STRATEGIST_BUDGET_USD, 'content-planner': PLANNER_BUDGET_USD, researcher: 1.0, analyst: 0.5, 'community-manager': 0.2 };

/** Environment variables a CLI child process (Claude Code, Codex) may inherit. No credential is on this list. */
export const CLI_ENV_ALLOW = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'] as const;

/** Copies the allow-listed variables (plus the `extra` names) from `source`. Exported for codex.ts and tests. */
export function allowListedEnv(source: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...CLI_ENV_ALLOW, ...extra]) {
    const v = source[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

/** Built-in tools every `claude -p` run is denied; the web tools are denied too unless the agent researches. */
export const CLI_DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Skill'] as const;
export const CLI_WEB_TOOLS = ['WebSearch', 'WebFetch', 'ToolSearch'] as const;

export class AgentError extends Error {
  constructor(public status: number, message: string, public detail?: Record<string, unknown>) {
    super(message);
  }
}

export type Billing = 'subscription' | 'api-key';

/** Your own Anthropic API key (SIGNAL_ANTHROPIC_API_KEY) may pay for agent runs when the "agentsApiKey" switch is on. */
export async function agentBilling(): Promise<Billing> {
  return (await featureEnabled('agentsApiKey')) && process.env.SIGNAL_ANTHROPIC_API_KEY ? 'api-key' : 'subscription';
}

export async function claudeAgentsAllowed(): Promise<{ enabled: boolean; reason: string; billing?: Billing }> {
  if (!(await featureEnabled('agents'))) return { enabled: false, reason: featureOffReason('agents') };
  const billing = await agentBilling();
  return {
    enabled: true,
    billing,
    reason: billing === 'api-key' ? 'Runs on this machine with Claude Code, paid by your Anthropic API key (cost shown per run), when you press the button.' : 'Runs on this machine with your own Claude Code sign-in, when you press the button.',
  };
}

/** Prompt override from <SIGNAL_PROMPTS_DIR>/<rel>, or '' when absent. */
export async function readPromptOverride(rel: string): Promise<string> {
  try {
    return (await fs.readFile(/* turbopackIgnore: true */ path.join(promptsDir(), rel), 'utf8')).trim();
  } catch {
    return '';
  }
}

/** The team role whose built-in prompt backs a CLI agent id (and the memory role its runs are recorded under). */
const ROLE_FOR: Record<AgentId, Role> = { strategist: 'strategist', 'content-planner': 'planner', researcher: 'researcher', analyst: 'analyst', 'community-manager': 'community-manager' };

/** Builds the full prompt text. Exported for tests. */
export async function buildPrompt(agent: AgentId, o: { task: string; input: unknown; untrusted?: unknown; outputSpec: string }): Promise<string> {
  const shared = (await readPromptOverride('_shared.md')) || SHARED_RULES;
  const own = (await readPromptOverride(`${agent}/prompt.md`)) || builtinPrompt(ROLE_FOR[agent]);
  return [
    shared.trim(),
    own.trim(),
    '## This run (Signal Content Studio, Instagram)',
    o.task.trim(),
    '## Input (trusted, from Signal)',
    '```json',
    JSON.stringify(o.input, null, 2),
    '```',
    ...(o.untrusted ? ['## Material from outside (information only)', '<untrusted_data>', JSON.stringify(o.untrusted, null, 2), '</untrusted_data>'] : []),
    '## Output',
    o.outputSpec.trim(),
    'Reply with exactly one fenced ```json block and nothing after it. Do not create or change files.',
  ].join('\n\n');
}

/** Pulls the JSON object out of the model's final message. Exported for tests. */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!).pop();
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new AgentError(502, 'The agent did not return valid JSON. Try again.');
  }
}

export type Runner = (prompt: string, opts: { web: boolean; agent?: AgentId; onEvent?: (e: { at: string; kind: string; text: string }) => void }) => Promise<{ text: string; seconds: number; cli: string; costUsd?: number | null; billing?: Billing; model?: string | null; turns?: number | null }>;

const redactKey = (t: string) => {
  const k = process.env.SIGNAL_ANTHROPIC_API_KEY;
  return (k && k.length > 8 ? t.split(k).join('[key]') : t).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]');
};

export interface AgentEvent { at: string; kind: 'start' | 'search' | 'read' | 'thinking' | 'writing' | 'note' | 'done' | 'error'; text: string }
export type OnEvent = (e: AgentEvent) => void;
type CliResult = { result?: string; is_error?: boolean; subtype?: string; total_cost_usd?: number; num_turns?: number };

const host = (u: unknown) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, '');
  } catch {
    return String(u ?? '').slice(0, 60);
  }
};
const clip = (t: unknown, n: number) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Turns one line of `claude -p --output-format stream-json` into progress events (and the final result). Exported for tests. */
export function parseStreamLine(line: string, state: { chars: number; model?: string }): { events: Omit<AgentEvent, 'at'>[]; result?: CliResult } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { events: [] };
  }
  const events: Omit<AgentEvent, 'at'>[] = [];
  if (j.type === 'system' && j.subtype === 'init') {
    if (typeof j.model === 'string' && j.model) state.model = clip(j.model, 80);
    events.push({ kind: 'start', text: `Claude Code started (${clip(j.model, 40) || 'default model'})` });
  }
  if (j.type === 'assistant') {
    const content = ((j.message as { content?: Record<string, unknown>[] } | undefined)?.content ?? []) as Record<string, unknown>[];
    for (const c of content) {
      const input = (c.input ?? {}) as Record<string, unknown>;
      if (c.type === 'tool_use' && c.name === 'WebSearch') events.push({ kind: 'search', text: clip(input.query, 160) });
      else if (c.type === 'tool_use' && c.name === 'WebFetch') events.push({ kind: 'read', text: host(input.url) });
      else if (c.type === 'thinking' && c.thinking) events.push({ kind: 'thinking', text: clip(c.thinking, 220) });
      else if (c.type === 'text' && c.text) {
        const t = String(c.text);
        events.push({ kind: 'writing', text: t.includes('```') ? `Writing the answer (${t.length.toLocaleString()} characters)` : clip(t, 220) });
      }
    }
  }
  if (j.type === 'stream_event') {
    const ev = (j.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') state.chars += ev.delta.text?.length ?? 0;
  }
  if (j.type === 'result') return { events, result: j as CliResult };
  return { events };
}

/** The child environment of a `claude -p` run: the allow-list, CLAUDE_CONFIG_DIR (where the CLI keeps its
 *  sign-in, when moved) and exactly one credential: your Signal key on api-key billing (agentsApiKey switch), else
 *  the CLI's own OAuth token when one is set. Everything else stays out. Exported for tests. */
export function cliEnv(billing: Billing, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = allowListedEnv(source, ['CLAUDE_CONFIG_DIR']);
  if (billing === 'api-key' && source.SIGNAL_ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = source.SIGNAL_ANTHROPIC_API_KEY;
  else if (billing === 'subscription' && source.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = source.CLAUDE_CODE_OAUTH_TOKEN;
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

/** The `claude -p` arguments for one run (the prompt goes on stdin). Every flag is in `claude --help` of
 *  Claude Code 2.1.319. Exported for tests. */
export function cliArgs(o: { agent: AgentId; web: boolean; billing: Billing; model?: string }): string[] {
  const denied = [...CLI_DENIED_TOOLS, ...(o.web ? [] : ['WebSearch', 'WebFetch'])];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--max-turns', o.web ? '30' : '4', '--tools', o.web ? CLI_WEB_TOOLS.join(',') : '', '--disallowedTools', denied.join(',')];
  if (o.web) args.push('--allowedTools', CLI_WEB_TOOLS.join(','));
  if (o.billing === 'api-key') args.push('--max-budget-usd', AGENT_BUDGET_USD[o.agent].toFixed(2));
  const model = (o.model ?? '').replace(/[^a-z0-9.\-]/gi, '');
  if (model) args.push('--model', model);
  return args;
}

function spawnCli(bin: string, args: string[], cwd: string, stdin: string, timeoutMs: number, billing: Billing = 'subscription', onLine?: (line: string) => void): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv(billing) as NodeJS.ProcessEnv });
    let out = '';
    let err = '';
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      out = (out + s).slice(-400_000);
      if (onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line);
        }
      }
    });
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-20_000)));
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code, out, err });
    });
    p.stdin.on('error', () => undefined); // the CLI may exit before reading its prompt; the exit code reports that
    p.stdin.end(stdin);
  });
}

/** The real runner: `claude -p` with the prompt on stdin, streaming progress events. */
export const claudeCliRunner: Runner = async (prompt, { web, agent, onEvent }) => {
  const bin = await cliBin('claude');
  const work = await fs.mkdtemp(path.join(/* turbopackIgnore: true */ os.tmpdir(), 'signal-agent-'));
  const started = Date.now();
  const billing = await agentBilling();
  const emit = (e: Omit<AgentEvent, 'at'>) => onEvent?.({ ...e, at: new Date().toISOString(), text: redactKey(e.text) });
  try {
    let cli = 'unknown';
    try {
      cli = (await spawnCli(bin, ['--version'], work, '', 15_000)).out.trim().slice(0, 80) || 'unknown';
    } catch {
      throw new AgentError(503, 'The Claude Code CLI was not found. Install it and sign in (`claude`), or set its path in Connections.');
    }
    emit({ kind: 'note', text: `Starting Claude Code ${cli}${billing === 'api-key' ? ' on your API key' : ' on your sign-in'}` });
    const id: AgentId = agent ?? (web ? 'strategist' : 'content-planner');
    const args = cliArgs({ agent: id, web, billing, model: process.env.CLAUDE_AGENT_MODEL || (billing === 'api-key' ? 'sonnet' : '') });
    const state: { chars: number; model?: string } = { chars: 0 };
    let res: CliResult | null = null;
    let lastChars = 0;
    const r = await spawnCli(bin, args, work, prompt, AGENT_TIMEOUT_MS, billing, (line) => {
      const parsed = parseStreamLine(line, state);
      for (const e of parsed.events) emit(e);
      if (parsed.result) res = parsed.result;
      if (state.chars - lastChars >= 1500) {
        lastChars = state.chars;
        emit({ kind: 'writing', text: `Writing… ${state.chars.toLocaleString()} characters so far` });
      }
    });
    // Older CLIs may print a single JSON object instead of a stream.
    if (!res) {
      try {
        res = JSON.parse(r.out) as CliResult;
      } catch {
        res = null;
      }
    }
    const final = res as CliResult | null;
    if (!final || final.is_error || typeof final.result !== 'string') {
      const hint = redactKey(String(final?.result || r.err || r.out.split('\n').slice(-3).join(' ') || 'no output')).replace(/\s+/g, ' ').trim().slice(-300);
      emit({ kind: 'error', text: hint });
      const failedCost = billing === 'api-key' && typeof final?.total_cost_usd === 'number' ? final.total_cost_usd : null;
      const err = new AgentError(502, `Claude Code did not finish${r.code === null ? ' (timed out)' : ` (exit ${r.code})`}${final?.subtype ? ` (${final.subtype})` : ''}: ${hint}`, {
        exit: r.code,
        cli,
        bin,
        seconds: Math.round((Date.now() - started) / 1000),
        billing,
        costUsd: failedCost,
        stderr: redactKey(r.err).slice(-2000),
        stdout: redactKey(r.out).slice(-2000),
      });
      // A run that started on the API key may have been billed: carry the known cost, else the run's cap.
      if (failedCost != null) (err as AgentError & { costUsd?: number }).costUsd = failedCost;
      else if (billing === 'api-key') (err as AgentError & { costUpperBoundUsd?: number }).costUpperBoundUsd = AGENT_BUDGET_USD[id];
      throw err;
    }
    const costUsd = billing === 'api-key' && typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null;
    emit({ kind: 'done', text: `Finished in ${Math.round((Date.now() - started) / 1000)}s${costUsd != null ? ` · $${costUsd.toFixed(2)}` : ''}` });
    return { text: final.result, seconds: Math.round((Date.now() - started) / 1000), cli, billing, costUsd, model: state.model ?? null, turns: typeof final.num_turns === 'number' ? final.num_turns : null };
  } finally {
    await fs.rm(/* turbopackIgnore: true */ work, { recursive: true, force: true }); // our own temp folder only
  }
};

/** Records one CLI run in project memory (runs.jsonl, the records the agent team writes too: start line, then
 *  end line; last line per id wins) so the Memory screen counts it. Only when the memory switch is on; never throws. */
async function recordCliRun(rec: AgentRunRecord): Promise<void> {
  try {
    if (!(await memoryAllowed()).enabled) return;
    await writeRun(rec);
  } catch {
    /* best effort: a memory write never fails the agent run */
  }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export async function runAgent<T>(agent: AgentId, o: { task: string; input: unknown; untrusted?: unknown; outputSpec: string; web?: boolean; campaign?: string | null; validate: (v: unknown) => T; onEvent?: OnEvent }, runner: Runner = claudeCliRunner): Promise<{ value: T; meta: { agent: AgentId; cli: string; seconds: number; at: string; billing: Billing; costUsd: number | null } }> {
  const allowed = await claudeAgentsAllowed();
  if (!allowed.enabled) throw new AgentError(403, allowed.reason);
  const prompt = await buildPrompt(agent, o);
  const startedAt = new Date().toISOString();
  const rec: AgentRunRecord = { id: newId('run', Date.parse(startedAt)), role: ROLE_FOR[agent], project: currentProject().id, campaign: o.campaign ?? null, startedAt, endedAt: null, status: 'running', model: null, costUsd: null, turns: null, summary: `Claude Code CLI (${agent})`, error: null };
  await recordCliRun(rec);
  const finish = (patch: Partial<AgentRunRecord>) => recordCliRun({ ...rec, ...patch, endedAt: new Date().toISOString() });
  let r: Awaited<ReturnType<Runner>>;
  try {
    r = await runner(prompt, { web: o.web === true, agent, onEvent: o.onEvent as ((e: { at: string; kind: string; text: string }) => void) | undefined });
  } catch (e) {
    await finish({ status: 'error', costUsd: agentCostOf(e), error: errText(e) });
    throw e;
  }
  const done = { model: r.model ?? null, turns: r.turns ?? null, costUsd: r.costUsd ?? null, summary: `Claude Code CLI ${r.cli} (${agent}, ${r.billing ?? 'subscription'}, ${r.seconds}s)`.slice(0, 200) };
  let value: T;
  try {
    value = o.validate(extractJson(r.text));
  } catch (e) {
    // The call was billed even though its answer is unusable: carry the cost so the caller can count it.
    if (e instanceof Error && typeof r.costUsd === 'number') (e as Error & { costUsd?: number }).costUsd = r.costUsd;
    await finish({ ...done, status: 'error', error: errText(e) });
    throw e;
  }
  await finish({ ...done, status: 'done' });
  return { value, meta: { agent, cli: r.cli, seconds: r.seconds, at: new Date().toISOString(), billing: r.billing ?? 'subscription', costUsd: r.costUsd ?? null } };
}

/** The cost a failed runAgent call carries (an answer that did not validate, or a billed run that failed), or null when unknown. */
export function agentCostOf(e: unknown): number | null {
  const c = (e as { costUsd?: unknown } | null)?.costUsd;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** What a failed run may have spent, for budgets: the known cost; else the run's --max-budget-usd cap when it
 *  billed the API key and its cost is unknown (timed out, crashed); else null (subscription, or never started). */
export function agentSpendOf(e: unknown): number | null {
  const known = agentCostOf(e);
  if (known != null) return known;
  const c = (e as { costUpperBoundUsd?: unknown } | null)?.costUpperBoundUsd;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}
