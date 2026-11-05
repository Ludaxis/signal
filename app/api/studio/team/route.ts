// GET  /api/studio/team?project=              whether the team may run, the last runs, the roles
// POST /api/studio/team {project, action:'review', id}   run the reviewer on one post (review.json)
// POST /api/studio/team {project, action:'report'}       run the analyst's weekly report
// Agents run only on the owner's button press. Nothing here publishes, schedules or approves.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { ContentError, isPackageId } from '@/lib/studio/content';
import { AgentError } from '@/lib/studio/claude-agent';
import { listRuns } from '@/lib/studio/memory/store';
import { weeklyReport } from '@/lib/studio/team/analyst';
import { reviewPackage } from '@/lib/studio/team/reviewer';
import { ROLE_IDS, ROLES } from '@/lib/studio/team/roles';
import { teamAllowed } from '@/lib/studio/team/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

function fail(e: unknown): Response {
  if (e instanceof ContentError || e instanceof AgentError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : e.status >= 500 ? 'internal' : 'validation', e.message);
  return jsonError(500, 'internal', String((e as Error)?.message ?? e).slice(0, 200));
}

const rolesSummary = () => ROLE_IDS.map((id) => ({ id, title: ROLES[id].title, model: ROLES[id].model, maxBudgetUsd: ROLES[id].maxBudgetUsd, maxTurns: ROLES[id].maxTurns, tools: ROLES[id].tools, web: ROLES[id].web, output: ROLES[id].output }));

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async () => {
    try {
      const runs = (await listRuns(30)).reverse(); // newest first
      return NextResponse.json({ allowed: await teamAllowed(), runs, roles: rolesSummary() }, { headers: { 'Cache-Control': 'no-store' } });
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
      switch (b.action) {
        case 'review': {
          const id = typeof b.id === 'string' ? b.id : '';
          if (!isPackageId(id)) return jsonError(400, 'validation', 'Unknown package.');
          const { review, run } = await reviewPackage(id);
          return NextResponse.json({ review, run });
        }
        case 'report': {
          const { report, run } = await weeklyReport();
          return NextResponse.json({ report, run });
        }
        default:
          return jsonError(400, 'validation', 'Unknown action.');
      }
    } catch (e) {
      return fail(e);
    }
  });
}
