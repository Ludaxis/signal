// Brand import fetch guard: every redirect hop re-checked, at most MAX_REDIRECTS, a streamed
// byte cap, and app store pages refused as brand sources. No network: fake fetch and fake DNS.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandError, MAX_REDIRECTS, getPublic, importWebsite, privateIp, type Resolve } from '@/lib/studio/brand';

let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-brand-fetch-'));
  process.env.SIGNAL_CONTENT_DIR = path.join(root, 'posts');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  delete process.env.SIGNAL_ALLOW_PRIVATE_FETCH;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_ALLOW_PRIVATE_FETCH']) delete process.env[k];
});

const DNS: Record<string, string[]> = { 'brand.test': ['93.184.216.34'], 'cdn.brand.test': ['2606:4700::6810:85e5'], 'internal.test': ['10.0.0.5'], 'mixed.test': ['93.184.216.34', '127.0.0.1'] };
const resolve: Resolve = async (host) => (DNS[host] ?? []).map((address) => ({ address }));
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
function fakeFetch(pages: Record<string, () => Response>) {
  return vi.fn(async (u: string, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    const page = pages[u];
    if (!page) throw new Error(`unexpected fetch ${u}`);
    return page();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('private address check', () => {
  it.each([
    ['10.1.2.3', true], ['127.0.0.1', true], ['0.0.0.0', true], ['169.254.169.254', true], ['172.16.0.1', true], ['172.31.255.255', true], ['192.168.1.1', true], ['100.64.0.1', true], ['224.0.0.1', true], ['198.18.0.1', true],
    ['172.32.0.1', false], ['8.8.8.8', false], ['93.184.216.34', false],
    ['::1', true], ['::', true], ['fd00::1', true], ['fe80::1', true], ['fe80::1%en0', true], ['ff02::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['::ffff:10.0.0.1', true], ['::127.0.0.1', true], ['64:ff9b::a00:1', true], ['64:ff9b::169.254.169.254', true],
    ['::ffff:8.8.8.8', false], ['64:ff9b::808:808', false], ['2606:4700::6810:85e5', false], ['2001:4860:4860::8888', false],
    ['not-an-ip', true],
  ])('%s → private %s', (ip, expected) => {
    expect(privateIp(ip)).toBe(expected);
  });
});

describe('redirects are followed by hand and every hop is re-checked', () => {
  it('refuses a redirect to a private IP literal without fetching it', async () => {
    const f = fakeFetch({ 'https://brand.test/': () => redirect('http://169.254.169.254/latest/meta-data/') });
    await expect(getPublic('https://brand.test/', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a host that resolves to a private address, or to any private address', async () => {
    const f = fakeFetch({ 'https://brand.test/': () => redirect('https://internal.test/admin'), 'https://brand.test/b': () => redirect('https://mixed.test/') });
    await expect(getPublic('https://brand.test/', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    await expect(getPublic('https://brand.test/b', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('refuses a redirect to an IPv6 loopback literal and to a non-http scheme', async () => {
    const f = fakeFetch({ 'https://brand.test/': () => redirect('http://[::1]:8080/'), 'https://brand.test/f': () => redirect('file:///etc/passwd') });
    await expect(getPublic('https://brand.test/', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    await expect(getPublic('https://brand.test/f', f, 1000, undefined, resolve)).rejects.toThrow(/Only http/);
  });

  it('follows public redirects (relative ones too) and reports the final address', async () => {
    const f = fakeFetch({
      'http://brand.test/': () => redirect('https://brand.test/', 301),
      'https://brand.test/': () => redirect('/home', 308),
      'https://brand.test/home': () => redirect('https://cdn.brand.test/home'),
      'https://cdn.brand.test/home': () => html('<title>Brand</title>'),
    });
    const r = await getPublic('http://brand.test/', f, 1000, undefined, resolve);
    expect(r).toMatchObject({ ok: true, status: 200, url: 'https://cdn.brand.test/home' });
    expect(r.body.toString()).toBe('<title>Brand</title>');
    expect(f).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const f = fakeFetch(Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`https://brand.test/${i}`, () => redirect(`/${i + 1}`)])));
    await expect(getPublic('https://brand.test/0', f, 1000, undefined, resolve)).rejects.toThrow(/redirects too many times/);
    expect(f).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('refuses the first host too when it is private or unknown', async () => {
    const f = fakeFetch({});
    await expect(getPublic('https://internal.test/', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    await expect(getPublic('https://nowhere.test/', f, 1000, undefined, resolve)).rejects.toThrow(/Can't find/);
    await expect(getPublic('http://127.0.0.1/', f, 1000, undefined, resolve)).rejects.toThrow(/private network/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('byte cap', () => {
  function endless(chunk = 64 * 1024) {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls > 200) c.close();
        else c.enqueue(new Uint8Array(chunk));
      },
    });
    return { stream, pulls: () => pulls };
  }

  it('stops reading a body with no Content-Length as soon as it passes the cap', async () => {
    const big = endless();
    const f = fakeFetch({ 'https://brand.test/': () => new Response(big.stream, { headers: { 'content-type': 'text/html' } }) });
    const e = await getPublic('https://brand.test/', f, 100_000, undefined, resolve).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrandError);
    expect((e as BrandError).status).toBe(413);
    expect(big.pulls()).toBeLessThan(10); // ~2 chunks of 64 KB read, not 200
  });

  it('refuses a declared Content-Length over the cap before reading the body', async () => {
    const big = endless();
    const f = fakeFetch({ 'https://brand.test/': () => new Response(big.stream, { headers: { 'content-type': 'text/html', 'content-length': '5000000' } }) });
    await expect(getPublic('https://brand.test/', f, 100_000, undefined, resolve)).rejects.toThrow(/too large/);
    expect(big.pulls()).toBeLessThanOrEqual(1);
  });

  it('accepts a body exactly at the cap', async () => {
    const f = fakeFetch({ 'https://brand.test/': () => new Response(new Uint8Array(1000), { headers: { 'content-type': 'image/png' } }) });
    const r = await getPublic('https://brand.test/', f, 1000, 'image/*', resolve);
    expect(r.body.length).toBe(1000);
  });
});

describe('app store pages are not brand sources', () => {
  it('refuses play.google.com and apps.apple.com before fetching anything', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(importWebsite('https://play.google.com/store/apps/example', f)).rejects.toThrow(/app store page, not the brand’s own website/);
    await expect(importWebsite('apps.apple.com/us/app/example/id123', f)).rejects.toThrow(/app store page/);
    await expect(importWebsite('https://itunes.apple.com/app/id123', f)).rejects.toThrow(/app store page/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a website that redirects to a store page, and saves nothing', async () => {
    process.env.SIGNAL_ALLOW_PRIVATE_FETCH = '1'; // fake hosts; DNS is not under test here
    const f = fakeFetch({ 'https://short.test/': () => redirect('https://apps.apple.com/us/app/example/id123'), 'https://apps.apple.com/us/app/example/id123': () => html('<title>Example on the App Store</title>') });
    await expect(importWebsite('short.test', f)).rejects.toThrow(/app store page/);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
