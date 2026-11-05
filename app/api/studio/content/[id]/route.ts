// POST /api/studio/content/:id
//   {action:'approve'} | {action:'posted', url, aiLabel}           manual path
//   {action:'send'} | {action:'check'} | {action:'resolve', posted, url} | {action:'label'}   automatic path
//     (Instagram's own API when set up for the account; otherwise Upload-Post)
//   {action:'plan', plannedFor} | {action:'schedule'} | {action:'cancel-schedule'}       Calendar and schedules
// Every action re-reads the package from disk and re-checks fingerprints and limits.
import { NextResponse, type NextRequest } from 'next/server';
import { ContentError, approvePackage, confirmLabel, discardPackage, isPackageId, recordPosted, setPlan } from '@/lib/studio/content';
import { cancelSchedule, checkDispatch, dispatchPackage, reschedule, resolveUncertain } from '@/lib/studio/dispatch';
import { cancelSignalSchedule, checkMeta, metaLive, moveSignalSchedule, publishViaMeta, scheduleInSignal } from '@/lib/studio/publish-meta';
import { schedulerAllowed } from '@/lib/studio/meta';
import { loadPackage } from '@/lib/studio/content';
import { notePackageChange } from '@/lib/studio/memory/hooks';
import { noteTrustDecision } from '@/lib/studio/autopilot/trust';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { inProject } from '@/lib/server/studioProject';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isPackageId(id)) return jsonError(404, 'not_found', 'Unknown package.');
  let body: { action?: unknown; url?: unknown; aiLabel?: unknown; posted?: unknown; project?: unknown; plannedFor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, body.project, async () => {
    const before = await loadPackage(id).catch(() => null);
    const res = await act(id, body, user.email);
    // Project memory: record what changed, best effort, never blocking the answer.
    // Autopilot trust: a owner approve or discard of an autopilot-made post counts toward (or resets) its format's trust.
    if (res.ok)
      await loadPackage(id)
        .then(async (after) => {
          await notePackageChange(before, after, user.email);
          await noteTrustDecision(before, after, user.email);
        })
        .catch(() => undefined);
    return res;
  });
}

async function act(id: string, body: { action?: unknown; url?: unknown; aiLabel?: unknown; posted?: unknown; plannedFor?: unknown }, email: string): Promise<Response> {
  const user = { email };
  {
    try {
      if (body.action === 'approve') return NextResponse.json({ package: await approvePackage(id, user.email) });
      if (body.action === 'posted')
        return NextResponse.json({ package: await recordPosted(id, typeof body.url === 'string' ? body.url.slice(0, 300) : '', body.aiLabel === true, user.email) });
      // Instagram's own API is used when it is set up for this account; otherwise Upload-Post.
      if (body.action === 'send') return NextResponse.json({ package: (await metaLive()).enabled ? await publishViaMeta(id, user.email) : await dispatchPackage(id, user.email) });
      if (body.action === 'check') {
        const cur = await loadPackage(id);
        return NextResponse.json({ package: cur.dispatch?.provider === 'meta' ? await checkMeta(id, user.email) : await checkDispatch(id, user.email) });
      }
      if (body.action === 'plan') {
        const iso = typeof body.plannedFor === 'string' ? body.plannedFor : null;
        const cur = await loadPackage(id);
        if (cur.status === 'scheduled' && cur.scheduled?.provider === 'signal') {
          if (!iso) return NextResponse.json({ package: await cancelSignalSchedule(id, user.email) });
          return NextResponse.json({ package: await moveSignalSchedule(id, iso, user.email) });
        }
        if (cur.status === 'scheduled') {
          if (!iso) return NextResponse.json({ package: await cancelSchedule(id, user.email) });
          return NextResponse.json({ package: await reschedule(id, iso, user.email) });
        }
        return NextResponse.json({ package: await setPlan(id, iso, user.email) });
      }
      if (body.action === 'schedule') {
        const cur = await loadPackage(id);
        if (!cur.plannedFor) return jsonError(400, 'validation', 'Plan a day and time in the Calendar first.');
        if ((await schedulerAllowed()).enabled && (await metaLive()).enabled) return NextResponse.json({ package: await scheduleInSignal(id, cur.plannedFor, user.email) });
        return NextResponse.json({ package: await dispatchPackage(id, user.email, { scheduleFor: cur.plannedFor }) });
      }
      if (body.action === 'cancel-schedule') {
        const cur = await loadPackage(id);
        return NextResponse.json({ package: cur.scheduled?.provider === 'signal' ? await cancelSignalSchedule(id, user.email) : await cancelSchedule(id, user.email) });
      }
      if (body.action === 'discard') return NextResponse.json({ package: await discardPackage(id, user.email) });
      if (body.action === 'label') return NextResponse.json({ package: await confirmLabel(id, user.email) });
      if (body.action === 'resolve')
        return NextResponse.json({
          package: await resolveUncertain(id, user.email, body.posted === true ? { posted: true, url: typeof body.url === 'string' ? body.url.slice(0, 300) : '' } : { posted: false }),
        });
      return jsonError(400, 'validation', 'Unknown action.');
    } catch (e) {
      if (e instanceof ContentError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 403 ? 'forbidden' : 'validation', e.message);
      return jsonError(500, 'internal', 'Could not update the package.');
    }
  }
}
