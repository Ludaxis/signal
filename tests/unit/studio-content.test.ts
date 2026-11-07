import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, assertDayCapacity, currentLimits, downloadName, GENERATOR_NOT_ALLOWED, isInstagramPostUrl, listPackages, loadPackage, PM_GENERATOR, PM_MOCK_STEPS, PM_RECORD_MISMATCH, PM_SWITCH_OFF, recordPosted } from '@/lib/studio/content';

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

const TEMPLATE_SOURCE = { generator: 'signal-template-v1', format: 'website-card', category: 'x', items: [], distractors: [], levels: [], seed: 's' };
const withSource = (id: string, source: Record<string, unknown> | null) => {
  const d = makePackage(id);
  const file = path.join(d, 'package.json');
  const spec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (source === null) delete spec.source;
  else spec.source = { ...TEMPLATE_SOURCE, ...source };
  writeFileSync(file, JSON.stringify(spec));
  return d;
};

describe('approval guard: the optional contentGenerators list', () => {
  it('approves every generator, and a package with none, when signal.config.json has no list', async () => {
    withSource('01', { generator: 'signal-higgsfield-v1' });
    expect((await approvePackage('01', 'owner', NOW)).status).toBe('approved');
    withSource('02', null);
    expect((await loadPackage('02')).status).toBe('ready');
  });

  it('refuses a generator the list leaves out, with a plain reason, and writes nothing', async () => {
    writeTestConfig(process.env.SIGNAL_CONFIG_FILE!, { contentGenerators: ['signal-template-v1'] });
    withSource('01', { generator: 'signal-higgsfield-v1' });
    await expect(approvePackage('01', 'owner', NOW)).rejects.toMatchObject({ status: 409, message: GENERATOR_NOT_ALLOWED });
    expect((await loadPackage('01')).status).toBe('ready');
    withSource('02', { generator: 'signal-template-v1' });
    expect((await approvePackage('02', 'owner', NOW)).status).toBe('approved');
  });
});

describe('Post maker packages', () => {
  const mark = (d: string, o: Record<string, unknown> = {}) => {
    const spec = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')) as { files: { name: string; sha256: string }[] };
    const files = Object.fromEntries(spec.files.map((f) => [f.name, { sha256: f.sha256 }]));
    writeFileSync(path.join(d, 'postmaker.json'), JSON.stringify({ schema: 'signal.pm.mark/1', recipeId: 'rc-20261101-abcd', runId: 'run-20261101-120000-abcd', lang: 'en', files, modes: { live: 3, mock: 0 }, template: { name: 'Story', version: 2 }, verdict: 'ship', ...o }));
  };

  it('is ready only while the postmaker switch is on and its record matches the files', async () => {
    const d = withSource('01', { generator: PM_GENERATOR });
    mark(d);
    expect((await loadPackage('01')).problems).toEqual([`${PM_SWITCH_OFF}.`]);
    writeTestConfig(process.env.SIGNAL_CONFIG_FILE!, { postmaker: true });
    const p = await loadPackage('01');
    expect(p.status).toBe('ready');
    expect(p.postmaker).toEqual({ template: 'Story', version: 2, recipeId: 'rc-20261101-abcd', runId: 'run-20261101-120000-abcd', lang: 'en', verdict: 'ship' });
    expect((await approvePackage('01', 'owner', NOW)).status).toBe('approved');
  });

  it('refuses a package made with mock steps or whose record names other bytes', async () => {
    writeTestConfig(process.env.SIGNAL_CONFIG_FILE!, { postmaker: true });
    mark(withSource('01', { generator: PM_GENERATOR }), { modes: { live: 2, mock: 1 } });
    expect((await loadPackage('01')).problems).toEqual([`${PM_MOCK_STEPS}.`]);
    mark(withSource('02', { generator: PM_GENERATOR }), { files: { 'slide-1.png': { sha256: '0'.repeat(64) } } });
    expect((await loadPackage('02')).problems).toContain(`${PM_RECORD_MISMATCH}.`);
    await expect(approvePackage('02', 'owner', NOW)).rejects.toMatchObject({ status: 409 });
  });
});

describe('downloadName', () => {
  it('names the project the file belongs to, slugged, and falls back to "signal"', () => {
    expect(downloadName('fixture', '01', 'slide-1.png')).toBe('fixture-post-01-slide-1.png');
    expect(downloadName('Some Brand!', '07', 'caption.txt')).toBe('some-brand-post-07-caption.txt');
    expect(downloadName('***', '02', 'reel.mp4')).toBe('signal-post-02-reel.mp4');
  });
});
