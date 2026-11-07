// @vitest-environment node
// reference uploads: magic-byte typing, the 500 MB / 20 MB / 300 s limits, the in-process
// MP4/MOV and image probes, page links through getPublic only, and social links refused. No network (guard on).
import './guard';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { imageSize, parseMoov, sniff } from '@/lib/studio/postmaker/media-probe';
import { addReferenceFile, addReferenceLink, readReference, SOCIAL_LINK_TEXT } from '@/lib/studio/postmaker/references';
import { tmp } from './guard';
import { jpeg, mp4, png, webp } from './media-fixtures';

const PROJECT = { timeZone: 'Europe/Berlin' };
const NOW = Date.parse('2026-11-06T10:00:00Z');

/** A body stream delivering `buf` in chunks of `size` bytes (the way a browser upload arrives). */
const stream = (buf: Buffer, size = 64 * 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size)));
      c.close();
    },
  });

const add = (buf: Buffer, o: { declaredBytes?: number | null } = {}) => addReferenceFile(tmp.root, PROJECT, stream(buf), { by: 'owner@example.test', now: NOW, ...o });

async function refusal(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(isPostmakerError(e), String(e)).toBe(true);
    return { status: (e as { status: number }).status, message: (e as Error).message };
  }
  throw new Error('expected a refusal');
}

describe('sniff and probe', () => {
  it('types files by their first bytes, never by name', () => {
    expect(sniff(mp4().subarray(0, 16))).toMatchObject({ kind: 'video', ext: 'mp4' });
    expect(sniff(mp4({ brand: 'qt  ' }).subarray(0, 16))).toMatchObject({ kind: 'video', ext: 'mov' });
    expect(sniff(png().subarray(0, 16))).toMatchObject({ kind: 'image', ext: 'png' });
    expect(sniff(jpeg().subarray(0, 16))).toMatchObject({ kind: 'image', ext: 'jpg' });
    expect(sniff(webp().subarray(0, 16))).toMatchObject({ kind: 'image', ext: 'webp' });
    expect(sniff(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniff(Buffer.from('GIF89a........'))).toBeNull();
  });

  it('reads duration, size, frame rate, codec and audio from the moov box', () => {
    const file = mp4({ seconds: 12.5, width: 1080, height: 1920, fps: 30 });
    const moovAt = file.indexOf(Buffer.from('moov')) - 4;
    expect(parseMoov(file.subarray(moovAt + 8))).toEqual({ durationMs: 12_500, width: 1080, height: 1920, fps: 30, hasAudio: true, codec: 'avc1' });
    const silent = mp4({ audio: false, fps: 25, seconds: 4 });
    expect(parseMoov(silent.subarray(silent.indexOf(Buffer.from('moov')) + 4))).toMatchObject({ hasAudio: false, fps: 25 });
  });

  it('reads image sizes from PNG, JPEG and WebP headers', () => {
    expect(imageSize(png(64, 32), 'png')).toEqual({ width: 64, height: 32 });
    expect(imageSize(jpeg(40, 30), 'jpg')).toEqual({ width: 40, height: 30 });
    expect(imageSize(webp(50, 20), 'webp')).toEqual({ width: 50, height: 20 });
  });
});

describe('addReferenceFile', () => {
  it('stores an MP4 under refs/<id>/ with ref.json and probe.json; the id is dated in the project zone', async () => {
    const buf = mp4({ seconds: 30 });
    const ref = await add(buf, { declaredBytes: buf.length });
    expect(ref).toMatchObject({ schema: 'signal.pm.reference/1', kind: 'video', file: 'source.mp4', rights: 'third-party-structure-only', addedBy: 'owner@example.test', url: null });
    expect(ref.id).toMatch(/^ref-20261106-[0-9a-f]{4}$/);
    expect(ref.probe).toMatchObject({ durationMs: 30_000, width: 1080, height: 1920 });
    const dir = path.join(tmp.root, 'refs', ref.id);
    expect(readFileSync(path.join(dir, 'source.mp4')).equals(buf)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'probe.json'), 'utf8'))).toEqual(ref.probe);
    expect(await readReference(tmp.root, ref.id)).toEqual(ref);
    expect(readdirSync(path.join(tmp.root, 'refs', '.incoming'))).toEqual([]); // the temp file is gone
  });

  it('accepts a MOV and the three image types', async () => {
    expect((await add(mp4({ brand: 'qt  ' }))).file).toBe('source.mov');
    expect(await add(png(10, 20))).toMatchObject({ kind: 'image', file: 'source.png', probe: { width: 10, height: 20, durationMs: 0 } });
    expect((await add(jpeg())).file).toBe('source.jpg');
    expect((await add(webp())).file).toBe('source.webp');
  });

  it('refuses a video longer than 300 s, keeps 300 s exactly', async () => {
    expect(await refusal(add(mp4({ seconds: 300.5 })))).toEqual({ status: 400, message: 'Videos can be up to 5 minutes long.' });
    expect((await add(mp4({ seconds: 300 }))).probe!.durationMs).toBe(300_000);
  });

  it('refuses by magic bytes: an HTML file named .mp4, a GIF, an empty body, a video with no readable moov', async () => {
    for (const bad of [Buffer.from('<html>hello world, this is not a video</html>'), Buffer.from('GIF89a' + 'x'.repeat(40)), Buffer.alloc(0), Buffer.concat([mp4().subarray(0, 40)])]) {
      expect((await refusal(add(bad))).status).toBe(400);
    }
    expect(existsSync(path.join(tmp.root, 'refs')) ? readdirSync(path.join(tmp.root, 'refs')).filter((f) => f !== '.incoming') : []).toEqual([]);
  });

  it('refuses a declared size over 500 MB before reading, and stops an image past 20 MB while streaming', async () => {
    expect(await refusal(add(png(), { declaredBytes: 500 * 1024 * 1024 + 1 }))).toEqual({ status: 400, message: 'Files can be up to 500 MB.' });
    const big = Buffer.concat([png(), Buffer.alloc(20 * 1024 * 1024)]);
    expect(await refusal(add(big, { declaredBytes: null }))).toEqual({ status: 400, message: 'Images can be up to 20 MB.' });
    expect(readdirSync(path.join(tmp.root, 'refs', '.incoming'))).toEqual([]);
  });
});

describe('addReferenceLink', () => {
  const page = '<html><head><title>Example page</title></head><body>Hello</body></html>';
  const fakeFetch = (async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const resolve = async () => [{ address: '93.184.216.34' }];

  it('refuses social-platform links without fetching them', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response('');
    }) as unknown as typeof fetch;
    for (const url of ['https://www.instagram.com/reel/abcdef/', 'https://vm.tiktok.com/xyz', 'https://youtu.be/abc', 'https://m.youtube.com/watch?v=1', 'https://x.com/a/status/1']) {
      expect(await refusal(addReferenceLink(tmp.root, PROJECT, url, { by: 'o', deps: { fetch: counting, resolve } }))).toEqual({ status: 400, message: SOCIAL_LINK_TEXT });
    }
    expect(calls).toBe(0);
  });

  it('reads a public page once through getPublic and keeps it as page.html', async () => {
    const ref = await addReferenceLink(tmp.root, PROJECT, 'https://example.com/page', { by: 'o', now: NOW, deps: { fetch: fakeFetch, resolve } });
    expect(ref).toMatchObject({ kind: 'page', file: 'page.html', url: 'https://example.com/page', probe: null });
    expect(readFileSync(path.join(tmp.root, 'refs', ref.id, 'page.html'), 'utf8')).toBe(page);
  });

  it('refuses private hosts (getPublic), passwords in links and a link that answers with a video', async () => {
    expect((await refusal(addReferenceLink(tmp.root, PROJECT, 'https://intranet.example/x', { by: 'o', deps: { fetch: fakeFetch, resolve: async () => [{ address: '10.0.0.5' }] } }))).status).toBe(400);
    expect((await refusal(addReferenceLink(tmp.root, PROJECT, 'https://u:p@example.com/', { by: 'o', deps: { fetch: fakeFetch, resolve } }))).status).toBe(400);
    const video = (async () => new Response('x', { status: 200, headers: { 'content-type': 'video/mp4' } })) as unknown as typeof fetch;
    expect(await refusal(addReferenceLink(tmp.root, PROJECT, 'https://cdn.example.com/clip', { by: 'o', deps: { fetch: video, resolve } }))).toEqual({ status: 400, message: SOCIAL_LINK_TEXT });
  });
});
