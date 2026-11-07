// @vitest-environment node
// Engine completions: `run.pause` then `run.continue` finishes with no node run twice
// (event log); the engine part (an edit during a run pauses later steps, Continue resumes) is pinned in
// scheduler.test.ts. Fake executors only; the network guard stays on.
import './guard';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { readEvents } from '@/lib/studio/postmaker/store/runs';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { setup } from './engine-fixtures';
import { tmp } from './guard';

afterEach(() => {
  _resetSchedulerState();
  _resetEngineState();
});

const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('run.pause, then run.continue', () => {
  it('Pause lets the steps in progress finish, starts nothing new, waits as "Paused"; Continue finishes with no step run twice', async () => {
    let releaseArt!: () => void;
    const artHeld = new Promise<void>((r) => (releaseArt = r));
    const { engine, recipeId, fakes } = await setup({ langs: ['en'], fakes: { holdUntil: (id) => (id === 'art' ? artHeld : undefined) } });
    const { estimate, plan } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token });
    await until(() => fakes.counters!.runs['art'] === 1);
    const pausing = await engine.pauseRun(h.run.id);
    expect(pausing.status).toBe('running'); // the step in progress is still going
    releaseArt();
    const paused = await h.done;
    expect(paused).toMatchObject({ status: 'needs-you', pausedFor: 'paused', finishedAt: null });
    const step = (id: string) => paused.steps.find((s) => s.nodeId === id)!;
    expect(step('art').status).toBe('done'); // the step in progress finished and kept its version
    const left = paused.steps.filter((s) => s.status === 'queued').map((s) => s.nodeId);
    expect(left.length).toBeGreaterThan(0);
    expect(left).toContain('check');
    const mid = (await readEvents(tmp.root, h.run.id)).events;
    expect(mid.filter((e) => e.kind === 'run.paused').at(-1)).toMatchObject({ text: 'Paused', data: { pausedFor: 'paused' } });
    // a paused run answers as it is; Continue resumes under the same id
    expect((await engine.pauseRun(h.run.id)).pausedFor).toBe('paused');
    const done = await (await engine.continueRun(h.run.id)).done;
    expect(done).toMatchObject({ id: h.run.id, status: 'done', pausedFor: null });
    const events = (await readEvents(tmp.root, h.run.id)).events;
    const started = events.filter((e) => e.kind === 'step.started').map((e) => e.nodeId!);
    expect(new Set(started).size).toBe(started.length); // no node ran twice
    expect([...started].sort()).toEqual([...plan].sort()); // and every planned node ran once
    for (const id of plan) expect(fakes.counters!.runs[id] ?? 0, id).toBeLessThanOrEqual(1);
    expect(done.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('a Pause while the run waits for a run slot starts nothing; finished and unknown runs are refused', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await expect(engine.pauseRun('run-20261106-100000-abcd')).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'not_found'));
    const { estimate } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token });
    await engine.pauseRun(h.run.id); // before any step had a chance to start
    const paused = await h.done;
    expect(paused).toMatchObject({ status: 'needs-you', pausedFor: 'paused' });
    const done = await (await engine.continueRun(h.run.id)).done;
    expect(done.status).toBe('done');
    await expect(engine.pauseRun(h.run.id)).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'finished'));
  });
});
