// Package ids go from two digits up to five. 00-99 stay byte-identical, 100-99999 are new, ordering is numeric
// everywhere a list of packages is built, and allocation goes 99 → 100.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestEnv, setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, isPackageId, listPackages, loadPackage, readPackageFile, setPlan, type PackageView } from '@/lib/studio/content';
import { nextPackageId } from '@/lib/studio/generate';
import { comparePackageIds, formatPackageId, nextPackageIdAfter, PACKAGE_ID_MAX, PACKAGE_IDS_USED_UP, packageIdOk } from '@/lib/studio/package-id';
import { galleryOrder, needsYouOrder, postedNewestFirst, sortForColumn } from '@/app/studio/posts-rules';
import { byTemplate } from '@/lib/studio/results-templates';
import { madeBy } from '@/lib/studio/pipelines/runner';
import { waitingInReview } from '@/lib/studio/autopilot/steps';

vi.mock('@/lib/server/studioAuth', () => ({ requireStudioUser: async () => ({ email: 'owner@example.test' }) }));

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const FIXTURE = ['98', '99', '100', '101'];
let dir = '';
let cfgDir = '';

function makePackage(id: string): string {
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
      destination: '@signal.demo',
      files: [
        { name: 'slide-1.png', role: 'slide', sha256: sha(slide) },
        { name: 'caption.txt', role: 'caption', sha256: sha(caption) },
      ],
    }),
  );
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'signal-pkg-ids-'));
  cfgDir = mkdtempSync(path.join(os.tmpdir(), 'signal-pkg-ids-cfg-'));
  setTestProjectEnv(dir);
  process.env.SIGNAL_PROJECTS_FILE = path.join(cfgDir, 'none.json');
  writeTestConfig(path.join(cfgDir, 'signal.config.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  clearTestEnv();
});

const REFUSED = ['0100', '1', '123456', '..', '1a', '', '0', '001', '00100', '100000', '-1', '1.5', ' 10', '10 ', '10/', '../10', '1e3', '٠١'];

describe('the id shape and allocation', () => {
  it('accepts 00-99 and 100-99999, refuses everything else', () => {
    for (let n = 0; n <= 99; n++) expect(packageIdOk(String(n).padStart(2, '0'))).toBe(true);
    for (const id of ['100', '101', '999', '1000', '12345', '99999']) expect(packageIdOk(id), id).toBe(true);
    for (const id of REFUSED) expect(packageIdOk(id), JSON.stringify(id)).toBe(false);
    expect(packageIdOk(100 as unknown)).toBe(false);
    expect(isPackageId('100')).toBe(true);
    expect(isPackageId('0100')).toBe(false);
  });

  it('00-99 round-trip byte-identical; new numbers are padded to two digits only', () => {
    for (let n = 0; n <= 99; n++) {
      const id = String(n).padStart(2, '0');
      expect(formatPackageId(Number(id))).toBe(id);
    }
    expect(formatPackageId(100)).toBe('100');
    expect(formatPackageId(99999)).toBe('99999');
    expect(formatPackageId(100000)).toBeNull();
    expect(formatPackageId(-1)).toBeNull();
    expect(formatPackageId(1.5)).toBeNull();
  });

  it('next id: max + 1, ignoring non-ids; 99 → 100; null past 99999', () => {
    expect(nextPackageIdAfter([])).toBe('01');
    expect(nextPackageIdAfter(['01', '07'])).toBe('08');
    expect(nextPackageIdAfter(['98', '99'])).toBe('100');
    expect(nextPackageIdAfter(['99', '0100', '123456', '.pm-x', 'notes'])).toBe('100');
    expect(nextPackageIdAfter(['100'], 150)).toBe('151');
    expect(nextPackageIdAfter(['99998'])).toBe('99999');
    expect(nextPackageIdAfter(['99999'])).toBeNull();
    expect(PACKAGE_IDS_USED_UP).toBe(`Package numbers are used up (${PACKAGE_ID_MAX}).`);
  });

  it('generate: a folder with 99 makes 100 next; 99999 is refused with a plain reason', async () => {
    makePackage('98');
    makePackage('99');
    expect(await nextPackageId()).toBe('100');
    mkdirSync(path.join(dir, '0100')); // not an id: ignored
    expect(await nextPackageId()).toBe('100');
    mkdirSync(path.join(dir, '99999'));
    await expect(nextPackageId()).rejects.toMatchObject({ status: 409, message: PACKAGE_IDS_USED_UP });
  });

  it('a two-digit package loads and lists unchanged, its files untouched', async () => {
    const d = makePackage('07');
    const before = readFileSync(path.join(d, 'package.json'));
    const p = await loadPackage('07');
    expect(p).toMatchObject({ id: '07', status: 'ready' });
    expect((await listPackages()).map((x) => x.id)).toEqual(['07']);
    expect(readFileSync(path.join(d, 'package.json')).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['07']);
  });

  it('a five-digit package loads, approves and serves its files', async () => {
    makePackage('12345');
    expect((await loadPackage('12345')).status).toBe('ready');
    expect((await readPackageFile('12345', 'caption.txt')).body.toString()).toBe('Caption 12345');
    expect((await approvePackage('12345', 'owner@example.test', NOW)).status).toBe('approved');
  });

  it('every malformed id is refused with 400 before any path is built', async () => {
    makePackage('10');
    for (const id of ['0100', '1', '123456', '..', '1a', '10/..', '../10']) {
      await expect(loadPackage(id), id).rejects.toMatchObject({ status: 400 });
      await expect(approvePackage(id, 'owner@example.test', NOW), id).rejects.toMatchObject({ status: 400 });
      await expect(setPlan(id, null, 'owner@example.test', NOW), id).rejects.toMatchObject({ status: 400 });
      await expect(readPackageFile(id, 'caption.txt'), id).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('numeric order in every list', () => {
  beforeEach(() => {
    // Made out of order on purpose; lexical order would be 100, 101, 98, 99.
    for (const id of ['100', '98', '101', '99']) makePackage(id);
  });

  it('compare: numeric, ids before non-ids', () => {
    expect(['100', '99', '101', '98', '00', '12345'].sort(comparePackageIds)).toEqual(['00', '98', '99', '100', '101', '12345']);
    expect(['zz', '100', '..', '99'].sort(comparePackageIds)).toEqual(['99', '100', '..', 'zz']);
  });

  it('Posts payload (listPackages) and the board columns', async () => {
    const all = await listPackages();
    expect(all.map((p) => p.id)).toEqual(FIXTURE);
    expect(sortForColumn('planned', all).map((p) => p.id)).toEqual(FIXTURE);
    expect(sortForColumn('rejected', all).map((p) => p.id)).toEqual([...FIXTURE].reverse());
    const posted = all.map((p) => ({ ...p, posted: { posted_at: '2026-11-03T10:00:00.000Z' } }));
    expect(sortForColumn('posted', posted).map((p) => p.id)).toEqual([...FIXTURE].reverse());
    expect(needsYouOrder(all).map((p) => p.id)).toEqual(FIXTURE);
  });

  it('Gallery: newest package number first', async () => {
    expect(galleryOrder(await listPackages()).map((p) => p.id)).toEqual(['101', '100', '99', '98']);
  });

  it('Calendar payload: unplanned and same-instant planned items in numeric order', async () => {
    const cal = await import('@/app/api/studio/calendar/route');
    const get = async () => (await (await cal.GET(new NextRequest('http://localhost/api/studio/calendar?from=2026-12-01&to=2026-12-31'))).json()) as { items: { id: string }[]; unplanned: { id: string }[] };
    expect((await get()).unplanned.map((x) => x.id)).toEqual(FIXTURE);
    for (const id of FIXTURE) await setPlan(id, '2026-12-02T17:00:00.000Z', 'owner@example.test', NOW);
    const j = await get();
    expect(j.unplanned).toEqual([]);
    expect(j.items.map((x) => x.id)).toEqual(FIXTURE);
  });

  it('Results payload: posted newest first, same instant by package number; every post counted by template', async () => {
    const all = await listPackages();
    const posted = all.map((p) => ({ ...p, posted: { posted_at: '2026-11-03T10:00:00.000Z' } }) as PackageView);
    posted[0] = { ...posted[0]!, posted: { ...posted[0]!.posted!, posted_at: '2026-11-03T11:00:00.000Z' } }; // 98 is the latest post
    expect(postedNewestFirst(posted).map((p) => p.id)).toEqual(['98', '101', '100', '99']);
    const measured = posted.map((p) => ({ ...p, metrics: { metrics: { views: 10, likes: 1, comments: 0, shares: 0, saves: 0 } } }) as unknown as PackageView);
    expect(byTemplate(measured, { templates: {}, formats: {} })).toMatchObject([{ key: 'none', posts: 4 }]);
  });
});

describe('pipelines and the autopilot backlog see package 100', () => {
  it('madeBy maps a slot to package 100', async () => {
    makePackage('99');
    const d = makePackage('100');
    writeFileSync(path.join(d, 'pipeline.json'), JSON.stringify({ pipeline: 'pl-1', name: 'Daily', slotAt: '2026-11-06T17:00:00.000Z', idea: { topic: 'x' }, madeAt: '2026-11-05T07:00:00.000Z', run: 'r1' }));
    const m = madeBy(await listPackages(), 'pl-1');
    expect([...m.entries()]).toEqual([['2026-11-06T17:00:00.000Z', '100']]);
  });

  it('the backlog count includes an autopilot post in folder 100', async () => {
    const mark = { run: 'ap_1', campaign: 'c1', slot: '2026-11-06-18:00', madeAt: '2026-11-05T07:00:00.000Z', autoApproved: null };
    for (const id of ['99', '100', '101']) writeFileSync(path.join(makePackage(id), 'autopilot.json'), JSON.stringify(mark));
    expect(await waitingInReview()).toBe(3);
  });
});
