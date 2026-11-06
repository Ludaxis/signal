// POST /api/studio/results {project} — refresh post results from Upload-Post (read-only, cached 3 h).
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { refreshMetrics } from '@/lib/studio/analytics';
import { rebuildMemory } from '@/lib/studio/memory/graph';
import { noteMetricsSnapshot } from '@/lib/studio/memory/hooks';
import { memoryAllowed } from '@/lib/studio/memory/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { project?: unknown; force?: unknown } = {};
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async () => {
    const snaps: Promise<void>[] = [];
    const r = await refreshMetrics({ force: b.force === true, onSnapshot: (id, f) => void snaps.push(noteMetricsSnapshot(id, f, user.email)) });
    await Promise.all(snaps);
    // Project memory: new results update the decision map and learnings. Best effort.
    if (r.refreshed > 0 && (await memoryAllowed()).enabled) {
      await rebuildMemory().catch(() => undefined);
    }
    return NextResponse.json(r);
  });
}
