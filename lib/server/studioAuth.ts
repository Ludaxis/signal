// Auth + origin guard for the Studio API routes: same-origin check, then the signed session cookie.
import type { NextRequest } from 'next/server';
import { OWNER_EMAIL, verifySession } from './auth';
import { checkSameOrigin, jsonError } from './security';
import { readSessionToken } from './session';

export interface StudioUser { email: string }

export async function requireStudioUser(req: NextRequest): Promise<StudioUser | Response> {
  const origin = checkSameOrigin({ method: req.method, url: req.url, headers: req.headers, allowedOrigin: process.env.SIGNAL_WEB_ORIGIN || null });
  if (!origin.ok) return jsonError(403, 'forbidden', 'Cross-origin request blocked.');
  const token = readSessionToken(req);
  if (!verifySession(token)) return jsonError(401, 'unauthenticated', 'Sign in first.');
  return { email: OWNER_EMAIL };
}
