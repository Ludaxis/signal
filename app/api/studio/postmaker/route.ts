// GET  /api/studio/postmaker?project=                 PostmakerHome: recipes, templates, recent runs, connectors, pause
// POST /api/studio/postmaker {project, action, …}     every mutating Post maker action, zod-validated
//   make-it | run | step.regenerate | step.regenerate-from-here | run.continue answer 202 {runId} at once; the UI polls
//   GET /api/studio/postmaker/runs/[id]. Errors: 400 validation, 403 forbidden, 404 not_found, 409 conflict.
// Session and same-origin checks first (requireStudioUser: the signed owner session), then the `postmaker`
// feature switch (off: every action except the estimate answers 403 feature-off), then the project.
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { pmError, pmFail, pmJson, postmakerOffRefusal } from '@/lib/studio/postmaker/api/http';
import { handleAction, home } from '@/lib/studio/postmaker/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Edited step outputs can be a full script; anything larger is not a JSON action. */
const MAX_BODY_BYTES = 2_500_000;

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async (project) => {
    try {
      return pmJson(await home(project));
    } catch (e) {
      return pmFail(e, 'home');
    }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return pmError(400, 'validation', 'Request too large.');
  let raw: string;
  let body: unknown;
  try {
    raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return pmError(400, 'validation', 'Request too large.');
    body = JSON.parse(raw);
  } catch {
    return pmError(400, 'validation', 'Bad request.');
  }
  const projectId = body && typeof body === 'object' ? (body as { project?: unknown }).project : undefined;
  const off = await postmakerOffRefusal(body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined);
  if (off) return off;
  return inProject(req, projectId, async (project) => {
    try {
      const action = parseAction(body);
      const r = await handleAction(project, { email: user.email }, action);
      return pmJson(r.body, r.status);
    } catch (e) {
      return pmFail(e, 'action');
    }
  });
}
