// @vitest-environment node
// Every registered connector implements the interface; test() of every connector is free (only the allowed
// free paths are fetched); status lines stay within 8 words in every state; every cost model carries source and
// readAt; connector chains are checked against the step kind's capabilities.
import '../guard';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putSecret } from '@/lib/studio/secret-box';
import { gateBackend, termsRefs } from '@/lib/studio/postmaker/connectors/allowed';
import { buildRegistry, connectorRows, CONNECTORS, connectorsFor, KIND_CAPABILITIES, validateChain } from '@/lib/studio/postmaker/connectors';
import { cachedCliInfo, PROBE_TTL_MS } from '@/lib/studio/postmaker/connectors/cli';
import { connectorStatus } from '@/lib/studio/postmaker/connectors/allowed';
import { isFeature, POSTMAKER_PAUSED_ENV } from '@/lib/studio/postmaker/connectors/features';
import type { CliInfo } from '@/lib/studio/tools';
import { STEP_KINDS } from '@/lib/studio/postmaker/types';
import { allSwitchesOn, setKeys, switchOn, writePostmakerConfig } from './env';
import { fakeFetch } from './fakes';

afterEach(() => vi.unstubAllGlobals());

const CAPS = ['llm.text', 'llm.vision', 'image.generate', 'image.export', 'video.i2v', 'tts', 'tts.timestamps', 'lipsync', 'music.generate', 'music.import', 'render.video', 'render.audio', 'audio.loudness'];
const EXPECTED_IDS = ['claude-cli', 'agent-sdk', 'codex', 'figma', 'higgsfield-image', 'higgsfield-video', 'elevenlabs', 'azure-speech', 'sync', 'hedra', 'elevenlabs-music', 'pack-music', 'owner-upload', 'browser-agent:suno', 'remotion', 'ffmpeg'];
const cli = (o: Partial<CliInfo> = {}) => async (c: 'claude' | 'codex'): Promise<CliInfo> => ({ cli: c, label: c, found: true, path: '/x', version: '9.9.9', source: 'path', signedIn: true, ...o });
const words = (s: string) => s.split(/\s+/).filter((w) => w && w !== '·').length;
const open = gateBackend({ approvals: { 'claude-cli-agents': async () => true, 'agent-team': async () => true, 'codex-images': async () => true, 'higgsfield-api': async () => true } });

describe('the registry', () => {
  it('holds exactly the expected connectors, each implementing the interface', () => {
    expect(CONNECTORS.map((c) => c.id)).toEqual(EXPECTED_IDS);
    for (const c of CONNECTORS) {
      expect(c.title, c.id).toMatch(/\S/);
      expect(['cli', 'api', 'browser-agent', 'local']).toContain(c.kind);
      expect(c.group).toBe('making');
      expect(c.capabilities.length, c.id).toBeGreaterThan(0);
      for (const k of c.capabilities) expect(CAPS).toContain(k.id);
      expect(['any', 'attended-only']).toContain(c.attendance);
      expect(isFeature(c.feature), c.id).toBe(true);
      expect(Array.isArray(c.gates)).toBe(true);
      for (const g of c.gates) expect(g, c.id).toMatch(/^(vendor|terms|approval):[a-z0-9-]+$/);
      for (const fn of ['status', 'test', 'estimate', 'invoke', 'mock', 'redact', 'keyPresent'] as const) expect(typeof c[fn], `${c.id}.${fn}`).toBe('function');
    }
  });

  it('every cost model carries source and readAt, is unverified, and has a per-call ceiling when it is paid by key', () => {
    for (const c of CONNECTORS) {
      const m = c.costModel;
      expect(m.source, c.id).toMatch(/\S/);
      expect(m.readAt, c.id).toBe('2026-11-06');
      expect(m.verified, c.id).toBe(false);
      if (m.billing === 'vendor-key') expect(m.perCallCeilingUsd, c.id).toBeGreaterThan(0);
      for (const k of c.capabilities) expect(k.source && k.readAt, `${c.id} ${k.id}`).toBeTruthy();
    }
  });

  it('every paid vendor connector names its terms ref; Codex and the browser agent are attended only', () => {
    for (const id of ['elevenlabs', 'azure-speech', 'sync', 'hedra', 'elevenlabs-music', 'higgsfield-video']) expect(CONNECTORS.find((c) => c.id === id)!.gates).toContain(`vendor:${id}`);
    expect(CONNECTORS.filter((c) => c.attendance === 'attended-only').map((c) => c.id)).toEqual(['codex', 'browser-agent:suno']);
  });

  it('test() of every connector is free: no paid request, only the free Figma /v1/me check is fetched', async () => {
    allSwitchesOn();
    setKeys();
    await putSecret('figma', 'token', 'figd_fixture_token_00000000000000');
    const { fetch, calls } = fakeFetch((url) => (url === 'https://api.figma.com/v1/me' ? { json: { handle: 'fixture-user' } } : undefined));
    vi.stubGlobal('fetch', fetch);
    for (const c of buildRegistry({ cliInfo: cli() })) {
      const r = await c.test();
      expect(r.costUsd, c.id).toBe(0);
      expect(typeof r.text).toBe('string');
    }
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual(['GET https://api.figma.com/v1/me']);
  });

  it('API connectors without a verified free check answer "Key saved. Not tested." (or the needs-key line)', async () => {
    const reg = buildRegistry();
    for (const id of ['elevenlabs', 'azure-speech', 'sync', 'hedra', 'elevenlabs-music', 'higgsfield-image', 'higgsfield-video', 'agent-sdk']) expect((await reg.find((c) => c.id === id)!.test()).ok, id).toBe(false);
    setKeys();
    for (const id of ['elevenlabs', 'azure-speech', 'sync', 'hedra', 'elevenlabs-music', 'higgsfield-image', 'higgsfield-video', 'agent-sdk']) expect(await reg.find((c) => c.id === id)!.test(), id).toEqual({ ok: true, text: 'Key saved. Not tested.', costUsd: 0 });
  });
});

describe('status lines (≤ 8 words, status dictionary)', () => {
  it('stay within 8 words in every state each connector can reach', async () => {
    const lines = new Map<string, string>();
    const collect = async (reg: ReturnType<typeof buildRegistry>, tag: string) => {
      for (const c of reg) {
        const s = await connectorStatus(c, { backend: open });
        lines.set(`${tag} ${c.id} ${s.state}`, s.line);
        expect(words(s.line), `${c.id}: ${s.line}`).toBeLessThanOrEqual(8);
        expect(s.line).not.toMatch(/\.env|runbook|rev \d|https?:/);
      }
    };
    await collect(buildRegistry({ cliInfo: cli() }), 'default');
    await collect(buildRegistry({ cliInfo: cli({ found: false }) }), 'missing');
    allSwitchesOn();
    await collect(buildRegistry({ cliInfo: cli({ signedIn: false }) }), 'no-key');
    setKeys();
    await collect(buildRegistry({ cliInfo: cli() }), 'no-record');
    writePostmakerConfig({ acceptedTerms: CONNECTORS.flatMap((c) => termsRefs(c)) });
    await collect(buildRegistry({ cliInfo: cli() }), 'ready');
    process.env[POSTMAKER_PAUSED_ENV] = '1';
    await collect(buildRegistry({ cliInfo: cli() }), 'paused');
    const states = new Set([...lines.keys()].map((k) => k.split(' ').at(-1)));
    expect([...states].sort()).toEqual(['needs-key', 'needs-sign-in', 'not-allowed', 'not-installed', 'off', 'ready']);
    expect(lines.get('ready elevenlabs ready')).toBe('Ready · Paid per use');
    expect(lines.get('ready claude-cli ready')).toBe('Ready · Uses your own plan');
    expect(lines.get('ready ffmpeg ready')).toBe('Ready · Runs on this computer');
    expect(lines.get('default elevenlabs off')).toBe('ElevenLabs is off. Runs as mock.');
    expect(lines.get('no-key sync needs-key')).toBe('Sync needs a key.');
    expect(lines.get('no-record hedra not-allowed')).toBe('Not allowed yet · Accept its terms');
    expect(lines.get('ready elevenlabs-music ready')).toBe('Ready · Paid per use');
    expect(lines.get('missing claude-cli not-installed')).toBe('Claude Code is not installed.');
    expect(lines.get('no-key codex needs-sign-in')).toBe('Sign in to Codex first.');
    expect(lines.get('paused elevenlabs off')).toBe('Post maker is paused. Runs as mock.');
  });

  it('Connections rows never carry a key value and show the switch state', async () => {
    setKeys();
    switchOn('postmakerSync');
    const rows = await connectorRows({ backend: open });
    expect(rows.map((r) => r.id)).toEqual(EXPECTED_IDS);
    expect(rows.find((r) => r.id === 'sync')!.switchOn).toBe(true);
    expect(rows.find((r) => r.id === 'elevenlabs')!.switchOn).toBe(false);
    const text = JSON.stringify(rows);
    for (const v of ['fixture-elevenlabs-key', 'fixture-sync-key', 'sk-ant-fixture', 'fixture-hf-secret']) expect(text).not.toContain(v);
  });
});

describe('CLI probes behind the Connections GET', () => {
  it('status() reuses one probe per CLI for 30 s and shares a running one; test() probes afresh', async () => {
    let clock = 1_000;
    const calls: string[] = [];
    const counting = async (c: 'claude' | 'codex'): Promise<CliInfo> => (calls.push(c), cli()(c));
    const reg = buildRegistry({ cliInfo: counting, now: () => clock });
    const byId = (id: string) => reg.find((c) => c.id === id)!;
    await Promise.all([connectorRows({ list: reg }), connectorRows({ list: reg }), connectorRows({ list: reg })]);
    expect(calls.sort()).toEqual(['claude', 'codex']);
    clock += PROBE_TTL_MS - 1;
    await connectorRows({ list: reg });
    expect(calls).toHaveLength(2);
    clock += 1;
    await connectorRows({ list: reg });
    expect(calls).toHaveLength(4);
    await byId('codex').test();
    await byId('claude-cli').test();
    expect(calls).toHaveLength(6);
    expect(PROBE_TTL_MS).toBe(30_000);
  });

  it('a failed probe is not kept', async () => {
    let n = 0;
    const flaky = cachedCliInfo(async (c) => {
      if (n++ === 0) throw new Error('spawn failed');
      return cli()(c);
    });
    await expect(flaky('claude')).rejects.toThrow('spawn failed');
    expect((await flaky('claude')).found).toBe(true);
    expect(n).toBe(2);
  });
});

describe('capabilities and chains', () => {
  it('maps every connector-using kind to connectors, and rejects a chain that cannot do the kind', () => {
    for (const k of STEP_KINDS) for (const cap of KIND_CAPABILITIES[k] ?? []) expect(connectorsFor(cap).length, `${k} ${cap}`).toBeGreaterThan(0);
    expect(connectorsFor('tts').map((c) => c.id)).toEqual(['elevenlabs', 'azure-speech']);
    expect(connectorsFor('lipsync').map((c) => c.id)).toEqual(['sync', 'hedra']);
    expect(connectorsFor('music.import').map((c) => c.id)).toEqual(['pack-music', 'owner-upload']);
    expect(validateChain('music', ['pack-music', 'owner-upload', 'elevenlabs-music', 'mock'])).toEqual([]);
    expect(validateChain('voice', ['elevenlabs', 'azure-speech', 'mock'])).toEqual([]);
    expect(validateChain('voice', ['sync'])).toEqual(['sync: cannot do voice']);
    expect(validateChain('voice', ['mock', 'elevenlabs'])).toEqual(['mock must be last']);
    expect(validateChain('lipsync', ['nope'])).toEqual(['nope: unknown connector']);
  });
});
