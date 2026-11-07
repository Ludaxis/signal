// Feature switches: off by default, on through signal.config.json, overridable by SIGNAL_FEATURE_<NAME>.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_IDS, acceptTerms, contentGeneratorAllowed, featureEnabled, featureOffReason, featureState, readConfig, setFeature } from '@/lib/server/signalConfig';

let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-config-'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SIGNAL_CONFIG_FILE;
  for (const k of Object.keys(process.env)) if (k.startsWith('SIGNAL_FEATURE_')) delete process.env[k];
});

describe('feature switches', () => {
  it('are all off without a config file, with a plain reason', async () => {
    for (const f of FEATURE_IDS) {
      expect(await featureEnabled(f)).toBe(false);
      expect((await featureState(f)).reason).toBe(featureOffReason(f));
    }
    expect(featureOffReason('autopilot')).toBe('Turn on "autopilot" in Connections → Features.');
  });
  it('read true values only, ignoring unknown keys and bad files', async () => {
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ features: { autopilot: true, scheduler: 'yes', nope: true } }));
    expect(await readConfig()).toEqual({ features: { autopilot: true }, contentGenerators: null, postmaker: { dayCapUsd: {}, acceptedTerms: {} } });
    expect(await featureEnabled('autopilot')).toBe(true);
    expect(await featureEnabled('scheduler')).toBe(false);
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, '{ not json');
    expect(await readConfig()).toEqual({ features: {}, contentGenerators: null, postmaker: { dayCapUsd: {}, acceptedTerms: {} } });
  });
  it('lets the environment override the file both ways', async () => {
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ features: { higgsfield: true } }));
    process.env.SIGNAL_FEATURE_HIGGSFIELD = '0';
    process.env.SIGNAL_FEATURE_UPLOAD_POST_SCHEDULING = '1';
    expect(await featureEnabled('higgsfield')).toBe(false);
    expect(await featureEnabled('uploadPostScheduling')).toBe(true);
    expect((await featureState('uploadPostScheduling', 'on')).reason).toBe('on');
  });
  it('lists the Post maker switches, all off, and the example config names every switch', async () => {
    const pm = ['postmaker', 'postmakerElevenlabs', 'postmakerAzureSpeech', 'postmakerSync', 'postmakerHedra', 'postmakerHiggsfieldVideo', 'postmakerElevenlabsMusic', 'browserAgent'] as const;
    for (const f of pm) {
      expect(FEATURE_IDS).toContain(f);
      expect(await featureEnabled(f)).toBe(false);
    }
    process.env.SIGNAL_FEATURE_POSTMAKER_ELEVENLABS = '1';
    expect(await featureEnabled('postmakerElevenlabs')).toBe(true);
    const example = JSON.parse(readFileSync(path.join(__dirname, '../../signal.config.example.json'), 'utf8')) as { features: Record<string, boolean> };
    expect(Object.keys(example.features).sort()).toEqual([...FEATURE_IDS].sort());
    expect(Object.values(example.features).every((v) => v === false)).toBe(true);
  });
});

describe('contentGenerators', () => {
  it('allows every generator when absent and only the listed ones when present', async () => {
    expect(await contentGeneratorAllowed('postmaker')).toBe(true);
    expect(await contentGeneratorAllowed('signal-template-v1')).toBe(true);
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ contentGenerators: ['signal-template-v1'] }));
    expect(await contentGeneratorAllowed('signal-template-v1')).toBe(true);
    expect(await contentGeneratorAllowed('postmaker')).toBe(false);
    expect(await contentGeneratorAllowed(null)).toBe(false);
    // A present but malformed list allows nothing.
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ contentGenerators: 'postmaker' }));
    expect(await contentGeneratorAllowed('postmaker')).toBe(false);
  });
});

describe('postmaker settings', () => {
  it('reads valid day caps only and records accepted terms once, keeping other keys', async () => {
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ features: { postmaker: true }, postmaker: { dayCapUsd: { elevenlabs: 5, sync: -1, hedra: 'x' } } }));
    expect((await readConfig()).postmaker.dayCapUsd).toEqual({ elevenlabs: 5 });
    await acceptTerms(['vendor:elevenlabs', 'not a ref'], '2026-11-01T10:00:00.000Z');
    await acceptTerms(['vendor:elevenlabs', 'terms:music-for-games'], '2026-11-02T10:00:00.000Z');
    const c = await readConfig();
    expect(c.postmaker.acceptedTerms).toEqual({ 'vendor:elevenlabs': '2026-11-01T10:00:00.000Z', 'terms:music-for-games': '2026-11-02T10:00:00.000Z' });
    expect(c.postmaker.dayCapUsd).toEqual({ elevenlabs: 5 });
    expect(c.features).toEqual({ postmaker: true });
    await setFeature('postmakerSync', true);
    expect((await readConfig()).postmaker.acceptedTerms['vendor:elevenlabs']).toBe('2026-11-01T10:00:00.000Z');
  });
});
