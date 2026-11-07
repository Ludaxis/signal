// GET /api/studio/memory?project=[&demo=1]   project memory for the Memory tab: the decision map,
// learnings, the last events, routing decisions and agent runs, plus the campaigns they belong to.
// Reads only, except that the derived decision map and learnings are rebuilt from the timeline
// when it has newer events (graph.json and learnings.json are caches of the timeline and posts). demo=1 returns the deterministic example payload so the tab can
// be previewed before memory is switched on; it is marked as example data by the UI.
import { NextResponse, type NextRequest } from 'next/server';
import { projectTimeZone } from '@/lib/studio/time';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { listCampaigns } from '@/lib/studio/campaigns';
import { demoPayload } from '@/lib/studio/memory/demo';
import { rebuildMemory } from '@/lib/studio/memory/graph';
import { listDecisions, listEvents, listRuns, memoryAllowed, readGraph, readLearnings } from '@/lib/studio/memory/store';
import type { MemoryPayload } from '@/lib/studio/memory/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const demo = new URL(req.url).searchParams.get('demo') === '1';
  return inProject(req, null, async (project) => {
    const info = { id: project.id, name: project.name, handle: project.handle, timeZone: projectTimeZone(project) };
    if (demo) return NextResponse.json(demoPayload(info), NO_STORE);

    const gate = await memoryAllowed();
    if (gate.enabled) {
      const [last] = await listEvents({ limit: 1 });
      const g = await readGraph();
      if (last && last.at > g.updatedAt) await rebuildMemory().catch(() => undefined);
    }
    const [graph, learnings, events, decisions, runs, campaigns] = await Promise.all([
      readGraph(),
      readLearnings(),
      listEvents({ limit: 300 }),
      listDecisions(200),
      listRuns(50),
      listCampaigns().catch(() => []),
    ]);
    const body: MemoryPayload = {
      enabled: gate.enabled,
      reason: gate.reason,
      project: info,
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, goal: c.goal, status: c.status })),
      graph,
      learnings: learnings.learnings,
      events: [...events].reverse(),
      decisions: [...decisions].reverse(),
      runs: [...runs].reverse(),
      stats: {
        events: events.length,
        decisions: decisions.length,
        judgeCostUsd: Math.round(decisions.reduce((s, d) => s + (d.costUsd ?? 0), 0) * 10000) / 10000,
        agentCostUsd: Math.round(runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100,
      },
    };
    return NextResponse.json(body, NO_STORE);
  });
}
