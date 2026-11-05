// Server-only: single-owner local login.
//
// - SIGNAL_OWNER_PASSWORD is the only credential. Set it in .env.local (any length ≥ 8).
//   SIGNAL_LOCAL_ONLY_NO_PASSWORD=1 skips the password, but only for requests that arrive on a
//   loopback address (localhost / 127.0.0.1 / [::1]) over plain http; anything else is refused.
// - A session is a compact token `<expiry>.<nonce>.<hmac>` signed with SIGNAL_SESSION_SECRET
//   (any long random string; if unset, a random secret is generated at start and every session ends
//   when the server restarts). It lives in an httpOnly cookie (lib/server/session.ts) and never in
//   localStorage or JavaScript.
// - Sessions last SESSION_MAX_AGE_SECONDS; the cookie carries the same lifetime.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SESSION_MAX_AGE_SECONDS } from './session';

export const OWNER_EMAIL = 'owner';
export const MIN_PASSWORD_LENGTH = 8;

let generatedSecret: Buffer | null = null;
let warnedGenerated = false;

function sessionSecret(): Buffer {
  const raw = (process.env.SIGNAL_SESSION_SECRET ?? '').trim();
  if (raw.length >= 16) return createHmac('sha256', 'signal-session').update(raw).digest();
  if (!generatedSecret) {
    generatedSecret = randomBytes(32);
    if (!warnedGenerated && process.env.NODE_ENV !== 'test') {
      console.warn('[signal] SIGNAL_SESSION_SECRET is not set (or shorter than 16 characters): sessions end when the server restarts.');
      warnedGenerated = true;
    }
  }
  return generatedSecret;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

export interface LoginMode {
  /** 'password': SIGNAL_OWNER_PASSWORD is required. 'open': no password (loopback only). 'unset': nothing configured. */
  mode: 'password' | 'open' | 'unset';
  reason: string;
}

/** How this server authenticates, from the environment. */
export function loginMode(): LoginMode {
  const pw = process.env.SIGNAL_OWNER_PASSWORD ?? '';
  const open = ['1', 'true', 'yes'].includes((process.env.SIGNAL_LOCAL_ONLY_NO_PASSWORD ?? '').trim().toLowerCase());
  if (pw.length >= MIN_PASSWORD_LENGTH) return { mode: 'password', reason: '' };
  if (pw) return { mode: 'unset', reason: `SIGNAL_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (open) return { mode: 'open', reason: 'No password: SIGNAL_LOCAL_ONLY_NO_PASSWORD=1 (loopback only).' };
  return { mode: 'unset', reason: 'Set SIGNAL_OWNER_PASSWORD in .env.local (or SIGNAL_LOCAL_ONLY_NO_PASSWORD=1 for loopback-only use).' };
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Checks a login attempt. `requestUrl` and `headers` decide whether the open (no password) mode applies. */
export function checkLogin(password: string, requestUrl: string, headers: Headers): { ok: true } | { ok: false; status: number; message: string } {
  const m = loginMode();
  if (m.mode === 'unset') return { ok: false, status: 503, message: m.reason };
  if (m.mode === 'open') {
    let host = '';
    let proto = 'http';
    try {
      const u = new URL(requestUrl);
      host = (headers.get('x-forwarded-host') ?? u.hostname).split(',')[0]!.trim().replace(/:\d+$/, '');
      proto = (headers.get('x-forwarded-proto') ?? u.protocol.replace(':', '')).split(',')[0]!.trim();
    } catch {
      /* refused below */
    }
    if (!isLoopbackHost(host) || headers.get('x-forwarded-for')) return { ok: false, status: 403, message: 'Password-less login works only from this machine (localhost). Set SIGNAL_OWNER_PASSWORD to sign in from elsewhere.' };
    void proto;
    return { ok: true };
  }
  if (!password || !safeEqual(password, process.env.SIGNAL_OWNER_PASSWORD!)) return { ok: false, status: 401, message: 'That password is not right.' };
  return { ok: true };
}

const sign = (body: string) => createHmac('sha256', sessionSecret()).update(body).digest('base64url');

/** A new signed session token. */
export function issueSession(now = Date.now(), maxAgeSeconds = SESSION_MAX_AGE_SECONDS): string {
  const body = `${now + maxAgeSeconds * 1000}.${randomBytes(16).toString('base64url')}`;
  return `${body}.${sign(body)}`;
}

/** The session is valid: well-formed, signed by this server and not expired. */
export function verifySession(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts as [string, string, string];
  if (!/^\d{10,16}$/.test(exp) || !/^[A-Za-z0-9_-]{16,48}$/.test(nonce) || !/^[A-Za-z0-9_-]{40,48}$/.test(sig)) return false;
  if (Number(exp) <= now) return false;
  return safeEqual(sig, sign(`${exp}.${nonce}`));
}
