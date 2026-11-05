// Higgsfield images and Reels: client, gate, redaction, formats, campaigns.
// No real network: every test injects a fake fetch. ffmpeg and sharp are the real local tools (tiny fixtures).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import {
  estimateImageCostUsd,
  estimateVideoCostUsd,
  HF_BASE,
  HF_IMAGE_COST_USD,
  HF_IMAGE_MODEL,
  HF_VIDEO_COST_USD_PER_SECOND_ESTIMATE,
  HF_VIDEO_MODEL,
  higgsfieldAllowed,
  higgsfieldClient,
  HiggsfieldError,
  parseStatus,
  redactHiggsfield,
} from '@/lib/studio/higgsfield';
import { ANY_PROJECT_FORMATS, BRIEF_FORMATS, FORMAT_LABEL, FORMATS, generatePackage } from '@/lib/studio/generate';
import { listPackages, loadPackage } from '@/lib/studio/content';
import { withProject, type Project } from '@/lib/studio/projects';
import { probeMedia } from '@/lib/studio/reel';
import { approveStrategy, cleanCampaignInput, createCampaign, makePlan, makeSlotPost, updateCampaign } from '@/lib/studio/campaigns';
import type { Runner } from '@/lib/studio/claude-agent';

const KEY_ID = 'hfid_test_1234567890';
const KEY_SECRET = 'hfsecret_SUPERSECRET_abcdefghij';
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
let root = '';
let stillPortrait: Buffer; // 3:4
let stillVertical: Buffer; // 9:16
let tinyMp4: Buffer;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = async () => {};

interface Seen { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** A scripted Higgsfield: submits return queued requests; each poll walks the given status list; downloads serve bytes. */
function fakeHiggsfield(o: { imageStatuses?: unknown[]; videoStatuses?: unknown[]; imageBytes?: Buffer; videoBytes?: Buffer; imageType?: string; videoType?: string; submitStatus?: number; submitBody?: unknown } = {}) {
  const seen: Seen[] = [];
  const polls: Record<string, number> = {};
  const imgUrl = 'https://cdn.higgsfield.test/out/img.png';
  const vidUrl = 'https://cdn.higgsfield.test/out/clip.mp4';
  const defaults = {
    img: o.imageStatuses ?? [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', images: [{ url: imgUrl }] }],
    vid: o.videoStatuses ?? [{ status: 'queued' }, { status: 'completed', video: { url: vidUrl } }],
  };
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({ url, method: init?.method ?? 'GET', headers, body });
    if (url.startsWith(HF_BASE) && headers.Authorization !== `Key ${KEY_ID}:${KEY_SECRET}`) return json(401, { detail: 'Invalid key' });
    if (url === `${HF_BASE}/${HF_IMAGE_MODEL}` || url === `${HF_BASE}/${HF_VIDEO_MODEL}`) {
      if (o.submitStatus) return json(o.submitStatus, o.submitBody ?? { detail: 'nope' });
      const id = url.endsWith(HF_IMAGE_MODEL) ? 'req-img-1' : 'req-vid-1';
      return json(200, { status: 'queued', request_id: id, status_url: `${HF_BASE}/requests/${id}/status`, cancel_url: `${HF_BASE}/requests/${id}/cancel`, expires_after: 604800 });
    }
    const m = url.match(/\/requests\/(req-[a-z]+-\d)\/(status|cancel)$/);
    if (m?.[2] === 'cancel') return json(200, { status: 'canceled' });
    if (m?.[2] === 'status') {
      const list = m[1]!.includes('img') ? defaults.img : defaults.vid;
      const i = polls[m[1]!] ?? 0;
      polls[m[1]!] = i + 1;
      return json(200, list[Math.min(i, list.length - 1)]);
    }
    if (url === imgUrl) return new Response(new Uint8Array(o.imageBytes ?? stillPortrait), { headers: { 'Content-Type': o.imageType ?? 'image/png' } });
    if (url === vidUrl) return new Response(new Uint8Array(o.videoBytes ?? tinyMp4), { headers: { 'Content-Type': o.videoType ?? 'video/mp4' } });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, seen, polls, imgUrl, vidUrl };
}

const example = (): Project => ({ id: 'example', name: 'Example', handle: '@example.photo', uploadPostProfile: '', contentDir: path.join(root, 'posts'), createdAt: '2026-11-01T00:00:00.000Z' });

beforeAll(async () => {
  stillPortrait = await sharp({ create: { width: 810, height: 1080, channels: 3, background: '#1a7f64' } }).png().toBuffer();
  stillVertical = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#241878' } }).png().toBuffer();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'signal-hf-fixture-'));
  const file = path.join(dir, 'clip.mp4');
  // A 1-second 360x640 clip without audio, like a small model output.
  execFileSync(ffmpegPath!, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  tinyMp4 = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-hf-'));
  mkdirSync(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_PROMPTS_DIR = path.join(root, 'agents');
  process.env.HF_API_KEY_ID = KEY_ID;
  process.env.HF_API_KEY_SECRET = KEY_SECRET;
  writeTestConfig(path.join(root, 'signal.config.json'), { higgsfield: true, claudeAgents: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_CONTENT_DIR', 'SIGNAL_PROMPTS_DIR', 'HF_API_KEY_ID', 'HF_API_KEY_SECRET']) delete process.env[k];
});

describe('Higgsfield switch', () => {
  it('is off until the switch is on, and off without both keys; reasons never show key values', async () => {
    writeTestConfig(path.join(root, 'signal.config.json'), { higgsfield: false });
    let a = await higgsfieldAllowed();
    expect(a.enabled).toBe(false);
    expect(a.reason).toMatch(/"higgsfield".*signal\.config\.json/);
    writeTestConfig(path.join(root, 'signal.config.json'), { higgsfield: true });
    delete process.env.HF_API_KEY_SECRET;
    a = await higgsfieldAllowed();
    expect(a.enabled).toBe(false);
    expect(a.reason).toContain('HF_API_KEY_SECRET');
    expect(a.reason).not.toContain(KEY_ID);
    process.env.HF_API_KEY_SECRET = KEY_SECRET;
    a = await higgsfieldAllowed();
    expect(a.enabled).toBe(true);
    expect(a.reason).not.toContain(KEY_SECRET);
    rmSync(path.join(root, 'signal.config.json'));
    expect((await higgsfieldAllowed()).reason).toMatch(/signal\.config\.json/);
  });

  it('exports the cost constants used for estimates', () => {
    expect(HF_IMAGE_COST_USD).toBe(0.0032);
    expect(HF_VIDEO_COST_USD_PER_SECOND_ESTIMATE).toBe(0.1);
    expect(estimateImageCostUsd(1)).toBe(0.0032);
    expect(estimateVideoCostUsd(5)).toBe(0.5);
  });
});

describe('Higgsfield client', () => {
  it('sends the Key header, JSON and an idempotency key, then polls and downloads an image', async () => {
    const hf = fakeHiggsfield();
    const c = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    const req = await c.submitImage({ prompt: 'A harbour at dawn', aspectRatio: '3:4', resolution: '1080p' });
    expect(req).toMatchObject({ requestId: 'req-img-1', kind: 'image', model: HF_IMAGE_MODEL, statusUrl: `${HF_BASE}/requests/req-img-1/status` });
    const submit = hf.seen[0]!;
    expect(submit.url).toBe(`${HF_BASE}/${HF_IMAGE_MODEL}`);
    expect(submit.method).toBe('POST');
    expect(submit.headers.Authorization).toBe(`Key ${KEY_ID}:${KEY_SECRET}`);
    expect(submit.headers['Content-Type']).toBe('application/json');
    expect(submit.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(submit.body).toEqual({ prompt: 'A harbour at dawn', aspect_ratio: '3:4', resolution: '1080p', batch_size: 1 });
    const done = await c.waitFor(req);
    expect(done).toMatchObject({ requestId: 'req-img-1', url: hf.imgUrl });
    expect(hf.polls['req-img-1']).toBe(3); // queued → in_progress → completed
    for (const s of hf.seen.filter((x) => x.url.includes('/status'))) expect(s.headers['Idempotency-Key']).toBeUndefined();
    const bytes = await c.download(done.url, 'image');
    expect(bytes.equals(stillPortrait)).toBe(true);
    // The download carries no API key.
    expect(hf.seen.at(-1)!.headers.Authorization).toBeUndefined();
  });

  it('submits image-to-video with the hosted image URL and returns the video URL', async () => {
    const hf = fakeHiggsfield();
    const c = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    const req = await c.submitVideo({ prompt: 'Slow drift', imageUrl: hf.imgUrl, duration: 5, resolution: '720p' });
    expect(req.kind).toBe('video');
    expect(hf.seen[0]!.body).toEqual({ prompt: 'Slow drift', image_url: hf.imgUrl, duration: 5, resolution: '720p' });
    const done = await c.waitFor(req);
    expect(done.url).toBe(hf.vidUrl);
    expect((await c.download(done.url, 'video')).equals(tinyMp4)).toBe(true);
    await expect(c.submitVideo({ prompt: 'x', imageUrl: 'http://insecure/img.png' })).rejects.toThrow(/https/);
  });

  it('turns nsfw, failed, cancelled and bad downloads into clear errors', async () => {
    const nsfw = fakeHiggsfield({ imageStatuses: [{ status: 'nsfw' }] });
    let c = higgsfieldClient({ fetch: nsfw.f, sleep: noSleep });
    let e = await c.waitFor(await c.submitImage({ prompt: 'p', aspectRatio: '1:1' })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HiggsfieldError);
    expect(e as HiggsfieldError).toMatchObject({ kind: 'nsfw', status: 422 });

    const failed = fakeHiggsfield({ imageStatuses: [{ status: 'failed', error: 'GPU exploded' }] });
    c = higgsfieldClient({ fetch: failed.f, sleep: noSleep });
    e = await c.waitFor(await c.submitImage({ prompt: 'p', aspectRatio: '1:1' })).catch((x: unknown) => x);
    expect(e as HiggsfieldError).toMatchObject({ kind: 'failed' });
    expect((e as Error).message).toMatch(/GPU exploded/);
    expect((e as Error).message).toMatch(/not charged/);

    const cancelled = fakeHiggsfield({ imageStatuses: [{ status: 'canceled' }] });
    c = higgsfieldClient({ fetch: cancelled.f, sleep: noSleep });
    e = await c.waitFor(await c.submitImage({ prompt: 'p', aspectRatio: '1:1' })).catch((x: unknown) => x);
    expect(e as HiggsfieldError).toMatchObject({ kind: 'canceled' });

    const noUrl = fakeHiggsfield({ imageStatuses: [{ status: 'completed', images: [] }] });
    c = higgsfieldClient({ fetch: noUrl.f, sleep: noSleep });
    await expect(c.waitFor(await c.submitImage({ prompt: 'p', aspectRatio: '1:1' }))).rejects.toThrow(/no result URL/);

    const html = fakeHiggsfield({ imageType: 'text/html' });
    c = higgsfieldClient({ fetch: html.f, sleep: noSleep });
    await expect(c.download(html.imgUrl, 'image')).rejects.toThrow(/text\/html instead of the image/);
    await expect(c.download('http://cdn.higgsfield.test/x.png', 'image')).rejects.toThrow(/https/);
  });

  it('gives up after the overall timeout and tries to cancel the request', async () => {
    const hf = fakeHiggsfield({ videoStatuses: [{ status: 'in_progress' }] });
    let t = NOW;
    const c = higgsfieldClient({ fetch: hf.f, sleep: noSleep, now: () => (t += 60_000) });
    const req = await c.submitVideo({ prompt: 'p', imageUrl: hf.imgUrl });
    const e = await c.waitFor(req).catch((x: unknown) => x);
    expect(e as HiggsfieldError).toMatchObject({ kind: 'timeout', status: 504 });
    expect((e as Error).message).toMatch(/12 minutes/);
    expect(hf.seen.some((s) => s.url.endsWith('/requests/req-vid-1/cancel') && s.method === 'POST')).toBe(true);
    expect(hf.polls['req-vid-1']).toBeGreaterThan(5);
    expect(hf.polls['req-vid-1']).toBeLessThan(20);
  });

  it('backs off between polls', async () => {
    const hf = fakeHiggsfield({ imageStatuses: [{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }, { status: 'queued' }, { status: 'completed', images: [{ url: 'https://cdn.higgsfield.test/out/img.png' }] }] });
    const waits: number[] = [];
    const c = higgsfieldClient({ fetch: hf.f, sleep: async (ms) => void waits.push(ms) });
    await c.waitFor(await c.submitImage({ prompt: 'p', aspectRatio: '1:1' }));
    expect(waits).toEqual([2000, 3000, 4500, 6750]);
  });

  it('never leaks the key: 401 and echoed secrets are redacted', async () => {
    process.env.HF_API_KEY_SECRET = 'wrong-secret-value';
    const hf = fakeHiggsfield();
    const c = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    const e = (await c.submitImage({ prompt: 'p', aspectRatio: '1:1' }).catch((x: unknown) => x)) as HiggsfieldError;
    expect(e).toMatchObject({ kind: 'auth', status: 401 });
    expect(e.message).not.toContain('wrong-secret-value');
    process.env.HF_API_KEY_SECRET = KEY_SECRET;
    const echo = fakeHiggsfield({ submitStatus: 400, submitBody: { detail: `Bad request for Key ${KEY_ID}:${KEY_SECRET} (${KEY_SECRET})` } });
    const e2 = (await higgsfieldClient({ fetch: echo.f, sleep: noSleep }).submitImage({ prompt: 'p', aspectRatio: '1:1' }).catch((x: unknown) => x)) as HiggsfieldError;
    expect(e2.message).not.toContain(KEY_SECRET);
    expect(e2.message).not.toContain(KEY_ID);
    expect(e2.message).toMatch(/\[key\]/);
    expect(redactHiggsfield(`Authorization: Key abc123:xyz789 and ${encodeURIComponent(KEY_SECRET)}`)).toBe('Authorization: Key [key] and [key]');
    expect(parseStatus({ status: 'failed', error: `token ${KEY_SECRET} rejected` }).error).toBe('token [key] rejected');
    expect(parseStatus({ status: 'completed', result: { images: [{ url: 'https://x.test/a.png' }, { url: 'ftp://no' }] } }).imageUrls).toEqual(['https://x.test/a.png']);
  });
});

describe('Higgsfield formats', () => {
  it('registers both formats for any project', () => {
    expect(FORMATS).toContain('higgsfield-image');
    expect(FORMATS).toContain('higgsfield-reel');
    expect(ANY_PROJECT_FORMATS).toEqual(expect.arrayContaining(['higgsfield-image', 'higgsfield-reel', 'codex-post', 'website-card']));
    expect(BRIEF_FORMATS).toEqual(['codex-post', 'higgsfield-image', 'higgsfield-reel']);
    expect(FORMAT_LABEL['higgsfield-image']).toBe('Higgsfield image');
    expect(FORMAT_LABEL['higgsfield-reel']).toBe('Higgsfield Reel');
  });

  it('refuses when the switch is off or the brief is empty, without calling the API', async () => {
    const hf = fakeHiggsfield();
    const client = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    writeTestConfig(path.join(root, 'signal.config.json'), { higgsfield: false });
    await expect(withProject(example(), () => generatePackage({ format: 'higgsfield-image', brief: { prompt: 'A harbour at dawn, soft light' }, higgsfield: client }))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/higgsfield.*signal\.config\.json/) });
    writeTestConfig(path.join(root, 'signal.config.json'), { higgsfield: true });
    delete process.env.HF_API_KEY_ID;
    await expect(withProject(example(), () => generatePackage({ format: 'higgsfield-reel', brief: { prompt: 'A harbour at dawn, soft light' }, higgsfield: client }))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/HF_API_KEY_ID/) });
    process.env.HF_API_KEY_ID = KEY_ID;
    await expect(withProject(example(), () => generatePackage({ format: 'higgsfield-image', brief: { prompt: 'short' }, higgsfield: client }))).rejects.toThrow(/Describe the image/);
    expect(hf.f).not.toHaveBeenCalled();
    expect(await listPackages()).toEqual([]);
  });

  it('makes a 1080x1350 image package from a brief, with the spend recorded', async () => {
    const hf = fakeHiggsfield();
    const client = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    const { id, spec } = await withProject(example(), () => generatePackage({ format: 'higgsfield-image', brief: { prompt: 'A harbour at dawn, soft light, long exposure', headline: 'Harbour light', caption: 'Five frames from a cold morning.' }, higgsfield: client, now: NOW }));
    const pkg = await withProject(example(), () => loadPackage(id));
    expect(pkg.status).toBe('ready');
    expect(pkg.format).toBe('image');
    expect(pkg.files.map((f) => [f.name, f.role, f.ok])).toEqual([['slide-1.png', 'slide', true], ['caption.txt', 'caption', true]]);
    expect(pkg.caption).toBe('Five frames from a cold morning.\n\n#Example');
    const meta = await sharp(readFileSync(path.join(root, 'posts', id, 'slide-1.png'))).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    expect(spec.source).toMatchObject({ generator: 'signal-higgsfield-v1', format: 'higgsfield-image', category: 'Harbour light' });
    expect(spec.source?.higgsfield).toMatchObject({ imageModel: HF_IMAGE_MODEL, videoModel: null, imageRequestId: 'req-img-1', videoRequestId: null, videoSeconds: null, estimatedCostUsd: 0.0032 });
    expect(spec.source?.higgsfield?.prompt).toMatch(/harbour at dawn/);
    expect(spec.source?.higgsfield?.prompt).toMatch(/No written words/);
    expect(spec.title).toBe('Higgsfield image · Harbour light');
    // Requested 3:4 at 1080p and nothing else.
    expect(hf.seen.filter((s) => s.method === 'POST').map((s) => s.url)).toEqual([`${HF_BASE}/${HF_IMAGE_MODEL}`]);
    expect(hf.seen[0]!.body).toMatchObject({ aspect_ratio: '3:4', resolution: '1080p', batch_size: 1 });
    const manifest = readFileSync(path.join(root, 'posts', id, 'manifest.md'), 'utf8');
    expect(manifest).toContain('req-img-1');
    expect(manifest).not.toContain(KEY_SECRET);
    expect(JSON.stringify(spec)).not.toContain(KEY_SECRET);
  });

  it('makes a Reel package: 9:16 still → Wan video → 1080x1920 H.264/AAC mp4 plus a cover', async () => {
    const hf = fakeHiggsfield({ imageBytes: stillVertical });
    const client = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    const { id, spec } = await withProject(example(), () => generatePackage({ format: 'higgsfield-reel', brief: { prompt: 'Waves rolling onto a harbour wall at dawn' }, higgsfield: client, now: NOW }));
    const pkg = await withProject(example(), () => loadPackage(id));
    expect(pkg.status).toBe('ready');
    expect(pkg.format).toBe('reel');
    expect(pkg.files.map((f) => [f.name, f.role, f.ok])).toEqual([['reel.mp4', 'video', true], ['cover.jpg', 'cover', true], ['caption.txt', 'caption', true]]);
    const info = await probeMedia(path.join(root, 'posts', id, 'reel.mp4'));
    expect(info).toMatchObject({ width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac' });
    expect(info.durationSec).toBeGreaterThan(0.5);
    const cover = await sharp(readFileSync(path.join(root, 'posts', id, 'cover.jpg'))).metadata();
    expect([cover.format, cover.width, cover.height]).toEqual(['jpeg', 1080, 1920]);
    const posts = hf.seen.filter((s) => s.method === 'POST');
    expect(posts.map((s) => s.url)).toEqual([`${HF_BASE}/${HF_IMAGE_MODEL}`, `${HF_BASE}/${HF_VIDEO_MODEL}`]);
    expect(posts[0]!.body).toMatchObject({ aspect_ratio: '9:16', resolution: '1080p' });
    expect(posts[1]!.body).toMatchObject({ image_url: hf.imgUrl, duration: 5, resolution: '720p' });
    expect(spec.source?.higgsfield).toMatchObject({ imageModel: HF_IMAGE_MODEL, videoModel: HF_VIDEO_MODEL, imageRequestId: 'req-img-1', videoRequestId: 'req-vid-1', videoSeconds: 5, estimatedCostUsd: 0.5032 });
    expect(spec.notes?.join(' ')).toMatch(/estimate/i);
    expect(pkg.caption).toBe('Waves rolling onto a harbour wall at dawn\n\n#Example');
  });

  it('surfaces a Higgsfield refusal as a package error and writes nothing', async () => {
    const hf = fakeHiggsfield({ imageStatuses: [{ status: 'nsfw' }] });
    const client = higgsfieldClient({ fetch: hf.f, sleep: noSleep });
    await expect(withProject(example(), () => generatePackage({ format: 'higgsfield-image', brief: { prompt: 'Something the model dislikes' }, higgsfield: client }))).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/unsafe/) });
    expect(await withProject(example(), () => listPackages())).toEqual([]);
  });
});

describe('Higgsfield formats in campaigns', () => {
  const STRATEGY = {
    summary: 'Cinematic stills and short Reels of the harbour.',
    audience: 'Photo lovers',
    positioning: 'Light first',
    pillars: [{ name: 'Light', weight: 100, why: 'It is the brand' }],
    postTypes: [
      { format: 'higgsfield-reel', role: 'Reach', hooks: ['Watch the light move'], captionStyle: 'Short', visualDirection: 'Harbour', hashtags: ['#light'], bestTimes: ['19:30'], dos: [], donts: [] },
      { format: 'higgsfield-image', role: 'Saves', hooks: ['One frame'], captionStyle: 'Short', visualDirection: 'Harbour', hashtags: ['#light'], bestTimes: ['18:00'], dos: [], donts: [] },
    ],
    experiments: [],
    kpis: [],
    research: [],
    risks: [],
  };
  const fence = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  it('accepts the formats and plans a prompt for every slot', async () => {
    const c = cleanCampaignInput({ name: 'Harbour', formats: ['higgsfield-reel', 'higgsfield-image', 'nope'] });
    expect(c.formats).toEqual(['higgsfield-reel', 'higgsfield-image']);

    mkdirSync(path.join(root, 'agents', 'strategist'), { recursive: true });
    mkdirSync(path.join(root, 'agents', 'content-planner'), { recursive: true });
    writeFileSync(path.join(root, 'agents', '_shared.md'), '# Shared rules');
    writeFileSync(path.join(root, 'agents', 'strategist', 'prompt.md'), '# Strategist');
    writeFileSync(path.join(root, 'agents', 'content-planner', 'prompt.md'), '# Planner');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const prompts: string[] = [];
      const runner: Runner = async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('"dates"')) {
          const dates = JSON.parse(prompt.match(/"dates": (\[[^\]]*\])/)![1]!) as string[];
          return { text: fence({ slots: dates.map((date, i) => ({ date, format: i % 2 ? 'higgsfield-image' : 'higgsfield-reel', pillar: 'Light', hook: `Hook ${i}`, angle: 'Angle', captionLead: 'Look.', prompt: `Harbour frame ${i} at dawn`, headline: `Frame ${i}`, articleUrl: '' })) }), seconds: 1, cli: 'test' };
        }
        return { text: fence(STRATEGY), seconds: 1, cli: 'test' };
      };
      // Immediate completions: makeSlotPost uses the real client (real poll sleeps), the fake fetch stands in for the network.
      const hf = fakeHiggsfield({ imageBytes: stillVertical, imageStatuses: [{ status: 'completed', images: [{ url: 'https://cdn.higgsfield.test/out/img.png' }] }], videoStatuses: [{ status: 'completed', video: { url: 'https://cdn.higgsfield.test/out/clip.mp4' } }] });
      const { campaignId, plan, pkg } = await withProject(example(), async () => {
        const camp = await createCampaign({ name: 'Harbour', formats: ['higgsfield-reel', 'higgsfield-image'], perWeek: 2 }, 'owner', NOW);
        const { proposeStrategy } = await import('@/lib/studio/campaigns');
        await proposeStrategy(camp.id, 'owner', '', runner);
        await approveStrategy(camp.id, 'owner', NOW);
        await updateCampaign(camp.id, { status: 'active' });
        const plan = await makePlan(camp.id, 'owner', { runner, now: NOW });
        vi.stubGlobal('fetch', hf.f);
        const made = await makeSlotPost(camp.id, plan.slots[0]!.id, 'owner', NOW);
        return { campaignId: camp.id, plan, pkg: await loadPackage(made.packageId) };
      });
      expect(plan.slots.length).toBeGreaterThan(0);
      expect(plan.slots.map((s) => s.format)).toEqual(expect.arrayContaining(['higgsfield-reel']));
      for (const s of plan.slots) expect(s.prompt).toMatch(/Harbour frame/);
      expect(plan.slots.find((s) => s.format === 'higgsfield-reel')!.headline).toBe(''); // headline only for image formats
      expect(plan.slots.find((s) => s.format === 'higgsfield-image')?.headline ?? 'Frame').toMatch(/Frame/);
      expect(prompts.at(-1)).toMatch(/higgsfield-reel/); // the planner spec names the formats
      expect(pkg.status).toBe('ready');
      expect(pkg.format).toBe('reel');
      expect(pkg.campaign).toMatchObject({ id: campaignId, slot: plan.slots[0]!.id });
      expect(pkg.source?.format).toBe('higgsfield-reel');
      expect(pkg.caption).toMatch(/^Look\.\n\nAngle/);
    } finally {
      vi.useRealTimers();
    }
  });
});
