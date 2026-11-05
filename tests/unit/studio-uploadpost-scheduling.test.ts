// Results (analytics), scheduling on Upload-Post, brand import and website posts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, listPackages, loadPackage, recordPosted } from '@/lib/studio/content';
import { cancelSchedule, checkDispatch, dispatchPackage, reschedule } from '@/lib/studio/dispatch';
import { insights, parseMetrics, rate, refreshMetrics } from '@/lib/studio/analytics';
import { discoverArticles, fontFamilies, hexColors, importWebsite, loadBrand, pickColors, updateBrand } from '@/lib/studio/brand';
import { generatePackage } from '@/lib/studio/generate';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const TOMORROW_18 = '2026-11-05T17:00:00.000Z'; // 18:00 Amsterdam
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let root = '';

function gate(o: { analytics?: boolean; scheduling?: boolean } = {}) {
  writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, analytics: o.analytics ?? true, scheduling: o.scheduling ?? true });
}
function makePackage(id: string) {
  const d = path.join(root, 'posts', id);
  mkdirSync(d, { recursive: true });
  const s1 = Buffer.from(`slide-1-${id}`), cap = `Caption ${id}`;
  writeFileSync(path.join(d, 'slide-1.png'), s1);
  writeFileSync(path.join(d, 'caption.txt'), cap);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'carousel', destination: '@signal.demo', 
    files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(s1) }, { name: 'caption.txt', role: 'caption', sha256: sha(cap) }] }));
  return d;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-up-sched-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.UPLOAD_POST_API_KEY = 'test-key-abcdefghijklmnopqrstuvwxyz0123456789';
  process.env.UPLOAD_POST_PROFILE = 'demo-profile';
  process.env.SIGNAL_ALLOW_PRIVATE_FETCH = '1';
  mkdirSync(path.join(root, 'posts'));
  gate();
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'UPLOAD_POST_API_KEY', 'UPLOAD_POST_PROFILE', 'SIGNAL_ALLOW_PRIVATE_FETCH']) delete process.env[k];
});

describe('scheduling on Upload-Post', () => {
  it('is refused until the switch is on, and sends nothing', async () => {
    gate({ scheduling: false });
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const f = vi.fn();
    await expect(dispatchPackage('01', 'owner', { fetch: f as never, now: NOW, scheduleFor: TOMORROW_18 })).rejects.toThrow(/uploadPostScheduling/);
    expect(f).not.toHaveBeenCalled();
  });

  it('schedules with scheduled_date, then moves and cancels it', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const f = vi.fn(async () => json(202, { success: true, job_id: 'job-1' }));
    const p = await dispatchPackage('01', 'owner', { fetch: f as never, now: NOW, scheduleFor: TOMORROW_18 });
    expect(p.status).toBe('scheduled');
    expect(p.scheduled).toMatchObject({ job_id: 'job-1', scheduled_for: TOMORROW_18 });
    expect(p.plannedFor).toBe(TOMORROW_18);
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('scheduled_date')).toBe('2026-11-05T17:00:00Z');
    expect(form.get('async_upload')).toBeNull();
    expect(form.get('is_ai_generated')).toBe('true');

    // Too soon, or a day that already has a post, is refused before any call.
    await expect(reschedule('01', new Date(NOW + 60_000).toISOString(), 'owner', { fetch: f as never, now: NOW })).rejects.toThrow(/10 minutes/);

    const patch = vi.fn(async () => json(200, { success: true }));
    const moved = await reschedule('01', '2026-11-06T09:00:00.000Z', 'owner', { fetch: patch as never, now: NOW });
    expect(moved.scheduled?.scheduled_for).toBe('2026-11-06T09:00:00.000Z');
    const [url, init] = patch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.upload-post.com/api/uploadposts/schedule/job-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ scheduled_date: '2026-11-06T09:00:00Z' });

    const busy = vi.fn(async () => json(409, { error: 'publishing' }));
    await expect(reschedule('01', '2026-11-07T09:00:00.000Z', 'owner', { fetch: busy as never, now: NOW })).rejects.toThrow(/publishing/);

    const del = vi.fn(async () => json(200, { success: true }));
    const back = await cancelSchedule('01', 'owner', { fetch: del as never, now: NOW });
    expect((del.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
    expect(back.status).toBe('approved');
    expect(back.plannedFor).toBe('2026-11-06T09:00:00.000Z');
    // Files are renamed, never deleted.
    expect(readdirSync(path.join(root, 'posts', '01')).some((n) => n.startsWith('scheduled-released-'))).toBe(true);
  });

  it('releases the claim after a definite rejection and keeps unclear answers paused', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const no = vi.fn(async () => json(400, { error: 'bad date' }));
    await expect(dispatchPackage('01', 'owner', { fetch: no as never, now: NOW, scheduleFor: TOMORROW_18 })).rejects.toThrow();
    expect((await loadPackage('01')).status).toBe('approved');
    const boom = vi.fn(async () => json(500, {}));
    expect((await dispatchPackage('01', 'owner', { fetch: boom as never, now: NOW, scheduleFor: TOMORROW_18 })).status).toBe('uncertain');
  });

  it('keeps one post per day across scheduled posts', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    await approvePackage('02', 'owner', NOW);
    const f = vi.fn(async () => json(202, { job_id: 'job-1' }));
    await dispatchPackage('01', 'owner', { fetch: f as never, now: NOW, scheduleFor: TOMORROW_18 });
    await expect(dispatchPackage('02', 'owner', { fetch: f as never, now: NOW, scheduleFor: '2026-11-05T08:00:00.000Z' })).rejects.toThrow(/one post per day/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('checks a scheduled job by job_id and records the post once it is live', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(202, { job_id: 'job-9' })) as never, now: NOW, scheduleFor: TOMORROW_18 });
    const pending = vi.fn(async () => json(200, { status: 'pending' }));
    expect((await checkDispatch('01', 'owner', { fetch: pending as never })).status).toBe('scheduled');
    expect(String((pending.mock.calls[0] as unknown as [string])[0])).toContain('job_id=job-9');
  });
});

describe('results from Upload-Post analytics', () => {
  it('parses metrics and computes the engagement rate', () => {
    const m = parseMetrics({ platforms: { instagram: { post_metrics: { views: 1200, reach: '800', likes: 40, comments: 4, saves: 12, shares: 4 } } } });
    expect(m).toMatchObject({ views: 1200, reach: 800, likes: 40, impressions: null });
    expect(rate(m)).toBeCloseTo(60 / 800);
    expect(parseMetrics({ platforms: {} })).toBeNull();
  });

  it('is off until the switch is on', async () => {
    gate({ analytics: false });
    const f = vi.fn();
    expect((await refreshMetrics({ fetch: f as never })).errors[0]).toMatch(/uploadPostResults/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refreshes posted packages with a request id, caches for 3 hours and ranks formats', async () => {
    for (const id of ['01', '02']) {
      makePackage(id);
      const at = NOW + Number(id) * 86_400_000;
      await approvePackage(id, 'owner', at);
      await recordPosted(id, `https://www.instagram.com/p/Abc${id}xyz/`, true, 'owner', at);
      // As written by Check status after an automatic post: the posted record carries Upload-Post's request id.
      const pf = path.join(root, 'posts', id, 'posted.json');
      writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, 'utf8')), request_id: `req-${id}` }));
    }
    const posted = (await listPackages()).filter((p) => p.posted);
    expect(posted).toHaveLength(2);
    const f = vi.fn(async (url: string) =>
      url.includes('req-01')
        ? json(200, { platforms: { instagram: { post_metrics: { views: 1000, reach: 500, likes: 50, comments: 0, saves: 0, shares: 0 } } } })
        : json(200, { platforms: { instagram: { post_metrics_error: 'Not ready' } } }),
    );
    const r = await refreshMetrics({ fetch: f as never, now: NOW });
    expect(r.refreshed).toBe(2);
    expect(r.errors[0]).toMatch(/Post 02: Not ready/);
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toBe('https://api.upload-post.com/api/uploadposts/post-analytics/req-01?platform=instagram');
    // Cached: a second call within 3 hours fetches nothing.
    await refreshMetrics({ fetch: f as never, now: NOW + 3600_000 });
    expect(f).toHaveBeenCalledTimes(2);
    const ins = insights(await listPackages());
    expect(ins.measured).toBe(1);
    expect(ins.totals).toEqual({ views: 1000, reach: 500, engagement: 50 });
    expect(ins.byFormat[0]).toMatchObject({ posts: 1, avgViews: 1000 });
    expect(ins.bestHour).toBeNull(); // needs 3+ measured posts
  });
});

const PNG = () => sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff5d52' } }).png().toBuffer();
async function site(): Promise<typeof fetch> {
  const png = await PNG();
  const pages: Record<string, () => Response> = {
    'https://example.test/': () =>
      new Response(
        `<html><head><title>Example | Photo stories</title><meta property="og:description" content="Stories told in photos."><meta name="theme-color" content="#1a7f64">
        <meta property="og:image" content="/og.png"><link rel="apple-touch-icon" href="/icon.png"><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="https://evil.test/x.css"></head>
        <body><h1>Every photo has a story</h1><a href="https://instagram.com/example.photo">IG</a></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
    'https://example.test/s.css': () => new Response(`:root{--brand:#1a7f64;--ink:#111111} body{font-family:"Fraunces", serif; background:#ffffff} a{color:#1a7f64} .x{color:#f0a500}`, { headers: { 'content-type': 'text/css' } }),
    'https://example.test/og.png': () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    'https://example.test/icon.png': () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    'https://example.test/sitemap.xml': () => new Response('<urlset><url><loc>https://example.test/</loc></url><url><loc>https://example.test/blog/harbour-light</loc></url></urlset>', { headers: { 'content-type': 'application/xml' } }),
    'https://example.test/blog/harbour-light': () =>
      new Response('<html><head><meta property="og:title" content="Harbour light at dawn"><meta property="og:description" content="Five frames from a cold morning on the quay."></head><body><p>x</p></body></html>', { headers: { 'content-type': 'text/html' } }),
  };
  return vi.fn(async (u: string) => {
    if (u.startsWith('https://evil.test')) throw new Error('must not fetch other hosts');
    return pages[u]?.() ?? new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('brand import and website posts', () => {
  it('finds colours and fonts in CSS', () => {
    const counts = hexColors('a{color:#1A7F64} b{color:#1a7f64;background:#fff} c{color:#f0a500}');
    expect(counts.get('#1a7f64')).toBe(2);
    const { colors, palette } = pickColors(counts);
    expect(colors.primary).toBe('#1a7f64');
    expect(palette).toContain('#f0a500');
    expect(fontFamilies('body{font-family:"Fraunces", Georgia, serif} h1{font-family: Inter, sans-serif}')).toEqual(expect.arrayContaining(['Fraunces', 'Inter']));
  });

  it('imports a public website into the brand kit without touching other hosts', async () => {
    const f = await site();
    const kit = await importWebsite('example.test', f);
    expect(kit.name).toBe('Example');
    expect(kit.tagline).toBe('Stories told in photos.');
    expect(kit.colors.primary).toBe('#1a7f64');
    expect(kit.fonts).toContain('Fraunces');
    expect(kit.instagram).toBe('@example.photo');
    expect(kit.logo).toBeTruthy();
    expect(existsSync(path.join(root, 'brand', 'logo.png'))).toBe(true);
    expect((await loadBrand())?.website).toBe('https://example.test');
    const saved = await updateBrand({ voice: ['calm', 'clear'] });
    expect(saved.voice).toEqual(['calm', 'clear']);
  });

  it('refuses private addresses unless allowed for tests', async () => {
    delete process.env.SIGNAL_ALLOW_PRIVATE_FETCH;
    await expect(importWebsite('http://127.0.0.1/', vi.fn() as never)).rejects.toThrow(/private network/);
  });

  it('makes a two-slide website post from a page on the site', async () => {
    const f = await site();
    await importWebsite('example.test', f);
    expect(await discoverArticles(f)).toEqual(['https://example.test/blog/harbour-light']);
    vi.stubGlobal('fetch', f);
    const { id } = await generatePackage({ format: 'website-card', articleUrl: 'https://example.test/blog/harbour-light', now: NOW });
    const pkg = await loadPackage(id);
    expect(pkg.status).toBe('ready');
    expect(pkg.files.filter((x) => x.role === 'slide')).toHaveLength(2);
    expect(pkg.source?.format).toBe('website-card');
    expect(pkg.source?.category).toBe('https://example.test/blog/harbour-light');
    expect(pkg.caption).toMatch(/Harbour light at dawn/);
    const meta = await sharp(readFileSync(path.join(root, 'posts', id, pkg.files[0]!.name))).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    await expect(generatePackage({ format: 'website-card', articleUrl: 'https://other.test/x', now: NOW })).rejects.toThrow(/own website/);
  });
});

