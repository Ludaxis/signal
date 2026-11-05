// posting through Instagram's own API, the R2 media bucket, Signal's scheduler, results and comments.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, listPackages, loadPackage, recordPosted } from '@/lib/studio/content';
import { currentProject } from '@/lib/studio/projects';
import { redactToken, replyToComment, tokenEnvName } from '@/lib/studio/meta';
import { signV4 } from '@/lib/studio/r2';
import { cancelSignalSchedule, checkMeta, metaLive, moveSignalSchedule, publishViaMeta, scheduleInSignal, tickProject } from '@/lib/studio/publish-meta';
import { refreshMetrics } from '@/lib/studio/analytics';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const TOKEN = 'IGAAtesttoken0123456789abcdefghijklmnop';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fast = { sleep: async () => undefined, pollMs: 0 };
let root = '';

function gate(o: { api?: boolean; scheduler?: boolean } = {}) {
  writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, instagramApi: o.api ?? true, signalScheduler: o.scheduler ?? true });
}
function makePackage(id: string, slides = 2) {
  const d = path.join(root, 'posts', id);
  mkdirSync(d, { recursive: true });
  const files = [];
  for (let i = 1; i <= slides; i++) {
    const b = Buffer.from(`slide-${i}-${id}`);
    writeFileSync(path.join(d, `slide-${i}.png`), b);
    files.push({ name: `slide-${i}.png`, role: 'slide', sha256: sha(b) });
  }
  const cap = `Caption ${id} #DemoBrand`;
  writeFileSync(path.join(d, 'caption.txt'), cap);
  files.push({ name: 'caption.txt', role: 'caption', sha256: sha(cap) });
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: slides > 1 ? 'carousel' : 'image', destination: '@signal.demo', files }));
}

/** A fake Instagram + R2. Records every call; behaviour can be overridden per test. */
function fakeMeta(o: { username?: string; publish?: () => Response | Promise<Response>; status?: string; media?: unknown[] } = {}) {
  const calls: { method: string; url: string; params: URLSearchParams }[] = [];
  let next = 100;
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    const params = method === 'POST' ? new URLSearchParams(String(init?.body ?? '')) : u.searchParams;
    calls.push({ method, url: u.origin + u.pathname, params });
    if (u.hostname.endsWith('r2.cloudflarestorage.com')) return new Response(null, { status: method === 'PUT' ? 200 : 204 });
    const p = u.pathname;
    if (p === '/me') return json(200, { user_id: '1789', username: o.username ?? 'signal.demo', account_type: 'BUSINESS', followers_count: 120, media_count: 3 });
    if (p === '/1789/content_publishing_limit') return json(200, { data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    if (p === '/1789/media' && method === 'POST') return json(200, { id: String(next++) });
    if (p === '/1789/media') return json(200, { data: o.media ?? [] });
    if (p === '/1789/media_publish') return o.publish ? o.publish() : json(200, { id: '999' });
    if (/^\/\d{3}$/.test(p) && u.searchParams.get('fields') === 'status_code,status') return json(200, { status_code: o.status ?? 'FINISHED' });
    if (p === '/999') return json(200, { id: '999', permalink: 'https://www.instagram.com/p/ABCdef123/', caption: 'x' });
    if (p === '/999/insights') return json(200, { data: [{ name: 'views', values: [{ value: 900 }] }, { name: 'reach', values: [{ value: 600 }] }, { name: 'likes', values: [{ value: 30 }] }, { name: 'saved', values: [{ value: 6 }] }] });
    return json(404, { error: { message: `no route ${method} ${p}` } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-meta-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env[tokenEnvName(currentProject())] = TOKEN;
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret-test', R2_BUCKET: 'signal-media', R2_PUBLIC_BASE: 'https://media.example.test' });
  mkdirSync(path.join(root, 'posts'));
  gate();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', tokenEnvName(currentProject()), 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE']) delete process.env[k];
});

describe('Instagram API posting', () => {
  it('stays off until the switch, the token and the media bucket are set', async () => {
    gate({ api: false });
    expect((await metaLive(NOW)).reason).toMatch(/instagramApi/);
    gate();
    delete process.env.R2_BUCKET;
    expect((await metaLive(NOW)).reason).toMatch(/R2_BUCKET/);
    process.env.R2_BUCKET = 'signal-media';
    expect((await metaLive(NOW)).enabled).toBe(true);
  });

  it('posts a carousel once with the AI label on the carousel, records the link and cleans up the bucket', async () => {
    makePackage('01', 2);
    await approvePackage('01', 'owner', NOW);
    const { f, calls } = fakeMeta();
    const p = await publishViaMeta('01', 'owner', { fetch: f, now: NOW, ...fast });
    expect(p.status).toBe('posted');
    expect(p.posted).toMatchObject({ url: 'https://www.instagram.com/p/ABCdef123/', via: 'meta', media_id: '999' });
    const creates = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/1789/media'));
    expect(creates).toHaveLength(3);
    expect(creates[0]!.params.get('is_carousel_item')).toBe('true');
    expect(creates[0]!.params.get('image_url')).toMatch(/^https:\/\/media\.example\.test\/signal\/demo\/01\//);
    expect(creates[0]!.params.get('is_ai_generated')).toBeNull();
    expect(creates[2]!.params.get('media_type')).toBe('CAROUSEL');
    expect(creates[2]!.params.get('children')).toBe('100,101');
    expect(creates[2]!.params.get('is_ai_generated')).toBe('true');
    expect(creates[2]!.params.get('caption')).toBe('Caption 01 #DemoBrand');
    expect(calls.filter((c) => c.url.endsWith('/media_publish'))).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    // Single use: a second send is refused without any call.
    await expect(publishViaMeta('01', 'owner', { fetch: f, now: NOW, ...fast })).rejects.toThrow();
  });

  it('refuses when the token belongs to another account, and sends nothing', async () => {
    makePackage('01', 1);
    await approvePackage('01', 'owner', NOW);
    const { f, calls } = fakeMeta({ username: 'someone.else' });
    await expect(publishViaMeta('01', 'owner', { fetch: f, now: NOW, ...fast })).rejects.toThrow(/not @signal\.demo/);
    expect(calls.some((c) => c.method === 'PUT' || c.url.endsWith('/media_publish'))).toBe(false);
    expect((await loadPackage('01')).status).toBe('approved');
  });

  it('marks an unanswered publish uncertain, never retries, and finds the post on Instagram later', async () => {
    makePackage('01', 1);
    await approvePackage('01', 'owner', NOW);
    const first = fakeMeta({ publish: () => Promise.reject(new Error('timeout')) });
    const p = await publishViaMeta('01', 'owner', { fetch: first.f, now: NOW, ...fast });
    expect(p.status).toBe('uncertain');
    expect(first.calls.filter((c) => c.url.endsWith('/media_publish'))).toHaveLength(1);
    const later = fakeMeta({ status: 'PUBLISHED', media: [{ id: '999', caption: 'Caption 01 #DemoBrand', timestamp: new Date(NOW + 5000).toISOString(), permalink: 'https://www.instagram.com/p/ABCdef123/' }] });
    const q = await checkMeta('01', 'owner', { fetch: later.f, now: NOW, ...fast });
    expect(q.status).toBe('posted');
    expect(later.calls.some((c) => c.url.endsWith('/media_publish'))).toBe(false);
  });

  it('frees the approval when Instagram clearly refuses or confirms it was not published', async () => {
    makePackage('01', 1);
    await approvePackage('01', 'owner', NOW);
    const no = fakeMeta({ publish: () => json(400, { error: { message: 'Media is invalid', code: 9004 } }) });
    await expect(publishViaMeta('01', 'owner', { fetch: no.f, now: NOW, ...fast })).rejects.toThrow(/Nothing was posted/);
    expect((await loadPackage('01')).status).toBe('approved');

    const unclear = fakeMeta({ publish: () => json(500, {}) });
    expect((await publishViaMeta('01', 'owner', { fetch: unclear.f, now: NOW, ...fast })).status).toBe('uncertain');
    const notPublished = fakeMeta({ status: 'FINISHED' });
    expect((await checkMeta('01', 'owner', { fetch: notPublished.f, now: NOW, ...fast })).status).toBe('approved');
    expect(notPublished.calls.some((c) => c.url.endsWith('/media_publish'))).toBe(false);
  });

  it('keeps tokens out of messages', () => {
    expect(redactToken(`bad https://graph.instagram.com/me?access_token=${TOKEN}&x=1 and ${TOKEN}`)).not.toContain(TOKEN);
  });

  it('signs R2 requests with AWS SigV4', () => {
    const h = signV4({ method: 'PUT', host: 'acct.r2.cloudflarestorage.com', path: '/b/k.png', body: Buffer.from('x'), contentType: 'image/png', keyId: 'AK', secret: 'S', now: new Date('2026-11-04T11:00:00Z') });
    expect(h['x-amz-date']).toBe('20261104T110000Z');
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261104\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("Signal's own scheduler", () => {
  it('schedules, moves and cancels, keeping one post per day', async () => {
    makePackage('01', 1);
    makePackage('02', 1);
    await approvePackage('01', 'owner', NOW);
    await approvePackage('02', 'owner', NOW);
    const p = await scheduleInSignal('01', '2026-11-05T17:00:00.000Z', 'owner', NOW);
    expect(p.status).toBe('scheduled');
    expect(p.scheduled).toMatchObject({ provider: 'signal', scheduled_for: '2026-11-05T17:00:00.000Z' });
    await expect(scheduleInSignal('02', '2026-11-05T08:00:00.000Z', 'owner', NOW)).rejects.toThrow(/one post per day/);
    expect((await moveSignalSchedule('01', '2026-11-06T09:00:00.000Z', 'owner', NOW)).plannedFor).toBe('2026-11-06T09:00:00.000Z');
    expect((await cancelSignalSchedule('01', 'owner', NOW)).status).toBe('approved');
  });

  it('is refused until the scheduler switch is on', async () => {
    gate({ scheduler: false });
    makePackage('01', 1);
    await approvePackage('01', 'owner', NOW);
    await expect(scheduleInSignal('01', '2026-11-05T17:00:00.000Z', 'owner', NOW)).rejects.toThrow(/"scheduler"/);
  });

  it('sends a due post on the tick, and turns a long-missed one into "missed" without posting', async () => {
    makePackage('01', 1);
    makePackage('02', 1);
    await approvePackage('01', 'owner', NOW);
    await approvePackage('02', 'owner', NOW);
    await scheduleInSignal('01', '2026-11-05T17:00:00.000Z', 'owner', NOW);
    await scheduleInSignal('02', '2026-11-06T17:00:00.000Z', 'owner', NOW);
    const { f, calls } = fakeMeta();
    const early = await tickProject({ fetch: f, now: NOW, ...fast });
    expect(early.sent).toEqual([]);
    const due = Date.parse('2026-11-05T17:00:30.000Z');
    const r = await tickProject({ fetch: f, now: due, ...fast });
    expect(r.sent).toEqual(['01']);
    expect((await loadPackage('01')).status).toBe('posted');
    // The machine was off from Friday until Saturday morning: post 02 is not sent late.
    await recordConfirm('01');
    const back = Date.parse('2026-11-07T08:00:00.000Z');
    const before = calls.filter((c) => c.url.endsWith('/media_publish')).length;
    const r2 = await tickProject({ fetch: f, now: back, ...fast });
    expect(r2.missed).toEqual(['02']);
    expect(calls.filter((c) => c.url.endsWith('/media_publish')).length).toBe(before);
    const p2 = await loadPackage('02');
    expect(p2.status).toBe('approved');
    expect(p2.missedAt).toBeTruthy();
  });
});

async function recordConfirm(id: string) {
  // Label confirmation by the owner after posting (kept separate from the scheduler).
  const { confirmLabel } = await import('@/lib/studio/content');
  await confirmLabel(id, 'owner', NOW);
}

describe('results and comments from Instagram', () => {
  it('reads post numbers from Instagram, matching manual posts by their link', async () => {
    makePackage('01', 1);
    await approvePackage('01', 'owner', NOW);
    await recordPosted('01', 'https://www.instagram.com/p/ABCdef123/', true, 'owner', NOW);
    const { f } = fakeMeta({ media: [{ id: '999', permalink: 'https://www.instagram.com/p/ABCdef123/', caption: 'x' }] });
    const r = await refreshMetrics({ fetch: f, now: NOW, force: true });
    expect(r).toEqual({ refreshed: 1, errors: [] });
    expect((await listPackages())[0]!.metrics?.metrics).toMatchObject({ views: 900, reach: 600, likes: 30, saves: 6, shares: null });
    expect(existsSync(path.join(root, 'posts', '01', 'metrics.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, 'posts', '01', 'metrics.json'), 'utf8')).metrics.views).toBe(900);
  });

  it('replies to a comment and rejects empty replies', async () => {
    const f = vi.fn(async () => json(200, { id: '555' })) as unknown as typeof fetch;
    expect(await replyToComment('1234567', 'Thanks!', f)).toBe('555');
    await expect(replyToComment('1234567', '   ', f)).rejects.toThrow(/1–2200/);
  });
});
