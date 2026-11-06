// Metrics provenance, history and statistical guards.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestEnv, setTestProjectEnv, TEST_PROJECT, writeTestConfig } from './studio-helpers';
import { approvePackage, listPackages, recordPosted } from '@/lib/studio/content';
import { buildMetricsFile, insights, metricsComplete, rate, readMetricsHistory, refreshMetrics, type Metrics } from '@/lib/studio/analytics';
import { metricsSnapshotData, noteMetricsSnapshot } from '@/lib/studio/memory/hooks';
import { listEvents } from '@/lib/studio/memory/store';
import { learningText, metricValue, metricsIncomplete, observationIncomplete, perReachBase } from '@/lib/studio/memory/stats';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let root = '';

function makePackage(id: string) {
  const d = path.join(root, 'posts', id);
  mkdirSync(d, { recursive: true });
  const s1 = Buffer.from(`slide-1-${id}`), cap = `Caption ${id}`;
  writeFileSync(path.join(d, 'slide-1.png'), s1);
  writeFileSync(path.join(d, 'caption.txt'), cap);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'carousel', destination: TEST_PROJECT.handle,
    files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(s1) }, { name: 'caption.txt', role: 'caption', sha256: sha(cap) }] }));
}
async function posted(id: string, at: number) {
  makePackage(id);
  await approvePackage(id, 'owner', at);
  await recordPosted(id, `https://www.instagram.com/p/Abc${id}xyz/`, true, 'owner', at);
  const pf = path.join(root, 'posts', id, 'posted.json');
  writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, 'utf8')), request_id: `req-${id}` }));
}
const body = (m: Record<string, number>) => json(200, { platforms: { instagram: { post_metrics: m } } });
const full = { views: 1000, reach: 500, likes: 50, comments: 1, saves: 2, shares: 3 };
const metricsPath = (id: string) => path.join(root, 'posts', id, 'metrics.json');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-metrics-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  process.env.UPLOAD_POST_API_KEY = 'test-key-abcdefghijklmnopqrstuvwxyz0123456789';
  mkdirSync(path.join(root, 'posts'));
  writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, analytics: true, memoryTeam: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  clearTestEnv();
  delete process.env.UPLOAD_POST_API_KEY;
});

describe('metrics.json provenance and history', () => {
  it('writes source, fetched_at, age_hours and complete, and appends to the history without rewriting', async () => {
    await posted('01', NOW);
    const firstAt = NOW + 5 * 3600_000;
    const events: string[] = [];
    await refreshMetrics({ fetch: (async () => body(full)) as never, now: firstAt, onSnapshot: (id) => void events.push(id) });
    const file = JSON.parse(readFileSync(metricsPath('01'), 'utf8'));
    expect(file).toMatchObject({ source: 'upload-post', fetched_at: new Date(firstAt).toISOString(), age_hours: 5, complete: true });
    expect(events).toEqual(['01']);
    const hist = path.join(root, 'posts', '01', 'metrics-history.jsonl');
    const first = readFileSync(hist, 'utf8');
    expect(first.trim().split('\n')).toHaveLength(1);
    // A later forced refresh adds a line; the earlier line is byte-identical.
    const laterAt = NOW + 30 * 3600_000;
    await refreshMetrics({ fetch: (async () => body({ ...full, views: 2000 })) as never, now: laterAt, force: true });
    expect(readFileSync(hist, 'utf8').startsWith(first)).toBe(true);
    const series = await readMetricsHistory('01');
    expect(series.map((s) => s.metrics?.views)).toEqual([1000, 2000]);
    expect(series[1]).toMatchObject({ age_hours: 30, source: 'upload-post' });
  });

  it('marks partial data incomplete, keeps old numbers and time on a failed fetch, and writes no history for it', async () => {
    await posted('01', NOW);
    await refreshMetrics({ fetch: (async () => body({ views: 10, reach: 0 })) as never, now: NOW + 3600_000 });
    expect(JSON.parse(readFileSync(metricsPath('01'), 'utf8')).complete).toBe(false);
    await refreshMetrics({ fetch: (async () => json(500, {})) as never, now: NOW + 9 * 3600_000, force: true });
    const file = JSON.parse(readFileSync(metricsPath('01'), 'utf8'));
    expect(file).toMatchObject({ error: 'HTTP 500', fetched_at: new Date(NOW + 3600_000).toISOString(), metrics: { views: 10 } });
    expect(await readMetricsHistory('01')).toHaveLength(1);
  });

  it('tolerates old files without provenance and torn history lines', async () => {
    await posted('01', NOW);
    writeFileSync(metricsPath('01'), JSON.stringify({ fetched_at: '2026-11-05T13:54:39.694Z', metrics: { views: 126, reach: 104, impressions: 126, likes: 0, comments: 0, saves: 0, shares: 0 } }));
    const p = (await listPackages()).find((x) => x.id === '01')!;
    expect(p.metrics?.metrics?.views).toBe(126);
    expect(insights(await listPackages()).measured).toBe(1);
    expect(await readMetricsHistory('99')).toEqual([]);
    appendFileSync(path.join(root, 'posts', '01', 'metrics-history.jsonl'), '{"fetched_at":"x","metrics":null}\n{torn\n');
    expect(await readMetricsHistory('01')).toHaveLength(1);
  });

  it('buildMetricsFile computes age and completeness', () => {
    const m: Metrics = { ...full, impressions: null };
    expect(metricsComplete(m)).toBe(true); // impressions is not expected
    expect(metricsComplete({ ...m, saves: null })).toBe(false);
    expect(buildMetricsFile({ source: 'instagram', now: NOW, postedAt: new Date(NOW - 90 * 60_000).toISOString(), metrics: m })).toMatchObject({ source: 'instagram', age_hours: 1.5, complete: true });
    expect(buildMetricsFile({ source: 'instagram', now: NOW, metrics: null, error: 'x' })).toMatchObject({ age_hours: null, complete: false, error: 'x' });
  });
});

describe('stats guards', () => {
  const m = (reach: number | null, views: number | null) => ({ views, reach, likes: 1, comments: 0, saves: 2, shares: 0 });
  it('falls back to views when reach is null or 0 and flags the observation incomplete', () => {
    expect(perReachBase(m(0, 50))).toEqual({ base: 50, incomplete: true });
    expect(perReachBase(m(null, 50))).toEqual({ base: 50, incomplete: true });
    expect(perReachBase(m(100, 50))).toEqual({ base: 100, incomplete: false });
    expect(metricValue(m(0, 50), 'saves_per_reach')).toBeCloseTo(0.04);
    expect(metricValue(m(0, 0), 'saves_per_reach')).toBeNull();
    expect(metricsIncomplete(m(0, 50))).toBe(true);
    expect(observationIncomplete({ metrics: m(100, 50) })).toBe(false);
    expect(observationIncomplete({ metrics: m(100, 50), incomplete: true })).toBe(true);
    expect(rate({ ...m(0, 50), impressions: null })).toBeCloseTo(3 / 50);
  });
  it('says "no baseline yet" instead of a number when the effect is null', () => {
    expect(learningText('question hooks', 'saves_per_reach', { effect: null, n: 2, nEff: 1 })).toMatch(/no baseline yet/);
    expect(learningText('question hooks', 'saves_per_reach', { effect: null, n: 0, nEff: 0 })).toMatch(/no measured results yet/);
  });
});

describe('best time guard', () => {
  it('is null with a reason and a sample size under 3 measured posts, set from 3', async () => {
    for (const [i, id] of ['01', '02', '03'].entries()) {
      await posted(id, NOW + i * 86_400_000);
      writeFileSync(metricsPath(id), JSON.stringify({ fetched_at: new Date(NOW + 5 * 86_400_000).toISOString(), metrics: { ...full, impressions: null } }));
    }
    const all = await listPackages();
    const two = insights(all.filter((p) => p.id !== '03'));
    expect(two).toMatchObject({ bestWeekday: null, bestHour: null, bestTimeSample: 2 });
    expect(two.bestTimeReason).toMatch(/3\+ measured posts \(have 2\)/);
    const three = insights(all);
    expect(three.bestWeekday).not.toBeNull();
    expect(three.bestHour).not.toBeNull();
    expect(three).toMatchObject({ bestTimeReason: null, bestTimeSample: 3 });
  });
});

describe('metrics.snapshot event', () => {
  it('carries the numbers and the source', async () => {
    const file = buildMetricsFile({ source: 'instagram', now: NOW, postedAt: new Date(NOW - 26 * 3600_000).toISOString(), metrics: { ...full, impressions: null } });
    expect(metricsSnapshotData(file)).toEqual({ ...full, source: 'instagram', ageHours: 26, complete: true });
    await noteMetricsSnapshot('07', file, 'owner');
    await noteMetricsSnapshot('08', { ...file, error: 'HTTP 500' }, 'owner'); // failed fetch: no event
    const ev = (await listEvents({ types: ['metrics.snapshot'] })).map((e) => ({ refs: e.refs, data: e.data }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ refs: { package: '07' }, data: { views: 1000, reach: 500, likes: 50, comments: 1, saves: 2, shares: 3, source: 'instagram' } });
  });
});
