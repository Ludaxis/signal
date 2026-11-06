// Mac app helpers extracted from desktop/main.cjs (desktop/env.cjs): mode resolution and the signal.env template.
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const req = createRequire(import.meta.url);
const { parseEnvFile, resolveMode, signalEnvTemplate } = req(path.resolve(__dirname, '../../desktop/env.cjs')) as {
  parseEnvFile: (t: string) => Record<string, string>;
  resolveMode: (o?: { user?: Record<string, string>; cfg?: { appDir?: string } }) => { mode: string; appDir: string };
  signalEnvTemplate: () => string;
};

describe('desktop mode resolution', () => {
  it('is bundled without a Signal folder', () => {
    expect(resolveMode()).toEqual({ mode: 'bundled', appDir: '' });
    expect(resolveMode({ user: {}, cfg: {} })).toEqual({ mode: 'bundled', appDir: '' });
  });
  it('is checkout when app-config or signal.env names a folder, and signal.env wins', () => {
    expect(resolveMode({ cfg: { appDir: '/repo/signal' } })).toEqual({ mode: 'checkout', appDir: '/repo/signal' });
    expect(resolveMode({ user: { SIGNAL_APP_DIR: '/mine' }, cfg: { appDir: '/repo/signal' } })).toEqual({ mode: 'checkout', appDir: '/mine' });
    expect(resolveMode({ user: { SIGNAL_APP_DIR: '' }, cfg: { appDir: '/repo/signal' } }).appDir).toBe('/repo/signal');
  });
});

describe('signal.env template', () => {
  const text = signalEnvTemplate();
  it('documents the live settings and nothing dead', () => {
    for (const k of ['SIGNAL_OWNER_PASSWORD', 'SIGNAL_APP_DIR', 'SIGNAL_PUBLISH_PAUSED', 'UPLOAD_POST_API_KEY', 'CLAUDE_BIN']) expect(text).toContain(`# ${k}=`);
    expect(text).toContain('# Feature switches: signal.config.json');
    expect(text).not.toContain('SIGNAL_CONFIG_FILE');
    expect(text).toContain('# SIGNAL_APP_DIR=/path/to/signal\n'); // a placeholder, not someone's home folder
  });
  it('is all comments, so a fresh file changes nothing', () => {
    expect(parseEnvFile(text)).toEqual({});
    expect(text.endsWith('\n')).toBe(true);
  });
});
