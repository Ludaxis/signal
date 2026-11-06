// One broken state file never fails the whole list, and a failed post with nothing posted can be
// rejected (discarded wins in the status), while anything that may be live cannot.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_PROJECT, clearTestEnv, setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, discardPackage, listPackages, loadPackage } from '@/lib/studio/content';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
let root = '';
let dir = '';

function makePackage(id: string, destination: string = TEST_PROJECT.handle) {
  const d = path.join(dir, id);
  mkdirSync(d, { recursive: true });
  const slide = Buffer.from(`png-bytes-${id}`);
  const caption = `Caption ${id}`;
  writeFileSync(path.join(d, 'slide-1.png'), slide);
  writeFileSync(path.join(d, 'caption.txt'), caption);
  writeFileSync(
    path.join(d, 'package.json'),
    JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination, files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(slide) }, { name: 'caption.txt', role: 'caption', sha256: sha(caption) }] }),
  );
  return d;
}
const write = (id: string, name: string, body: unknown) => writeFileSync(path.join(dir, id, name), typeof body === 'string' ? body : JSON.stringify(body));

/** A package that was sent and definitely refused (Upload-Post rejected it): dispatch + failed outcome, no posted.json. */
async function makeFailed(id: string) {
  makePackage(id);
  await approvePackage(id, 'owner', NOW);
  write(id, 'dispatch.json', { request_id: `r-${id}`, idempotency_key: `r-${id}`, claimed_at: new Date(NOW).toISOString(), claimed_by: 'owner', provider: 'upload-post', hashes: {} });
  write(id, 'outcome.json', { state: 'failed', at: new Date(NOW).toISOString(), message: 'Upload-Post rejected the post (HTTP 400): bad media' });
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-tolerance-'));
  dir = path.join(root, 'posts');
  mkdirSync(dir, { recursive: true });
  setTestProjectEnv(dir);
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'projects-none.json');
  writeTestConfig(path.join(root, 'signal.config.json'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearTestEnv();
});

describe('listPackages tolerates a broken state file', () => {
  it('a broken plan.json gives one invalid package naming the file; the list still returns', async () => {
    makePackage('01');
    makePackage('02');
    makePackage('03');
    write('02', 'plan.json', '{ not json');
    const all = await listPackages();
    expect(all.map((p) => [p.id, p.status])).toEqual([
      ['01', 'ready'],
      ['02', 'invalid'],
      ['03', 'ready'],
    ]);
    const broken = all.find((p) => p.id === '02')!;
    expect(broken.problems).toContain('plan.json could not be read (damaged or not valid JSON).');
    expect(broken.unreadable).toEqual(['plan.json']);
    // Nothing that may be live is unreadable: it can be rejected.
    expect((await discardPackage('02', 'owner', NOW)).status).toBe('discarded');
  });

  it('a broken package.json is named too, and does not hide the other packages', async () => {
    makePackage('01');
    makePackage('02');
    write('01', 'package.json', '{');
    const all = await listPackages();
    expect(all.map((p) => p.status)).toEqual(['invalid', 'ready']);
    expect(all[0]!.problems[0]).toBe('package.json could not be read (damaged or not valid JSON).');
  });

  it('a posted package with a broken metrics.json stays posted, with the file named', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    write('01', 'posted.json', { url: 'https://www.instagram.com/p/DAbc123xyz/', posted_at: new Date(NOW).toISOString(), ai_label_confirmed: true, recorded_by: 'owner', via: 'manual' });
    write('01', 'metrics.json', 'nope');
    const p = await loadPackage('01');
    expect(p.status).toBe('posted');
    expect(p.problems).toContain('metrics.json could not be read (damaged or not valid JSON).');
  });

  it('a broken posted.json or outcome.json makes the package invalid and it cannot be discarded (it may be live)', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    write('01', 'posted.json', '{"url":');
    expect((await loadPackage('01')).status).toBe('invalid');
    await expect(discardPackage('01', 'owner', NOW)).rejects.toThrow(/cannot read \(posted\.json\)/);
    expect(existsSync(path.join(dir, '01', 'discarded.json'))).toBe(false);

    await makeFailed('02');
    write('02', 'outcome.json', '{');
    expect((await loadPackage('02')).status).toBe('invalid');
    await expect(discardPackage('02', 'owner', NOW)).rejects.toThrow(/outcome\.json/);
  });
});

describe('rejecting a failed post with nothing posted', () => {
  it('accepts the discard and the package shows as discarded (discarded wins over failed)', async () => {
    await makeFailed('01');
    expect((await loadPackage('01')).status).toBe('failed');
    const p = await discardPackage('01', 'owner', NOW);
    expect(p.status).toBe('discarded');
    expect(existsSync(path.join(dir, '01', 'discarded.json'))).toBe(true);
    // It does not come back on the next read, and it is not discarded twice.
    expect((await listPackages()).find((x) => x.id === '01')!.status).toBe('discarded');
    await expect(discardPackage('01', 'owner', NOW)).rejects.toThrow(/discarded and cannot be discarded/);
  });

  it('still refuses posts that are on their way or unclear, and posted ones', async () => {
    await makeFailed('01');
    write('01', 'outcome.json', { state: 'uncertain', at: new Date(NOW).toISOString() });
    await expect(discardPackage('01', 'owner', NOW)).rejects.toThrow(/uncertain and cannot be discarded/);
    write('01', 'outcome.json', { state: 'submitted', at: new Date(NOW).toISOString() });
    await expect(discardPackage('01', 'owner', NOW)).rejects.toThrow(/submitted and cannot be discarded/);
    write('01', 'posted.json', { url: null, posted_at: new Date(NOW).toISOString(), ai_label_confirmed: false, recorded_by: 'owner', via: 'upload-post' });
    await expect(discardPackage('01', 'owner', NOW)).rejects.toThrow(/posted and cannot be discarded/);
  });

  it('a discarded package with a broken package.json shows as discarded, not as a problem in Planned', async () => {
    makePackage('01', '@someone.else'); // wrong destination: invalid
    expect((await loadPackage('01')).status).toBe('invalid');
    expect((await discardPackage('01', 'owner', NOW)).status).toBe('discarded');
  });
});
