// @vitest-environment node
// Post maker routes: 401 without a session and 403 cross-origin; make-it answers 202 and polling reaches Proof as
// needs-you with strictly increasing seq and `since`; media serves only this recipe's hashes (`..` and non-hex are
// 400); a mock run's clean Accept is 409 and Accept as draft makes no package; a clean stub run through the routes
// makes one package per language, approvable unchanged; validation, error redaction and the `postmaker` switch.
// Signed owner session (the single-owner login); network guard on; fakes only.
import './guard';
import { existsSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import * as home from '@/app/api/studio/postmaker/route';
import * as refs from '@/app/api/studio/postmaker/references/route';
import * as recipes from '@/app/api/studio/postmaker/recipes/[id]/route';
import * as runs from '@/app/api/studio/postmaker/runs/[id]/route';
import * as media from '@/app/api/studio/postmaker/media/[recipeId]/[sha]/route';
import { approvePackage, loadPackage } from '@/lib/studio/content';
import { GENERIC_500, POSTMAKER_OFF_TEXT } from '@/lib/studio/postmaker/api/http';
import { PostmakerActionSchema } from '@/lib/studio/postmaker/api/schemas';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, AT_PROOF_TEXT, mockDeconstruct, type Deconstruct } from '@/lib/studio/postmaker/service';
import { commitVersion } from '@/lib/studio/postmaker/store/commit';
import { putBytes } from '@/lib/studio/postmaker/store/objects';
import { createRecipe } from '@/lib/studio/postmaker/store/recipes';
import type { RecipeView, Reference, RunView } from '@/lib/studio/postmaker/types';
import { withPostsProject, withVerdict, writePostsConfig } from './accept-fixtures';
import { versionDraft } from './fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { tmp } from './guard';
import { mp4 } from './media-fixtures';
import { PROJECT, recipeDraft } from './recipe-fixture';

withPostsProject();

const ORIGIN = 'http://localhost:3000';
const P = TEST_PROJECT.id;
let token = '';
const saved = { secret: process.env.SIGNAL_SESSION_SECRET, renderDir: process.env.SIGNAL_RENDER_SERVICE_DIR, origin: process.env.SIGNAL_WEB_ORIGIN };

beforeEach(() => {
  // The service wires the real render chain only when Remotion is installed for the render child; these route tests
  // run without a child process (the guard), so the render-chain kinds keep their fakes here.
  process.env.SIGNAL_RENDER_SERVICE_DIR = `${tmp.dir}/no-render-service`;
  delete process.env.SIGNAL_WEB_ORIGIN;
  // The owner's signed session, as the login route issues it. The postmaker switch is on (withPostsProject); the off
  // case is tested below.
  process.env.SIGNAL_SESSION_SECRET = 'postmaker-routes-test-secret-000000';
  token = issueSession();
  _resetEngineState();
  _resetSchedulerState();
  _setServiceDeps({ deconstruct: fixtureDeconstruct, buildOptions: () => ({}) });
});
afterEach(() => {
  _setServiceDeps({});
  for (const [k, v] of Object.entries({ SIGNAL_SESSION_SECRET: saved.secret, SIGNAL_RENDER_SERVICE_DIR: saved.renderDir, SIGNAL_WEB_ORIGIN: saved.origin })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The fixture recipe (synthetic 7-beat story spine) as the deconstructor's answer. */
const fixtureDeconstruct: Deconstruct = async ({ options }) => {
  const { projectId: _p, referenceId: _r, ...rest } = recipeDraft(options.languages);
  void _p;
  void _r;
  return rest;
};

const cookie = () => ({ cookie: `${COOKIE_PLAIN}=${token}` });
const getReq = (url: string, headers: Record<string, string> = {}, auth = true) => new NextRequest(`${ORIGIN}${url}`, { headers: { ...(auth ? cookie() : {}), ...headers } });
const postAction = (body: Record<string, unknown>, o: { origin?: string; auth?: boolean } = {}) =>
  home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: o.origin ?? ORIGIN, ...(o.auth === false ? {} : cookie()) }, body: JSON.stringify({ project: P, ...body }) }));
const json = async <T>(r: Response) => (await r.json()) as T;
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

async function upload(buf: Buffer): Promise<Reference> {
  const r = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${P}&rights=own`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': String(buf.length), origin: ORIGIN, ...cookie() }, body: new Uint8Array(buf) }));
  expect(r.status).toBe(200);
  return (await json<{ reference: Reference }>(r)).reference;
}

const runView = async (runId: string, since = 0) => {
  const r = await runs.GET(getReq(`/api/studio/postmaker/runs/${runId}?project=${P}&since=${since}`), ctx({ id: runId }));
  expect(r.status).toBe(200);
  return json<RunView>(r);
};
const recipeViewOf = async (recipeId: string) => {
  const r = await recipes.GET(getReq(`/api/studio/postmaker/recipes/${recipeId}?project=${P}`), ctx({ id: recipeId }));
  expect(r.status).toBe(200);
  return json<RecipeView>(r);
};

/** Polls the run like the UI does until `until` holds (or fails after ~10 s). */
async function poll(runId: string, until: (v: RunView) => boolean): Promise<RunView> {
  for (let i = 0; i < 400; i++) {
    const v = await runView(runId);
    if (until(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not get there: ${JSON.stringify((await runView(runId)).run.status)}`);
}
const atProof = (v: RunView) => v.run.status === 'needs-you' && v.run.pausedFor === 'check';

async function makeIt(langs: ('fa' | 'en')[] = ['fa', 'en'], capUsd?: number): Promise<{ runId: string; recipeId: string }> {
  const ref = await upload(mp4({ seconds: 30 }));
  const r = await postAction({ action: 'make-it', referenceId: ref.id, options: { languages: langs, lengthSec: 30, shape: '9:16', ...(capUsd !== undefined ? { capUsd } : {}) } });
  expect(r.status).toBe(202);
  const b = await json<{ runId: string; recipeId: string }>(r);
  expect(b.runId).toMatch(/^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
  return b;
}

describe('session and origin', () => {
  it('every route answers 401 without a session', async () => {
    expect((await home.GET(getReq(`/api/studio/postmaker?project=${P}`, {}, false))).status).toBe(401);
    expect((await postAction({ action: 'run.stop', runId: 'run-20261106-100000-abcd' }, { auth: false })).status).toBe(401);
    expect((await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'video/mp4' }, body: 'x' }))).status).toBe(401);
    expect((await recipes.GET(getReq('/api/studio/postmaker/recipes/rc-20261106-0001', {}, false), ctx({ id: 'rc-20261106-0001' }))).status).toBe(401);
    expect((await runs.GET(getReq('/api/studio/postmaker/runs/run-20261106-100000-abcd', {}, false), ctx({ id: 'run-20261106-100000-abcd' }))).status).toBe(401);
    expect((await media.GET(getReq(`/api/studio/postmaker/media/rc-20261106-0001/${'a'.repeat(64)}`, {}, false), ctx({ recipeId: 'rc-20261106-0001', sha: 'a'.repeat(64) }))).status).toBe(401);
  });

  it('a cross-origin POST answers 403 before anything runs, also with a valid session', async () => {
    const r = await postAction({ action: 'run.stop', runId: 'run-20261106-100000-abcd' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('forbidden');
    const up = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${P}`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'video/mp4', ...cookie() }, body: new Uint8Array(mp4()) }));
    expect(up.status).toBe(403);
    expect(existsSync(`${tmp.root}/refs`)).toBe(false);
  });
});

describe('make-it and polling', () => {
  it('answers 202 with a run id; polling reaches Proof (needs-you) on mock providers; seq strictly increases and since filters', async () => {
    const { runId, recipeId } = await makeIt();
    const v = await poll(runId, atProof);
    expect(v.run).toMatchObject({ recipeId, trigger: 'make-it', status: 'needs-you', pausedFor: 'check', finishedAt: null, spentUsd: 0 });
    expect(v.run.steps.every((s) => s.status === 'done' && s.mode === 'mock')).toBe(true);
    const seqs = v.events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(10);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(v.nextSeq).toBe(seqs.at(-1)! + 1);
    expect(v.events.at(-1)).toMatchObject({ kind: 'gate.waiting', nodeId: 'check', text: 'Proof' });
    const k = seqs[5]!;
    const later = await runView(runId, k);
    expect(later.events.map((e) => e.seq)).toEqual(seqs.filter((s) => s > k));
    expect((await runView(runId, v.nextSeq)).events).toEqual([]);
    // The recipe screen data: 20 nodes (22 with lip-sync when the pack has a face), derived status, the fa gates waiting for a named person.
    const rv = await recipeViewOf(recipeId);
    expect(rv.nodes).toHaveLength(20); // no face in the fixture options: no lip-sync nodes
    expect(rv.run!.id).toBe(runId);
    expect(rv.nodes.find((n) => n.id === 'narration-text:fa')!.gateState).toMatchObject({ kind: 'needs-sign-off' });
    expect(rv.nodes.find((n) => n.id === 'voice:fa')!.gateState).toMatchObject({ kind: 'off', fix: 'connections' });
  });

  it('Continue on a run waiting at Proof answers 409 and starts nothing', async () => {
    const { runId } = await makeIt(['en']);
    const before = await poll(runId, atProof);
    const r = await postAction({ action: 'run.continue', runId });
    expect(r.status).toBe(409);
    expect(await json<{ error: { code: string; message: string; details: { reason: string } } }>(r)).toEqual({ error: { code: 'conflict', message: AT_PROOF_TEXT, details: { reason: 'at-proof' } } });
    const after = await runView(runId);
    expect(after.run).toMatchObject({ status: 'needs-you', pausedFor: 'check' });
    expect(after.events.map((e) => e.seq)).toEqual(before.events.map((e) => e.seq));
  });

  it('the built-in even mock deconstruction also reaches Proof (no fixture)', async () => {
    // The default deconstruction is the analyse step (ffmpeg pre-processing, covered in postmaker/wiring.test.ts); the
    // guard forbids child processes here, so this route test uses the even mock structure directly.
    _setServiceDeps({ buildOptions: () => ({}), deconstruct: mockDeconstruct });
    const { runId } = await makeIt(['en']);
    expect((await poll(runId, atProof)).run.status).toBe('needs-you');
  });

  it('GET home lists the recipe, the run and the connectors', async () => {
    const { runId, recipeId } = await makeIt(['en']);
    await poll(runId, atProof);
    const r = await home.GET(getReq(`/api/studio/postmaker?project=${P}`));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await json<{ recipes: { id: string }[]; runs: { id: string }[]; connectors: unknown[]; paused: boolean }>(r);
    expect(b.recipes.map((x) => x.id)).toEqual([recipeId]);
    expect(b.runs.map((x) => x.id)).toEqual([runId]);
    expect(b.connectors.length).toBeGreaterThan(0);
    expect(b.paused).toBe(false);
  });
});

describe('proof.accept on a mock run', () => {
  it('clean accept answers 409 (mock, unsigned); Accept as draft proves the template as Draft and creates no package', async () => {
    const { runId } = await makeIt();
    await poll(runId, atProof);
    const clean = await postAction({ action: 'proof.accept', runId, asDraft: false, templateName: 'Story spine' });
    expect(clean.status).toBe(409);
    const err = (await json<{ error: { code: string; details: { reason: string; blockers: { why: string }[] } } }>(clean)).error;
    expect(err.code).toBe('conflict');
    expect(err.details.reason).toBe('accept-blocked');
    expect(err.details.blockers.map((b) => b.why)).toEqual(expect.arrayContaining(['unsigned', 'mock']));
    const draft = await postAction({ action: 'proof.accept', runId, asDraft: true, templateName: 'Story spine' });
    expect(draft.status).toBe(200);
    const b = await json<{ packageIds: string[]; template: { status: string; name: string } }>(draft);
    expect(b.packageIds).toEqual([]);
    expect(b.template).toMatchObject({ status: 'draft', name: 'Story spine' });
    expect(readdirSync(tmp.contentDir).filter((n) => /^\d{2}$/.test(n))).toEqual([]);
    expect((await runView(runId)).run).toMatchObject({ status: 'done', packageIds: [] });
  });
});

describe('a clean stub run through the routes', () => {
  it('sign the text gate, continue, sign the listening gate, accept: one ready package per language, approvable unchanged', { timeout: 30_000 }, async () => {
    _setServiceDeps({ deconstruct: fixtureDeconstruct, buildOptions: () => ({}), allowed: () => true, executors: withVerdict('premium') });
    const { runId, recipeId } = await makeIt(['fa', 'en'], 5);
    let v = await poll(runId, (x) => x.run.status !== 'running' && x.run.status !== 'queued');
    expect(v.run).toMatchObject({ status: 'needs-you', pausedFor: 'gate' });
    expect(v.run.steps.find((s) => s.nodeId === 'voice:fa')!.status).toBe('queued');
    let rv = await recipeViewOf(recipeId);
    const text = rv.nodes.find((n) => n.id === 'narration-text:fa')!;
    expect(text.gateState).toMatchObject({ kind: 'needs-sign-off' });
    // An agent-looking name is refused; a person signs the exact version.
    expect((await postAction({ action: 'gate.sign-off', recipeId, nodeId: text.id, version: text.current!.n, gate: 'fa-native-editor', name: 'language-editor', verdict: 'pass' })).status).toBe(400);
    let r = await postAction({ action: 'gate.sign-off', recipeId, nodeId: text.id, version: text.current!.n, gate: 'fa-native-editor', name: 'Editor A', verdict: 'pass' });
    expect(r.status).toBe(200);
    expect((await json<{ gate: { signed: boolean } }>(r)).gate.signed).toBe(true);
    r = await postAction({ action: 'run.continue', runId });
    expect(r.status).toBe(202);
    v = await poll(runId, atProof);
    expect(v.run.steps.every((x) => x.status === 'done')).toBe(true);
    rv = await recipeViewOf(recipeId);
    const voice = rv.nodes.find((n) => n.id === 'voice:fa')!;
    expect(voice.current!.mode).toBe('live');
    r = await postAction({ action: 'gate.sign-off', recipeId, nodeId: voice.id, version: voice.current!.n, gate: 'fa-native-listener', name: 'Editor A', verdict: 'pass' });
    expect(r.status).toBe(200);
    r = await postAction({ action: 'proof.accept', runId, asDraft: false, templateName: 'Story spine' });
    expect(r.status).toBe(200);
    const b = await json<{ packageIds: string[]; verdict: string; template: { status: string } }>(r);
    expect(b).toMatchObject({ packageIds: ['01', '02'], verdict: 'premium', template: { status: 'proven' } });
    for (const id of b.packageIds) {
      const p = await loadPackage(id);
      expect(p).toMatchObject({ status: 'ready', problems: [], postmaker: { template: 'Story spine' } });
    }
    expect((await approvePackage('02', 'owner@example.test')).status).toBe('approved');
    expect((await runView(runId)).run).toMatchObject({ status: 'done', packageIds: ['01', '02'] });
  });
});

describe('media', () => {
  it('serves only hashes this recipe references (Range supported); another recipe’s hash is 404; `..` and non-hex are 400', async () => {
    const { runId, recipeId } = await makeIt(['en']);
    await poll(runId, atProof);
    const rv = await recipeViewOf(recipeId);
    const video = rv.nodes.find((n) => n.id === 'render:en')!.current!.outputs.find((o) => o.port === 'video')!;
    const get = (rid: string, sha: string, headers: Record<string, string> = {}) => media.GET(getReq(`/api/studio/postmaker/media/${rid}/${sha}?project=${P}`, headers), ctx({ recipeId: rid, sha }));
    let r = await get(recipeId, video.sha256);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    const whole = Buffer.from(await r.arrayBuffer());
    expect(whole.length).toBe(video.bytes);
    r = await get(recipeId, video.sha256, { range: 'bytes=0-3' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 0-3/${video.bytes}`);
    expect(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(0, 4))).toBe(true);
    expect((await get(recipeId, video.sha256, { range: 'bytes=999999-' })).status).toBe(416);
    // A hash only another recipe references.
    const { recipe: other } = await createRecipe(tmp.root, PROJECT, recipeDraft(['en']), { id: 'rc-20261106-0b0b' });
    const put = await putBytes(tmp.root, 'only in the other recipe');
    await commitVersion(tmp.root, versionDraft(other.id, 'art', { outputs: [{ port: 'scenes', name: 'x.txt', kind: 'text', mime: 'text/plain', sha256: put.sha256, bytes: put.bytes }] }));
    expect((await get(recipeId, put.sha256)).status).toBe(404);
    expect((await get(other.id, put.sha256)).status).toBe(200);
    expect((await get(recipeId, 'f'.repeat(64))).status).toBe(404);
    expect((await get(recipeId, '..')).status).toBe(400);
    expect((await get(recipeId, '../../../etc/passwd')).status).toBe(400);
    expect((await get(recipeId, 'Z'.repeat(64))).status).toBe(400);
    expect((await get(recipeId, video.sha256.toUpperCase())).status).toBe(400);
    expect((await get('..', video.sha256)).status).toBe(400);
    expect((await get('rc-20261106-ffff', video.sha256)).status).toBe(404);
  });
});

describe('validation and redaction', () => {
  it('bad bodies are 400, unknown ids 404, long actions on stale tokens 409', async () => {
    const raw = await home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...cookie() }, body: '{not json' }));
    expect(raw.status).toBe(400);
    expect((await postAction({ action: 'nope' })).status).toBe(400);
    expect((await postAction({ action: 'run.stop', runId: 'run-20261106-100000-abcd', extra: true })).status).toBe(400);
    expect((await postAction({ action: 'run.stop', runId: 'run-20261106-100000-abcd' })).status).toBe(404);
    expect((await recipes.GET(getReq(`/api/studio/postmaker/recipes/..?project=${P}`), ctx({ id: '..' }))).status).toBe(400);
    expect((await recipes.GET(getReq(`/api/studio/postmaker/recipes/rc-20261106-ffff?project=${P}`), ctx({ id: 'rc-20261106-ffff' }))).status).toBe(404);
    expect((await runs.GET(getReq(`/api/studio/postmaker/runs/run-20261106-100000-abcd?since=-1&project=${P}`), ctx({ id: 'run-20261106-100000-abcd' }))).status).toBe(400);
    const { runId, recipeId } = await makeIt(['en']);
    await poll(runId, atProof);
    const stale = await postAction({ action: 'run', recipeId, scope: { all: true }, capUsd: 1, estimateToken: 'stale' });
    expect(stale.status).toBe(409);
    expect((await postAction({ action: 'template.make-post', templateId: 'tpl-20261106-abcd', brief: { topic: 'x' } })).status).toBe(404);
  });

  it('an unexpected error answers a generic 500 and never the message (paths, hosts)', async () => {
    _setServiceDeps({
      deconstruct: async () => {
        throw new Error('EACCES: permission denied, open /home/someone/private/keys.json at api.vendor.example');
      },
    });
    const ref = await upload(mp4());
    const r = await postAction({ action: 'make-it', referenceId: ref.id, options: { languages: ['en'], lengthSec: 30, shape: '9:16' } });
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: GENERIC_500, details: {} } });
    expect(text).not.toMatch(/home|someone|keys|vendor|EACCES/);
  });

  it('the references route refuses social links and non-media bodies', async () => {
    let r = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...cookie() }, body: JSON.stringify({ project: P, url: 'https://www.tiktok.com/@a/video/1' }) }));
    expect(r.status).toBe(400);
    expect((await json<{ error: { message: string } }>(r)).error.message).toBe('Download it and drop the file');
    r = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${P}`, { method: 'POST', headers: { 'content-type': 'video/mp4', origin: ORIGIN, ...cookie() }, body: '<html>not a video at all</html>' }));
    expect(r.status).toBe(400);
    r = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${P}&rights=everything`, { method: 'POST', headers: { 'content-type': 'video/mp4', origin: ORIGIN, ...cookie() }, body: new Uint8Array(mp4()) }));
    expect(r.status).toBe(400);
  });
});

describe('the postmaker feature switch', () => {
  it('while it is off, mutating actions and reference uploads answer 403 feature-off with a plain reason; reads, polling and the estimate stay open', async () => {
    const { runId, recipeId } = await makeIt(['en']);
    await poll(runId, atProof);
    writePostsConfig({ postmaker: false });
    for (const body of [{ action: 'make-it', referenceId: 'ref-x', options: { languages: ['en'], lengthSec: 30, shape: '9:16' } }, { action: 'run.stop', runId }, { action: 'step.lock', recipeId, nodeId: 'script' }, { action: 'proof.accept', runId, asDraft: true, templateName: 'x' }]) {
      const r = await postAction(body);
      expect(r.status, body.action).toBe(403);
      expect(await json(r)).toEqual({ error: { code: 'forbidden', message: POSTMAKER_OFF_TEXT, details: { reason: 'feature-off' } } });
    }
    const up = await refs.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/references?project=${P}&rights=own`, { method: 'POST', headers: { 'content-type': 'video/mp4', origin: ORIGIN, ...cookie() }, body: new Uint8Array(mp4({ seconds: 5 })) }));
    expect(up.status).toBe(403);
    expect((await home.GET(getReq(`/api/studio/postmaker?project=${P}`))).status).toBe(200);
    expect((await runs.GET(getReq(`/api/studio/postmaker/runs/${runId}?project=${P}`), ctx({ id: runId }))).status).toBe(200);
    expect((await recipes.GET(getReq(`/api/studio/postmaker/recipes/${recipeId}?project=${P}`), ctx({ id: recipeId }))).status).toBe(200);
    expect((await postAction({ action: 'estimate', recipeId, scope: { all: true } })).status).toBe(200);
  });

  it('every action in the schema except the estimate answers 403 with the plain message while it is off', async () => {
    writePostsConfig({ postmaker: false });
    const names = PostmakerActionSchema.options.map((o) => o.shape.action.value as string);
    expect(names.length).toBeGreaterThan(20);
    for (const action of names.filter((n) => n !== 'estimate')) {
      const r = await postAction({ action });
      expect(r.status, action).toBe(403);
      expect(await json(r), action).toEqual({ error: { code: 'forbidden', message: POSTMAKER_OFF_TEXT, details: { reason: 'feature-off' } } });
    }
    expect(existsSync(`${tmp.root}/recipes`)).toBe(false);
  });
});
