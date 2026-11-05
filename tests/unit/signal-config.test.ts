// Feature switches: off by default, on through signal.config.json, overridable by SIGNAL_FEATURE_<NAME>.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_IDS, featureEnabled, featureOffReason, featureState, readConfig } from '@/lib/server/signalConfig';

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
    expect(featureOffReason('autopilot')).toBe('Turn on "autopilot" in signal.config.json (features.autopilot: true) or set SIGNAL_FEATURE_AUTOPILOT=1.');
  });
  it('read true values only, ignoring unknown keys and bad files', async () => {
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ features: { autopilot: true, scheduler: 'yes', nope: true } }));
    expect(await readConfig()).toEqual({ features: { autopilot: true } });
    expect(await featureEnabled('autopilot')).toBe(true);
    expect(await featureEnabled('scheduler')).toBe(false);
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, '{ not json');
    expect(await readConfig()).toEqual({ features: {} });
  });
  it('lets the environment override the file both ways', async () => {
    writeFileSync(process.env.SIGNAL_CONFIG_FILE!, JSON.stringify({ features: { higgsfield: true } }));
    process.env.SIGNAL_FEATURE_HIGGSFIELD = '0';
    process.env.SIGNAL_FEATURE_UPLOAD_POST_SCHEDULING = '1';
    expect(await featureEnabled('higgsfield')).toBe(false);
    expect(await featureEnabled('uploadPostScheduling')).toBe(true);
    expect((await featureState('uploadPostScheduling', 'on')).reason).toBe('on');
  });
});
