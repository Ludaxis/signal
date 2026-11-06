// Agent team runtime: gates, SDK options, tool allow-lists, hook denials, run records, budget stops.
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { AgentError } from '@/lib/studio/claude-agent';
import { listEvents, listRuns } from '@/lib/studio/memory/store';
import type { Role } from '@/lib/studio/memory/types';
import { BUILTIN_TOOLS_DENIED, ROLES, ROLE_IDS, SIGNAL_TOOL_NAMES, allowedToolNames, disallowedToolNames, mcpToolName, systemPromptFor } from '@/lib/studio/team/roles';
import { runRole, subprocessEnv, teamAllowed } from '@/lib/studio/team/runtime';
import { signalMcpServer, signalTools } from '@/lib/studio/team/tools';
import { DECOYS, TEST_KEY, cleanupTeamEnv, fakeQuery, makePackage, setupTeamRoot } from './team-helpers';

const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
let root = '';

afterEach(() => {
  cleanupTeamEnv();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

async function hookOf(options: { hooks?: Partial<Record<string, { hooks: HookCallback[] }[]>> }): Promise<HookCallback> {
  const h = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!h) throw new Error('no PreToolUse hook');
  return h;
}
const preToolUse = (tool_name: string): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: {}, tool_use_id: 'tu_1', session_id: 's', transcript_path: '/dev/null', cwd: '/' });

describe('gates', () => {
  it('refuses with 403 and never calls the SDK when memory is switched off', async () => {
    root = setupTeamRoot({ memoryTeam: false });
    const { queryFn, calls } = fakeQuery({ structured_output: { ok: true } });
    await expect(runRole('reviewer', { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(0);
    expect((await teamAllowed()).reason).toMatch(/"memory"/);
  });
  it('refuses when agents are switched off or when there is no API key (the SDK cannot use a claude.ai login)', async () => {
    root = setupTeamRoot({ claudeAgents: false });
    const { queryFn, calls } = fakeQuery({ structured_output: { ok: true } });
    await expect(runRole('analyst', { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW })).rejects.toBeInstanceOf(AgentError);
    cleanupTeamEnv();
    rmSync(root, { recursive: true, force: true });
    root = setupTeamRoot({ claudeApiKey: false });
    const r = await teamAllowed();
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/API key/);
    await expect(runRole('analyst', { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW })).rejects.toMatchObject({ status: 403 });
    cleanupTeamEnv();
    rmSync(root, { recursive: true, force: true });
    root = setupTeamRoot({ key: false });
    expect((await teamAllowed()).enabled).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('SDK options', () => {
  it('isolates the run: no settings, no built-ins, role tools only, caps, model and key mapping', async () => {
    root = setupTeamRoot();
    const { queryFn, calls } = fakeQuery({ structured_output: { ok: true }, total_cost_usd: 0.07, num_turns: 2 });
    const { value, run } = await runRole<{ ok: boolean }>('reviewer', { prompt: 'Review it.', schema: SCHEMA, label: 'review post 01' }, { queryFn, now: NOW });
    expect(value).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.permissionPrompts).toBe('none');
    expect(o.tools).toEqual([]);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'Agent', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill']) expect(o.disallowedTools).toContain(t);
    expect(o.allowedTools).toEqual(ROLES.reviewer.tools.map(mcpToolName));
    expect(o.allowedTools).not.toContain('WebSearch');
    expect(o.maxBudgetUsd).toBe(0.3);
    expect(o.maxTurns).toBe(12);
    expect(o.model).toBe('sonnet');
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema: SCHEMA });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['signal']);
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(o.hooks?.PreToolUse?.[0]?.onFailure).toBe('block');
    expect(o.verbatimPrompts).toBe(true);
    // Environment: our key under the SDK's name, nothing else that could authenticate anywhere.
    const env = o.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe(TEST_KEY);
    expect(env.SIGNAL_ANTHROPIC_API_KEY).toBeUndefined();
    for (const k of Object.keys(DECOYS).filter((k) => k !== 'ANTHROPIC_API_KEY')) expect(env[k]).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toContain(o.cwd!);
    // The working folder was an empty temp folder and is gone afterwards.
    expect(o.cwd).toMatch(/signal-team-/);
    expect(existsSync(o.cwd!)).toBe(false);
    // The prompt carries the context pack, clearly marked, and the task.
    expect(calls[0]!.prompt).toMatch(/<context_pack role="reviewer"[\s\S]*<\/context_pack>/);
    expect(calls[0]!.prompt).toContain('Review it.');
    expect(typeof o.systemPrompt).toBe('string');
    expect(o.systemPrompt as string).toMatch(/shared rules/i);
    expect(o.systemPrompt as string).toMatch(/# Reviewer/);
    expect(run.status).toBe('done');
  });
  it('gives the researcher, and only the researcher, the web', async () => {
    root = setupTeamRoot();
    const { queryFn, calls } = fakeQuery({ structured_output: { ok: true } });
    await runRole('researcher', { prompt: 'Find it.', schema: SCHEMA }, { queryFn, now: NOW });
    const o = calls[0]!.options;
    expect(o.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.allowedTools).toEqual([...ROLES.researcher.tools.map(mcpToolName), 'WebSearch', 'WebFetch']);
    expect(o.disallowedTools).not.toContain('WebSearch');
    expect(o.disallowedTools).toContain('Bash');
    expect(o.model).toBe('sonnet');
    expect(o.maxBudgetUsd).toBe(1.0);
    for (const r of ROLE_IDS.filter((x) => x !== 'researcher')) {
      expect(disallowedToolNames(r)).toContain('WebSearch');
      expect(disallowedToolNames(r)).toContain('WebFetch');
      expect(allowedToolNames(r).some((t) => /^Web/.test(t))).toBe(false);
    }
    expect(disallowedToolNames('lead')).toEqual([...BUILTIN_TOOLS_DENIED]);
  });
  it('uses the agreed model tier and caps per role', async () => {
    root = setupTeamRoot();
    const want: Record<Role, [string, number]> = { lead: ['opus', 3], strategist: ['opus', 1.5], 'creative-producer': ['opus', 1.2], reviewer: ['sonnet', 0.3], analyst: ['sonnet', 0.8], planner: ['sonnet', 0.8], researcher: ['sonnet', 1.0], 'motion-designer': ['sonnet', 0.6], 'community-manager': ['haiku', 0.2] };
    for (const r of ROLE_IDS) {
      const { queryFn, calls } = fakeQuery({ structured_output: { ok: true } });
      await runRole(r, { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW });
      expect([calls[0]!.options.model, calls[0]!.options.maxBudgetUsd]).toEqual(want[r]);
      expect(calls[0]!.options.maxTurns).toBe(ROLES[r].maxTurns);
    }
  });
  it('subprocessEnv keeps only basics plus the Signal key', () => {
    root = setupTeamRoot();
    process.env.SOME_RANDOM_SECRET = 'nope';
    const env = subprocessEnv('/tmp/cfg');
    delete process.env.SOME_RANDOM_SECRET;
    expect(env.ANTHROPIC_API_KEY).toBe(TEST_KEY);
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
  });
});

describe('tool surface', () => {
  const FORBIDDEN = /publish|schedul|approv|send|reply_send|dispatch|meta|upload|post_now|delete/i;
  it('has no publishing, scheduling, approving or sending tool for any role', () => {
    for (const t of SIGNAL_TOOL_NAMES) expect(t).not.toMatch(FORBIDDEN);
    for (const r of ROLE_IDS) {
      for (const t of ROLES[r].tools) expect(SIGNAL_TOOL_NAMES).toContain(t);
      for (const t of allowedToolNames(r)) expect(t).not.toMatch(FORBIDDEN);
      const server = signalMcpServer({ role: r, campaign: null, now: NOW });
      expect(server.type).toBe('sdk');
      expect(server.name).toBe('signal');
    }
    const names = signalTools({ role: 'lead', campaign: null, now: NOW }).map((t) => t.name).sort();
    expect(names).toEqual([...SIGNAL_TOOL_NAMES].sort());
  });
  it('a tool handler refuses a role outside its allow-list and audits it', async () => {
    root = setupTeamRoot();
    await makePackage(root, '01');
    const audit: { tool: string; allowed: boolean }[] = [];
    const tools = signalTools({ role: 'analyst', campaign: null, now: NOW, audit: (a) => audit.push({ tool: a.tool, allowed: a.allowed }) });
    const writeReview = tools.find((t) => t.name === 'write_review')!;
    const r = await writeReview.handler({ id: '01', review: {} }, {});
    expect(r.isError).toBe(true);
    expect(String((r.content[0] as { text: string }).text)).toMatch(/analyst role may not use write_review/);
    expect(existsSync(`${root}/posts/01/review.json`)).toBe(false);
    const listPosts = tools.find((t) => t.name === 'list_posts')!;
    const ok = await listPosts.handler({}, {});
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse((ok.content[0] as { text: string }).text) as { posts: Record<string, unknown>[] };
    expect(body.posts[0]).toMatchObject({ id: '01', status: 'ready' });
    expect(JSON.stringify(body)).not.toMatch(/sha256|hashes|idempotency/);
    expect(audit).toEqual([{ tool: 'write_review', allowed: false }, { tool: 'list_posts', allowed: true }]);
  });
  it('the PreToolUse hook denies a tool outside the allow-list and lets role tools through', async () => {
    root = setupTeamRoot();
    const { queryFn, calls } = fakeQuery({ structured_output: { ok: true } });
    await runRole('reviewer', { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW });
    const hook = await hookOf(calls[0]!.options);
    const denied = (await hook(preToolUse('Bash'), 'tu_1', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toMatch(/mcp__signal__get_post/);
    const web = (await hook(preToolUse('WebSearch'), 'tu_2', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(web.hookSpecificOutput?.permissionDecision).toBe('deny');
    const other = (await hook(preToolUse('mcp__signal__write_report'), 'tu_3', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(other.hookSpecificOutput?.permissionDecision).toBe('deny');
    const allowed = (await hook(preToolUse('mcp__signal__get_post'), 'tu_4', { signal: new AbortController().signal })) as { continue?: boolean; hookSpecificOutput?: unknown };
    expect(allowed.continue).toBe(true);
    expect(allowed.hookSpecificOutput).toBeUndefined();
  });
});

describe('run records', () => {
  it('writes the run at start and end with cost, turns and model, and records agent.run', async () => {
    root = setupTeamRoot();
    const { queryFn } = fakeQuery({ structured_output: { ok: true }, total_cost_usd: 0.12, num_turns: 3 }, 'claude-sonnet-4-5-test');
    const { run } = await runRole('analyst', { prompt: 'x', schema: SCHEMA, label: 'weekly report' }, { queryFn, now: NOW });
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: run.id, role: 'analyst', project: 'demo', status: 'done', costUsd: 0.12, turns: 3, model: 'claude-sonnet-4-5-test' });
    expect(runs[0]!.endedAt).not.toBeNull();
    expect(runs[0]!.summary).toContain('weekly report');
    const ev = await listEvents({ types: ['agent.run'] });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ by: 'agent:analyst', refs: { run: run.id }, data: { status: 'done', costUsd: 0.12 } });
    expect(JSON.stringify(ev[0])).not.toContain(TEST_KEY);
  });
  it('maps a budget or turn stop to stopped-budget and reports the cost so far', async () => {
    root = setupTeamRoot();
    const { queryFn } = fakeQuery({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.31, num_turns: 9, errors: ['budget'] });
    await expect(runRole('reviewer', { prompt: 'x', schema: SCHEMA }, { queryFn, now: NOW })).rejects.toMatchObject({ status: 502, detail: { costUsd: 0.31 } });
    const turns = fakeQuery({ subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.05, num_turns: 12, errors: [] });
    await expect(runRole('reviewer', { prompt: 'x', schema: SCHEMA }, { queryFn: turns.queryFn, now: NOW + 1000 })).rejects.toThrow(/turn cap/);
    const runs = await listRuns();
    expect(runs.map((r) => r.status)).toEqual(['stopped-budget', 'stopped-budget']);
    expect(runs[0]).toMatchObject({ costUsd: 0.31, turns: 9 });
    expect(runs[0]!.error).toMatch(/budget cap \(\$0\.30\)/);
  });
  it('falls back to fenced JSON when there is no structured output, and rejects a wrong shape', async () => {
    root = setupTeamRoot();
    const fenced = fakeQuery({ result: 'Done.\n```json\n{"ok": false}\n```' });
    const r = await runRole<{ ok: boolean }>('lead', { prompt: 'x', schema: SCHEMA, validate: (v) => v as { ok: boolean } }, { queryFn: fenced.queryFn, now: NOW });
    expect(r.value).toEqual({ ok: false });
    const bad = fakeQuery({ structured_output: { nope: 1 } });
    await expect(
      runRole('lead', {
        prompt: 'x',
        schema: SCHEMA,
        validate: (v) => {
          if (typeof (v as { ok?: unknown }).ok !== 'boolean') throw new Error('ok missing');
          return v;
        },
      }, { queryFn: bad.queryFn, now: NOW + 1 }),
    ).rejects.toThrow(/wrong shape/);
    expect((await listRuns()).map((x) => x.status)).toEqual(['done', 'error']);
  });
  it('prefers prompt overrides when present and falls back to built-in prompts otherwise', async () => {
    root = setupTeamRoot();
    const builtin = await systemPromptFor('creative-producer');
    expect(builtin).toMatch(/# Creative producer/);
    expect(builtin).toMatch(/first second|first frame/i);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(`${root}/agents/creative-producer`, { recursive: true });
    writeFileSync(`${root}/agents/_shared.md`, '# Repo shared');
    writeFileSync(`${root}/agents/creative-producer/prompt.md`, '# Repo producer');
    expect(await systemPromptFor('creative-producer')).toBe('# Repo shared\n\n# Repo producer');
    expect(await systemPromptFor('reviewer')).toMatch(/^# Repo shared\n\n# Reviewer/);
  });
  it('built-in prompts carry the claims and measurement rules the code enforces', async () => {
    root = setupTeamRoot();
    const strategist = await systemPromptFor('strategist');
    expect(strategist).toMatch(/no "most people…"/);
    expect(strategist).toMatch(/no watch time, hold rate, retention/);
    expect(strategist).toMatch(/Signal drops hooks that break it/);
    expect(await systemPromptFor('planner')).toMatch(/Stay inside the dates and post types you are given/);
  });
});
