// Instagram API with Unified Login — config checks, OAuth state (CSRF), token exchange and
// storage, account mapping, permissions, expiry, and publishing safety (pause switch, scheduler).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { checkState, describe as describeConn, disconnect, finishConnect, getConnection, loginUrl, makeState, redactSecrets, unifiedConfig, type StatePayload } from '@/lib/studio/ig-unified';
import { createContainer, getAccount, igFeature, instagramApiAllowed } from '@/lib/studio/meta';
import { metaLive, tickAll } from '@/lib/studio/publish-meta';
import { liveState } from '@/lib/studio/dispatch';
import { resultsSource } from '@/lib/studio/analytics';
import { approvePackage } from '@/lib/studio/content';
import type { Project } from '@/lib/studio/projects';

const SECRET = 'appsecret_0123456789abcdef0123456789';
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'EAAG' + 'x'.repeat(60);
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const PROJECTS: Project[] = [
  { id: 'demo', name: 'Demo', handle: '@signal.demo', uploadPostProfile: 'demo-profile', contentDir: '', createdAt: '' },
  { id: 'example', name: 'Example', handle: '@example.photo', uploadPostProfile: '', contentDir: '', createdAt: '' },
] as Project[];
let root = '';

function env() {
  Object.assign(process.env, {
    META_APP_ID: '100000000000001',
    META_APP_SECRET: SECRET,
    META_LOGIN_CONFIG_ID: '123456789012345',
    META_REDIRECT_URI: 'https://localhost:3000/api/studio/instagram/callback',
    SIGNAL_TOKEN_KEY: KEY,
    SIGNAL_SECRETS_DIR: path.join(root, 'secrets'),
  });
}
function gate(o: { unified?: boolean; scheduler?: boolean } = {}) {
  writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, instagramApi: true, signalScheduler: o.scheduler ?? true, unifiedLogin: o.unified ?? true });
}

/** Fake Meta: records calls; scopes and expiry configurable. */
function fakeMeta(o: { appId?: string; scopes?: string[]; expiresAt?: number; accounts?: { id: string; username: string }[]; valid?: boolean; token?: string } = {}) {
  const calls: { url: string; method: string; auth: string | null; body: string; cache?: RequestCache; redirect?: RequestRedirect }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: h.get('authorization'), body: String(init?.body ?? ''), cache: init?.cache, redirect: init?.redirect });
    const u = new URL(url);
    if (u.pathname.endsWith('/oauth/access_token')) return json(200, { access_token: o.token ?? TOKEN, token_type: 'bearer' });
    if (u.pathname.endsWith('/debug_token')) return json(200, { data: { app_id: o.appId ?? '100000000000001', is_valid: o.valid ?? true, expires_at: o.expiresAt ?? 0, scopes: o.scopes ?? ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'] } });
    if (u.pathname.endsWith('/me') && u.searchParams.get('fields') === 'client_business_id') return json(200, { client_business_id: '555', id: '777' });
    if (u.pathname.endsWith('/me/assigned_instagram_accounts')) return json(200, { data: o.accounts ?? [{ id: '17840000000000001', username: 'signal.demo' }, { id: '17840000000000002', username: 'example.photo' }, { id: '17840000000000003', username: 'someone.else' }] });
    if (/\/17840000000000001$/.test(u.pathname)) return json(200, { id: '17840000000000001', username: 'signal.demo', followers_count: 12, media_count: 3 });
    if (u.pathname.endsWith('/17840000000000001/media')) return json(200, { id: '900' });
    return json(404, { error: { message: `no route ${u.pathname}` } });
  });
  return { f: f as unknown as typeof fetch, calls };
}
const statePayload: StatePayload = { n: 'x', p: 'demo', u: 'u', e: NOW + 60_000 };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-unified-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  mkdirSync(path.join(root, 'posts'));
  env();
  gate();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI', 'SIGNAL_TOKEN_KEY', 'SIGNAL_SECRETS_DIR', 'SIGNAL_PUBLISH_PAUSED', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE', 'INSTAGRAM_TOKEN_DEMO', 'UPLOAD_POST_API_KEY']) delete process.env[k];
});

describe('configuration', () => {
  it('needs every setting, an https callback, a real App Secret and a 32-byte key', () => {
    expect(unifiedConfig().ok).toBe(true);
    process.env.META_REDIRECT_URI = 'http://localhost:3000/api/studio/instagram/callback';
    expect(unifiedConfig()).toMatchObject({ ok: false, reason: expect.stringMatching(/https/) });
    env();
    process.env.META_APP_SECRET = '100000000000001'; // an ID pasted into the secret field
    expect(unifiedConfig()).toMatchObject({ ok: false, reason: expect.stringMatching(/App Secret/) });
    env();
    process.env.SIGNAL_TOKEN_KEY = 'short';
    expect(unifiedConfig()).toMatchObject({ ok: false, reason: expect.stringMatching(/32 random bytes/) });
    env();
    delete process.env.META_LOGIN_CONFIG_ID;
    expect(unifiedConfig()).toMatchObject({ ok: false, reason: expect.stringMatching(/Meta app settings/) });
  });

  it('builds the Unified Login URL without secrets or scopes', () => {
    const c = unifiedConfig();
    if (!c.ok) throw new Error(c.reason);
    const u = new URL(loginUrl(c.cfg, 'nonce123'));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: '100000000000001', config_id: '123456789012345', redirect_uri: 'https://localhost:3000/api/studio/instagram/callback', response_type: 'code', state: 'nonce123', prompt: 'login' });
    expect(u.toString()).not.toContain(SECRET);
  });

  it('keeps secrets and tokens out of messages', () => {
    const t = redactSecrets(`bad ${SECRET} https://graph.facebook.com/x?client_secret=${SECRET}&access_token=${TOKEN}&code=abc ${TOKEN}`);
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain(TOKEN);
  });
});

describe('OAuth state (CSRF)', () => {
  const key = Buffer.from(KEY, 'base64');
  it('accepts the matching state from the same user within 10 minutes, once signed', () => {
    const { state, cookie } = makeState('example', 'owner', key, NOW);
    expect(checkState(state, cookie, 'owner', key, NOW + 60_000).p).toBe('example');
  });
  it('rejects a missing cookie, a wrong state, a forged cookie, another user and an old login', () => {
    const { state, cookie } = makeState('demo', 'owner', key, NOW);
    expect(() => checkState(state, null, 'owner', key, NOW)).toThrow(/missing or expired/);
    expect(() => checkState('other', cookie, 'owner', key, NOW)).toThrow(/state mismatch/);
    const [body] = cookie.split('.');
    const forged = `${Buffer.from(JSON.stringify({ n: state, p: 'demo', u: 'x', e: NOW + 1e9 })).toString('base64url')}.${cookie.split('.')[1]}`;
    expect(() => checkState(state, forged, 'owner', key, NOW)).toThrow(/invalid/);
    expect(() => checkState(state, `${body}.AAAA`, 'owner', key, NOW)).toThrow(/invalid/);
    expect(() => checkState(state, cookie, 'someone@else.test', key, NOW)).toThrow(/another Signal session/);
    expect(() => checkState(state, cookie, 'owner', key, NOW + 11 * 60_000)).toThrow(/10 minutes/);
    expect(() => checkState(state, cookie, 'owner', randomBytes(32), NOW)).toThrow(/invalid/);
  });
});

describe('token exchange, storage and account mapping', () => {
  it('exchanges the code once with the App Secret, checks the token, and stores only matching accounts, encrypted', async () => {
    const { f, calls } = fakeMeta({ expiresAt: Math.floor((NOW + 60 * 86_400_000) / 1000) });
    const r = await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'owner', fetch: f, now: NOW, projects: PROJECTS });
    expect(r.connected.map((c) => c.username)).toEqual(['signal.demo', 'example.photo']);
    expect(r.ignored).toEqual(['@someone.else']);
    expect(r.missingScopes).toEqual([]);
    // Keep Meta's documented GET exchange; remove the app credential from the debug URL.
    const withSecret = calls.filter((c) => c.url.includes(SECRET));
    expect(withSecret.map((c) => new URL(c.url).pathname)).toEqual(['/v26.0/oauth/access_token']);
    const exchange = calls[0]!;
    expect(exchange.method).toBe('GET');
    expect(new URL(exchange.url).searchParams.get('code')).toBe('AQD_code_1234567890');
    const debug = calls[1]!;
    expect(new URL(debug.url).searchParams.get('input_token')).toBe(TOKEN);
    expect(new URL(debug.url).searchParams.has('access_token')).toBe(false);
    expect(debug.auth).toBe(`Bearer 100000000000001|${SECRET}`);
    for (const call of calls) expect(call).toMatchObject({ cache: 'no-store', redirect: 'error' });
    for (const c of calls.filter((x) => x.url.includes('/me'))) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
    // Stored file: owner-only, no plaintext token or username.
    const file = path.join(root, 'secrets', 'instagram-connections.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('example.photo');
    const conn = await getConnection('example');
    expect(conn).toMatchObject({ igUserId: '17840000000000002', username: 'example.photo', clientBusinessId: '555' });
    expect(describeConn(conn, NOW)).toMatchObject({ daysLeft: 60, expired: false, features: { publish: true, comments: true, insights: true } });
    expect(JSON.stringify(describeConn(conn, NOW))).not.toContain(TOKEN);
    // Another key cannot read it.
    process.env.SIGNAL_TOKEN_KEY = randomBytes(32).toString('base64');
    expect(await getConnection('example')).toBeNull();
  });

  it.each(['/oauth/access_token', '/debug_token', '/me/assigned_instagram_accounts'])('redacts raw and encoded opaque credentials echoed by %s', async (endpoint) => {
    const code = 'AQD_private.code#1234567890';
    const opaqueToken = 'opaque/token+without-prefix=private:123456';
    const { f: normal } = fakeMeta({ token: opaqueToken });
    const f: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith(endpoint)) {
        const values = endpoint === '/oauth/access_token' ? [code, SECRET] : [code, SECRET, opaqueToken];
        return json(400, { error: { message: values.flatMap((v) => [v, encodeURIComponent(v)]).join(' ') } });
      }
      return normal(input, init);
    };
    let message = '';
    try {
      await finishConnect({ code, statePayload, by: 'owner', fetch: f, now: NOW, projects: PROJECTS });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('[secret]');
    for (const value of [code, SECRET, opaqueToken]) {
      expect(message).not.toContain(value);
      expect(message).not.toContain(encodeURIComponent(value));
    }
    expect(await getConnection('demo')).toBeNull();
  });

  it('does not expose a transport exception, log credentials, or retry a failed exchange', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const f = vi.fn(async (input: string | URL | Request) => { throw new Error(`Network failure for ${String(input)}`); });
    await expect(finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f as typeof fetch, now: NOW, projects: PROJECTS })).rejects.toThrow('Meta did not answer.');
    expect(f).toHaveBeenCalledTimes(1);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(await getConnection('demo')).toBeNull();
  });

  it('refuses tokens for another app or invalid tokens, and saves nothing', async () => {
    const other = fakeMeta({ appId: '999999999' });
    await expect(finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: other.f, now: NOW, projects: PROJECTS })).rejects.toThrow(/another Meta app/);
    const bad = fakeMeta({ valid: false });
    await expect(finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: bad.f, now: NOW, projects: PROJECTS })).rejects.toThrow(/not valid/);
    expect(await getConnection('demo')).toBeNull();
  });

  it('reports missing publishing permission and gates comments and insights by the granted scopes', async () => {
    const { f } = fakeMeta({ scopes: ['instagram_basic', 'instagram_content_publish'] });
    const r = await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f, now: NOW, projects: PROJECTS });
    expect(r.missingScopes).toEqual([]);
    expect((await igFeature('publish')).enabled).toBe(true);
    expect((await igFeature('comments')).reason).toMatch(/instagram_manage_comments/);
    expect((await igFeature('insights')).enabled).toBe(false);
    expect((await resultsSource()).source).not.toBe('instagram');
    const only = fakeMeta({ scopes: ['instagram_basic'] });
    expect((await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: only.f, now: NOW, projects: PROJECTS })).missingScopes).toEqual(['instagram_content_publish']);
  });

  it('uses graph.facebook.com with the Instagram account ID (not /me) and a Bearer header', async () => {
    const { f } = fakeMeta();
    await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f, now: NOW, projects: PROJECTS });
    const api = fakeMeta();
    const acct = await getAccount(api.f);
    expect(acct).toMatchObject({ userId: '17840000000000001', username: 'signal.demo' });
    const call = api.calls[0]!;
    expect(new URL(call.url).origin + new URL(call.url).pathname).toBe('https://graph.facebook.com/v26.0/17840000000000001');
    expect(call.url).not.toContain('access_token');
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    await createContainer('17840000000000001', { kind: 'image', url: 'https://pub.example/x.png', caption: 'c', aiLabel: true }, api.f);
    const post = api.calls.at(-1)!;
    expect(new URLSearchParams(post.body).get('is_ai_generated')).toBe('true');
    expect(post.body).not.toContain(TOKEN);
  });

  it('stops using an expired connection and can disconnect', async () => {
    const { f } = fakeMeta({ expiresAt: Math.floor((NOW + 86_400_000) / 1000) });
    await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f, now: NOW, projects: PROJECTS });
    // Pin the clock: the token expires one day after NOW, whatever today's date is.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW);
      expect((await instagramApiAllowed()).enabled).toBe(true);
      vi.setSystemTime(NOW + 2 * 86_400_000);
      expect((await instagramApiAllowed()).reason).toMatch(/expired/);
    } finally {
      vi.useRealTimers();
    }
    expect(await disconnect('demo')).toBe(true);
    expect(await getConnection('demo')).toBeNull();
    expect((await instagramApiAllowed()).reason).toMatch(/not connected/);
  });

  it('stays off until the switch is on, even with a stored connection', async () => {
    const { f } = fakeMeta();
    await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f, now: NOW, projects: PROJECTS });
    gate({ unified: false });
    expect((await instagramApiAllowed()).enabled).toBe(false);
  });
});

describe('publishing safety while setting up', () => {
  it('SIGNAL_PUBLISH_PAUSED blocks Post now on both paths and the scheduler makes no calls', async () => {
    const { f } = fakeMeta();
    await finishConnect({ code: 'AQD_code_1234567890', statePayload, by: 'o', fetch: f, now: NOW, projects: PROJECTS });
    Object.assign(process.env, { R2_ACCOUNT_ID: 'a1', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'signal-media', R2_PUBLIC_BASE: 'https://pub.example', UPLOAD_POST_API_KEY: 'x', SIGNAL_PUBLISH_PAUSED: '1' });
    expect((await metaLive(NOW)).reason).toMatch(/paused/);
    expect((await liveState(NOW)).reason).toMatch(/paused/);
    // A due Signal schedule exists; the paused scheduler must not touch it or call anything.
    const d = path.join(root, 'posts', '01');
    mkdirSync(d);
    const s1 = Buffer.from('s1');
    writeFileSync(path.join(d, 'slide-1.png'), s1);
    writeFileSync(path.join(d, 'caption.txt'), 'c');
    const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id: '01', title: 't', format: 'image', destination: '@signal.demo', files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(s1) }, { name: 'caption.txt', role: 'caption', sha256: sha('c') }] }));
    await approvePackage('01', 'owner', NOW);
    writeFileSync(path.join(d, 'scheduled.json'), JSON.stringify({ job_id: '', scheduled_for: new Date(Date.now() - 60_000).toISOString(), provider: 'signal' }));
    const spy = vi.fn();
    await tickAll({ fetch: spy as never });
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(d, 'scheduled.json'), 'utf8')).provider).toBe('signal'); // untouched
  });
});
