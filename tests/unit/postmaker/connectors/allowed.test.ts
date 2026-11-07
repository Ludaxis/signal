// @vitest-environment node
// The single decision point: kill switch → feature switch → key → gate refs → attendance, the terms you accept once,
// the optional day caps, mock fallback and requireLive refusals.
import '../guard';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '@/lib/server/signalConfig';
import { callConnector, connectorAllowed, connectorStatus, gateBackend, termsRefs, vendorDayCapUsd } from '@/lib/studio/postmaker/connectors/allowed';
import { buildRegistry, connectorById, switchConnector, TERMS_NEEDED } from '@/lib/studio/postmaker/connectors';
import type { RegisteredConnector } from '@/lib/studio/postmaker/connectors/base';
import { elevenlabs } from '@/lib/studio/postmaker/connectors/elevenlabs';
import { isFeature, POSTMAKER_PAUSED_ENV, type FeatureId } from '@/lib/studio/postmaker/connectors/features';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { allSwitchesOn, setKeys, switchOn, writePostmakerConfig } from './env';
import { ctxOf } from './fakes';

const NOW = Date.parse('2026-11-10T12:00:00+01:00');
const approvalsAllOpen = { 'claude-cli-agents': async () => true, 'agent-team': async () => true, 'codex-images': async () => true, 'higgsfield-api': async () => true };
const open = () => gateBackend({ approvals: approvalsAllOpen });
const installed = { cliInfo: async (cli: string) => ({ cli, label: cli, found: true, path: '/x', version: '1', source: 'path' as const, signedIn: true }) };
/** Every connector that could run live (Suno is blocked in code and has its own test below). */
const runnable = () => buildRegistry(installed as never).filter((c) => !c.blocked);
const acceptAll = () => writePostmakerConfig({ acceptedTerms: buildRegistry().flatMap((c) => termsRefs(c)) });

/** A connector whose invoke and mock are spies, with a tiny estimate so the per-call ceiling never interferes. */
function stub(c: RegisteredConnector) {
  const invoke = vi.fn(async () => ({ mode: 'live' }));
  const mock = vi.fn(async () => ({ mode: 'mock' }));
  // Figma keeps its token in the encrypted store, not in an environment key: the stub stands in for a saved token.
  const keyPresent = c.id === 'figma' ? async () => true : c.keyPresent;
  return { spy: { ...c, invoke, mock, keyPresent, estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'x' }) } as unknown as RegisteredConnector, invoke, mock };
}

describe('connectorAllowed: one table over every connector', () => {
  it('every switch off → the run is a mock and says "‹Service› is off. Runs as mock."', async () => {
    setKeys();
    acceptAll();
    for (const c of runnable()) {
      const { spy, invoke, mock } = stub(c);
      const ctx = ctxOf();
      const r = await callConnector(spy, {} as never, ctx, { backend: open(), attended: true, now: NOW });
      expect(r.mode, c.id).toBe('mock');
      expect(r.decision, c.id).toMatchObject({ live: false, state: 'off', why: 'off' });
      expect(ctx.events.map((e) => e.text), c.id).toContain(`${c.title}: ${c.title} is off. Runs as mock.`);
      expect(invoke, c.id).not.toHaveBeenCalled();
      expect(mock, c.id).toHaveBeenCalledTimes(1);
      if (!c.probe) expect((await connectorStatus(c, { backend: open(), attended: true, now: NOW })).line, c.id).toBe(`${c.title} is off. Runs as mock.`);
    }
  });

  it('switch on + key + terms accepted → live (stub invoke), one connector at a time', async () => {
    setKeys();
    acceptAll();
    for (const c of runnable()) {
      for (const k of Object.keys(process.env)) if (k.startsWith('SIGNAL_FEATURE_')) delete process.env[k];
      expect(isFeature(c.feature), c.id).toBe(true);
      switchOn(c.feature as FeatureId);
      const { spy, invoke } = stub(c);
      const r = await callConnector(spy, {} as never, ctxOf(), { backend: open(), attended: true, now: NOW });
      expect(r.mode, c.id).toBe('live');
      expect(r.decision, c.id).toMatchObject({ live: true, state: 'ready', why: null });
      expect(invoke, c.id).toHaveBeenCalledTimes(1);
    }
  });

  it('the kill switch wins over every switch, key and accepted term', async () => {
    allSwitchesOn();
    setKeys();
    acceptAll();
    process.env[POSTMAKER_PAUSED_ENV] = '1';
    for (const c of runnable()) {
      const { spy, invoke } = stub(c);
      expect((await callConnector(spy, {} as never, ctxOf(), { backend: open(), attended: true, now: NOW })).mode, c.id).toBe('mock');
      await expect(callConnector(spy, {} as never, ctxOf(), { backend: open(), attended: true, now: NOW, requireLive: true })).rejects.toSatisfy((e: unknown) => isPostmakerError(e) && e.status === 403);
      expect(invoke, c.id).not.toHaveBeenCalled();
      expect(await connectorAllowed(c, { backend: open(), attended: true, now: NOW }), c.id).toMatchObject({ live: false, state: 'off', why: 'paused' });
    }
  });
});

describe('connectorAllowed order', () => {
  it('defaults: every connector is off or not allowed, so every run is mock', async () => {
    for (const c of buildRegistry()) {
      const d = await connectorAllowed(c, { now: NOW });
      expect(d.live, c.id).toBe(false);
      expect(['off', 'not-allowed'], c.id).toContain(d.state);
    }
  });

  it('switch on but no key → needs-key with "‹Name› needs a key."', async () => {
    switchOn('postmakerElevenlabs');
    expect(await connectorAllowed(elevenlabs, { now: NOW })).toMatchObject({ live: false, state: 'needs-key', why: 'key', reason: 'ElevenLabs needs a key.' });
  });

  it('switch and key but terms not accepted → not allowed; accepting once opens it', async () => {
    switchOn('postmakerElevenlabs');
    setKeys(['ELEVENLABS_API_KEY']);
    expect(await connectorAllowed(elevenlabs, { now: NOW })).toMatchObject({ live: false, state: 'not-allowed', why: 'terms', reason: 'Accept its terms in Connections.' });
    expect((await connectorStatus(elevenlabs, { now: NOW })).line).toBe('Not allowed yet · Accept its terms');
    writePostmakerConfig({ acceptedTerms: ['vendor:elevenlabs'] });
    expect(await connectorAllowed(elevenlabs, { now: NOW })).toMatchObject({ live: true, state: 'ready' });
  });

  it('a connector with a terms ref needs every ref accepted', async () => {
    switchOn('postmakerElevenlabsMusic');
    setKeys(['ELEVENLABS_API_KEY']);
    const music = connectorById('elevenlabs-music')!;
    const refs = termsRefs(music);
    expect(refs.length).toBeGreaterThan(1);
    writePostmakerConfig({ acceptedTerms: refs.slice(0, 1) });
    expect(await connectorAllowed(music, { now: NOW })).toMatchObject({ live: false, why: 'terms' });
    writePostmakerConfig({ acceptedTerms: refs });
    expect(await connectorAllowed(music, { now: NOW })).toMatchObject({ live: true });
  });

  it('an approval ref follows its existing switch; closed reads "Turn on its switch in Connections."', async () => {
    switchOn('postmakerHiggsfieldVideo');
    setKeys(['HF_API_KEY_ID', 'HF_API_KEY_SECRET']);
    writePostmakerConfig({ acceptedTerms: ['vendor:higgsfield-video'] });
    const video = connectorById('higgsfield-video')!;
    expect(await connectorAllowed(video, { backend: gateBackend({ approvals: { 'higgsfield-api': async () => false } }), now: NOW })).toMatchObject({ live: false, why: 'gate', reason: 'Turn on its switch in Connections.' });
    expect(await connectorAllowed(video, { backend: gateBackend({ approvals: { 'higgsfield-api': async () => true } }), now: NOW })).toMatchObject({ live: true });
    // Through the registered approvals: the Studio's own higgsfield switch.
    expect((await connectorAllowed(video, { now: NOW })).live).toBe(false);
    switchOn('higgsfield');
    expect((await connectorAllowed(video, { now: NOW })).live).toBe(true);
  });

  it('attended-only connectors are live only in an attended run', async () => {
    switchOn('postmaker');
    const codex = buildRegistry(installed as never).find((c) => c.id === 'codex')!;
    expect(await connectorAllowed(codex, { backend: open(), now: NOW })).toMatchObject({ live: false, why: 'attendance', reason: 'Needs you: press Run' });
    expect(await connectorAllowed(codex, { backend: open(), attended: true, now: NOW })).toMatchObject({ live: true });
  });

  it('is evaluated at each call (no caching): a switch turned off between two calls closes the second', async () => {
    switchOn('postmakerElevenlabs');
    setKeys(['ELEVENLABS_API_KEY']);
    writePostmakerConfig({ acceptedTerms: ['vendor:elevenlabs'] });
    expect((await connectorAllowed(elevenlabs, { now: NOW })).live).toBe(true);
    process.env.SIGNAL_FEATURE_POSTMAKER_ELEVENLABS = '0';
    expect((await connectorAllowed(elevenlabs, { now: NOW })).live).toBe(false);
  });

  it('approval refs reuse existing switches; an unknown or throwing approval is closed', async () => {
    const b = gateBackend({ approvals: { yes: async () => true, boom: async () => { throw new Error('x'); } } });
    expect((await b.refOk('approval:yes', NOW)).ok).toBe(true);
    expect((await b.refOk('approval:boom', NOW)).ok).toBe(false);
    expect((await b.refOk('approval:missing', NOW)).ok).toBe(false);
    expect((await b.refOk('nonsense', NOW)).ok).toBe(false);
    expect((await gateBackend({ acceptedTerms: async () => ({ 'terms:x': '2026-11-01T00:00:00Z' }) }).refOk('terms:x', NOW)).ok).toBe(true);
  });
});

describe('turning a paid service on', () => {
  it('asks once to accept its terms, stores the acceptance and never asks again', async () => {
    await expect(switchConnector('elevenlabs', true, { now: NOW })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, TERMS_NEEDED) && e.status === 409);
    expect((await readConfig()).features.postmakerElevenlabs).toBeUndefined();
    await switchConnector('elevenlabs', true, { acceptTerms: true, now: NOW });
    const c = await readConfig();
    expect(c.features.postmakerElevenlabs).toBe(true);
    expect(c.postmaker.acceptedTerms).toEqual({ 'vendor:elevenlabs': new Date(NOW).toISOString() });
    await switchConnector('elevenlabs', false);
    expect((await readConfig()).features.postmakerElevenlabs).toBeUndefined();
    await switchConnector('elevenlabs', true); // accepted before: no question
    expect((await readConfig()).features.postmakerElevenlabs).toBe(true);
  });

  it('a blocked binding cannot be switched on, and a local connector has no switch of its own', async () => {
    await expect(switchConnector('browser-agent:suno', true, { acceptTerms: true })).rejects.toSatisfy((e: unknown) => isPostmakerError(e) && e.status === 403);
    await expect(switchConnector('ffmpeg', true)).rejects.toSatisfy((e: unknown) => isPostmakerError(e) && e.status === 400);
    await expect(switchConnector('nope', true)).rejects.toSatisfy((e: unknown) => isPostmakerError(e) && e.status === 404);
  });
});

describe('day caps', () => {
  it('come from signal.config.json postmaker.dayCapUsd, per connector id, and are absent by default', async () => {
    expect(await vendorDayCapUsd(elevenlabs)).toBeNull();
    writePostmakerConfig({ dayCapUsd: { elevenlabs: 3.5 } });
    expect(await vendorDayCapUsd(elevenlabs)).toBe(3.5);
    expect(await vendorDayCapUsd({ id: 'ffmpeg' })).toBeNull();
    expect(await vendorDayCapUsd(elevenlabs, { readCaps: async () => ({ elevenlabs: 1 }) })).toBe(1);
  });
});

describe('requireLive and the per-call ceiling', () => {
  it('without the kill switch, an open connector calls invoke once and reports live', async () => {
    allSwitchesOn();
    setKeys();
    acceptAll();
    const invoke = vi.fn(async () => ({ mode: 'live' }));
    const spy = { ...elevenlabs, invoke, estimate: () => ({ usdLow: 0.01, usdHigh: 0.01, seconds: 1, basis: 'x' }) } as unknown as typeof elevenlabs;
    const r = await callConnector(spy, {} as never, ctxOf(), { now: NOW });
    expect(r.mode).toBe('live');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('the per-call ceiling stops a call before invoke', async () => {
    allSwitchesOn();
    setKeys();
    acceptAll();
    const invoke = vi.fn(async () => ({}));
    const spy = { ...elevenlabs, invoke, estimate: () => ({ usdLow: 5, usdHigh: 5, seconds: 1, basis: 'x' }) } as unknown as typeof elevenlabs;
    await expect(callConnector(spy, {} as never, ctxOf(), { now: NOW })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'over_ceiling'));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requireLive on an attended-only connector outside an attended run answers 409 "Needs you: press Run"', async () => {
    allSwitchesOn();
    const codex = buildRegistry(installed as never).find((c) => c.id === 'codex')!;
    await expect(callConnector(codex, { prompt: 'x', width: 10, height: 10 } as never, ctxOf(), { backend: open(), now: NOW, requireLive: true })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'needs_you') && e.status === 409 && e.message === 'Needs you: press Run');
  });
});

describe('the suno binding is not allowed regardless of switches', () => {
  it('reports not-allowed and refuses invoke with 403, even fully opened or paused', async () => {
    const suno = connectorById('browser-agent:suno')!;
    const line = 'Not allowed · The site’s terms forbid it';
    const check = async () => {
      expect(await suno.status()).toEqual({ state: 'not-allowed', line, fix: null });
      expect(await connectorStatus(suno, { backend: open(), attended: true, now: NOW })).toEqual({ state: 'not-allowed', line, fix: null });
      expect(await connectorAllowed(suno, { backend: open(), attended: true, now: NOW })).toMatchObject({ live: false, state: 'not-allowed', why: 'blocked' });
      await expect(suno.invoke({ inputs: {}, lengthMs: 30_000, tempo: null } as never, ctxOf())).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'forbidden') && e.status === 403);
      await expect(callConnector(suno, { inputs: {}, lengthMs: 30_000, tempo: null } as never, ctxOf(), { backend: open(), attended: true, requireLive: true, now: NOW })).rejects.toSatisfy((e: unknown) => isPostmakerError(e) && e.status === 403);
    };
    await check();
    allSwitchesOn();
    setKeys();
    acceptAll();
    await check();
    process.env[POSTMAKER_PAUSED_ENV] = '1';
    await check();
    // The mock (a click track) is still available for a mock run.
    const r = await callConnector(suno, { inputs: {}, lengthMs: 2_000, tempo: { bpm: 120, downbeatMs: 0 } } as never, ctxOf(), { attended: true, now: NOW });
    expect(r.mode).toBe('mock');
  });
});
