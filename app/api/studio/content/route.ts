// GET /api/studio/content?project=<id> — the project's post packages, limits and posting state.
import { NextResponse, type NextRequest } from 'next/server';
import { ContentError, contentDir, currentLimits, listPackages } from '@/lib/studio/content';
import { jsonError } from '@/lib/server/security';
import { liveState } from '@/lib/studio/dispatch';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import type { Project } from '@/lib/studio/projects';
import { codexImagesAllowed } from '@/lib/studio/codex';
import { higgsfieldAllowed } from '@/lib/studio/higgsfield';
import { checkDispatch, schedulingAllowed } from '@/lib/studio/dispatch';
import { insights, resultsSource } from '@/lib/studio/analytics';
import { metaLive, tickAll } from '@/lib/studio/publish-meta';
import { schedulerAllowed } from '@/lib/studio/meta';
import { projectTimeZone } from '@/lib/studio/time';
import { loadPackFormats } from '@/lib/studio/formats';
import { connectionBlocks, postingPath } from '@/lib/studio/posting-blocks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async (project) => {
    try {
      return await load(project, user.email);
    } catch (e) {
      // A plain JSON error (never a bare 500) so Today, Posts, Library and Results can say what went wrong.
      return jsonError(500, 'internal', e instanceof ContentError ? `Could not load the posts: ${e.message}` : 'Could not load the posts. Try again.');
    }
  });
}

async function load(project: Project, email: string): Promise<Response> {
  // Signal's own scheduler also runs on every dashboard load (it is a no-op unless the switch is on).
  await tickAll().catch(() => undefined);
  let packages = await listPackages();
  // Scheduled posts whose time has passed: read their status once (never re-sends anything).
  const due = packages.filter((p) => p.status === 'scheduled' && p.scheduled && p.scheduled.provider !== 'signal' && Date.parse(p.scheduled.scheduled_for) < Date.now() - 2 * 60_000).slice(0, 3);
  if (due.length && process.env.UPLOAD_POST_API_KEY) {
    for (const p of due) await checkDispatch(p.id, email).catch(() => undefined);
    packages = await listPackages();
  }
  const lim = await currentLimits();
  const meta = await metaLive();
  const sched = await schedulerAllowed();
  // The formats this project can make, named as its pack names them: the make form lists these.
  const set = await loadPackFormats(project);
  // Today › Needs you: a connection that blocks a post planned within 24 h. Read only; checks no provider.
  const path = postingPath({ metaLive: meta.enabled, automatic: lim.open && lim.dispatch, uploadPostKey: Boolean(process.env.UPLOAD_POST_API_KEY), uploadPostProfile: Boolean(project.uploadPostProfile) });
  return NextResponse.json(
    {
      project: { id: project.id, name: project.name, handle: project.handle, timeZone: projectTimeZone(project) },
      formats: set.formats.map((id) => ({ id, label: set.labels[id] })),
      account: { destination: project.handle, open: lim.open, reason: lim.reason, expiresAt: lim.expiresAt, maxPosts: lim.maxPosts, maxPerDay: lim.maxPerDay, posted: packages.filter((p) => p.posted).length },
      folder: contentDir().replace(process.env.HOME ?? '\u0000', '~'),
      packages,
      live: meta.enabled ? { enabled: true, reason: meta.reason, provider: 'meta' } : await liveState(),
      instagram: meta,
      scheduling: meta.enabled && sched.enabled ? { enabled: true, reason: '', provider: 'signal' } : { ...(await schedulingAllowed()), provider: 'upload-post' },
      analytics: await resultsSource(),
      insights: insights(packages),
      codex: await codexImagesAllowed(),
      higgsfield: await higgsfieldAllowed(),
      connectionBlocks: connectionBlocks(packages, path),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
