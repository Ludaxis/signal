// GET/POST /api/studio/pipelines: auth, the payload shape, create/update/toggle/delete/run-now.
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import { GET, POST } from '@/app/api/studio/pipelines/route';
import type { PipelinesPayload } from '@/lib/studio/pipelines/types';
import { listAutopilotRuns } from '@/lib/studio/autopilot/runner';
import { TIMEZONE } from '@/lib/time';
import { TEST_PROJECT, writeTestConfig } from './studio-helpers';
import { campaignWithSlots, root, setupAutopilotProject, teardownAutopilotProject, writeSettings } from './autopilot-helpers';
import { P1, readPipeline, writePipeline } from './pipelines-helpers';

const ORIGIN = 'http://localhost:3000';
let token = '';

beforeEach(() => {
  setupAutopilotProject({ higgsfield: true });
  process.env.SIGNAL_SESSION_SECRET = 'pipelines-api-test-secret-0000';
  token = issueSession();
});
afterEach(() => {
  delete process.env.SIGNAL_SESSION_SECRET;
  teardownAutopilotProject();
});

const get = (auth = true) => GET(new NextRequest(`${ORIGIN}/api/studio/pipelines?project=${TEST_PROJECT.id}`, { headers: auth ? { cookie: `${COOKIE_PLAIN}=${token}` } : {} }));
const post = (body: unknown, auth = true) =>
  POST(new NextRequest(`${ORIGIN}/api/studio/pipelines`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(auth ? { cookie: `${COOKIE_PLAIN}=${token}` } : {}) }, body: JSON.stringify({ project: TEST_PROJECT.id, ...(body as object) }) }));
const json = async <T>(r: Response) => (await r.json()) as T;

describe('GET', () => {
  it('needs a session', async () => {
    expect((await get(false)).status).toBe(401);
    expect((await post({ action: 'create', pipeline: {} }, false)).status).toBe(401);
  });
  it('answers the payload shape: pipelines with next slots, spend, status and last result; formats, campaigns, switches', async () => {
    campaignWithSlots(['2026-11-06']);
    writePipeline(P1, { name: 'Blog', steps: { schedule: { makeAheadDays: 5 } } });
    writePipeline('pl-20261102-bbbb', { name: 'Gone', archived: true });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await json<PipelinesPayload>(r);
    expect(j.pipelines.map((p) => p.name)).toEqual(['Blog']);
    const [p] = j.pipelines;
    expect(p).toMatchObject({ id: P1, enabled: true, spendToday: 0, last: null, state: { listNext: 0, ideas: [], lastRunAt: null, lastResult: null } });
    expect(p!.next.map((s) => s.id)).toEqual(expect.arrayContaining(['2026-11-06-18:00', '2026-11-09-18:00']));
    expect(p!.nextAt).toBe(p!.next[0]!.at);
    expect(p!.status.text).toBe('Waiting');
    expect(p!.status.problems.map((x) => x.text)).toEqual(['No website yet.']);
    expect(p!.status.problems[0]!.why).toMatch(/Brand screen/);
    expect(j.formats.map((f) => f.id)).toContain('website-card');
    expect(j.formats.every((f) => typeof f.name === 'string')).toBe(true);
    expect(j.campaigns).toEqual([{ id: 'c-20261101-aaaa', name: 'Grow saves', status: 'active', autopilot: false }]);
    expect(j.switches.autopilot.enabled).toBe(true);
    expect(j.paused.paused).toBe(false);
    expect(j.website).toBe(false);
    expect(j.timeZone).toBe(TIMEZONE);
    expect(j.running).toBeNull();
    expect(typeof j.nextRunAt).toBe('string');
    expect(j.runs).toEqual([]);
  });
  it('status is Off when the switch is off, Waiting with a reason when a switch blocks it, and notes Codex and trusted publishing', async () => {
    writePipeline(P1, { enabled: false, steps: { source: { kind: 'list', list: ['x'] }, make: { format: 'codex-post' }, approve: { mode: 'trusted' } } });
    let [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status.text).toBe('Off');
    expect(p!.status.problems.map((x) => x.text)).toEqual(['Codex needs Run now.', 'Trusted publishing is switched off.']);
    writePipeline(P1, { steps: { source: { kind: 'list', list: ['x'] }, make: { format: 'higgsfield-image' } } });
    [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status).toEqual({ text: 'On', problems: [] });
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true });
    [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status.text).toBe('Waiting');
    expect(p!.status.problems.map((x) => x.text)).toEqual(['Higgsfield is switched off.']);
    process.env.SIGNAL_AUTOPILOT_PAUSED = '1';
    [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status.text).toBe('Waiting');
    expect(p!.status.problems[0]).toMatchObject({ text: 'Paused.' });
  });
  it('a campaign-source pipeline waits while the campaign’s own autopilot is off, and says that its posts count against the pipeline budget', async () => {
    campaignWithSlots(['2026-11-06']);
    writePipeline(P1, { steps: { source: { kind: 'campaign', campaign: 'c-20261101-aaaa' } } });
    let [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status.text).toBe('Waiting');
    expect(p!.status.problems).toEqual([{ text: 'Campaign "Grow saves" is off.', why: expect.stringMatching(/autopilot is switched off.*count against this pipeline’s budget/) }]);
    writeSettings('c-20261101-aaaa', { enabled: true });
    [p] = (await json<PipelinesPayload>(await get())).pipelines;
    expect(p!.status).toEqual({ text: 'On', problems: [] });
  });
});

describe('POST', () => {
  it('create with defaults, update a step, toggle, delete (archive)', async () => {
    let r = await post({ action: 'create', pipeline: { enabled: true, steps: { source: { kind: 'list', list: ['a', 'b'] }, make: { format: 'higgsfield-image' }, schedule: { perWeek: 2, days: [1, 4] } } } });
    expect(r.status).toBe(200);
    const { pipeline: p } = await json<{ pipeline: { id: string; name: string; enabled: boolean; steps: Record<string, unknown> } }>(r);
    expect(p).toMatchObject({ name: 'My list → posts', enabled: true });
    expect(p.steps.schedule).toEqual({ perWeek: 2, days: [1, 4], times: ['18:00'], makeAheadDays: 3 });
    expect(p.steps.source).toEqual({ kind: 'list', list: ['a', 'b'], campaign: null });

    r = await post({ action: 'update', id: p.id, patch: { name: 'Quiz days', steps: { schedule: { times: ['12:00'] } } } });
    expect(r.status).toBe(200);
    const u = (await json<{ pipeline: { name: string; steps: { schedule: { times: string[]; days: number[] }; source: { list: string[] } } } }>(r)).pipeline;
    expect(u.name).toBe('Quiz days');
    expect(u.steps.schedule).toMatchObject({ times: ['12:00'], days: [1, 4] });
    expect(u.steps.source.list).toEqual(['a', 'b']);

    r = await post({ action: 'toggle', id: p.id, enabled: false });
    expect((await json<{ pipeline: { enabled: boolean } }>(r)).pipeline.enabled).toBe(false);
    expect((await post({ action: 'toggle', id: p.id, enabled: 'no' })).status).toBe(400);

    r = await post({ action: 'delete', id: p.id });
    expect((await json<{ pipeline: { archived: boolean } }>(r)).pipeline.archived).toBe(true);
    expect(readPipeline(p.id).archived).toBe(true);
    expect((await json<PipelinesPayload>(await get())).pipelines).toEqual([]);
    expect((await post({ action: 'update', id: 'pl-20261105-zzzz', patch: {} })).status).toBe(404);
    expect((await post({ action: 'nope' })).status).toBe(400);
  });
  it('a removed pipeline answers 404 to update, toggle and run-now, and stays as it is', async () => {
    writePipeline(P1, { archived: true, enabled: false, steps: { source: { kind: 'list', list: ['a'] }, make: { format: 'higgsfield-image' } } });
    expect((await post({ action: 'update', id: P1, patch: { name: 'Back', steps: { schedule: { times: ['09:00'] } } } })).status).toBe(404);
    expect((await post({ action: 'toggle', id: P1, enabled: true })).status).toBe(404);
    const r = await post({ action: 'run-now', id: P1 });
    expect(r.status).toBe(404);
    expect(await json<{ error: { message: string } }>(r)).toMatchObject({ error: { message: 'This pipeline was removed.' } });
    expect(readPipeline(P1)).toMatchObject({ name: 'Test pipeline', enabled: false, archived: true, steps: { schedule: { times: ['18:00'] } } });
    expect(await listAutopilotRuns()).toEqual([]);
  });
  it('run-now starts one run for that pipeline (202 with the run id) and refuses when switched off, paused or busy', async () => {
    writePipeline(P1, { enabled: false, steps: { source: { kind: 'list', list: ['a'] }, make: { format: 'higgsfield-image' } } });
    expect((await post({ action: 'run-now', id: 'pl-20261105-zzzz' })).status).toBe(404);
    process.env.SIGNAL_AUTOPILOT_PAUSED = '1';
    expect((await post({ action: 'run-now', id: P1 })).status).toBe(409);
    delete process.env.SIGNAL_AUTOPILOT_PAUSED;
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, higgsfield: true });
    expect((await post({ action: 'run-now', id: P1 })).status).toBe(403);
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true, higgsfield: true });
    const r = await post({ action: 'run-now', id: P1 });
    expect(r.status).toBe(202);
    const { run } = await json<{ run: string }>(r);
    expect(run).toMatch(/^ap_/);
    // the run is on record and scoped to the pipeline (it fails on the real generator here, which is fine: the record exists)
    const until = Date.now() + 5000;
    let runs = await listAutopilotRuns();
    while (runs[0]?.status === 'running' && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 50));
      runs = await listAutopilotRuns();
    }
    expect(runs[0]).toMatchObject({ id: run, trigger: 'manual', pipeline: P1 });
  });
});
