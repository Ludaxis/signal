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

  it('concurrent saves and switch flips all reach the file (no lost update, no temp-file clash)', async () => {
    await Promise.all([
      saveGroup('r2', { R2_BUCKET: 'bucket-one' }),
      setSwitch('publishing', false),
      saveGroup('upload-post', { UPLOAD_POST_API_KEY: 'up_live_key_abcdefgh123456' }),
      saveGroup('meta', { META_APP_ID: '1234567' }),
      setSwitch('autopilot', false),
    ]);
    const names = Object.keys((JSON.parse(readFileSync(path.join(tmp, 'settings.json'), 'utf8')) as { items: Record<string, unknown> }).items).sort();
    expect(names).toEqual(['META_APP_ID', 'R2_BUCKET', 'SIGNAL_AUTOPILOT_PAUSED', 'SIGNAL_PUBLISH_PAUSED', 'UPLOAD_POST_API_KEY']);
    // After a restart the saved pause still applies.
    for (const n of names) delete process.env[n];
    delete g.__signalEnvOriginal;
    delete g.__signalSettingsApplied;
    expect(await applySavedSettings()).toBe(5);
    expect(publishingPaused().paused).toBe(true);
  });

  it('does not report a saved value as saved when this SIGNAL_TOKEN_KEY cannot read it', async () => {
    await saveGroup('upload-post', { UPLOAD_POST_API_KEY: 'up_live_key_abcdefgh123456' });
    await setSwitch('publishing', false);
    process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 4).toString('base64'); // another key (e.g. the Mac app vs. a dev server)
    delete process.env.UPLOAD_POST_API_KEY;
    delete process.env.SIGNAL_PUBLISH_PAUSED;
    delete g.__signalEnvOriginal;
    delete g.__signalSettingsApplied;
    const st = await settingsStatus();
    const up = st.groups.find((x) => x.id === 'upload-post')!;
    expect(up.fields[0]).toMatchObject({ source: 'missing', hint: null });
    expect(up.complete).toBe(false);
    expect(up.saved).toBe(false);
    expect(st.switches.publishing).toEqual({ on: true, source: 'default' });
  });

  it('accepts only a plain https host (and path) as the R2 public address', async () => {
    for (const ok of ['https://pub-0123456789abcdef.r2.dev', 'https://media.example.com/signal/', 'https://media.example.com:8443']) {
      await expect(saveGroup('r2', { R2_PUBLIC_BASE: ok })).resolves.toEqual(['Public address']);
    }
    expect(process.env.R2_PUBLIC_BASE).toBe('https://media.example.com:8443');
    for (const bad of ['https://user:pass@media.example.com', 'https://media.example.com/?x=1', 'https://media.example.com/#x', 'https://[::1]/', 'https://media.example.com/a b', 'https://media.example.com/\u0000', 'https://']) {
      await expect(saveGroup('r2', { R2_PUBLIC_BASE: bad })).rejects.toThrow(/does not look right/);
    }
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
