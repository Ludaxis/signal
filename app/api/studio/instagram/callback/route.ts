// GET /api/studio/instagram/callback?code=&state=   Meta Unified Login redirect target.
// Verifies the signed-in Studio user and the single-use state cookie, then exchanges the code,
// stores the matching accounts' tokens encrypted on this machine, and returns to the Studio.
// No token, code or secret is ever put in the redirect URL or logged.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { STATE_COOKIE, UnifiedLoginError, checkState, finishConnect, unifiedConfig, unifiedLoginAllowed } from '@/lib/studio/ig-unified';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const u = new URL('/studio', req.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v.slice(0, 200));
  const res = NextResponse.redirect(u, { status: 303 });
  res.cookies.set({ name: STATE_COOKIE, value: '', httpOnly: true, sameSite: 'lax', path: '/api/studio/instagram', maxAge: 0 }); // single use
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return back(req, { ig: 'error', msg: 'Sign in to Signal first, then press Connect again.' });
  const q = new URL(req.url).searchParams;
  const allowed = await unifiedLoginAllowed();
  if (!allowed.enabled) return back(req, { ig: 'error', msg: allowed.reason });
  const c = unifiedConfig();
  if (!c.ok) return back(req, { ig: 'error', msg: c.reason });
  try {
    const payload = checkState(q.get('state'), req.cookies.get(STATE_COOKIE)?.value, user.email, c.cfg.key);
    if (q.get('error')) return back(req, { ig: 'error', msg: `Meta login was not completed (${(q.get('error_reason') || q.get('error') || '').replace(/[^a-z_ ]/gi, '').slice(0, 60)}). Nothing was saved.` });
    const code = q.get('code');
    if (!code) return back(req, { ig: 'error', msg: 'Meta did not return a code. Nothing was saved.' });
    const r = await finishConnect({ code, statePayload: payload, by: user.email });
    const names = r.connected.map((x) => `@${x.username}`).join(', ') || 'none';
    const parts = [`Connected: ${names}.`];
    if (r.ignored.length) parts.push(`Not used (no matching project): ${r.ignored.join(', ')}.`);
    if (r.missingScopes.length) parts.push(`Missing permissions: ${r.missingScopes.join(', ')}.`);
    return back(req, { ig: r.connected.length ? 'connected' : 'error', msg: parts.join(' '), project: payload.p });
  } catch (e) {
    return back(req, { ig: 'error', msg: e instanceof UnifiedLoginError ? e.message : 'Connecting failed. Nothing was saved.' });
  }
}
