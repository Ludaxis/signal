// @vitest-environment node
// The Proof slice on fakes: the fixture pack built from
// tests/fixtures/postmaker/pack-example, the synthetic 10 s reference dropped through the upload path, `make-it`
// through the service to Proof, then regenerate, regenerate from here, edit, lock, use-version, the contract diff
// and cache hits. Covers and the network half of.
// Real local tools where CI has them: analyse pre-processing with the bundled ffmpeg, the Persian
// narration-text step, script and post-copy in mock mode, check, render chain on the fake 2-frame
// renderer. Every connector is off, so every node runs as mock. The network guard is on and its log must stay empty;
// only the bundled ffmpeg may be spawned (to make and read the synthetic reference).
import child_process from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import type { ScriptDoc } from '@/lib/studio/postmaker/graph/adapters';
import { fakeRenderChain, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import { _setServiceDeps, engineFor, handleAction, rootOf, type ServiceProject } from '@/lib/studio/postmaker/service';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { getJson } from '@/lib/studio/postmaker/store/objects';
import { readPackLock } from '@/lib/studio/postmaker/store/recipes';
import { readEvents } from '@/lib/studio/postmaker/store/runs';
import { listVersionNumbers } from '@/lib/studio/postmaker/store/versions';
import type { PostmakerAction, Run, Scope } from '@/lib/studio/postmaker/types';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { networkGuardLog, tmp } from './guard';
import './connectors/env';
import { fixtureBuilders, laneOf, SLICE_NODES, sliceExecutors, sliceFixture, sliceProject, sliceVoice, templateDeconstruct, uploadReference, waitForRun } from './slice-harness';

const realSpawn = child_process.spawn;
const FFMPEG = ffmpegStatic as string;
const allowFfmpeg = ((bin: string, args: string[], opts: object) => {
  if (bin !== FFMPEG) throw new Error(`spawn of ${bin} is not allowed here`);
  return realSpawn(bin, args, opts);
}) as unknown as Spawn;

vi.setConfig({ testTimeout: 30_000 });

const shared = { dir: '', pack: '', ref: '' };
beforeAll(async () => {
  shared.dir = mkdtempSync(path.join(os.tmpdir(), 'signal-slice-'));
  const { buildPack, makeRef } = await fixtureBuilders();
  shared.pack = (await buildPack(path.join(shared.dir, 'pack'))).dir;
  shared.ref = await makeRef({ out: path.join(shared.dir, 'ref-9x16-10s.mp4'), ffmpeg: FFMPEG, spawn: allowFfmpeg });
}, 60_000);
afterAll(() => rmSync(shared.dir, { recursive: true, force: true }));
afterEach(() => {
  _setServiceDeps({});
  expect(networkGuardLog()).toEqual([]); //: nothing tried the network or a vendor binary
});

const actor = { email: 'slice@example.test' };

interface Slice {
  project: ServiceProject;
  root: string;
  recipeId: string;
  run: Run;
  voice: ReturnType<typeof sliceVoice>;
  chain: RenderChain & { calls: number };
  act: (a: PostmakerAction) => Promise<Record<string, unknown>>;
  confirmed: (a: PostmakerAction & { estimateToken: string }, scope: Scope) => Promise<{ first: boolean; run: Run }>;
  /** Starts a long action and waits for its run to stop. */
  long: (a: PostmakerAction) => Promise<Run>;
  versions: (ids?: string[]) => Promise<Record<string, number | null>>;
}

/** Drops the reference and presses Make it (the service, as the API calls it); resolves at Proof. */
async function makeIt(): Promise<Slice> {
  const project = sliceProject(tmp.dir, shared.pack);
  const root = rootOf(project);
  const fixture = sliceFixture();
  const voice = sliceVoice(fixture);
  const base = fakeRenderChain();
  const chain = { id: base.id, calls: 0, run: (t, o) => (chain.calls++, base.run(t, o)) } as RenderChain & { calls: number };
  _setServiceDeps({
    executors: sliceExecutors({ root, project, render: chain, fakes: { counters: newCounters(), voiceMs: voice.fn }, renderDeps: { ffmpeg: null, workDir: (r, n) => path.join(tmp.dir, 'work', r, n.replace(/:/g, '-')) } }),
    deconstruct: templateDeconstruct({ root, tools: { ffmpeg: FFMPEG, ffprobe: null, spawn: allowFfmpeg }, workDir: path.join(tmp.dir, 'analyse'), fixture }),
  });
  const act = async (a: PostmakerAction) => (await handleAction(project, actor, a)).body;
  const long = async (a: PostmakerAction) => {
    const r = await handleAction(project, actor, a);
    expect(r.status).toBe(202);
    return waitForRun(root, (r.body as { runId: string }).runId);
  };
  /**
   * The UI's confirm flow: the API estimate with the action's own options (a regenerate is `exact`
   * on its node, from-here is `fromHere`), then the action with its token, in one step. A 409 estimate-changed is
   * left only for an estimate that genuinely changed in between; the person then confirms the fresh one.
   */
  const confirmed = async (a: PostmakerAction & { estimateToken: string }, scope: Scope) => {
    const recipeId = (a as { recipeId: string }).recipeId;
    const nodeId = (a as { nodeId?: string }).nodeId;
    const opts = a.action === 'step.regenerate' ? { nodeId, exact: true } : a.action === 'step.regenerate-from-here' ? { nodeId, fromHere: true } : { scope };
    const est = (await act({ action: 'estimate', recipeId, ...opts } as PostmakerAction)) as { estimate: { token: string } };
    try {
      return { first: true, run: await long({ ...a, estimateToken: est.estimate.token } as PostmakerAction) };
    } catch (e) {
      if (!isPostmakerError(e, 'estimate-changed')) throw e;
      const fresh = (e as unknown as { estimate: { token: string } }).estimate.token;
      return { first: false, run: await long({ ...a, estimateToken: fresh } as PostmakerAction) };
    }
  };
  const ref = await uploadReference(root, project, shared.ref);
  const started = await handleAction(project, actor, { action: 'make-it', referenceId: ref.id, options: { languages: ['fa', 'en'], lengthSec: 30, shape: '9:16' } });
  expect(started.status).toBe(202);
  const { runId, recipeId } = started.body as { runId: string; recipeId: string };
  const run = await waitForRun(root, runId);
  const versions = async (ids = SLICE_NODES) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await readHead(root, recipeId, id)).current] as const)));
  return { project, root, recipeId, run, voice, chain, act, long, confirmed, versions };
}

const engineOf = async (s: Slice) => (await engineFor(s.project)).engine;
const expect409 = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(isPostmakerError(e, code), String(e)).toBe(true);
  return e as Error & { blockers?: { nodeId: string | null; why: string }[] };
};

describe('make-it with mock providers reaches Proof with no other click', () => {
  it('20 nodes done, all mock, $0; it waits at Proof; Accept as draft is offered, a clean Accept is not', async () => {
    const s = await makeIt();
    expect(s.run).toMatchObject({ trigger: 'make-it', status: 'needs-you', pausedFor: 'check', spentUsd: 0, packageIds: [] });
    expect(s.run.steps.map((x) => x.nodeId).sort()).toEqual([...SLICE_NODES].sort());
    expect(s.run.steps.every((x) => x.status === 'done' && x.mode === 'mock')).toBe(true);
    const { events } = await readEvents(s.root, s.run.id);
    expect(events.at(-1)).toMatchObject({ kind: 'gate.waiting', nodeId: 'check', text: 'Proof' });
    const engine = await engineOf(s);
    const st = await engine.status(s.recipeId);
    expect(Object.keys(st).sort()).toEqual([...SLICE_NODES].sort()); // no lip-sync, no b-roll
    expect(Object.values(st).every((x) => x.status === 'done' && !x.outOfDate)).toBe(true);
    // The 30 s cut: the template's slice-30 boundaries hold on the composed timeline (900 frames).
    const state = await engine.state(s.recipeId);
    expect(state.current['motion:fa']!.provides.beatFrames).toEqual({ b01: [0, 180], b02: [180, 312], b03: [312, 372], b04: [372, 522], b05: [522, 630], b06: [630, 702], b07: [702, 900] });
    for (const lang of ['fa', 'en']) expect(state.current[`compose:${lang}`]!.provides.totalFrames).toBe(900);
    // The default chain ran the creative executors on the pack, not their fakes.
    expect(state.current.art!.implVersion).toBe('art@1');
    expect(state.current.music!.implVersion).toBe('music@1');
    for (const lang of ['fa', 'en']) {
      expect(state.current[`motion:${lang}`]!.implVersion).toBe('motion@2');
      expect(state.current[`mix:${lang}`]!.implVersion).toBe('mix@4');
    }
    const grid = await getJson<{ source: string; bpm: number; track: { assetId: string | null } }>(s.root, state.current.music!.outputs.find((o) => o.port === 'beatGrid')!.sha256);
    expect(grid).toMatchObject({ source: 'library', bpm: 100, track: { assetId: 'music-loop-100' } });
    // The demo swipe runs through the pack phone frame's own UI targets.
    const motion = await getJson<{ compiled: { swipes: { targets: { id: string }[] }[] } }>(s.root, state.current['motion:en']!.outputs.find((o) => o.port === 'motion')!.sha256);
    expect(motion.compiled.swipes.flatMap((w) => w.targets.map((x) => x.id))).toEqual(['tile-1', 'tile-2']);
    // Compose hands StorySpine the compiled characters, the Tier A rig and the scene backgrounds.
    for (const lang of ['fa', 'en']) {
      const tl = await getJson<Timeline>(s.root, state.current[`compose:${lang}`]!.outputs.find((o) => o.port === 'timeline')!.sha256);
      const lead = tl.motion!.characters.filter((c) => c.charId === 'char-cutout');
      expect(lead.length).toBeGreaterThan(0);
      expect(lead.every((c) => c.loops.includes('breath') && c.loops.includes('blink'))).toBe(true);
      expect(lead.some((c) => c.gestures.length > 0)).toBe(true);
      expect(tl.characters!.cast.map((c) => [c.charId, c.tier, Boolean(c.rig), Boolean(c.still)])).toEqual([['char-cutout', 'A', true, false], ['char-elder', 'B', false, true]]);
      expect(tl.elements.filter((e) => e.kind === 'scene').every((e) => e.kind === 'scene' && e.image?.startsWith('art/'))).toBe(true);
      expect(tl.art!.every((f) => /^art\/[0-9a-f]{64}\.(png|svg)$/.test(f.src) && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    }
    // The pack was read: the pack lock names the fixture pack and its template.
    const lock = await readPackLock(s.root);
    expect(lock).toMatchObject({ packId: 'example-word-game' });
    expect(Object.keys(lock!.entries)).toEqual(expect.arrayContaining(['template:pov-story-spine', 'lexicon:fa', 'glossary', 'style:fa', 'voice:mock-narrator-fa', 'asset:music-loop-100', 'font:Vazirmatn', 'font:Instrument Sans']));
    // Clean Accept is refused (mock steps and unsigned Persian gates); Accept as draft works and writes no package.
    const blocked = await expect409(s.act({ action: 'proof.accept', runId: s.run.id, asDraft: false, templateName: 'POV story' }), 'accept-blocked');
    expect(blocked.blockers?.filter((b) => b.why === 'unsigned').map((b) => b.nodeId)).toEqual(['narration-text:fa', 'voice:fa']);
    expect(blocked.blockers?.some((b) => b.why === 'mock')).toBe(true);
    const draft = await s.act({ action: 'proof.accept', runId: s.run.id, asDraft: true, templateName: 'POV story' });
    expect(draft).toMatchObject({ asDraft: true, packageIds: [] });
    expect((draft.template as { status: string }).status).toBe('draft');
  });
});

describe('regenerate a voice take and regenerate from here', () => {
  it('a take of l03 5 % longer keeps motion:fa current (retimed) and leaves the en lane untouched', async () => {
    const s = await makeIt();
    const before = await s.versions();
    s.voice.scale['l03:fa'] = 1.05;
    const r = await (await engineOf(s)).regenerate({ recipeId: s.recipeId, nodeId: 'voice:fa', mode: 'keep-contracts', beats: ['b02'] });
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    // Retimed by the free adapters: motion.retimeHolds, captions.recompute, compose.rebuild.
    expect(r.adapted).toEqual(['motion:fa', 'captions:fa', 'compose:fa']);
    // Out of date: render:fa, plus what the later wiring added (mix reads the voice stems; post-copy reads
    // the composed timeline) and the check. Nothing in the en lane, nothing shared upstream.
    expect(r.outOfDate.sort()).toEqual(['check', 'mix:fa', 'post-copy:fa', 'render:fa']);
    const after = await s.versions();
    for (const id of SLICE_NODES) expect(after[id], id).toBe(['voice:fa', 'motion:fa', 'captions:fa', 'compose:fa'].includes(id) ? before[id]! + 1 : before[id]);
    const engine = await engineOf(s);
    const st = await engine.status(s.recipeId);
    expect(st['motion:fa']!.outOfDate).toBe(false);
    expect((await engine.state(s.recipeId)).current['motion:fa']!.provides.beatFrames).toMatchObject({ b02: [180, 318] }); // +6 frames for the longer take
    for (const id of laneOf('en')) expect(st[id]!.outOfDate, id).toBe(false);
  });

  it('Regenerate from here on motion:fa re-renders fa only; en nodes keep their versions', async () => {
    const s = await makeIt();
    const before = await s.versions();
    const calls = s.chain.calls;
    const { run, first } = await s.confirmed({ action: 'step.regenerate-from-here', recipeId: s.recipeId, nodeId: 'motion:fa', capUsd: 0, estimateToken: '' }, { from: 'motion:fa' });
    expect(first).toBe(true); // one-step confirm
    expect(run.trigger).toBe('regenerate-from-here');
    expect(run.scope.nodes).toEqual(expect.arrayContaining(['motion:fa', 'compose:fa', 'mix:fa', 'render:fa']));
    expect(run.scope.nodes.filter((n) => n.endsWith(':en'))).toEqual([]);
    expect(run.status === 'needs-you' && run.pausedFor === 'check').toBe(true); // back at Proof
    const after = await s.versions();
    expect(after['motion:fa']).toBe(before['motion:fa']! + 1);
    expect(after['render:fa']).toBe(before['render:fa']! + 1);
    for (const id of [...laneOf('en'), 'script', 'art', 'music', 'narration-text:fa', 'voice:fa']) expect(after[id], id).toBe(before[id]);
    expect(s.chain.calls).toBeGreaterThan(calls); // the fa render ran again
  });
});

describe('contract diff on voice:fa (on the slice)', () => {
  it('a take of l03 20 % longer is a contract break: the diff names lineMs.l03 and beatFrames.b02, no head moves, the candidate can be discarded', async () => {
    const s = await makeIt();
    const before = await s.versions();
    s.voice.scale['l03:fa'] = 1.2;
    const r = await (await engineOf(s)).regenerate({ recipeId: s.recipeId, nodeId: 'voice:fa', mode: 'keep-contracts' });
    expect(r.outcome).toBe('contract-break');
    if (r.outcome !== 'contract-break') return;
    expect(r.diff.map((d) => d.key)).toEqual(expect.arrayContaining(['lineMs.l03', 'beatFrames.b02']));
    expect(r.diff.find((d) => d.key === 'lineMs.l03')).toMatchObject({ from: 3966, to: 4759 });
    expect(await s.versions()).toEqual(before);
    const c = await s.act({ action: 'step.choose-candidate', recipeId: s.recipeId, nodeId: 'voice:fa', version: r.candidate, accept: false });
    expect((c.head as { current: number }).current).toBe(before['voice:fa']);
    expect(await listVersionNumbers(s.root, s.recipeId, 'voice:fa')).toEqual([1, 2]);
  });
});

describe('lock music, then edit the script CTA', () => {
  it('re-runs post-copy, captions, compose, mix and render in both lanes and never music', async () => {
    const s = await makeIt();
    await s.act({ action: 'step.lock', recipeId: s.recipeId, nodeId: 'music' });
    await expect409(s.act({ action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'music', mode: 'keep-contracts', estimateToken: 'x' }), 'locked');
    const engine = await engineOf(s);
    const v = (await engine.state(s.recipeId)).current.script!;
    const doc = await getJson<ScriptDoc>(s.root, v.outputs.find((o) => o.port === 'script')!.sha256);
    const edit = await s.act({ action: 'step.edit', recipeId: s.recipeId, nodeId: 'script', baseVersion: v.n, output: { json: { script: { ...doc, cta: { fa: 'امشب بازی کن', en: 'Play tonight' } } } } });
    expect(edit.version).toMatchObject({ source: 'edit', editedByUser: true });
    const st = await engine.status(s.recipeId);
    expect(st.music).toMatchObject({ outOfDate: false, lockedButChanged: true });
    const before = await s.versions();
    const { run } = await s.confirmed({ action: 'run', recipeId: s.recipeId, scope: { all: true }, capUsd: 0, estimateToken: '' }, { all: true });
    expect(run.status === 'needs-you' && run.pausedFor === 'check').toBe(true);
    const ran = run.steps.map((x) => x.nodeId);
    for (const k of ['post-copy', 'captions', 'compose', 'mix', 'render']) for (const l of ['fa', 'en']) expect(ran, `${k}:${l}`).toContain(`${k}:${l}`);
    expect(ran).not.toContain('music');
    expect((await s.versions()).music).toBe(before.music);
    expect(await listVersionNumbers(s.root, s.recipeId, 'music')).toEqual([1]);
    expect((await engine.state(s.recipeId)).current['post-copy:fa']!.provides.cta).toEqual({ fa: 'امشب بازی کن' });
    // An edited step is not overwritten silently: regenerate needs overwriteEdit.
    await expect409(s.act({ action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'script', mode: 'keep-contracts', estimateToken: 'x' }), 'edited');
  });
});

describe('and cache hits', () => {
  it('a second run with nothing changed creates no version and finishes in under 5 s without rendering', async () => {
    const s = await makeIt();
    const before = await s.versions();
    const calls = s.chain.calls;
    const t0 = Date.now();
    const { estimate, plan } = (await s.act({ action: 'estimate', recipeId: s.recipeId, scope: { all: true } })) as { estimate: { token: string }; plan: string[] };
    expect(plan).toEqual([]);
    const run = await s.long({ action: 'run', recipeId: s.recipeId, scope: { all: true }, capUsd: 0, estimateToken: estimate.token });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(run.steps).toEqual([]);
    expect(await s.versions()).toEqual(before);
    expect(s.chain.calls).toBe(calls);
  });

  it('use-version back to the first take: the deterministic steps whose inputs are known again are cache hits', async () => {
    const s = await makeIt();
    const first = await s.versions(laneOf('en'));
    const regen = await s.confirmed({ action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'voice:en', mode: 'allow-breaks', estimateToken: '' }, { nodes: ['voice:en'] });
    expect(regen.first).toBe(true); // the estimate takes the regenerate's options, so its token holds the first time
    await s.confirmed({ action: 'run', recipeId: s.recipeId, scope: { all: true }, capUsd: 0, estimateToken: '' }, { all: true });
    const second = await s.versions(laneOf('en'));
    expect(second['voice:en']).toBe(2);
    expect(second['captions:en']).toBe(2);
    await s.act({ action: 'step.use-version', recipeId: s.recipeId, nodeId: 'voice:en', version: 1 });
    expect((await s.versions(['voice:en']))['voice:en']).toBe(1);
    const { run } = await s.confirmed({ action: 'run', recipeId: s.recipeId, scope: { all: true }, capUsd: 0, estimateToken: '' }, { all: true });
    const hits = (await readEvents(s.root, run.id)).events.filter((e) => e.kind === 'cache.hit').map((e) => e.nodeId);
    expect(hits).toContain('captions:en'); // same inputs as its version 1: reused, not re-made
    expect(await listVersionNumbers(s.root, s.recipeId, 'captions:en')).toEqual([1, 2]);
    const third = await s.versions(laneOf('en'));
    expect(third).toMatchObject({ 'narration-text:en': first['narration-text:en'], 'voice:en': 1, 'captions:en': 1 });
    for (const id of laneOf('fa')) expect(run.steps.map((x) => x.nodeId), id).not.toContain(id); // the fa lane is untouched
  });
});
