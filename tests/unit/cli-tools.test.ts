// Saved CLI paths: only the claude / codex program itself, an existing regular executable
// file, checked with an allow-listed environment. No model call: the fake CLIs are shell scripts.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnv, cliBin, cliInfo, cliNameOk, saveCliPath } from '@/lib/studio/tools';

let tmp: string;
const saved = { ...process.env };
const exe = (p: string, body: string, mode = 0o755) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'signal-cli-'));
  process.env.SIGNAL_DATA_DIR = path.join(tmp, 'data');
  delete process.env.CLAUDE_BIN;
  delete process.env.CODEX_BIN;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true });
});

describe('saved CLI path rules', () => {
  it('accepts only a basename of claude / codex (or .exe) for that CLI', () => {
    expect(cliNameOk('claude', '/opt/homebrew/bin/claude')).toBe(true);
    expect(cliNameOk('claude', 'C:/tools/claude.exe')).toBe(true);
    expect(cliNameOk('codex', '/usr/local/bin/codex')).toBe(true);
    expect(cliNameOk('codex', '/usr/local/bin/codex.exe')).toBe(true);
    expect(cliNameOk('claude', '/usr/local/bin/codex')).toBe(false);
    expect(cliNameOk('claude', '/bin/sh')).toBe(false);
    expect(cliNameOk('claude', '/x/claude-evil')).toBe(false);
    expect(cliNameOk('codex', '/x/codex.sh')).toBe(false);
  });

  it('refuses another program even when it exists and is executable', async () => {
    const sh = exe(path.join(tmp, 'bin', 'sh'), '#!/bin/sh\necho hi\n');
    await expect(saveCliPath('claude', sh)).rejects.toThrow(/must end in \/claude/);
    const codex = exe(path.join(tmp, 'bin', 'codex'), '#!/bin/sh\necho codex-cli 1\n');
    await expect(saveCliPath('claude', codex)).rejects.toThrow(/must end in \/claude/);
    expect(await cliBin('claude')).toBe('claude');
  });

  it('refuses a folder, a missing file and a file that is not executable', async () => {
    mkdirSync(path.join(tmp, 'dir', 'claude'), { recursive: true });
    await expect(saveCliPath('claude', path.join(tmp, 'dir', 'claude'))).rejects.toThrow(/not a program/);
    await expect(saveCliPath('claude', path.join(tmp, 'none', 'claude'))).rejects.toThrow(/not a program/);
    const plain = exe(path.join(tmp, 'plain', 'claude'), '#!/bin/sh\necho x\n', 0o644);
    await expect(saveCliPath('claude', plain)).rejects.toThrow(/not a program/);
    await expect(saveCliPath('claude', 'claude')).rejects.toThrow(/full path/);
  });

  it('accepts the real program name, including claude.exe', async () => {
    const claude = exe(path.join(tmp, 'win', 'claude.exe'), '#!/bin/sh\necho 2.0.0 (Claude Code)\n');
    await saveCliPath('claude', claude);
    expect(await cliBin('claude')).toBe(claude);
    await saveCliPath('claude', '');
    expect(await cliBin('claude')).toBe('claude');
  });

  it('ignores a saved path in tools.json that breaks the rules (older file or a hand edit)', async () => {
    const sh = exe(path.join(tmp, 'bin', 'sh'), '#!/bin/sh\necho 1.0\n');
    mkdirSync(path.join(tmp, 'data'), { recursive: true });
    writeFileSync(path.join(tmp, 'data', 'tools.json'), JSON.stringify({ v: 1, bins: { claude: sh, codex: 'relative/codex' } }));
    expect(await cliBin('claude')).toBe('claude');
    expect(await cliBin('codex')).toBe('codex');
    process.env.PATH = path.join(tmp, 'empty');
    const info = await cliInfo('claude');
    expect(info).toMatchObject({ found: false, path: null, source: 'path' });
  });
});

describe('CLI checks run with an allow-listed environment', () => {
  it('keeps only what a CLI needs to start', () => {
    const env = checkEnv({ PATH: '/bin', HOME: '/home/a', CODEX_HOME: '/home/a/.codex', UPLOAD_POST_API_KEY: 'k', R2_SECRET_ACCESS_KEY: 's', SIGNAL_TOKEN_KEY: 't', NODE_OPTIONS: '--require /tmp/x.js', ANTHROPIC_API_KEY: 'a' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/a', CODEX_HOME: '/home/a/.codex' });
  });

  it('never passes Signal keys or NODE_OPTIONS to the --version and login-status checks', async () => {
    const codex = exe(path.join(tmp, 'bin', 'codex'), '#!/bin/sh\necho "codex-cli 1.0 key=${UPLOAD_POST_API_KEY:-none} opts=${NODE_OPTIONS:-none} token=${SIGNAL_TOKEN_KEY:-none}"\n');
    await saveCliPath('codex', codex);
    process.env.UPLOAD_POST_API_KEY = 'up-secret-value';
    process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    process.env.SIGNAL_TOKEN_KEY = 'token-key-value';
    const info = await cliInfo('codex');
    expect(info).toMatchObject({ found: true, path: codex, source: 'saved', signedIn: true });
    expect(info.version).toBe('codex-cli 1.0 key=none opts=none token=none');
  });
});
