// Workspace: linked folders (read-only, no escapes), Figma links and token store, CLI lookup.
// No real network: Figma calls use a fake fetch.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderError, getFolder, kindOf, linkFolder, listFiles, listFolders, resolveInside, unlinkFolder, unsafeFolderReason } from '@/lib/studio/folders';
import { connectFigma, figmaStatus, linkFigmaFile, listFrames, parseFigmaUrl } from '@/lib/studio/figma';
import { getSecret, putSecret } from '@/lib/studio/secret-box';
import { cliBin, resolveOnPath, saveCliPath } from '@/lib/studio/tools';

let tmp: string;
const saved = { ...process.env };
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'signal-ws-'));
  process.env.SIGNAL_DATA_DIR = path.join(tmp, 'data');
  process.env.SIGNAL_SECRETS_DIR = path.join(tmp, 'secrets');
  process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
  delete process.env.CLAUDE_BIN;
  delete process.env.CODEX_BIN;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true });
});

describe('linked folders', () => {
  it('refuses the disk root, home and private folders', () => {
    expect(unsafeFolderReason('/', '/Users/a')).toMatch(/whole disk/);
    expect(unsafeFolderReason('/Users/a', '/Users/a')).toMatch(/home folder/);
    expect(unsafeFolderReason('/Users/a/.ssh', '/Users/a')).toMatch(/private/);
    expect(unsafeFolderReason('/Users/a/Library/Keychains', '/Users/a')).toMatch(/private/);
    expect(unsafeFolderReason('/etc', '/Users/a')).toMatch(/system/);
    expect(unsafeFolderReason('/Users/a/Projects/game', '/Users/a')).toBeNull();
  });

  it('links, lists media and refuses paths outside the folder', async () => {
    const dir = path.join(tmp, 'game');
    mkdirSync(path.join(dir, 'art'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, 'art', 'hero.png'), 'x');
    writeFileSync(path.join(dir, 'README.md'), '# game');
    writeFileSync(path.join(dir, 'node_modules', 'x', 'skip.png'), 'x');
    writeFileSync(path.join(dir, '.git', 'skip.png'), 'x');
    writeFileSync(path.join(dir, 'main.ts'), 'code');
    writeFileSync(path.join(tmp, 'secret.png'), 'x');
    symlinkSync(path.join(tmp, 'secret.png'), path.join(dir, 'link.png'));

    const f = await linkFolder('p1', dir);
    expect(f.label).toBe('game');
    expect((await linkFolder('p1', dir)).id).toBe(f.id); // same folder twice → one link
    const { files } = await listFiles(f);
    expect(files.map((x) => x.rel).sort()).toEqual(['README.md', 'art/hero.png']); // symlinks are not listed
    await expect(resolveInside(f, 'art/hero.png')).resolves.toContain('hero.png');
    await expect(resolveInside(f, '../secret.png')).rejects.toBeInstanceOf(FolderError);
    await expect(resolveInside(f, 'link.png')).rejects.toThrow(/outside/);
    await expect(resolveInside(f, '/etc/passwd')).rejects.toBeInstanceOf(FolderError);
    expect(await listFolders('p2')).toEqual([]);
    await expect(getFolder('p2', f.id)).rejects.toThrow(/not linked/);
    expect(await unlinkFolder('p1', f.id)).toBe(true);
    expect(await listFolders('p1')).toEqual([]);
  });

  it('rejects relative and missing paths', async () => {
    await expect(linkFolder('p1', 'relative/dir')).rejects.toThrow(/full folder path/);
    await expect(linkFolder('p1', path.join(tmp, 'nope'))).rejects.toThrow(/not found/);
  });

  it('classifies file kinds', () => {
    expect(kindOf('a.PNG')).toBe('image');
    expect(kindOf('a.mov')).toBe('video');
    expect(kindOf('a.fig')).toBe('design');
    expect(kindOf('a.md')).toBe('doc');
    expect(kindOf('a.ts')).toBeNull();
  });
});

describe('Figma', () => {
  it('parses file links', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567/My-File?node-id=1-2')).toBe('AbCdEf1234567');
    expect(parseFigmaUrl('https://www.figma.com/file/AbCdEf1234567/x')).toBe('AbCdEf1234567');
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567/branch/ZyXwVu9876543/x')).toBe('ZyXwVu9876543');
    expect(parseFigmaUrl('https://evil.example.com/design/AbCdEf1234567/x')).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/community/plugin/123')).toBeNull();
  });

  it('stores the token encrypted, links files and lists frames', async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)['X-Figma-Token']).toBe('figd_test_token_value_1234567890');
      const u = String(url);
      const body = u.endsWith('/me') ? { handle: 'reza' } : u.includes('depth=1') ? { name: 'Brand', thumbnailUrl: 'https://s3/x.png' } : { document: { children: [{ id: '0:1', name: 'Page 1', type: 'CANVAS', children: [{ id: '1:2', name: 'Hero', type: 'FRAME' }, { id: '1:3', name: 'note', type: 'TEXT' }] }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    expect((await figmaStatus()).connected).toBe(false);
    expect(await connectFigma('figd_test_token_value_1234567890', f)).toBe('reza');
    const st = await figmaStatus();
    expect(st).toMatchObject({ connected: true, user: 'reza' });
    const file = await linkFigmaFile('p1', 'https://www.figma.com/design/AbCdEf1234567/Brand', f);
    expect(file.name).toBe('Brand');
    expect(await listFrames('p1', 'AbCdEf1234567', f)).toEqual([{ id: '1:2', name: 'Hero', page: 'Page 1', type: 'FRAME' }]);
    await expect(listFrames('p2', 'AbCdEf1234567', f)).rejects.toThrow(/not linked/);
    expect(calls.every((c) => c.startsWith('https://api.figma.com/v1/'))).toBe(true);
  });

  it('needs SIGNAL_TOKEN_KEY', async () => {
    delete process.env.SIGNAL_TOKEN_KEY;
    expect((await figmaStatus()).ready).toBe(false);
  });
});

describe('secret box', () => {
  it('round-trips and fails closed with another key', async () => {
    await putSecret('t', 'a', 'value-1');
    expect(await getSecret('t', 'a')).toBe('value-1');
    process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(await getSecret('t', 'a')).toBeNull();
  });
});

describe('CLI lookup', () => {
  it('resolves on PATH and prefers env, then a saved path', async () => {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const fake = path.join(bin, 'codex');
    writeFileSync(fake, '#!/bin/sh\necho codex-cli 9.9.9\n');
    chmodSync(fake, 0o755);
    expect(await resolveOnPath('codex', bin)).toBe(fake);
    expect(await resolveOnPath('codex', path.join(tmp, 'none'))).toBeNull();
    expect(await cliBin('codex')).toBe('codex');
    await saveCliPath('codex', fake);
    expect(await cliBin('codex')).toBe(fake);
    process.env.CODEX_BIN = '/env/codex';
    expect(await cliBin('codex')).toBe('/env/codex');
    await expect(saveCliPath('claude', 'claude')).rejects.toThrow(/full path/);
    await expect(saveCliPath('claude', path.join(tmp, 'missing'))).rejects.toThrow(/not a program/);
  });
});
