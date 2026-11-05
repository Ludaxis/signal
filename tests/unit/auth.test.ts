// Owner login: modes, loopback-only password-less mode, signed sessions.
import { afterEach, describe, expect, it } from 'vitest';
import { checkLogin, issueSession, loginMode, verifySession } from '@/lib/server/auth';

const ENV = ['SIGNAL_OWNER_PASSWORD', 'SIGNAL_LOCAL_ONLY_NO_PASSWORD', 'SIGNAL_SESSION_SECRET'];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('login mode', () => {
  it('is unset without a password and says what to do', () => {
    expect(loginMode()).toMatchObject({ mode: 'unset', reason: /SIGNAL_OWNER_PASSWORD/ });
    expect(checkLogin('x', 'http://localhost:3000/api/session', new Headers())).toMatchObject({ ok: false, status: 503 });
  });
  it('refuses a short password', () => {
    process.env.SIGNAL_OWNER_PASSWORD = 'short';
    expect(loginMode()).toMatchObject({ mode: 'unset', reason: /at least 8/ });
  });
  it('checks the password in password mode', () => {
    process.env.SIGNAL_OWNER_PASSWORD = 'correct-horse-battery';
    expect(loginMode().mode).toBe('password');
    expect(checkLogin('wrong', 'http://localhost:3000/api/session', new Headers())).toMatchObject({ ok: false, status: 401 });
    expect(checkLogin('', 'http://localhost:3000/api/session', new Headers())).toMatchObject({ ok: false, status: 401 });
    expect(checkLogin('correct-horse-battery', 'https://signal.example.test/api/session', new Headers())).toEqual({ ok: true });
  });
  it('password-less mode works from loopback only and never through a proxy', () => {
    process.env.SIGNAL_LOCAL_ONLY_NO_PASSWORD = '1';
    expect(loginMode().mode).toBe('open');
    expect(checkLogin('', 'http://localhost:3000/api/session', new Headers())).toEqual({ ok: true });
    expect(checkLogin('', 'http://127.0.0.1:3000/api/session', new Headers())).toEqual({ ok: true });
    expect(checkLogin('', 'http://[::1]:3000/api/session', new Headers())).toEqual({ ok: true });
    expect(checkLogin('', 'http://10.0.0.5:3000/api/session', new Headers())).toMatchObject({ ok: false, status: 403 });
    expect(checkLogin('', 'http://localhost:3000/api/session', new Headers({ 'x-forwarded-host': 'signal.example.test' }))).toMatchObject({ ok: false, status: 403 });
    expect(checkLogin('', 'http://localhost:3000/api/session', new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toMatchObject({ ok: false, status: 403 });
    // A real password wins over the open mode.
    process.env.SIGNAL_OWNER_PASSWORD = 'correct-horse-battery';
    expect(loginMode().mode).toBe('password');
  });
});

describe('sessions', () => {
  it('issues tokens that verify, expire and reject tampering', () => {
    process.env.SIGNAL_SESSION_SECRET = 'a-long-random-secret-for-tests';
    const now = Date.parse('2026-11-05T12:00:00Z');
    const t = issueSession(now, 60);
    expect(verifySession(t, now + 1000)).toBe(true);
    expect(verifySession(t, now + 61_000)).toBe(false);
    expect(verifySession(t.slice(0, -2) + 'zz', now)).toBe(false);
    expect(verifySession(t.replace(/^\d+/, String(now + 10 * 60_000)), now + 61_000)).toBe(false);
    expect(verifySession(null, now)).toBe(false);
    expect(verifySession('a.b', now)).toBe(false);
    process.env.SIGNAL_SESSION_SECRET = 'another-secret-that-is-long';
    expect(verifySession(t, now)).toBe(false);
  });
  it('issues different tokens each time', () => {
    process.env.SIGNAL_SESSION_SECRET = 'a-long-random-secret-for-tests';
    expect(issueSession()).not.toBe(issueSession());
  });
});
