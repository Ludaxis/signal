// Server-only: the GET /api/studio/pipelines answer for the current project.
import { TIMEZONE, todayInZone } from '@/lib/time';
import { listCampaigns } from '../campaigns';
import { listPackages } from '../content';
import { FORMAT_LABEL } from '../generate';
import { loadBrand } from '../brand';
import { listAutopilotRuns, nextRunAt, runsForDay } from '../autopilot/runner';
import { autopilotAllowed, autopilotPaused, higgsfieldAllowed, readSettings, trustedPublishAllowed } from '../autopilot/settings';
import { spendOfPipeline, ATTENDED_ONLY, HIGGSFIELD_FORMATS } from '../autopilot/steps';
import type { AutopilotRun } from '../autopilot/types';
import { madeBy } from './runner';
import { listPipelines, projectFormats, readState, stepProblems, upcomingSlots } from './store';
import type { Pipeline, PipelineRow, PipelinesPayload, RepeatRow } from './types';
import { repeatPipeline } from './runner';
import { repeatAllowed, slotsMadeBy } from '../postmaker/repeat-state';
import { postmakerRoot as rootOf } from '../postmaker/store/paths';
import { listTemplates } from '../postmaker/store/templates';
import type { PackageView } from '../content';
import { currentProject } from '../projects';

const touches = (r: AutopilotRun, id: string) => r.pipeline === id || r.steps.some((s) => 'pipeline' in s && s.pipeline === id);

function statusOf(p: Pipeline, g: PipelinesPayload['switches'], paused: PipelinesPayload['paused'], website: boolean, campaigns: { id: string; name: string; status: string; autopilot: boolean }[]): PipelineRow['status'] {
  const problems: { text: string; why: string }[] = [];
  if (paused.paused) problems.push({ text: 'Paused.', why: paused.reason });
  if (!g.autopilot.enabled) problems.push({ text: 'Autopilot is switched off.', why: g.autopilot.reason });
  if (p.steps.source.kind === 'website' && !website) problems.push({ text: 'No website yet.', why: 'Import the website on the Brand screen; the pipeline reads its new pages from there.' });
  for (const t of stepProblems(p)) problems.push({ text: t, why: t });
  if (p.steps.source.kind === 'campaign' && p.steps.source.campaign) {
    const c = campaigns.find((x) => x.id === p.steps.source.campaign);
    if (!c) problems.push({ text: 'Campaign missing.', why: 'The linked campaign no longer exists. Pick another one.' });
    else if (c.status !== 'active') problems.push({ text: 'Campaign not running.', why: `The linked campaign is ${c.status}. Start it on the Campaigns screen.` });
    else if (!c.autopilot) problems.push({ text: `Campaign "${c.name}" is off.`, why: 'Its autopilot is switched off, so this pipeline makes nothing from its plan. Switch its autopilot on in the campaign’s card on the Campaigns screen. Posts made through this pipeline count against this pipeline’s budget, not the campaign’s.' });
  }
  if (HIGGSFIELD_FORMATS.includes(p.steps.make.format) && !g.higgsfield.enabled) problems.push({ text: 'Higgsfield is switched off.', why: g.higgsfield.reason });
  if (ATTENDED_ONLY.includes(p.steps.make.format)) problems.push({ text: 'Codex needs Run now.', why: 'Codex runs on your own sign-in only when you press a button, so this pipeline makes nothing in the daily run. Press Run now to make its posts.' });
  if (p.steps.approve.mode === 'trusted' && !g.trustedPublish.enabled) problems.push({ text: 'Trusted publishing is switched off.', why: `${g.trustedPublish.reason} Posts wait for you in Review until then.` });
  const blocking = problems.some((x) => !x.text.startsWith('Codex') && !x.text.startsWith('Trusted'));
  const text = !p.enabled ? 'Off' : blocking ? 'Waiting' : 'On';
  return { text, problems };
}

/**
 * Every proven template with Repeat settings, with its upcoming slots like a pipeline row (the Calendar and
 * Pipelines screens read the same `next`). A slot a post was started for counts as made: with its package when it
 * was accepted, in `waiting` when it still waits for the person at Proof.
 */
export async function repeatRows(all: PackageView[], todays: AutopilotRun[], now = Date.now()): Promise<RepeatRow[]> {
  const root = rootOf(currentProject());
  const sw = await repeatAllowed();
  const rows: RepeatRow[] = [];
  for (const t of await listTemplates(root).catch(() => [])) {
    const p = t.status === 'proven' ? repeatPipeline(t) : null;
    if (!p) continue;
    const ids = [...new Set([p.id, t.id])];
    const made = new Map<string, string>();
    for (const id of ids) for (const [at, pkg] of madeBy(all, id)) made.set(at, pkg);
    const ledger = await slotsMadeBy(root, ids);
    const waiting: string[] = [];
    for (const [at, e] of ledger) if (!made.has(at)) {
      if (e.packageIds[0]) made.set(at, e.packageIds[0]);
      else waiting.push(at);
    }
    const next = upcomingSlots(p, made, now);
    const started = new Set(waiting);
    rows.push({
      templateId: t.id,
      name: t.name,
      enabled: p.enabled && sw.enabled,
      reason: !p.enabled ? 'Repeat is off for this template.' : sw.reason,
      next,
      nextAt: next.find((s) => !s.packageId && !started.has(s.at))?.at ?? null,
      waiting: waiting.sort(),
      spendToday: spendOfPipeline(todays, p.id),
    });
  }
  return rows;
}

export async function pipelinesPayload(now = Date.now()): Promise<PipelinesPayload> {
  const [autopilot, trustedPublish, higgsfield, pipelines, campaigns, all, runs, todays, brand] = await Promise.all([
    autopilotAllowed(),
    trustedPublishAllowed(),
    higgsfieldAllowed(),
    listPipelines(),
    listCampaigns(),
    listPackages(),
    listAutopilotRuns(40),
    runsForDay(todayInZone(now)),
    loadBrand().catch(() => null),
  ]);
  const paused = autopilotPaused();
  const switches = { autopilot, trustedPublish, higgsfield };
  const website = Boolean(brand?.website);
  const camps: PipelinesPayload['campaigns'] = [];
  for (const c of campaigns) camps.push({ id: c.id, name: c.name, status: c.status, autopilot: (await readSettings(c.id).catch(() => null))?.enabled === true });
  const rows: PipelineRow[] = [];
  for (const p of pipelines) {
    const next = p.steps.source.kind === 'campaign' ? [] : upcomingSlots(p, madeBy(all, p.id), now);
    const last = runs.find((r) => r.status !== 'running' && touches(r, p.id)) ?? null;
    rows.push({
      ...p,
      next,
      nextAt: next.find((s) => !s.packageId)?.at ?? null,
      spendToday: spendOfPipeline(todays, p.id),
      state: await readState(p.id),
      status: statusOf(p, switches, paused, website, camps),
      last: last
        ? {
            at: last.startedAt,
            status: last.status,
            made: last.steps.filter((s) => s.kind === 'make' && s.pipeline === p.id && s.package).length,
            problems: last.steps.filter((s) => 'pipeline' in s && s.pipeline === p.id && 'error' in s && s.error).length,
            note: last.note,
          }
        : null,
    });
  }
  const running = runs.find((r) => r.status === 'running') ?? null;
  return {
    pipelines: rows,
    repeats: await repeatRows(all, todays, now),
    formats: projectFormats().map((id) => ({ id, name: FORMAT_LABEL[id] })),
    campaigns: camps,
    switches,
    paused,
    website,
    timeZone: TIMEZONE,
    running: running?.id ?? null,
    nextRunAt: autopilot.enabled && !paused.paused ? nextRunAt(now, runs) : null,
    runs: runs.filter((r) => r.status === 'running' || pipelines.some((p) => touches(r, p.id))).slice(0, 8),
  };
}
