// The owner's own agents (rows claude-cli, agent-sdk, codex). Signal never reads their sign-ins: it finds
// the CLI (`cliBin`, `--version`, Codex `login status`) and runs it with the existing allow-listed environments, so
// no saved key reaches a child process: `cliEnv()` passes only the one credential a Claude run needs on
// API-key billing and `codexEnv()` none.
//
// - claude-cli: `claude -p` with the same envelope as claude-agent.ts (--restricted, --strict-mcp-config, every
//   built-in tool denied, no session on disk), the prompt on stdin, the role budget as --max-budget-usd on API-key
//   billing. Vision mode widens the envelope (Read inside the temp cwd, which then holds only the contact
//   sheets and the timeline the request hands over) and needs a security review first: refused unless the registry
//   is built with the explicit `allowVision: true` (nothing in the app does that yet). The fallback
//   `visionTransport: 'stdin'` sends the images as base64 blocks of one stream-json message on stdin instead
//   (no file in the cwd, no tool at all); the same `allowVision` switch refuses it until the review.
// - agent-sdk: one role run through team/runtime.ts runRole() (API key only; no free check, so never tested).
// - codex: image generation through codex.ts codexImage(), attended only (a button press in an open app).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_DENIED_TOOLS, CLI_VISION_TOOLS, agentBilling, cliEnv, parseStreamLine, placeVisionFiles, visionStdin, type Billing, type VisionFile, type VisionTransport } from '../../claude-agent';
import { codexImage } from '../../codex';
import { runRole, type RoleTask, type RunDeps } from '../../team/runtime';
import type { Role } from '../../memory/types';
import { cliBin, cliInfo, type CliInfo } from '../../tools';
import { t } from '@/app/studio/copy/en';
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import { READ_AT, type RegisteredConnector, type Spawn } from './base';
import { defineConnector } from './define';
import { mockCardPng } from './mock/image';

export interface LlmRequest {
  /** Trusted task text plus any untrusted material already framed by the executor. */
  prompt: string;
  /** Step kind, for the mock's placeholder answer. */
  kind: string;
  maxTurns: number;
  /** The role's per-run cap, passed as --max-budget-usd on API-key billing. */
  budgetUsd: number;
  model?: string;
  vision?: boolean;
  /** Vision runs only: the files placed in the temp cwd (contact sheets and the text timeline). */
  files?: VisionFile[];
}
export interface LlmResult {
  text: string;
  costUsd: number | null;
  model: string | null;
  billing: Billing | null;
  mode: 'live' | 'mock';
}

export interface CliDeps {
  cliInfo?: (cli: 'claude' | 'codex') => Promise<CliInfo>;
  cliBin?: (cli: 'claude' | 'codex') => Promise<string>;
  billing?: () => Promise<Billing>;
  env?: () => NodeJS.ProcessEnv;
  runRole?: typeof runRole;
  codexImage?: typeof codexImage;
  /** run vision requests (default false: refused until the security review signs the envelope). */
  allowVision?: boolean;
  /** Files in the temp cwd for Read (default) or, the fallback, base64 blocks on stdin. */
  visionTransport?: VisionTransport;
  /** How long a status() probe answer is reused (default PROBE_TTL_MS). */
  probeTtlMs?: number;
  now?: () => number;
}

/** GET /api/studio/connections reads every row's status; a CLI probe spawns `--version` (and `codex login status`). */
export const PROBE_TTL_MS = 30_000;

/**
 * Reuses one cliInfo answer per CLI for ttlMs, and shares a probe that is still running, so repeated page loads do
 * not spawn the CLIs again. A failed probe is forgotten at once. Only status() uses it; test() always probes afresh.
 */
export function cachedCliInfo(info: (cli: 'claude' | 'codex') => Promise<CliInfo>, ttlMs: number = PROBE_TTL_MS, now: () => number = Date.now) {
  const memo = new Map<'claude' | 'codex', { at: number; p: Promise<CliInfo> }>();
  return (cli: 'claude' | 'codex'): Promise<CliInfo> => {
    const hit = memo.get(cli);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = info(cli);
    const entry = { at: now(), p };
    memo.set(cli, entry);
    p.catch(() => {
      if (memo.get(cli) === entry) memo.delete(cli);
    });
    return p;
  };
}

/** `claude -p` arguments for a Post maker step: no tools at all, bounded turns, the budget on API-key billing.
 *  `vision: true` names Read as the only tool (and allows it); every other denial stays, the web included. */
export function claudeCliArgs(o: { maxTurns: number; budgetUsd: number; billing: Billing; model?: string; vision?: boolean; visionTransport?: VisionTransport }): string[] {
  const turns = Math.max(1, Math.min(30, Math.round(o.maxTurns)));
  // Stdin fallback: the images travel in the message; no tool at all, Read stays denied.
  const stdin = o.vision === true && o.visionTransport === 'stdin';
  const vision = o.vision === true && !stdin;
  const denied = [...CLI_DENIED_TOOLS.filter((t) => !vision || !(CLI_VISION_TOOLS as readonly string[]).includes(t)), 'WebSearch', 'WebFetch'];
  const args = ['-p', ...(stdin ? ['--input-format', 'stream-json'] : []), '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--max-turns', String(turns), '--tools', vision ? CLI_VISION_TOOLS.join(',') : '', '--disallowedTools', denied.join(',')];
  if (vision) args.push('--allowedTools', CLI_VISION_TOOLS.join(','));
  if (o.billing === 'api-key') args.push('--max-budget-usd', Math.max(0.01, o.budgetUsd).toFixed(2));
  const model = (o.model ?? '').replace(/[^a-z0-9.\-]/gi, '');
  if (model) args.push('--model', model);
  return args;
}

function runCli(spawn: Spawn, bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; signal: AbortSignal; onLine: (l: string) => void; timeoutMs: number }): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: o.env, signal: o.signal });
    let buf = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), o.timeoutMs);
    p.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) o.onLine(line);
      }
    });
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) o.onLine(buf);
      resolve({ code, err });
    });
    p.stdin?.end(o.stdin);
  });
}

export function makeCliConnectors(deps: CliDeps = {}) {
  const info = deps.cliInfo ?? cliInfo;
  const probeInfo = cachedCliInfo(info, deps.probeTtlMs ?? PROBE_TTL_MS, deps.now ?? Date.now);
  const bin = deps.cliBin ?? cliBin;
  const billing = deps.billing ?? agentBilling;
  const env = deps.env ?? (() => process.env);

  const claudeCli: RegisteredConnector<LlmRequest, LlmResult> = defineConnector<LlmRequest, LlmResult>({
    id: 'claude-cli',
    title: 'Claude Code',
    kind: 'cli',
    group: 'making',
    capabilities: [
      { id: 'llm.text', source: 'claude-agent.ts (Claude Code 2.1.319 flags)', readAt: READ_AT },
      { id: 'llm.vision', limits: { status: 'needs security review' }, source: 'claude-agent.ts vision mode (off until reviewed)', readAt: READ_AT },
    ],
    costModel: { unit: 'token', usdPerUnit: null, minimumUsd: 0, perCallCeilingUsd: 2, billing: 'claude-plan', verified: false, source: 'role caps in agent-envelopes.ts (AGENT_BUDGET_USD pattern)', readAt: READ_AT },
    attendance: 'any',
    settingsGroup: null,
    feature: 'agents',
    gates: ['approval:claude-cli-agents'],
    probe: async () => {
      const i = await probeInfo('claude');
      return { installed: i.found, signedIn: null, version: i.version };
    },
    test: async () => {
      const i = await info('claude');
      return i.found ? { ok: true, text: t('connector.works', { service: 'Claude Code' }), costUsd: 0 } : { ok: false, text: t('connector.notInstalled', { service: 'Claude Code' }), costUsd: 0 };
    },
    estimate: (r) => ({ usdLow: 0, usdHigh: Math.max(0, r.budgetUsd), seconds: 120, basis: `role cap $${r.budgetUsd.toFixed(2)}` }),
    async invoke(r, ctx: InvokeCtx) {
      if (r.vision && !deps.allowVision) throw new PostmakerError(403, 'forbidden', 'Vision mode needs its security review first.');
      if (!r.vision && r.files?.length) throw new PostmakerError(400, 'validation', 'Files go only with a vision run.');
      const b = await billing();
      const viaStdin = r.vision === true && deps.visionTransport === 'stdin';
      const args = claudeCliArgs({ maxTurns: r.maxTurns, budgetUsd: r.budgetUsd, billing: b, model: r.model, vision: r.vision === true, ...(viaStdin ? { visionTransport: 'stdin' as const } : {}) });
      const spawn = ctx.deps.spawn ?? (await import('node:child_process')).spawn;
      const cwd = await fs.mkdtemp(path.join(/* turbopackIgnore: true */ os.tmpdir(), 'signal-pm-cli-'));
      const state: { chars: number; model?: string } = { chars: 0 };
      let result: { result?: string; is_error?: boolean; total_cost_usd?: number } | undefined;
      try {
        let stdin = r.prompt;
        try {
          if (viaStdin) stdin = visionStdin(r.prompt, r.files ?? []);
          else if (r.vision) await placeVisionFiles(cwd, r.files ?? []);
        } catch (e) {
          throw new PostmakerError(400, 'validation', (e as Error).message);
        }
        const out = await runCli(spawn, await bin('claude'), args, {
          cwd,
          env: cliEnv(b, env()) as NodeJS.ProcessEnv,
          stdin,
          signal: ctx.signal,
          timeoutMs: 8 * 60_000,
          onLine: (line) => {
            const p = parseStreamLine(line, state);
            for (const e of p.events) ctx.onEvent({ kind: e.kind, text: claudeCli.redact(e.text) });
            if (p.result) result = p.result;
          },
        });
        if (!result) throw new PostmakerError(502, 'upstream', `Claude Code stopped without an answer (exit ${out.code}). ${claudeCli.redact(out.err.trim().split('\n').pop() ?? '')}`.trim());
        if (result.is_error) throw new PostmakerError(502, 'upstream', `Claude Code reported an error. ${claudeCli.redact(String(result.result ?? '').slice(0, 200))}`.trim());
        return { text: String(result.result ?? ''), costUsd: b === 'api-key' ? (typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null) : 0, model: state.model ?? null, billing: b, mode: 'live' };
      } finally {
        await fs.rm(/* turbopackIgnore: true */ cwd, { recursive: true, force: true }); // our own temp folder only
      }
    },
    mock: async (r) => ({ text: JSON.stringify({ mock: true, kind: r.kind }), costUsd: 0, model: null, billing: null, mode: 'mock' }),
  });

  const agentSdk: RegisteredConnector<{ role: Role; task: RoleTask }, { value: unknown; costUsd: number | null; mode: 'live' | 'mock' }> = defineConnector<{ role: Role; task: RoleTask }, { value: unknown; costUsd: number | null; mode: 'live' | 'mock' }>({
    id: 'agent-sdk',
    title: 'Claude Agent SDK',
    kind: 'api',
    group: 'making',
    capabilities: [{ id: 'llm.text', source: 'team/runtime.ts runRole()', readAt: READ_AT }],
    costModel: { unit: 'token', usdPerUnit: null, minimumUsd: 0, perCallCeilingUsd: 2, billing: 'vendor-key', verified: false, source: 'role caps in team/roles.ts', readAt: READ_AT },
    attendance: 'any',
    settingsGroup: 'anthropic',
    feature: 'agentsApiKey',
    gates: ['approval:agent-team'],
    // test(): the default answer ('Key saved. Not tested.' or the needs-key line): any SDK call spends.
    estimate: () => ({ usdLow: 0, usdHigh: 2, seconds: 180, basis: 'role cap' }),
    async invoke(r, ctx) {
      const run = deps.runRole ?? runRole;
      const onEvent: RunDeps['onEvent'] = (e) => ctx.onEvent({ kind: e.kind, text: agentSdk.redact(e.text) });
      const out = await run(r.role, r.task, { onEvent });
      return { value: out.value, costUsd: out.run.costUsd, mode: 'live' };
    },
    mock: async () => ({ value: null, costUsd: 0, mode: 'mock' }),
  });

  const codex: RegisteredConnector<{ prompt: string; width: number; height: number }, { image: Buffer; cliVersion: string | null; mode: 'live' | 'mock' }> = defineConnector<{ prompt: string; width: number; height: number }, { image: Buffer; cliVersion: string | null; mode: 'live' | 'mock' }>({
    id: 'codex',
    title: 'Codex',
    kind: 'cli',
    group: 'making',
    capabilities: [{ id: 'image.generate', source: 'codex.ts (codex-cli 0.159.3 flags)', readAt: READ_AT }],
    costModel: { unit: 'request', usdPerUnit: 0, minimumUsd: 0, perCallCeilingUsd: 0, billing: 'owner-plan', verified: false, source: 'codex.ts (the owner’s own Codex plan)', readAt: READ_AT },
    attendance: 'attended-only',
    settingsGroup: null,
    feature: 'postmaker',
    gates: ['approval:codex-images'],
    probe: async () => {
      const i = await probeInfo('codex');
      return { installed: i.found, signedIn: i.signedIn, version: i.version };
    },
    test: async () => {
      const i = await info('codex');
      if (!i.found) return { ok: false, text: t('connector.notInstalled', { service: 'Codex' }), costUsd: 0 };
      if (i.signedIn === false) return { ok: false, text: t('connector.needsSignIn', { service: 'Codex' }), costUsd: 0 };
      return { ok: true, text: t('connector.works', { service: 'Codex' }), costUsd: 0 };
    },
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 240, basis: 'your Codex plan' }),
    async invoke(r) {
      const out = await (deps.codexImage ?? codexImage)(r.prompt, r.width, r.height);
      return { image: out.png, cliVersion: out.cliVersion, mode: 'live' };
    },
    mock: async (r) => ({ image: await mockCardPng(r.prompt, r.width, r.height), cliVersion: null, mode: 'mock' }),
  });

  return { claudeCli, agentSdk, codex };
}
