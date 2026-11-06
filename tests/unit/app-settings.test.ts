// Keys and switches set in Connections: encrypted, applied to process.env, never returned.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySavedSettings, clearGroup, saveGroup, setSwitch, settingsStatus } from '@/lib/studio/app-settings';
import { publishingPaused } from '@/lib/studio/safety';

let tmp: string;
const saved = { ...process.env };
const g = globalThis as { __signalEnvOriginal?: unknown; __signalSettingsApplied?: unknown };
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'signal-settings-'));
  process.env.SIGNAL_SECRETS_DIR = tmp;
  process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 3).toString('base64');
  delete process.env.UPLOAD_POST_API_KEY;
  delete process.env.R2_BUCKET;
  delete g.__signalEnvOriginal;
  delete g.__signalSettingsApplied;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true });
});

describe('app settings', () => {
  it('saves encrypted, applies at once and never returns secrets', async () => {
    await saveGroup('upload-post', { UPLOAD_POST_API_KEY: 'up_live_key_abcdefgh123456' });
    expect(process.env.UPLOAD_POST_API_KEY).toBe('up_live_key_abcdefgh123456');
    expect(readFileSync(path.join(tmp, 'settings.json'), 'utf8')).not.toContain('abcdefgh');
    const st = await settingsStatus();
    const f = st.groups.find((x) => x.id === 'upload-post')!.fields[0]!;
    expect(f).toMatchObject({ source: 'saved', value: null, hint: '…3456' });
    expect(JSON.stringify(st)).not.toContain('abcdefgh');
  });

  it('a saved value wins over .env.local and removing it brings .env.local back', async () => {
    process.env.R2_BUCKET = 'from-env';
    await saveGroup('r2', { R2_BUCKET: 'my-bucket' });
    expect(process.env.R2_BUCKET).toBe('my-bucket');
    await clearGroup('r2');
    expect(process.env.R2_BUCKET).toBe('from-env');
  });

  it('checks values and refuses unknown groups', async () => {
    await expect(saveGroup('r2', { R2_PUBLIC_BASE: 'http://insecure' })).rejects.toThrow(/does not look right/);
    await expect(saveGroup('nope', {})).rejects.toThrow(/Unknown/);
    await expect(saveGroup('r2', { R2_BUCKET: '' })).rejects.toThrow(/at least one/);
  });

  it('the publishing switch overrides SIGNAL_PUBLISH_PAUSED and survives a restart', async () => {
    process.env.SIGNAL_PUBLISH_PAUSED = '1';
    expect(publishingPaused().paused).toBe(true);
    await setSwitch('publishing', true);
    expect(publishingPaused().paused).toBe(false);
    process.env.SIGNAL_PUBLISH_PAUSED = '1'; // a restart loads .env.local again…
    delete g.__signalSettingsApplied;
    await applySavedSettings(); // …and the saved switch is applied on start
    expect(publishingPaused().paused).toBe(false);
    expect((await settingsStatus()).switches.publishing).toEqual({ on: true, source: 'saved' });
  });

  it('needs SIGNAL_TOKEN_KEY to save', async () => {
    delete process.env.SIGNAL_TOKEN_KEY;
    await expect(setSwitch('publishing', true)).rejects.toThrow(/SIGNAL_TOKEN_KEY/);
    expect((await settingsStatus()).ready).toBe(false);
  });
});

describe('feature switches from the app', () => {
  it('writes signal.config.json and keeps other keys; env still decides when set', async () => {
    const { featureEnabled, featureStates, setFeature } = await import('@/lib/server/signalConfig');
    const { writeFileSync, readFileSync: read } = await import('node:fs');
    const file = path.join(tmp, 'signal.config.json');
    process.env.SIGNAL_CONFIG_FILE = file;
    writeFileSync(file, JSON.stringify({ note: 'keep', features: { agents: true } }));
    await setFeature('scheduler', true);
    expect(await featureEnabled('scheduler')).toBe(true);
    await setFeature('agents', false);
    expect(JSON.parse(read(file, 'utf8'))).toEqual({ note: 'keep', features: { scheduler: true } });
    process.env.SIGNAL_FEATURE_SCHEDULER = '0';
    expect((await featureStates()).find((f) => f.id === 'scheduler')).toMatchObject({ on: false, forcedByEnv: true });
    delete process.env.SIGNAL_FEATURE_SCHEDULER;
  });
});
