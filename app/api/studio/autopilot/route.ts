// GET  /api/studio/autopilot?project=     AutopilotPayload: switches, pause, schedule, campaigns with settings, trust, runs, spend
// POST /api/studio/autopilot {project, action, …}   AutopilotAction:
//   settings {campaign, patch} | run-now | trust {format, trusted} | pull {package}
// Everything is behind the autopilot switches; run-now answers with the run id at once and the UI polls GET.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { ContentError } from '@/lib/studio/content';
import { AgentError } from '@/lib/studio/claude-agent';
import { autopilotAllowed, autopilotPaused, updateSettings } from '@/lib/studio/autopilot/settings';
import { isFormat, readTrust, setTrust } from '@/lib/studio/autopilot/trust';
import { pullPackage } from '@/lib/studio/autopilot/pull';
import { runInProgress, startRun } from '@/lib/studio/autopilot/runner';
import { autopilotPayload } from '@/lib/studio/autopilot/payload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fail(e: unknown): Response {
  if (e instanceof ContentError || e instanceof AgentError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : 'validation', e.message);
  return jsonError(500, 'internal', String((e as Error)?.message ?? e).slice(0, 200));
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async () => {
    try {
      return NextResponse.json(await autopilotPayload(), { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
      return fail(e);
    }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async () => {
    try {
      const by = user.email;
      switch (b.action) {
        case 'settings': {
          const campaign = typeof b.campaign === 'string' ? b.campaign : '';
          return NextResponse.json({ settings: await updateSettings(campaign, b.patch, by) });
        }
        case 'run-now': {
          const gate = await autopilotAllowed();
          if (!gate.enabled) return jsonError(403, 'forbidden', gate.reason);
          const pause = autopilotPaused();
          if (pause.paused) return jsonError(409, 'conflict', pause.reason);
          if (runInProgress()) return jsonError(409, 'conflict', 'An autopilot run is already in progress for this project.');
          const { id, done } = await startRun('manual');
          void done.catch(() => undefined); // the run keeps its own record; the UI polls GET
          return NextResponse.json({ run: id }, { status: 202 });
        }
        case 'trust': {
          if (!isFormat(b.format)) return jsonError(400, 'validation', 'Unknown format.');
          if (typeof b.trusted !== 'boolean') return jsonError(400, 'validation', 'trusted must be true or false.');
          return NextResponse.json({ trust: await setTrust(b.format, b.trusted), file: await readTrust() });
        }
        case 'pull':
          return NextResponse.json(await pullPackage(typeof b.package === 'string' ? b.package : '', by));
        default:
          return jsonError(400, 'validation', 'Unknown action.');
      }
    } catch (e) {
      return fail(e);
    }
  });
}
