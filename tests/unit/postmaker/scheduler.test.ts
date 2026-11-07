// @vitest-environment node
// scheduler and runs: (≤ 3 nodes per run, ≤ 1 remotion job process-wide under 2 concurrent runs), the
// 2-runs-per-project queue, (pause for edit while a 400 ms fake step runs; Continue run),
// (crash while a fake vendor job is pending; Resume collects without a second submit).
import './guard';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetSchedulerState, connectorActive, NODES_PER_RUN, PlanExecutor, Semaphore, takeRunSlot } from '@/lib/studio/postmaker/graph/scheduler';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { openReservations } from '@/lib/studio/postmaker/store/ledger';
import { readJsonLines } from '@/lib/studio/postmaker/store/fs';
import { ledgerFile } from '@/lib/studio/postmaker/store/paths';
import type { LedgerLine } from '@/lib/studio/postmaker/types';
import { _resetEngineState, PostmakerEngine } from '@/lib/studio/postmaker/runner';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { getJson } from '@/lib/studio/postmaker/store/objects';
import { readEvents, readPending, readRun } from '@/lib/studio/postmaker/store/runs';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { ExecutorRegistry } from '@/lib/studio/postmaker/executors/types';
import type { AlignmentDoc } from '@/lib/studio/postmaker/graph/adapters';
import { PROJECT, setup } from './engine-fixtures';
import { tmp } from './guard';

afterEach(() => {
  _resetSchedulerState();
  _resetEngineState();
});

const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('PlanExecutor', () => {
  it('starts at most 3 nodes at once and only after their in-plan parents are done', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const plan = ['a', 'b', 'c', 'd', 'e', 'f'];
    const parents: Record<string, string[]> = { a: [], b: [], c: [], d: [], e: [], f: ['a', 'b'] };
    const x = new PlanExecutor(plan, {
      parents: (id) => parents[id]!,
      start: async (id) => {
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return id === 'e' ? 'failed' : 'done';
      },
    });
    const res = await x.execute();
    expect(peak).toBe(NODES_PER_RUN);
    expect(order.indexOf('f')).toBeGreaterThan(Math.max(order.indexOf('a'), order.indexOf('b')));
    expect(res.done.sort()).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(res.failed).toEqual(['e']);
  });

  it('Semaphore hands a freed slot to the waiter: an acquire between a release and the wake-up cannot over-admit', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let peak = sem.active;
    const p2 = sem.acquire().then((r) => ((peak = Math.max(peak, sem.active)), r));
    r1(); // wakes p2 on a later microtask
    let p3Done = false;
    const p3 = sem.acquire().then((r) => ((p3Done = true), (peak = Math.max(peak, sem.active)), r)); // runs before p2 wakes
    const r2 = await p2;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(p3Done).toBe(false);
    expect(sem.active).toBe(1);
    r2();
    const r3 = await p3;
    expect(sem.active).toBe(1);
    r3();
    r3(); // idempotent
    expect(sem.active).toBe(0);
    expect(peak).toBe(1);
  });

  it('a lifted edit hold lets the held node run, even after every other node finished', async () => {
    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const ran: string[] = [];
    const x = new PlanExecutor(['a', 'b'], {
      parents: (id) => (id === 'b' ? ['a'] : []),
      start: async (id) => {
        if (id === 'a') await aHeld;
        ran.push(id);
        return 'done';
      },
    });
    const running = x.execute();
    const hold = x.hold(['b']);
    expect(hold.held).toEqual(['b']);
    releaseA();
    await new Promise((r) => setTimeout(r, 10)); // a is done; nothing in flight, the edit is still open
    expect(ran).toEqual(['a']);
    hold.settle(false); // the edit was refused
    const res = await running;
    expect(ran).toEqual(['a', 'b']);
    expect(res).toMatchObject({ done: ['a', 'b'], pause: null, pausedForEdit: [], stopped: false });
  });

  it('run slots: one running run per recipe, two per project; the third waits (queued) and starts when one ends', async () => {
    const a = takeRunSlot('run-a', 'p1', 'rc-1');
    const b = takeRunSlot('run-b', 'p1', 'rc-2');
    const c = takeRunSlot('run-c', 'p1', 'rc-3');
    const d = takeRunSlot('run-d', 'p2', 'rc-4');
    const e = takeRunSlot('run-e', 'p2', 'rc-4'); // same recipe as d
    expect([a.queued, b.queued, c.queued, d.queued, e.queued]).toEqual([false, false, true, false, true]);
    let started = false;
    void c.ready.then(() => (started = true));
    await Promise.resolve();
    expect(started).toBe(false);
    a.release();
    await c.ready;
    expect(started).toBe(true);
    d.release();
    await e.ready;
    for (const s of [b, c, e]) s.release();
  });
});

describe('limits under 2 concurrent fake runs', () => {
  it('never more than 3 nodes of one run, never more than 1 remotion job process-wide', async () => {
    const peaks = { remotion: 0, run: [0, 0] };
    let remotion = 0;
    // Wrap every executor (the real narration-text one too): count nodes in flight per run, and hold each node until
    // 3 of its run are in flight (or 150 ms passed), so the limit is reached deterministically, not by timing luck.
    const instrument = (i: number, reg: ExecutorRegistry): ExecutorRegistry => {
      let active = 0;
      const out = {} as ExecutorRegistry;
      for (const [kind, ex] of Object.entries(reg) as [keyof ExecutorRegistry, ExecutorRegistry[keyof ExecutorRegistry]][]) {
        const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, connectorOf: (...a: A) => string) => async (...a: A): Promise<R> => {
          const connector = connectorOf(...a);
          active++;
          peaks.run[i] = Math.max(peaks.run[i]!, active);
          if (connector === 'remotion') peaks.remotion = Math.max(peaks.remotion, ++remotion, connectorActive('remotion'));
          try {
            const end = Date.now() + 150;
            while (active < NODES_PER_RUN && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
            return await fn(...a);
          } finally {
            active--;
            if (connector === 'remotion') remotion--;
          }
        };
        out[kind] = {
          ...ex,
          run: wrap(ex.run.bind(ex), (x) => x.connector),
          ...(ex.job ? { job: { submit: ex.job.submit, collect: wrap(ex.job.collect, (_id, x) => x.connector) } } : {}),
        };
      }
      return out;
    };
    const one = await setup({ id: 'rc-20261106-0001' });
    const two = await setup({ id: 'rc-20261106-0002' });
    const e1x = new PostmakerEngine({ root: tmp.root, project: PROJECT, executors: instrument(0, one.engine.executors), packLock: null });
    const e2x = new PostmakerEngine({ root: tmp.root, project: PROJECT, executors: instrument(1, two.engine.executors), packLock: null });
    const e1 = (await e1x.estimate(one.recipeId, { all: true })).estimate;
    const e2 = (await e2x.estimate(two.recipeId, { all: true })).estimate;
    const [h1, h2] = await Promise.all([
      e1x.run({ recipeId: one.recipeId, scope: { all: true }, estimateToken: e1.token }),
      e2x.run({ recipeId: two.recipeId, scope: { all: true }, estimateToken: e2.token }),
    ]);
    expect([h1.run.status, h2.run.status]).toEqual(['running', 'running']);
    const [r1, r2] = await Promise.all([h1.done, h2.done]);
    expect([r1.status, r2.status]).toEqual(['done', 'done']);
    expect(peaks.run).toEqual([3, 3]); // reached and never passed
    expect(peaks.remotion).toBe(1);
  });

  it('a third run in the project is queued and runs after one of the first two ends', async () => {
    const s = await Promise.all(['rc-20261106-0001', 'rc-20261106-0002', 'rc-20261106-0003'].map((id) => setup({ id, langs: ['en'], fakes: { delayMs: { art: 20 } } })));
    const hs = [];
    for (const x of s) hs.push(await x.engine.run({ recipeId: x.recipeId, scope: { all: true }, estimateToken: (await x.engine.estimate(x.recipeId, { all: true })).estimate.token }));
    expect(hs.map((h) => h.run.status)).toEqual(['running', 'running', 'queued']);
    const runs = await Promise.all(hs.map((h) => h.done));
    expect(runs.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(Date.parse(runs[2]!.finishedAt!)).toBeGreaterThan(0);
  });
});

describe('pause for edit', () => {
  it('editing voice:fa while art runs lets art finish, pauses the fa lane, the en lane continues; Continue run resumes', async () => {
    // T asks for a 3 s fake delay; the fake holds art on a promise instead, released right after the edit, so the
    // ordering is exact on a loaded CI machine.
    let releaseArt!: () => void;
    const artHeld = new Promise<void>((r) => (releaseArt = r));
    const { engine, recipeId } = await setup({ fakes: { holdUntil: (id) => (id === 'art' ? artHeld : undefined) } });
    const { estimate } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token });
    await until(async () => (await readHead(tmp.root, recipeId, 'voice:fa')).current === 1 && (await readHead(tmp.root, recipeId, 'voice:en')).current === 1);
    expect((await readHead(tmp.root, recipeId, 'art')).current).toBeNull(); // art is still running
    const v = (await readVersion(tmp.root, recipeId, 'voice:fa', 1))!;
    const a = await getJson<AlignmentDoc>(tmp.root, v.outputs.find((o) => o.port === 'alignment')!.sha256);
    const edited = { ...a, lines: a.lines.map((l, i) => (i === 0 ? { ...l, ms: l.ms + 40 } : l)) };
    const e = await engine.edit({ recipeId, nodeId: 'voice:fa', baseVersion: 1, output: { json: { alignment: edited } }, by: 'tester@example.test' });
    expect(e.paused).toEqual(expect.arrayContaining(['motion:fa', 'compose:fa', 'mix:fa', 'render:fa']));
    expect(e.paused.some((id) => id.endsWith(':en'))).toBe(false);
    releaseArt(); // art finishes after the edit
    const run = await h.done;
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'edit' });
    const step = (id: string) => run.steps.find((s) => s.nodeId === id)!;
    expect(step('art').status).toBe('done');
    for (const id of ['motion:fa', 'compose:fa', 'mix:fa', 'render:fa']) expect(step(id).status, id).toBe('queued');
    for (const id of ['voice:en', 'lipsync:en', 'motion:en', 'captions:en', 'compose:en', 'mix:en', 'render:en']) expect(step(id).status, id).toBe('done');
    const ev = (await readEvents(tmp.root, run.id)).events;
    expect(ev.find((x) => x.kind === 'run.paused')).toMatchObject({ text: 'Paused for your edit' });
    const again = await (await engine.continueRun(run.id)).done;
    expect(again.status).toBe('done');
    const m = (await readVersion(tmp.root, recipeId, 'motion:fa', 1))!;
    expect(m.inputs.find((i) => i.nodeId === 'voice:fa')).toMatchObject({ version: 2 }); // made from the edit
    expect(again.id).toBe(run.id);
  });
});

describe('Stop', () => {
  it('Stop during a paid step: the step finishes and settles at its real cost, nothing new starts, the run stays stopped', async () => {
    let releaseVoice!: () => void;
    const voiceHeld = new Promise<void>((r) => (releaseVoice = r));
    const { engine, recipeId, fakes } = await setup({
      langs: ['en'],
      fakes: { costs: { 'voice:en': { usdHigh: 0.3, actual: 0.25 } }, holdUntil: (id) => (id === 'voice:en' ? voiceHeld : undefined) },
      deps: { allowed: () => true },
    });
    const { estimate } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, capUsd: 5, estimateToken: estimate.token });
    await until(async () => fakes.counters!.runs['voice:en'] === 1);
    expect(await openReservations(tmp.root, h.run.id)).toMatchObject([{ nodeId: 'voice:en', usd: 0.3 }]);
    const stopping = await engine.stopRun(h.run.id);
    expect(stopping).toMatchObject({ status: 'stopped', finishedAt: null }); // still draining the step in progress
    releaseVoice();
    const run = await h.done;
    expect(run).toMatchObject({ status: 'stopped', pausedFor: null, spentUsd: 0.25, reservedUsd: 0 });
    expect(run.finishedAt).not.toBeNull();
    expect(run.steps.find((x) => x.nodeId === 'voice:en')).toMatchObject({ status: 'done', version: 1, usd: 0.25 });
    expect((await readHead(tmp.root, recipeId, 'voice:en')).current).toBe(1); // the paid output is kept
    expect(fakes.counters!.runs['captions:en']).toBeUndefined(); // nothing started after Stop
    expect(run.steps.find((x) => x.nodeId === 'captions:en')!.status).toBe('queued');
    const lines = await readJsonLines<LedgerLine>(ledgerFile(tmp.root));
    const reserveLine = lines.find((l) => l.t === 'reserve' && l.nodeId === 'voice:en')!;
    expect(lines.filter((l) => 'id' in l && l.id === reserveLine.id && l.t !== 'reserve')).toMatchObject([{ t: 'settle', usd: 0.25, known: true }]);
    expect(await openReservations(tmp.root, run.id)).toEqual([]);
    const ev = (await readEvents(tmp.root, run.id)).events;
    expect(ev.some((e) => e.kind === 'step.failed')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ kind: 'run.done', text: 'stopped' });
  });

  it('Stop after a crash with a submitted vendor job settles that reservation at its upper bound (it may be billed)', async () => {
    let runId = '';
    const s = await setup({ langs: ['en'], fakes: { costs: { 'lipsync:en': { usdHigh: 0.5, actual: 0.4 } } }, deps: { allowed: () => true } });
    s.fakes.onSubmitted = (nodeId) => {
      if (nodeId === 'lipsync:en') s.engine._crash(runId);
    };
    const { estimate } = await s.engine.estimate(s.recipeId, { all: true });
    const h = await s.engine.run({ recipeId: s.recipeId, scope: { all: true }, capUsd: 5, estimateToken: estimate.token });
    runId = h.run.id;
    await h.done;
    _resetSchedulerState();
    _resetEngineState();
    const engine = new PostmakerEngine({ root: tmp.root, project: PROJECT, executors: defaultExecutors({ fakes: { ...s.fakes, onSubmitted: undefined } }), packLock: null, allowed: () => true });
    expect(await engine.recoverInterrupted()).toEqual([runId]);
    const run = await engine.stopRun(runId);
    expect(run).toMatchObject({ status: 'stopped', spentUsd: 0.5, reservedUsd: 0 });
    const lines = await readJsonLines<LedgerLine>(ledgerFile(tmp.root));
    const r = lines.find((l) => l.t === 'reserve' && l.nodeId === 'lipsync:en')!;
    expect(lines.find((l) => l.t === 'settle' && l.id === r.id)).toMatchObject({ usd: 0.5, known: false });
    expect(lines.some((l) => l.t === 'release' && l.id === r.id)).toBe(false);
    expect(await openReservations(tmp.root, runId)).toEqual([]);
  });

  it('a refused edit during a run (stale base version) does not hold or pause the run', async () => {
    let releaseArt!: () => void;
    const artHeld = new Promise<void>((r) => (releaseArt = r));
    const { engine, recipeId } = await setup({ langs: ['en'], fakes: { holdUntil: (id) => (id === 'art' ? artHeld : undefined) } });
    const { estimate } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token });
    await until(async () => (await readHead(tmp.root, recipeId, 'voice:en')).current === 1);
    const err = await engine.edit({ recipeId, nodeId: 'voice:en', baseVersion: 7, output: { json: {} }, by: 'tester@example.test' }).catch((e: unknown) => e);
    expect(isPostmakerError(err, 'conflict')).toBe(true);
    releaseArt();
    const run = await h.done;
    expect(run).toMatchObject({ status: 'done', pausedFor: null });
    const ev = (await readEvents(tmp.root, run.id)).events;
    expect(ev.some((e) => e.kind === 'run.paused')).toBe(false);
  });
});

describe('crash recovery', () => {
  it('a process kill while a fake vendor job is pending, then Resume, collects the result without a second submit', async () => {
    let runId = '';
    const s = await setup({});
    const fakes = s.fakes;
    fakes.onSubmitted = (nodeId) => {
      if (nodeId === 'lipsync:fa') s.engine._crash(runId);
    };
    const { estimate } = await s.engine.estimate(s.recipeId, { all: true });
    const h = await s.engine.run({ recipeId: s.recipeId, scope: { all: true }, estimateToken: estimate.token });
    runId = h.run.id;
    await h.done;
    expect(fakes.counters!.submits['lipsync:fa']).toBe(1);
    expect((await readPending(tmp.root, s.recipeId, 'lipsync:fa'))!.jobs).toHaveLength(1);
    expect((await readRun(tmp.root, runId))!.status).toBe('running'); // nothing was written after the kill

    // restart: a new process (fresh slots, fresh controllers), same content folder
    _resetSchedulerState();
    _resetEngineState();
    fakes.onSubmitted = undefined;
    const engine = new PostmakerEngine({ root: tmp.root, project: PROJECT, executors: defaultExecutors({ fakes }), packLock: null });
    expect(await engine.recoverInterrupted()).toEqual([runId]);
    const failed = (await readRun(tmp.root, runId))!;
    expect(failed.status).toBe('failed');
    expect(failed.steps.find((x) => x.nodeId === 'lipsync:fa')).toMatchObject({ status: 'failed', error: 'Signal stopped while this run was going' });
    expect((await readEvents(tmp.root, runId)).events.at(-1)).toMatchObject({ kind: 'run.done', text: 'Signal stopped while this run was going' });
    const done = await (await engine.resume(runId)).done;
    expect(done.status).toBe('done');
    expect(fakes.counters!.submits['lipsync:fa']).toBe(1); // no second submit
    expect(fakes.counters!.collects['lipsync:fa']).toBe(2);
    expect((await readPending(tmp.root, s.recipeId, 'lipsync:fa'))!.jobs).toEqual([]);
    const v = (await readVersion(tmp.root, s.recipeId, 'lipsync:fa', 1))!;
    expect(v.provenance.requests[0]!.id).toBe('fake-lipsync-fa-1');
  });
});
