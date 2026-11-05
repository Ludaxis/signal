// POST /api/session  — sign in with the owner password; sets the httpOnly session cookie.
// DELETE /api/session — sign out; clears the cookie.
// GET /api/session   — public runtime facts for the login screen (the login mode), never a secret.
import { NextResponse, type NextRequest } from 'next/server';
import { checkLogin, issueSession, loginMode } from '@/lib/server/auth';
import { checkSameOrigin, jsonError } from '@/lib/server/security';
import { SESSION_MAX_AGE_SECONDS, clearSessionCookies, setSessionCookie, shouldUseSecureCookie } from '@/lib/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function originGuard(req: NextRequest): Response | null {
  const r = checkSameOrigin({ method: req.method, url: req.url, headers: req.headers, allowedOrigin: process.env.SIGNAL_WEB_ORIGIN || null });
  return r.ok ? null : jsonError(403, 'forbidden', 'Cross-origin request blocked.');
}

export async function GET(): Promise<Response> {
  const m = loginMode();
  return NextResponse.json({ mode: m.mode, reason: m.mode === 'password' ? '' : m.reason }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const blocked = originGuard(req);
  if (blocked) return blocked;
  let password = '';
  try {
    const b = (await req.json()) as { password?: unknown };
    password = typeof b.password === 'string' ? b.password.slice(0, 1024) : '';
  } catch {
    return jsonError(400, 'validation', 'Enter the owner password.');
  }
  const r = checkLogin(password, req.url, req.headers);
  if (!r.ok) return jsonError(r.status, r.status === 401 ? 'unauthenticated' : r.status === 403 ? 'forbidden' : 'unavailable', r.message);
  const token = issueSession();
  const res = NextResponse.json({ user: { email: 'owner' }, expires_at: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  setSessionCookie(res, token, shouldUseSecureCookie(req.url, req.headers), SESSION_MAX_AGE_SECONDS);
  return res;
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const blocked = originGuard(req);
  if (blocked) return blocked;
  const res = new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  clearSessionCookies(res);
  return res;
}
