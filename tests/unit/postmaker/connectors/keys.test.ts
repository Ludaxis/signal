// @vitest-environment node
// (needs-key state and line), (keys stored encrypted in a temp ~/.signal, at most the last 4 characters
// leave the server, and the child process of a fake CLI run lacks every key).
import '../guard';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveGroup, settingsStatus } from '@/lib/studio/app-settings';
import { CLI_ENV_ALLOW } from '@/lib/studio/claude-agent';
import { codexEnv } from '@/lib/studio/codex';
import { buildRegistry, connectorRows } from '@/lib/studio/postmaker/connectors';
import { claudeCliArgs, makeCliConnectors } from '@/lib/studio/postmaker/connectors/cli';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { env, setKeys, switchOn } from './env';
import { ctxOf, FAKE_KEYS, fakeSpawn } from './fakes';

describe('a connector whose key group is incomplete', () => {
  it('reports needs-key with "‹Name› needs a key." and a Connections fix', async () => {
    switchOn('postmakerElevenlabs', 'postmakerAzureSpeech', 'postmakerSync', 'postmakerHedra');
    const reg = buildRegistry();
    for (const [id, name] of [['elevenlabs', 'ElevenLabs'], ['azure-speech', 'Azure Speech'], ['sync', 'Sync'], ['hedra', 'Hedra']] as const) {
      expect(await reg.find((c) => c.id === id)!.status(), id).toEqual({ state: 'needs-key', line: `${name} needs a key.`, fix: 'connections', version: null });
    }
    // Azure needs both its key and its region.
    process.env.AZURE_SPEECH_KEY = FAKE_KEYS.AZURE_SPEECH_KEY;
    expect((await reg.find((c) => c.id === 'azure-speech')!.status()).state).toBe('needs-key');
    process.env.AZURE_SPEECH_REGION = 'westeurope';
    expect((await reg.find((c) => c.id === 'azure-speech')!.status()).state).toBe('not-allowed');
  });

  it('format checks only: a malformed key or region is refused before saving, nothing is sent anywhere', async () => {
    await expect(saveGroup('elevenlabs', { ELEVENLABS_API_KEY: 'short' })).rejects.toThrow(/does not look right/);
    await expect(saveGroup('azure-speech', { AZURE_SPEECH_REGION: 'West Europe' })).rejects.toThrow(/does not look right/);
    await expect(saveGroup('sync', { SYNC_API_KEY: 'has space in it 123' })).rejects.toThrow(/does not look right/);
    await expect(saveGroup('hedra', { HEDRA_API_KEY: FAKE_KEYS.HEDRA_API_KEY })).resolves.toEqual(['API key']);
  });
});

describe('saved keys stay in the encrypted store', () => {
  it('stores the key encrypted in the temp secrets folder; status shows at most the last 4 characters', async () => {
    await saveGroup('elevenlabs', { ELEVENLABS_API_KEY: FAKE_KEYS.ELEVENLABS_API_KEY });
    await saveGroup('sync', { SYNC_API_KEY: FAKE_KEYS.SYNC_API_KEY });
    const file = readFileSync(path.join(env.secrets, 'settings.json'), 'utf8');
    expect(file).not.toContain(FAKE_KEYS.ELEVENLABS_API_KEY);
    expect(file).not.toContain('fixture-elevenlabs');
    const st = await settingsStatus();
    const el = st.groups.find((g) => g.id === 'elevenlabs')!;
    expect(el.fields[0]).toMatchObject({ source: 'saved', value: null, hint: '…aaaa' });
    const out = JSON.stringify(st) + JSON.stringify(await connectorRows());
    for (const v of [FAKE_KEYS.ELEVENLABS_API_KEY, FAKE_KEYS.SYNC_API_KEY]) {
      expect(out).not.toContain(v);
      expect(out).not.toContain(v.slice(0, -4)); // nothing beyond the last 4
    }
  });

  it('a fake Claude CLI run (subscription billing) gets the allow-listed environment and none of the keys', async () => {
    setKeys();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth-token-0000';
    const { spawn, calls } = fakeSpawn({ stdout: [JSON.stringify({ type: 'system', subtype: 'init', model: 'fixture-model' }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking about it' }] } }), JSON.stringify({ type: 'result', result: '```json\n{"ok":true}\n```', total_cost_usd: 0.12 })] });
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude' });
    const ctx = ctxOf({ deps: { spawn } });
    const r = await claudeCli.invoke({ prompt: 'Write the beats.', kind: 'script', maxTurns: 6, budgetUsd: 1.2 }, ctx);
    expect(r).toMatchObject({ text: '```json\n{"ok":true}\n```', costUsd: 0, model: 'fixture-model', billing: 'subscription', mode: 'live' });
    const call = calls[0]!;
    expect(call.bin).toBe('/fake/claude');
    expect(call.stdin).toBe('Write the beats.');
    const allowed = new Set<string>([...CLI_ENV_ALLOW, 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_OAUTH_TOKEN']);
    for (const k of Object.keys(call.env)) expect(allowed.has(k), k).toBe(true);
    const values = Object.values(call.env).join('\n');
    for (const v of Object.values(FAKE_KEYS)) if (v.length > 12) expect(values).not.toContain(v);
    expect(values).not.toContain(process.env.SIGNAL_TOKEN_KEY!);
    expect(call.args).toEqual(claudeCliArgs({ maxTurns: 6, budgetUsd: 1.2, billing: 'subscription' }));
    expect(call.args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '--no-session-persistence']));
    expect(call.args).not.toContain('--max-budget-usd');
    expect(ctx.events.map((e) => e.kind)).toEqual(['start', 'writing']);
  });

  it('on API-key billing the only credential passed is that one key (as ANTHROPIC_API_KEY), with the role cap', async () => {
    setKeys();
    const { spawn, calls } = fakeSpawn({ stdout: [JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.31 })] });
    const { claudeCli } = makeCliConnectors({ billing: async () => 'api-key', cliBin: async () => '/fake/claude' });
    const r = await claudeCli.invoke({ prompt: 'x', kind: 'script', maxTurns: 6, budgetUsd: 1.2 }, ctxOf({ deps: { spawn } }));
    expect(r.costUsd).toBe(0.31);
    const e = calls[0]!.env;
    expect(e.ANTHROPIC_API_KEY).toBe(FAKE_KEYS.SIGNAL_ANTHROPIC_API_KEY);
    const others = Object.entries(e).filter(([k]) => k !== 'ANTHROPIC_API_KEY').map(([, v]) => v).join('\n');
    for (const v of Object.values(FAKE_KEYS)) if (v.length > 12) expect(others).not.toContain(v);
    expect(calls[0]!.args.slice(-2)).toEqual(['--max-budget-usd', '1.20']);
  });

  it('a CLI error answer is redacted; vision mode is refused until its security review', async () => {
    setKeys();
    const { spawn } = fakeSpawn({ stdout: [JSON.stringify({ type: 'result', is_error: true, result: `bad ${FAKE_KEYS.SIGNAL_ANTHROPIC_API_KEY}` })] });
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude' });
    const err = (await claudeCli.invoke({ prompt: 'x', kind: 'script', maxTurns: 2, budgetUsd: 1 }, ctxOf({ deps: { spawn } })).catch((x: Error) => x)) as Error;
    expect(err.message).toMatch(/reported an error/);
    expect(err.message).not.toContain(FAKE_KEYS.SIGNAL_ANTHROPIC_API_KEY);
    await expect(claudeCli.invoke({ prompt: 'x', kind: 'analyse', maxTurns: 2, budgetUsd: 1, vision: true }, ctxOf({ deps: { spawn } }))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
  });

  it('the Codex child environment carries no key at all', () => {
    setKeys();
    const e = codexEnv(process.env);
    const values = Object.values(e).join('\n');
    for (const v of Object.values(FAKE_KEYS)) if (v.length > 12) expect(values).not.toContain(v);
    expect(Object.keys(e).every((k) => (CLI_ENV_ALLOW as readonly string[]).includes(k) || k === 'CODEX_HOME')).toBe(true);
  });
});
