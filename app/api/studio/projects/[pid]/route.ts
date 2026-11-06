// POST /api/studio/projects/:pid
//   {action:'account', confirmHandle, days, maxPosts, maxPerDay, posting, codexImages}  account posting settings (typed handle)
//   {action:'verify'}  read-only Upload-Post profile check (only once the account settings exist)
//   {action:'upload-post-profile', profile}  link an Upload-Post profile that exists on your plan ('' unlinks)
//   {action:'upload-post-dispatch', on}      the account's one-click posting switch in accounts.json (Meta first, Upload-Post as fallback)
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { ProjectError, accountSettings, postingActive, setAccountSettings, getProject, markVerified, setAutomaticPosting, setUploadPostProfile } from '@/lib/studio/projects';
import { UploadPostError, getUpProfile, upProfileUrl } from '@/lib/studio/uploadpost';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ pid: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { pid } = await ctx.params;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  try {
    const project = await getProject(pid);
    if (b.action === 'account') {
      const a = await setAccountSettings(
        project,
        {
          confirmHandle: String(b.confirmHandle ?? ''),
          days: Number(b.days ?? 0),
          maxPosts: Number(b.maxPosts ?? 30),
          maxPerDay: Number(b.maxPerDay ?? 1),
          posting: b.posting === true,
          codexImages: b.codexImages === true,
        },
        user.email,
      );
      return NextResponse.json({ account: a });
    }
    if (b.action === 'verify') {
      if (!postingActive(await accountSettings(project.id))) return jsonError(403, 'forbidden', 'Set the account limits first; the check runs only for set-up accounts.');
      if (!project.uploadPostProfile) return NextResponse.json({ ok: false, message: `${project.handle} posts through Instagram's API: connect it with Meta on the Connections screen.` });
      const key = process.env.UPLOAD_POST_API_KEY;
      if (!key) return jsonError(400, 'validation', 'Add your Upload-Post API key in Connections → Keys.');
      let r: Response;
      try {
        r = await fetch(upProfileUrl(project.uploadPostProfile), {
          headers: { Authorization: `Apikey ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
          cache: 'no-store',
        });
      } catch {
        return jsonError(502, 'internal', 'Upload-Post did not answer. Try again.');
      }
      if (r.status === 404) return NextResponse.json({ ok: false, message: `Upload-Post has no profile named “${project.uploadPostProfile}”. Check Manage Users.` });
      if (!r.ok) return NextResponse.json({ ok: false, message: `Upload-Post answered HTTP ${r.status}.` });
      const j = (await r.json().catch(() => null)) as { profile?: { social_accounts?: Record<string, unknown> }; social_accounts?: Record<string, unknown> } | null;
      const social = (j?.profile?.social_accounts ?? j?.social_accounts ?? {}) as Record<string, { username?: string; handle?: string; display_name?: string; reauth_required?: boolean } | null>;
      const ig = social.instagram && typeof social.instagram === 'object' ? social.instagram : null;
      // Upload-Post: `handle` is the public @name; `username` is Instagram's opaque account id.
      const handle = ig?.handle ? String(ig.handle).replace(/^@/, '') : null;
      const shown = handle ?? ig?.display_name ?? null;
      await markVerified(project.id, handle ?? ig?.display_name ?? null);
      if (!ig) return NextResponse.json({ ok: false, message: `Profile “${project.uploadPostProfile}” has no Instagram account connected.` });
      if (ig.reauth_required) return NextResponse.json({ ok: false, message: 'Instagram needs to be reconnected in Upload-Post.' });
      const want = project.handle.replace(/^@/, '').toLowerCase();
      if (!handle)
        return NextResponse.json({ ok: true, instagram: shown, message: `Instagram is connected${shown ? ` (“${shown}”)` : ''}. Upload-Post didn't report the @handle, so check it's ${project.handle} in Upload-Post.` });
      const match = handle.toLowerCase() === want;
      return NextResponse.json({ ok: match, instagram: handle, message: match ? `Connected: Instagram @${want}.` : `Profile is connected to Instagram @${handle}, not ${project.handle}.` });
    }
    if (b.action === 'upload-post-profile') {
      const r = await setUploadPostProfile(project.id, typeof b.profile === 'string' ? b.profile.slice(0, 64) : '', getUpProfile);
      return NextResponse.json({ project: { id: r.project.id, uploadPostProfile: r.project.uploadPostProfile }, instagram: r.instagram });
    }
    if (b.action === 'upload-post-dispatch') {
      const a = await setAutomaticPosting(project.id, b.on === true, user.email);
      return NextResponse.json({ posting: a.posting });
    }
    return jsonError(400, 'validation', 'Unknown action.');
  } catch (e) {
    if (e instanceof ProjectError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 404 ? 'not_found' : 'validation', e.message);
    if (e instanceof UploadPostError) return jsonError(e.status >= 400 && e.status < 600 ? e.status : 502, 'upstream', e.message);
    return jsonError(500, 'internal', 'Could not update the project.');
  }
}
