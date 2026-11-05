// httpOnly session cookie. The API token is never readable by browser JavaScript.
import type { NextRequest, NextResponse } from 'next/server';

export const COOKIE_PLAIN = 'signal_session';
/** __Host- prefix: Secure, Path=/, no Domain — used whenever the cookie is Secure. */
export const COOKIE_HOST = '__Host-signal_session';
/** Contract: sessions are 12 h sliding with a 7 day maximum; the cookie lives for the maximum. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

/** Secure in production, except plain-http loopback (local `next start` and e2e). */
export function shouldUseSecureCookie(requestUrl: string, headers?: Headers): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  try {
    const url = new URL(requestUrl);
    const proto = headers?.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    if (proto === 'http' && isLoopback(url.hostname)) return false;
  } catch {
    /* default to secure */
  }
  return true;
}

export function readSessionToken(req: Pick<NextRequest, 'cookies'>): string | null {
  return req.cookies.get(COOKIE_HOST)?.value || req.cookies.get(COOKIE_PLAIN)?.value || null;
}

export function setSessionCookie(res: NextResponse, token: string, secure: boolean, maxAge = SESSION_MAX_AGE_SECONDS): void {
  res.cookies.set({
    name: secure ? COOKIE_HOST : COOKIE_PLAIN,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge,
  });
}

export function clearSessionCookies(res: NextResponse): void {
  for (const name of [COOKIE_HOST, COOKIE_PLAIN]) {
    res.cookies.set({ name, value: '', httpOnly: true, sameSite: 'lax', secure: name === COOKIE_HOST, path: '/', maxAge: 0 });
  }
}
