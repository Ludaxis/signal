// @vitest-environment node
// Through the routes: the four actions that answered 409 'unavailable' before now work. `run.pause` and
// `run.continue` on a paused run (no step started twice), `recipe.regenerate-beat`, and `step.edit` with
// `replaceFile` after a POST to the uploads route (a wrong magic byte is 400; the switch off is 403). The source no
// longer has an 'unavailable' answer. Fakes only; network guard on.
import './guard';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import * as home from '@/app/api/studio/postmaker/route';
import * as refs from '@/app/api/studio/postmaker/references/route';
import * as uploads from '@/app/api/studio/postmaker/uploads/route';
import * as runs from '@/app/api/studio/postmaker/runs/[id]/route';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, type Deconstruct } from '@/lib/studio/postmaker/service';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import type { Recipe, Reference, RunView, StepVersion } from '@/lib/studio/postmaker/types';
import { withPostsProject, writePostsConfig } from './accept-fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { tmp } from './guard';
import { mp4, png } from './media-fixtures';
import { recipeDraft } from './recipe-fixture';

withPostsProject();

const ORIGIN = 'http://localhost:3000';
let token = '';
const saved = { secret: process.env.SIGNAL_SESSION_SECRET, renderDir: process.env.SIGNAL_RENDER_SERVICE_DIR };

const fixtureDeconstruct: Deconstruct = async ({ options }) => {
  const { projectId: _p, referenceId: _r, ...rest } = recipeDraft(options.languages);
  void _p;
  void _r;
  return rest;
};

let release: () => void = () => undefined;
let counters = newCounters();

beforeEach(async () => {
  process.env.SIGNAL_RENDER_SERVICE_DIR = `${tmp.dir}/no-render-service`;
  process.env.SIGNAL_SESSION_SECRET = 'postmaker-completions-test-secret-00';
  _resetEngineState();
  _resetSchedulerState();
  token = issueSession();
  // art is held until the test releases it, so a Pause lands while a step is in progress
  const held = new Promise<void>((r2) => (release = r2));
  counters = newCounters();
  _setServiceDeps({ deconstruct: fixtureDeconstruct, buildOptions: () => ({}), executors: defaultExecutors({ fakes: { counters, holdUntil: (id) => (id === 'art' ? held : undefined) } }) });
});
afterEach(() => {
  release();
  _setServiceDeps({});
  for (const [k, v] of Object.entries({ SIGNAL_SESSION_SECRET: saved.secret, SIGNAL_RENDER_SERVICE_DIR: saved.renderDir })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const cookie = () => ({ cookie: `${COOKIE_PLAIN}=${token}` });
const postAction = (body: Record<string, unknown>) =>
  home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...cookie() }, body: JSON.stringify({ project: TEST_PROJECT.id, ...body }) }));
const json = async <T>(r: Response) => (await r.json()) as T;
const runView = async (runId: string) => json<RunView>(await runs.GET(new NextRequest(`${ORIGIN}/api/studio/postmaker/runs/${runId}?project=${TEST_PROJECT.id}&since=0`, { headers: cookie() }), { params: Promise.resolve({ id: runId }) }));
async function poll(runId: string, until: (v: RunView) => boolean): Promise<RunView> {
  for (let i = 0; i < 400; i++) {
    const v = await runView(runId);
    if (until(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not get there`);
}
const atProof = (v: RunView) => v.run.status === 'needs-you' && v.run.pausedFor === 'check' && v.events.at(-1)?.kind === 'gate.waiting';
const postUpload = (body: Buffer | string, type = 'application/octet-stream') =>
  uploads.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/uploads?project=${TEST_PROJECT.id}`, { method: 'POST', headers: { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), origin: ORIGIN, ...cookie() }, body: typeof body === 'string' ? body : new Uint8Array(body) }));

async function makeIt(): Promise<{ runId: string; recipeId: string }> {
  const buf = mp4({ seconds: 30 });
  const up = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${TEST_PROJECT.id}&rights=own`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': String(buf.length), origin: ORIGIN, ...cookie() }, body: new Uint8Array(buf) }));
  const ref = (await json<{ reference: Reference }>(up)).reference;
  const r = await postAction({ action: 'make-it', referenceId: ref.id, options: { languages: ['en'], lengthSec: 30, shape: '9:16' } });
  expect(r.status).toBe(202);
  return json<{ runId: string; recipeId: string }>(r);
}

describe('pause, continue, regenerate one beat and Replace file answer through the routes', () => {
  it('run.pause (200) holds new steps while art finishes; run.continue (202) reaches Proof with no step started twice', async () => {
    const { runId } = await makeIt();
    await poll(runId, () => counters.runs['art'] === 1);
    const p = await postAction({ action: 'run.pause', runId });
    expect(p.status).toBe(200);
    release();
    const paused = await poll(runId, (v) => v.run.status === 'needs-you' && v.run.pausedFor === 'paused');
    expect(paused.events.at(-1)).toMatchObject({ kind: 'run.paused', text: 'Paused' });
    expect((await postAction({ action: 'run.pause', runId })).status).toBe(200); // already paused: as it is
    const c = await postAction({ action: 'run.continue', runId });
    expect(c.status).toBe(202);
    const v = await poll(runId, atProof);
    const started = v.events.filter((e) => e.kind === 'step.started').map((e) => e.nodeId);
    expect(new Set(started).size).toBe(started.length);
    expect(v.run.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('recipe.regenerate-beat answers 200 with the recipe; step.edit replaceFile answers 200 after an upload; a bad upload is 400', async () => {
    release();
    const { runId, recipeId } = await makeIt();
    await poll(runId, atProof);
    const rb = await postAction({ action: 'recipe.regenerate-beat', recipeId, beatId: 'b02', note: 'shorter' });
    expect(rb.status).toBe(200);
    expect((await json<{ recipe: Recipe; changed: boolean }>(rb)).recipe.id).toBe(recipeId);

    const bad = await postUpload('<html>not an image</html>');
    expect(bad.status).toBe(400);
    const u = await postUpload(png(1080, 1920));
    expect(u.status).toBe(200);
    const { upload } = await json<{ upload: { id: string; kind: string; mime: string } }>(u);
    expect(upload).toMatchObject({ kind: 'image', mime: 'image/png' });
    const base = (await readHead(tmp.root, recipeId, 'render:en')).current!;
    const wrongType = await postAction({ action: 'step.edit', recipeId, nodeId: 'render:en', baseVersion: base, output: { replaceFile: { port: 'video', uploadId: upload.id } } });
    expect(wrongType.status).toBe(400);
    expect((await json<{ error: { details: { reason: string } } }>(wrongType)).error.details.reason).toBe('wrong-type');
    const e = await postAction({ action: 'step.edit', recipeId, nodeId: 'render:en', baseVersion: base, output: { replaceFile: { port: 'cover', uploadId: upload.id } } });
    expect(e.status).toBe(200);
    expect((await json<{ version: StepVersion }>(e)).version).toMatchObject({ n: base + 1, editedByUser: true });

    writePostsConfig({ postmaker: false });
    expect((await postUpload(png())).status).toBe(403);
  });

  it('the service has no "unavailable" answer left', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../lib/studio/postmaker/service.ts'), 'utf8');
    expect(src).not.toMatch(/'unavailable'/);
  });
});
