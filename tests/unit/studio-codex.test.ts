import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexImage, codexImagesAllowed } from '@/lib/studio/codex';
import { clearTestEnv, setTestProjectEnv, writeTestConfig } from './studio-helpers';

let root = '';
function config(generators: string[]) {
  writeTestConfig(path.join(root, 'signal.config.json'), { codex: generators.includes('codex-cli-image'), expires: '2099-01-01T00:00:00Z' });
}
function fakeCodex(behaviour: 'ok' | 'none') {
  // A stand-in for the Codex CLI: records its arguments and writes ./output.png into the -C folder.
  const png = path.join(root, 'fixture.png');
  const script = path.join(root, 'codex');
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9-test"; exit 0; fi
echo "$@" > "${root}/args.txt"
dir=""; prev=""
for a in "$@"; do if [ "$prev" = "-C" ]; then dir="$a"; fi; prev="$a"; done
${behaviour === 'ok' ? `cp "${png}" "$dir/output.png"` : ''}
echo DONE
`,
  );
  chmodSync(script, 0o755);
  process.env.CODEX_BIN = script;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-codex-test-'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  setTestProjectEnv(path.join(root, 'posts'));
  await sharp({ create: { width: 1200, height: 1500, channels: 3, background: '#3c24c0' } }).png().toFile(path.join(root, 'fixture.png'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearTestEnv();
  delete process.env.CODEX_BIN;
});

describe('Codex CLI images', () => {
  it('is off until the account settings allow Codex images', async () => {
    config([]);
    expect((await codexImagesAllowed()).enabled).toBe(false);
    fakeCodex('ok');
    await expect(codexImage('x', 1080, 1350)).rejects.toThrow(/switched off/);
    config(['codex-cli-image']);
    expect((await codexImagesAllowed()).enabled).toBe(true);
  });

  it('runs codex exec sandboxed in a temp folder and returns a normalised image', async () => {
    config(['codex-cli-image']);
    fakeCodex('ok');
    const img = await codexImage('Five bubbles', 1080, 1350);
    const meta = await sharp(img.png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    expect(img.cliVersion).toContain('9.9.9');
    const args = readFileSync(path.join(root, 'args.txt'), 'utf8');
    expect(args).toMatch(/^exec --skip-git-repo-check --sandbox workspace-write --ephemeral -C \S*signal-codex-/);
    expect(args).toContain('$imagegen');
    expect(args).not.toMatch(/danger-full-access|--full-auto/);
  });

  it('reports a clear error when Codex makes no image', async () => {
    config(['codex-cli-image']);
    fakeCodex('none');
    await expect(codexImage('x', 1080, 1350)).rejects.toThrow(/did not produce an image/);
  });
});
