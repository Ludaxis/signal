// @vitest-environment node
// The suite's network guard is active (an accidental live call fails), and the Post maker modules stay generic: no
// store names, nothing from a maintainer's own denylist (SIGNAL_NAME_DENYLIST) and no imports of the older template
// modules under lib/studio/postmaker/.
import './guard';
import child_process from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetworkBlocked } from './guard';
import { maintainerDenylist } from '../name-denylist';

describe('network guard', () => {
  it('blocks fetch, sockets and child processes', async () => {
    await expect(Promise.resolve().then(() => fetch('https://example.invalid/'))).rejects.toBeInstanceOf(NetworkBlocked);
    expect(() => http.request('http://example.invalid/')).toThrow(NetworkBlocked);
    expect(() => https.get('https://example.invalid/')).toThrow(NetworkBlocked);
    expect(() => net.connect(443, 'example.invalid')).toThrow(NetworkBlocked);
    expect(() => child_process.spawn('ffmpeg', ['-version'])).toThrow(NetworkBlocked);
    expect(() => child_process.execFile('claude', ['-p'])).toThrow(NetworkBlocked);
  });
});

const ROOT = path.resolve(__dirname, '../../../lib/studio/postmaker');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe('generic core (Post maker modules)', () => {
  it('names no store or denylisted name and imports no older template module', () => {
    const all = files(ROOT);
    expect(all.length).toBeGreaterThan(10);
    const hits: string[] = [];
    const deny = maintainerDenylist();
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      if (/google play|play store|\bapp store\b|itunes store|steam store/i.test(text)) hits.push(`${path.relative(ROOT, f)}: store`);
      if (deny?.test(text)) hits.push(`${path.relative(ROOT, f)}: name`);
      if (/from ['"][^'"]*\/(render|reel|projects)['"]/.test(text) || /\b(FONT_PATH|ICON_PATH|defaultProject)\b/.test(text)) hits.push(`${path.relative(ROOT, f)}: import`);
    }
    expect(hits).toEqual([]);
  });
});
