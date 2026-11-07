// Runs: runs/<runId>/run.json (replaced as the run moves) and events.jsonl (append-only, one line per event
// with a monotonic `seq` the polling API reads from). Also the per-node pending.json for crash recovery.
import { PostmakerError } from '../errors';
import type { EventLine, PendingJobs, Run } from '../types';
import { appendLine, checkSchema, listDir, pretty, readJsonFile, readJsonLines, writeOnce, writeReplace } from './fs';
import { withLock } from './mutex';
import { assertRunId, eventsFile, pendingFile, runFile, RUN_ID_RE } from './paths';
import path from 'node:path';

export const RUN_SCHEMA = 'signal.pm.run/1' as const;

const runLock = (root: string, id: string) => `pm-run:${runFile(root, id)}`;

function validRun(run: Run): void {
  checkSchema(run, 'run', 1);
  assertRunId(run.id);
  for (const k of ['capUsd', 'spentUsd', 'reservedUsd'] as const) {
    if (!Number.isFinite(run[k]) || run[k] < 0) throw new PostmakerError(400, 'validation', `${k} must be a number ≥ 0.`);
  }
}

/** Writes a new run; refuses an id that already exists. */
export async function createRun(root: string, run: Run): Promise<Run> {
  validRun(run);
  await writeOnce(runFile(root, run.id), pretty(run));
  return run;
}

export async function readRun(root: string, id: string): Promise<Run | null> {
  const run = await readJsonFile<Run>(runFile(root, id));
  if (!run) return null;
  checkSchema(run, 'run', 1);
  if (run.id !== id) throw new PostmakerError(409, 'version-changed', 'run.json does not match its folder.');
  return run;
}

/** Read-modify-write of run.json under the run's lock. */
export function updateRun(root: string, id: string, change: (run: Run) => Run): Promise<Run> {
  return withLock(runLock(root, id), async () => {
    const run = await readRun(root, id);
    if (!run) throw new PostmakerError(404, 'not_found', 'Unknown run.');
    const next = change(run);
    if (next.id !== id) throw new PostmakerError(400, 'validation', 'A run cannot change its id.');
    validRun(next);
    await writeReplace(runFile(root, id), pretty(next));
    return next;
  });
}

export async function listRunIds(root: string): Promise<string[]> {
  return (await listDir(path.join(root, 'runs'))).filter((f) => RUN_ID_RE.test(f)).sort();
}

// ---- events ----------------------------------------------------------------------------------------------------

export type StoredEvent = EventLine & { seq: number };
const lastSeq = new Map<string, number>();

/** Appends one event and returns its `seq` (1, 2, 3, … per run, never reused, also after a restart). */
export function appendEvent(root: string, runId: string, event: EventLine): Promise<number> {
  const file = eventsFile(root, runId);
  return withLock(`pm-events:${file}`, async () => {
    let seq = lastSeq.get(file);
    if (seq === undefined) {
      seq = 0;
      for (const e of await readJsonLines<StoredEvent>(file)) if (Number.isInteger(e.seq) && e.seq > seq) seq = e.seq;
    }
    seq += 1;
    await appendLine(file, JSON.stringify({ seq, ...event }));
    lastSeq.set(file, seq);
    return seq;
  });
}

/** Events with `seq > after`, in order, and the `nextSeq` to poll from. */
export async function readEvents(root: string, runId: string, after = 0): Promise<{ events: StoredEvent[]; nextSeq: number }> {
  const all = (await readJsonLines<StoredEvent>(eventsFile(root, runId))).filter((e) => Number.isInteger(e.seq));
  all.sort((a, b) => a.seq - b.seq);
  const events = all.filter((e) => e.seq > after);
  return { events, nextSeq: (all.at(-1)?.seq ?? 0) + 1 };
}

/** Test hook: forget the in-memory seq cache (simulates a restart). */
export const _forgetEventSeqs = () => lastSeq.clear();

// ---- pending vendor jobs -----------------------------------------------------------------------------------------

export async function writePending(root: string, recipeId: string, nodeId: string, pending: PendingJobs): Promise<void> {
  checkSchema(pending, 'pending', 1);
  if (pending.nodeId !== nodeId) throw new PostmakerError(400, 'validation', 'pending.json belongs to another step.');
  await writeReplace(pendingFile(root, recipeId, nodeId), pretty(pending));
}

export async function readPending(root: string, recipeId: string, nodeId: string): Promise<PendingJobs | null> {
  const p = await readJsonFile<PendingJobs>(pendingFile(root, recipeId, nodeId));
  if (!p) return null;
  checkSchema(p, 'pending', 1);
  return p;
}
