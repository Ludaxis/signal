// GET /api/studio/postmaker/runs/[id]?project=&since=<seq>   RunView: the run and its events after `since`,
// with `nextSeq` to poll from (every 1 s while running, 5 s otherwise).
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { pmError, pmFail, pmJson } from '@/lib/studio/postmaker/api/http';
import { runView } from '@/lib/studio/postmaker/service';
import { RUN_ID_RE } from '@/lib/studio/postmaker/store/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return pmError(400, 'validation', 'Unknown run.');
  const sinceRaw = new URL(req.url).searchParams.get('since') ?? '0';
  if (!/^\d{1,9}$/.test(sinceRaw)) return pmError(400, 'validation', 'since must be a whole number.');
  return inProject(req, null, async (project) => {
    try {
      return pmJson(await runView(project, id, Number(sinceRaw)));
    } catch (e) {
      return pmFail(e, 'run');
    }
  });
}
