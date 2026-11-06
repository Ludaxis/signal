// Publishing safety: the AI-label canary on every send path, day accounting for schedules, provider timestamps,
// the Upload-Post monthly quota, pause and provider edge cases, label evidence and scheduler honesty.
// Every provider is a fake fetch; the global fetch throws so nothing can reach the network.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_PROJECT, clearTestEnv, setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import { approvePackage, assertDayCapacity, assertNoUnlabelled, confirmLabel, currentLimits, goesOutAt, listPackages, loadPackage } from '@/lib/studio/content';
import { checkDispatch, dispatchPackage, reschedule } from '@/lib/studio/dispatch';
import { moveSignalSchedule, publishViaMeta, scheduleInSignal, schedulerTimerRegistered, tickProject } from '@/lib/studio/publish-meta';
import { currentProject } from '@/lib/studio/projects';
import { tokenEnvName } from '@/lib/studio/meta';
import { parseUsage, providerTime, uploadQuota } from '@/lib/studio/uploadpost';
import { GET as calendarGET } from '@/app/api/studio/calendar/route';
import { GET as connectionsGET } from '@/app/api/studio/connections/route';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const KEY = 'test-key-abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = 'IGAAtesttoken0123456789abcdefghijklmnop';
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const TOMORROW_18 = '2026-11-05T17:00:00.000Z'; // 18:00 in the test zone (UTC+1 in November)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fast = { sleep: async () => undefined, pollMs: 0 };
const ORIGIN = 'http://localhost:3000';
let root = '';

function makePackage(id: string) {
  const d = path.join(root, 'posts', id);
  mkdirSync(d, { recursive: true });
  const s1 = Buffer.from(`slide-1-${id}`), cover = Buffer.from(`cover-${id}`), cap = `Caption ${id} #DemoBrand`;
  writeFileSync(path.join(d, 'slide-1.png'), s1);
  writeFileSync(path.join(d, 'cover.png'), cover);
  writeFileSync(path.join(d, 'caption.txt'), cap);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination: TEST_PROJECT.handle,
    files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(s1) }, { name: 'cover.png', role: 'cover', sha256: sha(cover) }, { name: 'caption.txt', role: 'caption', sha256: sha(cap) }] }));
}
/** As written by Check status after an automatic post: posted, AI label not yet confirmed by you. */
function markPostedUnlabelled(id: string, at = NOW) {
  writeFileSync(path.join(root, 'posts', id, 'posted.json'), JSON.stringify({ url: 'https://www.instagram.com/p/DAbc123xyz/', posted_at: new Date(at).toISOString(), ai_label_confirmed: false, recorded_by: 'owner', via: 'upload-post', request_id: `req-${id}` }));
}
const readPkg = (id: string, name: string) => JSON.parse(readFileSync(path.join(root, 'posts', id, name), 'utf8'));
const usageFile = () => path.join(root, 'data', 'upload-post-usage.json');

/** A fake Instagram + R2 that records calls. The post has Instagram's own timestamp and AI flag. */
function fakeMeta(o: { mediaTimestamp?: string; aiLabel?: boolean } = {}) {
  const calls: { method: string; url: string }[] = [];
  let next = 100;
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    calls.push({ method, url: u.origin + u.pathname });
    if (u.hostname.endsWith('r2.cloudflarestorage.com')) return new Response(null, { status: method === 'PUT' ? 200 : 204 });
    const p = u.pathname;
    if (p === '/me') return json(200, { user_id: '1789', username: 'signal.demo', account_type: 'BUSINESS' });
    if (p === '/1789/content_publishing_limit') return json(200, { data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    if (p === '/1789/media' && method === 'POST') return json(200, { id: String(next++) });
    if (p === '/1789/media_publish') return json(200, { id: '999' });
    if (/^\/\d{3}$/.test(p) && u.searchParams.get('fields') === 'status_code,status') return json(200, { status_code: 'FINISHED' });
    if (p === '/999') return json(200, { id: '999', permalink: 'https://www.instagram.com/p/ABCdef123/', caption: 'x', timestamp: o.mediaTimestamp ?? '2026-11-04T11:00:05+0000', is_ai_generated: o.aiLabel ?? true });
    return json(404, { error: { message: `no route ${method} ${p}` } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

let token = '';
function signIn() {
  process.env.SIGNAL_SESSION_SECRET = 'publishing-safety-test-secret-0000';
  token = issueSession();
}
const authed = (url: string) => new NextRequest(`${ORIGIN}${url}`, { headers: { cookie: `${COOKIE_PLAIN}=${token}` } });

const ENV = ['SIGNAL_SECRETS_DIR', 'SIGNAL_SESSION_SECRET', 'UPLOAD_POST_API_KEY', 'SIGNAL_PUBLISH_PAUSED', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE'];
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-publishing-safety-'));
  setTestProjectEnv(path.join(root, 'posts'));
  Object.assign(process.env, {
    SIGNAL_CONFIG_FILE: path.join(root, 'signal.config.json'),
    SIGNAL_PROJECTS_FILE: path.join(root, 'no-projects.json'),
    SIGNAL_DATA_DIR: path.join(root, 'data'),
    SIGNAL_SECRETS_DIR: path.join(root, 'secrets'),
    UPLOAD_POST_API_KEY: KEY,
    UPLOAD_POST_PROFILE: TEST_PROJECT.profile,
  });
  mkdirSync(path.join(root, 'posts'));
  vi.stubGlobal('fetch', () => {
    throw new Error('Tests must not use the network.');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  for (const k of [...ENV, tokenEnvName(currentProject())]) delete process.env[k];
  clearTestEnv();
  delete (globalThis as { __signalSchedulerRegistered?: boolean }).__signalSchedulerRegistered;
});

describe('Upload-Post path', () => {
  beforeEach(() => writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, scheduling: true }));

  it('the AI-label canary blocks Post now and Schedule while a posted package is unlabelled', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    await approvePackage('02', 'owner', NOW);
    markPostedUnlabelled('01');
    const f = vi.fn(async () => json(202, { success: true, job_id: 'job-2' }));
    const later = NOW + 86_400_000;
    await expect(dispatchPackage('02', 'owner', { fetch: f as never, now: later })).rejects.toThrow(/post 01 shows Instagram's AI label/);
    await expect(dispatchPackage('02', 'owner', { fetch: f as never, now: NOW, scheduleFor: '2026-11-06T17:00:00.000Z' })).rejects.toThrow(/AI label/);
    expect(f).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'posts', '02', 'dispatch.json'))).toBe(false);
    const all = await listPackages();
    expect(() => assertNoUnlabelled(all, '01')).not.toThrow(); // the post itself is not its own blocker
    expect(() => assertNoUnlabelled(all, '02')).toThrow(/post 01/);
    // Confirming the label (Instagram API off: nothing is read) opens the way again.
    await confirmLabel('01', 'owner', NOW);
    expect((await dispatchPackage('02', 'owner', { fetch: f as never, now: NOW, scheduleFor: '2026-11-06T17:00:00.000Z' })).status).toBe('scheduled');
  });

  it('counts an Upload-Post schedule on its scheduled day after the due-time check flips it to processing', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    await approvePackage('02', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(202, { job_id: 'job-1' })) as never, now: NOW, scheduleFor: TOMORROW_18 });
    const processing = async () => json(200, { status: 'processing', results: [{ platform: 'instagram', success: false, status: 'processing' }] });
    const due = Date.parse('2026-11-05T17:05:00.000Z');
    const p = await checkDispatch('01', 'owner', { fetch: processing as never, now: due });
    expect(p.status).toBe('submitted');
    expect(goesOutAt(p)).toBe(TOMORROW_18);
    const all = await listPackages();
    const lim = await currentLimits(NOW);
    expect(() => assertDayCapacity(all, Date.parse('2026-11-05T08:00:00.000Z'), lim, '02')).toThrow(/one post per day/);
    expect(() => assertDayCapacity(all, NOW, lim, '02')).not.toThrow(); // the creation day stays free

    // The Calendar puts it on the same day.
    signIn();
    const r = await calendarGET(authed('/api/studio/calendar?from=2026-11-05&to=2026-11-05'));
    expect(r.status).toBe(200);
    const cal = (await r.json()) as { items: { id: string; when: string; kind: string }[] };
    expect(cal.items.find((x) => x.id === '01')).toMatchObject({ when: TOMORROW_18, kind: 'posted' });
    const r4 = await calendarGET(authed('/api/studio/calendar?from=2026-11-04&to=2026-11-04'));
    expect(((await r4.json()) as { items: { id: string }[] }).items.some((x) => x.id === '01')).toBe(false);

    // Completed: posted_at is Upload-Post's upload_timestamp, recorded_at is the check time.
    const checkedAt = Date.parse('2026-11-06T09:00:00.000Z');
    const done = async () => json(200, { status: 'completed', results: [{ platform: 'instagram', success: true, upload_timestamp: '2026-11-05T17:00:40Z', url: 'https://www.instagram.com/p/DAbc123xyz/' }] });
    const posted = await checkDispatch('01', 'owner', { fetch: done as never, now: checkedAt });
    expect(posted.status).toBe('posted');
    expect(posted.posted!.posted_at).toBe('2026-11-05T17:00:40.000Z');
    expect(readPkg('01', 'posted.json').recorded_at).toBe('2026-11-06T09:00:00.000Z');
  });

  it('a Post now completed without a provider time keeps the check time', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(200, { success: true })) as never, now: NOW });
    const done = async () => json(200, { status: 'completed', results: [{ platform: 'instagram', success: true }] });
    const p = await checkDispatch('01', 'owner', { fetch: done as never, now: NOW + 60_000 });
    expect(p.posted!.posted_at).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('a provider 404 on a past-due schedule makes it uncertain with the reason; before the due time it stays scheduled', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(202, { job_id: 'job-1' })) as never, now: NOW, scheduleFor: TOMORROW_18 });
    const gone = vi.fn(async () => json(404, { status: 'not_found' }));
    expect((await checkDispatch('01', 'owner', { fetch: gone as never, now: NOW })).status).toBe('scheduled');
    const p = await checkDispatch('01', 'owner', { fetch: gone as never, now: Date.parse('2026-11-05T17:10:00.000Z') });
    expect(p.status).toBe('uncertain');
    expect(p.outcome!.message).toMatch(/no longer knows this scheduled post \(HTTP 404\).*has passed/);
    expect(goesOutAt(p)).toBe(TOMORROW_18);
  });

  it('refuses to move an Upload-Post schedule while publishing is paused, without calling Upload-Post', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(202, { job_id: 'job-1' })) as never, now: NOW, scheduleFor: TOMORROW_18 });
    process.env.SIGNAL_PUBLISH_PAUSED = '1';
    const patch = vi.fn(async () => json(200, { success: true }));
    await expect(reschedule('01', '2026-11-06T09:00:00.000Z', 'owner', { fetch: patch as never, now: NOW })).rejects.toThrow(/Publishing is paused/);
    expect(patch).not.toHaveBeenCalled();
    expect((await loadPackage('01')).scheduled?.scheduled_for).toBe(TOMORROW_18);
  });

  it('remembers usage{count,limit,last_reset}, refuses Post now and Schedule at the limit (counting waiting schedules) and exposes the quota', async () => {
    for (const id of ['01', '02', '03']) {
      makePackage(id);
      await approvePackage(id, 'owner', NOW);
    }
    // Post now: the answer carries the usage.
    const up = vi.fn(async () => json(200, { success: true, request_id: 'r1', usage: { count: 9, limit: 10, last_reset: '2026-11-01T00:00:00Z' } }));
    await dispatchPackage('01', 'owner', { fetch: up as never, now: NOW });
    const stored = readFileSync(usageFile(), 'utf8');
    expect(stored).not.toContain(KEY);
    expect(Object.values(JSON.parse(stored).accounts)).toEqual([{ count: 9, limit: 10, last_reset: '2026-11-01T00:00:00.000Z', seen_at: new Date(NOW).toISOString() }]);
    await checkDispatch('01', 'owner', { fetch: (async () => json(200, { status: 'completed', results: [{ platform: 'instagram', success: true, upload_timestamp: '2026-11-04T11:00:10Z' }] })) as never, now: NOW });
    await confirmLabel('01', 'owner', NOW);
    // 9 used: one more can be scheduled; it then fills the quota.
    await dispatchPackage('02', 'owner', { fetch: (async () => json(202, { job_id: 'job-2' })) as never, now: NOW + 1000, scheduleFor: '2026-11-06T17:00:00.000Z' });
    expect(await uploadQuota(NOW + 2000)).toMatchObject({ used: 10, limit: 10, count: 9, scheduled: 1, resetsAt: '2026-12-01T00:00:00.000Z', stale: false });
    const f = vi.fn(async () => json(200, { success: true }));
    const thu = Date.parse('2026-11-05T12:00:00+01:00');
    await expect(dispatchPackage('03', 'owner', { fetch: f as never, now: thu })).rejects.toThrow(/monthly upload limit is used up \(10 of 10, including 1 scheduled post still to go out\)/);
    await expect(dispatchPackage('03', 'owner', { fetch: f as never, now: NOW, scheduleFor: '2026-11-07T17:00:00.000Z' })).rejects.toThrow(/monthly upload limit/);
    expect(f).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'posts', '03', 'dispatch.json'))).toBe(false);

    // GET /api/studio/connections shows it (no provider call).
    signIn();
    const r = await connectionsGET(authed(`/api/studio/connections?project=${TEST_PROJECT.id}`));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { uploadPost: { quota: unknown } };
    expect(body.uploadPost.quota).toMatchObject({ used: 10, limit: 10, resetsAt: '2026-12-01T00:00:00.000Z' });
    // After the month turns the old count is not used; the waiting schedule still is.
    expect(await uploadQuota(Date.parse('2026-12-02T00:00:00Z'))).toMatchObject({ used: 1, stale: true });
  });

  it('learns the usage from status answers too, and the quota is null until any answer carried it', async () => {
    expect(await uploadQuota(NOW)).toBeNull();
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(200, { success: true })) as never, now: NOW });
    await checkDispatch('01', 'owner', { fetch: (async () => json(200, { status: 'processing', results: [], usage: { count: 10, limit: 10 } })) as never, now: NOW });
    expect(await uploadQuota(NOW)).toMatchObject({ used: 10, limit: 10, resetsAt: null });
  });

  it('parses usage and provider times defensively', () => {
    expect(parseUsage({ usage: { count: '3', limit: 10, last_reset: 1761955200 } })).toEqual({ count: 3, limit: 10, last_reset: '2025-11-01T00:00:00.000Z' });
    expect(parseUsage({ usage: { count: 3 } })).toBeNull();
    expect(parseUsage({ usage: { count: 1, limit: 0 } })).toBeNull();
    expect(parseUsage(null)).toBeNull();
    expect(providerTime('2026-11-05T17:00:12+0000')).toBe('2026-11-05T17:00:12.000Z');
    expect(providerTime(1762362012)).toBe('2025-11-05T17:00:12.000Z');
    expect(providerTime('soon')).toBeNull();
  });

  it('label.json records the link, hashes and that the AI flag was not read when the Instagram API is off', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    markPostedUnlabelled('01');
    await confirmLabel('01', 'owner', NOW);
    const label = readPkg('01', 'label.json');
    expect(label).toMatchObject({ confirmed_by: 'owner', confirmed_at: new Date(NOW).toISOString() });
    expect(label.evidence).toEqual({
      permalink: 'https://www.instagram.com/p/DAbc123xyz/',
      media_id: null,
      ai_label: null,
      ai_label_source: null,
      read_at: null,
      hashes: { 'slide-1.png': sha('slide-1-01'), 'cover.png': sha('cover-01') },
    });
  });
});

describe("Instagram API path and Signal's scheduler", () => {
  beforeEach(() => {
    writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, instagramApi: true, signalScheduler: true });
    process.env[tokenEnvName(currentProject())] = TOKEN;
    Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret-test', R2_BUCKET: 'signal-media', R2_PUBLIC_BASE: 'https://media.example.test' });
    (globalThis as { __signalSchedulerRegistered?: boolean }).__signalSchedulerRegistered = true;
  });

  it('refuses a Signal schedule when the minute timer is not registered in this process', async () => {
    delete (globalThis as { __signalSchedulerRegistered?: boolean }).__signalSchedulerRegistered;
    expect(schedulerTimerRegistered()).toBe(false);
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await expect(scheduleInSignal('01', TOMORROW_18, 'owner', NOW)).rejects.toThrow(/minute scheduler is not running/);
    expect(existsSync(path.join(root, 'posts', '01', 'scheduled.json'))).toBe(false);
    expect((await loadPackage('01')).status).toBe('approved');
  });

  it('the AI-label canary blocks publishViaMeta and scheduleInSignal, and a due post becomes "missed" with the reason', async () => {
    makePackage('01');
    makePackage('02');
    makePackage('03');
    for (const id of ['01', '02', '03']) await approvePackage(id, 'owner', NOW);
    await scheduleInSignal('02', TOMORROW_18, 'owner', NOW);
    markPostedUnlabelled('01');
    const { f, calls } = fakeMeta();
    await expect(publishViaMeta('03', 'owner', { fetch: f, now: NOW + 86_400_000 * 2, ...fast })).rejects.toThrow(/post 01 shows Instagram's AI label/);
    await expect(scheduleInSignal('03', '2026-11-07T17:00:00.000Z', 'owner', NOW)).rejects.toThrow(/AI label/);
    const r = await tickProject({ fetch: f, now: Date.parse('2026-11-05T17:00:30.000Z'), ...fast });
    expect(r.sent).toEqual([]);
    expect(r.missed).toEqual(['02']);
    expect(calls).toEqual([]); // nothing hosted, nothing published
    const p2 = await loadPackage('02');
    expect(p2.status).toBe('approved');
    expect(p2.missedReason).toMatch(/post 01 shows Instagram's AI label/);
    expect(readdirSync(path.join(root, 'posts', '02')).some((n) => n.startsWith('scheduled-missed-'))).toBe(true);
  });

  it("records Instagram's own timestamp as posted_at, and label.json stores the read AI flag, media id, link and hashes", async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const { f } = fakeMeta({ mediaTimestamp: '2026-11-04T11:00:05+0000', aiLabel: true });
    const p = await publishViaMeta('01', 'owner', { fetch: f, now: NOW + 3_600_000, ...fast });
    expect(p.status).toBe('posted');
    expect(p.posted!.posted_at).toBe('2026-11-04T11:00:05.000Z');
    expect(readPkg('01', 'posted.json').recorded_at).toBe(new Date(NOW + 3_600_000).toISOString());
    await confirmLabel('01', 'owner', NOW + 3_700_000, { fetch: f });
    expect(readPkg('01', 'label.json').evidence).toEqual({
      permalink: 'https://www.instagram.com/p/ABCdef123/',
      media_id: '999',
      ai_label: true,
      ai_label_source: 'instagram-api',
      read_at: new Date(NOW + 3_700_000).toISOString(),
      hashes: { 'slide-1.png': sha('slide-1-01'), 'cover.png': sha('cover-01') },
    });
  });

  it('a failed Instagram read never blocks the confirmation and is recorded', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const { f } = fakeMeta();
    await publishViaMeta('01', 'owner', { fetch: f, now: NOW, ...fast });
    const down = (async () => json(500, { error: { message: 'Service unavailable' } })) as unknown as typeof fetch;
    expect((await confirmLabel('01', 'owner', NOW, { fetch: down })).labelConfirmed).toBe(true);
    expect(readPkg('01', 'label.json').evidence).toMatchObject({ media_id: '999', ai_label: null, read_error: expect.stringMatching(/Could not read the post/) });
  });

  it('refuses to move a Signal schedule while publishing is paused', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await scheduleInSignal('01', TOMORROW_18, 'owner', NOW);
    process.env.SIGNAL_PUBLISH_PAUSED = '1';
    await expect(moveSignalSchedule('01', '2026-11-06T09:00:00.000Z', 'owner', NOW)).rejects.toThrow(/Publishing is paused/);
    expect((await loadPackage('01')).scheduled?.scheduled_for).toBe(TOMORROW_18);
  });
});
