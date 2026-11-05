import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, assertDayCapacity, currentLimits, isInstagramPostUrl, listPackages, loadPackage, recordPosted } from '@/lib/studio/content';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
let dir = '';

function makePackage(id: string, extra: Partial<{ destination: string }> = {}) {
  const d = path.join(dir, id);
  mkdirSync(d, { recursive: true });
  const slide = Buffer.from(`png-bytes-${id}`);
  const caption = `Caption ${id}`;
  writeFileSync(path.join(d, 'slide-1.png'), slide);
  writeFileSync(path.join(d, 'caption.txt'), caption);
  writeFileSync(
    path.join(d, 'package.json'),
    JSON.stringify({
      id,
      title: `Post ${id}`,
      format: 'image',
      destination: extra.destination ?? '@signal.demo',
      
      files: [
        { name: 'slide-1.png', role: 'slide', sha256: sha(slide) },
        { name: 'caption.txt', role: 'caption', sha256: sha(caption) },
      ],
    }),
  );
  return d;
}

const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const URL1 = 'https://www.instagram.com/p/DAbc123xyz/';

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'signal-content-'));
  setTestProjectEnv(dir);
  process.env.SIGNAL_CONFIG_FILE = path.join(dir, '..', path.basename(dir) + '-gates.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(dir, '..', path.basename(dir) + '-none.json');
  writeTestConfig(process.env.SIGNAL_CONFIG_FILE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SIGNAL_CONTENT_DIR;
  rmSync(process.env.SIGNAL_CONFIG_FILE!, { force: true });
  delete process.env.SIGNAL_CONFIG_FILE;
  delete process.env.SIGNAL_PROJECTS_FILE;
});

describe('hand-crafted post packages', () => {
  it('loads a verified package as ready with its caption', async () => {
    makePackage('01');
    const p = await loadPackage('01');
    expect(p.status).toBe('ready');
    expect(p.caption).toBe('Caption 01');
    expect(p.files.every((f) => f.ok)).toBe(true);
  });

  it('carries the autopilot mark when autopilot.json is present, and ignores a broken one', async () => {
    const d = makePackage('01');
    expect((await loadPackage('01')).autopilot).toBeNull();
    const mark = { run: 'ap_1', campaign: 'c1', slot: '2026-11-06-18:00', madeAt: '2026-11-05T07:00:00.000Z', autoApproved: { at: '2026-11-05T07:03:00.000Z', trustInARow: 5, scheduledFor: '2026-11-06T17:00:00.000Z', via: 'meta' } };
    writeFileSync(path.join(d, 'autopilot.json'), JSON.stringify(mark));
    const p = await loadPackage('01');
    expect(p.autopilot).toEqual(mark);
    expect(p.status).toBe('ready'); // the mark alone changes no status
    writeFileSync(path.join(d, 'autopilot.json'), '{"nope":true}');
    expect((await loadPackage('01')).autopilot).toBeNull();
  });

  it('marks a package changed when a file no longer matches its fingerprint', async () => {
    const d = makePackage('01');
    writeFileSync(path.join(d, 'slide-1.png'), 'edited');
    const p = await loadPackage('01');
    expect(p.status).toBe('changed');
    await expect(approvePackage('01', 'owner', NOW)).rejects.toThrow(/changed/);
  });

  it('rejects a package for another destination', async () => {
    makePackage('01', { destination: '@someone.else' });
    expect((await loadPackage('01')).status).toBe('invalid');
  });

  it('approves once, invalidates the approval on edit, and records the manual post', async () => {
    const d = makePackage('01');
    expect((await approvePackage('01', 'owner', NOW)).status).toBe('approved');
    await expect(approvePackage('01', 'owner', NOW)).rejects.toThrow();
    await expect(recordPosted('01', 'https://example.com/x', true, 'owner', NOW)).rejects.toThrow(/Instagram post link/);
    await expect(recordPosted('01', URL1, false, 'owner', NOW)).rejects.toThrow(/AI label/);
    const posted = await recordPosted('01', URL1, true, 'owner', NOW);
    expect(posted.status).toBe('posted');
    await expect(recordPosted('01', URL1, true, 'owner', NOW)).rejects.toThrow(/already/);
    expect(existsSync(path.join(d, 'approval.json'))).toBe(true);
  });

  it('allows several approvals but keeps one post per day when it goes out', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    expect((await approvePackage('02', 'owner', NOW)).status).toBe('approved');
    await recordPosted('01', URL1, true, 'owner', NOW);
    const all = await listPackages();
    const lim = await currentLimits(NOW);
    expect(() => assertDayCapacity(all, NOW + 60_000, lim)).toThrow(/one post per day/);
    expect(() => assertDayCapacity(all, Date.parse('2026-11-05T09:00:00+01:00'), lim)).not.toThrow();
  });

  it('refuses approvals after the posting period ends', async () => {
    makePackage('01');
    await expect(approvePackage('01', 'owner', Date.parse('2026-11-18T00:01:00+01:00'))).rejects.toThrow(/has ended/);
  });

  it('only lists two-digit package folders and validates post links', async () => {
    makePackage('01');
    mkdirSync(path.join(dir, 'raw'));
    expect((await listPackages()).map((p) => p.id)).toEqual(['01']);
    expect(isInstagramPostUrl('https://www.instagram.com/reel/C9xYz12AbC/')).toBe(true);
    expect(isInstagramPostUrl('https://instagram.com.evil.io/p/abc12/')).toBe(false);
  });
});
