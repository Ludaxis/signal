// GET  /api/studio/campaigns?project=            all campaigns of the project, with their plans
// GET  /api/studio/campaigns?project=&id=        one campaign: plan, posts and results
// GET  /api/studio/campaigns?project=&id=&progress=1   live progress of the campaign's agent run
// POST /api/studio/campaigns {project, action, …}
//   create {campaign} | update {id, patch} | strategy {id, notes} | approve-strategy {id}
//   plan {id} | make-post {id, slotId} | skip-slot {id, slotId}
// Agents (strategy, plan) and post generation run only on the owner's button press.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { ContentError } from '@/lib/studio/content';
import { AgentError, claudeAgentsAllowed } from '@/lib/studio/claude-agent';
import { GOALS, approveStrategy, campaignView, getProgress, createCampaign, getCampaign, getPlan, listCampaigns, makePlan, makeSlotPost, proposeStrategy, skipSlot, updateCampaign } from '@/lib/studio/campaigns';
import { projectTimeZone } from '@/lib/studio/time';
import { loadPackFormats } from '@/lib/studio/formats';
import { recordEvent } from '@/lib/studio/memory/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

function fail(e: unknown): Response {
  if (e instanceof ContentError || e instanceof AgentError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status === 403 ? 'forbidden' : 'validation', e.message);
  return jsonError(500, 'internal', String((e as Error)?.message ?? e).slice(0, 200));
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const id = new URL(req.url).searchParams.get('id');
  return inProject(req, null, async (project) => {
    try {
      if (id && new URL(req.url).searchParams.get('progress') === '1') return NextResponse.json({ progress: await getProgress(id) }, { headers: { 'Cache-Control': 'no-store' } });
      if (id) return NextResponse.json(await campaignView(id), { headers: { 'Cache-Control': 'no-store' } });
      const campaigns = await listCampaigns();
      const plans = Object.fromEntries(await Promise.all(campaigns.map(async (c) => [c.id, await getPlan(c.id)] as const)));
      // Post types under the project pack's names when it has a formats.json (the built-in set otherwise).
      const set = await loadPackFormats(project);
      const formats = set.formats.map((f) => ({ id: f, name: set.labels[f] }));
      return NextResponse.json({ campaigns, plans, agents: await claudeAgentsAllowed(), goals: GOALS, formats, timeZone: projectTimeZone(project) }, { headers: { 'Cache-Control': 'no-store' } });
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
      const id = typeof b.id === 'string' ? b.id : '';
      const slotId = typeof b.slotId === 'string' ? b.slotId.slice(0, 60) : '';
      // Each step is also recorded in project memory; recordEvent is gated, best effort and never throws.
      const by = user.email;
      switch (b.action) {
        case 'create': {
          const c = await createCampaign((b.campaign ?? {}) as Record<string, unknown>, by);
          await recordEvent({ type: 'campaign.created', by, campaign: c.id, data: { name: c.name, goal: c.goal, formats: c.formats, perWeek: c.perWeek } });
          return NextResponse.json({ campaign: c });
        }
        case 'update': {
          const before = await getCampaign(id).catch(() => null);
          const c = await updateCampaign(id, (b.patch ?? {}) as Record<string, unknown>);
          if (before && before.status !== c.status) await recordEvent({ type: 'campaign.status', by, campaign: c.id, data: { from: before.status, to: c.status } });
          return NextResponse.json({ campaign: c });
        }
        case 'strategy': {
          const c = await proposeStrategy(id, by, typeof b.notes === 'string' ? b.notes : '');
          if (c.proposal) await recordEvent({ type: 'strategy.proposed', by: 'agent:strategist', campaign: c.id, data: { summary: c.proposal.summary.slice(0, 300), pillars: c.proposal.pillars.map((x) => ({ name: x.name, weight: x.weight })), requestedBy: by } });
          return NextResponse.json({ campaign: c });
        }
        case 'approve-strategy': {
          const c = await approveStrategy(id, by);
          if (c.strategy) await recordEvent({ type: 'strategy.approved', by, campaign: c.id, data: { summary: c.strategy.summary.slice(0, 300), pillars: c.strategy.pillars.map((x) => ({ name: x.name, weight: x.weight })), experiments: c.strategy.experiments.map((x) => x.hypothesis.slice(0, 200)) } });
          return NextResponse.json({ campaign: c });
        }
        case 'plan': {
          const plan = await makePlan(id, by);
          await recordEvent({ type: 'plan.made', by: 'agent:planner', campaign: id, data: { slots: plan.slots.filter((x) => x.status === 'planned').length, requestedBy: by } });
          return NextResponse.json({ plan });
        }
        case 'make-post': {
          const r = await makeSlotPost(id, slotId, by);
          const slot = r.plan.slots.find((x) => x.id === slotId);
          await recordEvent({ type: 'post.made', by, campaign: id, refs: { package: r.packageId, slot: slotId }, data: slot ? { format: slot.format, pillar: slot.pillar, hook: slot.hook.slice(0, 200), date: slot.date } : {} });
          return NextResponse.json(r);
        }
        case 'skip-slot':
          return NextResponse.json({ plan: await skipSlot(id, slotId) });
        default:
          return jsonError(400, 'validation', 'Unknown action.');
      }
    } catch (e) {
      return fail(e);
    }
  });
}
