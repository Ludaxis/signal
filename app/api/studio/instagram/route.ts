// GET  /api/studio/instagram?project=                 setup + connection status (no secrets), account and quota when connected
// GET  /api/studio/instagram?project=&view=comments    latest posts with their comments (needs instagram_manage_comments)
// POST /api/studio/instagram {project, action, …}
//   connect-start  → {url} Meta Unified Login URL; sets the signed, httpOnly state cookie
//   disconnect     → deletes this project's stored connection (token) on this machine
//   test           → read-only check: account, publishing quota, granted permissions. Never publishes.
//   review-calls   → one read-only call per permission Signal uses, so Meta's App Review counts them. Never publishes or changes anything.
//   reply {commentId, text} | hide {commentId, hide} | delete {commentId}   (comments, on button press)
import { NextResponse, type NextRequest } from 'next/server';
import { projectTimeZone } from '@/lib/studio/time';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { shouldUseSecureCookie } from '@/lib/server/session';
import { MetaError, deleteComment, mediaInsights, getAccount, hideComment, igContext, igFeature, instagramApiAllowed, listComments, listMedia, publishingQuota, replyToComment, schedulerAllowed, tokenEnvName } from '@/lib/studio/meta';
import { STATE_COOKIE, STATE_TTL_MS, UnifiedLoginError, describe, disconnect, getConnection, loginUrl, makeState, unifiedConfig, unifiedLoginAllowed } from '@/lib/studio/ig-unified';
import { publishingPaused } from '@/lib/studio/safety';
import { r2Config } from '@/lib/studio/r2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const ID_RE = /^[0-9]{5,30}$/;
const noStore = { headers: { 'Cache-Control': 'no-store' } };
const fail = (e: unknown) => jsonError(e instanceof MetaError || e instanceof UnifiedLoginError ? Math.min(Math.max(e.status, 400), 599) : 502, 'upstream', (e as Error).message);

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const view = new URL(req.url).searchParams.get('view');
  return inProject(req, null, async (project) => {
    const api = await instagramApiAllowed();
    const r2 = r2Config();
    const ctx = await igContext(project);
    const setup = {
      api,
      unifiedLogin: await unifiedLoginAllowed(),
      connection: describe(await getConnection(project.id)),
      mode: 'error' in ctx ? null : ctx.mode,
      scheduler: await schedulerAllowed(),
      mediaHost: r2.ok ? { enabled: true, reason: '' } : { enabled: false, reason: r2.reason },
      paused: publishingPaused(),
      comments: await igFeature('comments'),
      insights: await igFeature('insights'),
      publish: await igFeature('publish'),
      tokenEnv: tokenEnvName(project),
    };
    if (!api.enabled) return NextResponse.json({ setup, account: null }, noStore);
    try {
      const account = await getAccount();
      const handleOk = account.username.toLowerCase() === project.handle.replace(/^@/, '').toLowerCase();
      if (view === 'comments') {
        if (!setup.comments.enabled) return NextResponse.json({ setup, account, handleOk, posts: [] }, noStore);
        const media = await listMedia(account.userId, 8);
        const posts = [];
        for (const m of media) posts.push({ ...m, commentList: (m.comments ?? 0) > 0 ? await listComments(m.id).catch(() => []) : [] });
        return NextResponse.json({ setup, account, handleOk, posts, timeZone: projectTimeZone(project) }, noStore);
      }
      const quota = await publishingQuota(account.userId).catch(() => null);
      return NextResponse.json({ setup, account, handleOk, quota }, noStore);
    } catch (e) {
      return fail(e);
    }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { project?: unknown; action?: unknown; commentId?: unknown; text?: unknown; hide?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async (project) => {
    try {
      if (b.action === 'connect-start') {
        const allowed = await unifiedLoginAllowed();
        if (!allowed.enabled) return jsonError(403, 'forbidden', allowed.reason);
        const c = unifiedConfig();
        if (!c.ok) return jsonError(403, 'forbidden', c.reason);
        const { state, cookie } = makeState(project.id, user.email, c.cfg.key);
        const res = NextResponse.json({ url: loginUrl(c.cfg, state) }, noStore);
        res.cookies.set({ name: STATE_COOKIE, value: cookie, httpOnly: true, sameSite: 'lax', secure: shouldUseSecureCookie(req.url, req.headers) || new URL(c.cfg.redirectUri).protocol === 'https:', path: '/api/studio/instagram', maxAge: Math.floor(STATE_TTL_MS / 1000) });
        return res;
      }
      if (b.action === 'disconnect') return NextResponse.json({ removed: await disconnect(project.id) }, noStore);
      if (b.action === 'test') {
        const api = await instagramApiAllowed();
        if (!api.enabled) return jsonError(409, 'conflict', api.reason);
        const account = await getAccount();
        const quota = await publishingQuota(account.userId).catch(() => null);
        return NextResponse.json({ ok: true, account, handleOk: account.username.toLowerCase() === project.handle.replace(/^@/, '').toLowerCase(), quota, connection: describe(await getConnection(project.id)), published: false }, noStore);
      }
      if (b.action === 'review-calls') {
        const api = await instagramApiAllowed();
        if (!api.enabled) return jsonError(409, 'conflict', api.reason);
        const results: { permission: string; call: string; ok: boolean; note: string }[] = [];
        const run = async (permission: string, call: string, fn: () => Promise<string>) => {
          try {
            results.push({ permission, call, ok: true, note: await fn() });
          } catch (e) {
            results.push({ permission, call, ok: false, note: (e as Error).message.slice(0, 200) });
          }
        };
        let userId = '';
        await run('instagram_basic', 'GET /{ig-user}', async () => { const a = await getAccount(); userId = a.userId; return `@${a.username}`; });
        if (userId) {
          await run('instagram_content_publish', 'GET /{ig-user}/content_publishing_limit', async () => { const q = await publishingQuota(userId); if (!q) throw new Error('No answer from the publishing limit.'); return `${q.used}/${q.total} used today`; });
          const media = await listMedia(userId, 5).catch(() => []);
          const first = media[0];
          if (!first) results.push({ permission: 'instagram_manage_comments, instagram_manage_insights', call: 'needs one post', ok: false, note: 'The account has no posts yet, so comments and insights cannot be read.' });
          else {
            await run('instagram_manage_comments', 'GET /{media}/comments', async () => `${(await listComments(first.id)).length} comments read`);
            await run('instagram_manage_insights', 'GET /{media}/insights', async () => { const m = await mediaInsights(first.id); return `reach ${m.reach ?? '—'}`; });
          }
        }
        return NextResponse.json({ ok: results.every((r) => r.ok), results, published: false }, noStore);
      }
      const comments = await igFeature('comments');
      if (!comments.enabled) return jsonError(403, 'forbidden', comments.reason);
      const cid = typeof b.commentId === 'string' && ID_RE.test(b.commentId) ? b.commentId : null;
      if (!cid) return jsonError(400, 'validation', 'Unknown comment.');
      if (b.action === 'reply' && typeof b.text === 'string') return NextResponse.json({ id: await replyToComment(cid, b.text.slice(0, 2200)) });
      if (b.action === 'hide') {
        await hideComment(cid, b.hide !== false);
        return NextResponse.json({ ok: true });
      }
      if (b.action === 'delete') {
        await deleteComment(cid);
        return NextResponse.json({ ok: true });
      }
      return jsonError(400, 'validation', 'Unknown action.');
    } catch (e) {
      return fail(e);
    }
  });
}
