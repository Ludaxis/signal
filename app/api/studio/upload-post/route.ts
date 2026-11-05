// GET  /api/studio/upload-post — whether profile setup is allowed, plan, and profiles with their Instagram.
// POST /api/studio/upload-post {action:'create', username, displayName} | {action:'connect', username} | {action:'get', username}
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { UploadPostError, connectLink, createUpProfile, getUpProfile, listUpProfiles, profileManagementAllowed } from '@/lib/studio/uploadpost';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const fail = (e: unknown) =>
  e instanceof UploadPostError ? jsonError(e.status >= 400 && e.status < 600 ? e.status : 502, 'validation', e.message) : jsonError(500, 'internal', 'Upload-Post request failed.');

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const allowed = await profileManagementAllowed();
  if (!allowed.enabled) return NextResponse.json({ allowed: false, reason: allowed.reason, profiles: [] });
  try {
    const l = await listUpProfiles();
    return NextResponse.json({ allowed: true, reason: '', ...l }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { action?: unknown; username?: unknown; displayName?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  const username = typeof b.username === 'string' ? b.username.trim().slice(0, 64) : '';
  if (!username) return jsonError(400, 'validation', 'Choose a profile.');
  try {
    if (b.action === 'create') return NextResponse.json({ profile: await createUpProfile(username, typeof b.displayName === 'string' ? b.displayName : username) });
    if (b.action === 'get') return NextResponse.json({ profile: await getUpProfile(username) });
    if (b.action === 'connect') {
      const origin = new URL(req.url).origin;
      return NextResponse.json(await connectLink(username, `${origin}/studio?connected=${encodeURIComponent(username)}`));
    }
    return jsonError(400, 'validation', 'Unknown action.');
  } catch (e) {
    return fail(e);
  }
}
