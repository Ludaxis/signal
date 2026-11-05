// GET  /api/studio/pipelines?project=         PipelinesPayload: pipelines with next slots, today's spend, status, last result
// POST /api/studio/pipelines {project, action, …}   PipelineAction:
//   create {pipeline} | update {id, patch} | delete {id} (archive) | toggle {id, enabled} | run-now {id}
// run-now starts one autopilot run limited to that pipeline (same switches, pause, budget and lock as the daily run;
// Codex allowed because you pressed the button) and answers with the run id; the UI polls GET.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { ContentError } from '@/lib/studio/content';
import { AgentError } from '@/lib/studio/claude-agent';
import { autopilotAllowed, autopilotPaused } from '@/lib/studio/autopilot/settings';
import { runInProgress, startRun } from '@/lib/studio/autopilot/runner';
import { recordEvent } from '@/lib/studio/memory/store';
import { pipelinesPayload } from '@/lib/studio/pipelines/payload';
import { archivePipeline, createPipeline, getLivePipeline, updatePipeline } from '@/lib/studio/pipelines/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fail(e: unknown): Response {
  if (e instanceof ContentError || e instanceof AgentError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : 'validation', e.message);
  // An unexpected error stays on the server: the message may name files or hosts, so the answer is generic.
  console.error('[pipelines]', e instanceof Error ? e.message : String(e).slice(0, 200));
  return jsonError(500, 'internal', 'Something went wrong on the server. Try again.');
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async () => {
    try {
      return NextResponse.json(await pipelinesPayload(), { headers: { 'Cache-Control': 'no-store' } });
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
      const id = typeof b.id === 'string' ? b.id : '';
      switch (b.action) {
        case 'create': {
          const p = await createPipeline(b.pipeline ?? {});
          await recordEvent({ type: 'note.added', by, data: { pipeline: p.id, note: `Pipeline "${p.name}" created (${p.steps.source.kind} → ${p.steps.make.format}).` } });
          return NextResponse.json({ pipeline: p });
        }
        case 'update':
          return NextResponse.json({ pipeline: await updatePipeline(id, b.patch ?? {}) });
        case 'toggle': {
          if (typeof b.enabled !== 'boolean') return jsonError(400, 'validation', 'enabled must be true or false.');
          return NextResponse.json({ pipeline: await updatePipeline(id, { enabled: b.enabled }) });
        }
        case 'delete': {
          const p = await archivePipeline(id);
          await recordEvent({ type: 'note.added', by, data: { pipeline: p.id, note: `Pipeline "${p.name}" removed.` } });
          return NextResponse.json({ pipeline: p });
        }
        case 'run-now': {
          await getLivePipeline(id); // 404 for an unknown or removed id
          const gate = await autopilotAllowed();
          if (!gate.enabled) return jsonError(403, 'forbidden', gate.reason);
          const pause = autopilotPaused();
          if (pause.paused) return jsonError(409, 'conflict', pause.reason);
          if (runInProgress()) return jsonError(409, 'conflict', 'An autopilot run is already in progress for this project.');
          const { id: run, done } = await startRun('manual', {}, { pipeline: id });
          void done.catch(() => undefined); // the run keeps its own record; the UI polls GET
          return NextResponse.json({ run }, { status: 202 });
        }
        default:
          return jsonError(400, 'validation', 'Unknown action.');
      }
    } catch (e) {
      return fail(e);
    }
  });
}
