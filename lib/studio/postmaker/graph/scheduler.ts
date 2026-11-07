// The run scheduler: walks a planned node set in dependency order with at most 3 nodes of one run at
// once, process-wide per-connector semaphores, at most one running run per recipe and 2 per project (a further run
// waits, `status: 'queued'`), and pause rules: pause-for-edit holds every not-yet-started descendant of an edited node
// while the node in progress finishes; a cap or gate pause stops new starts. All shared state lives on globalThis so it
// survives module duplication across bundles (the autopilot `locks()` pattern).
import { CONNECTOR_LIMITS, semaphoreKey } from './kinds';

export const NODES_PER_RUN = 3;
export const RUNS_PER_PROJECT = 2;

// ---- semaphores ------------------------------------------------------------------------------------------------

/**
 * A counting semaphore that hands a freed slot straight to the next waiter: `active` is not decremented while someone
 * waits, so an `acquire()` that runs between a release and the waiter's continuation cannot take the slot too.
 */
export class Semaphore {
  active = 0;
  private waiters: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((r) => this.waiters.push(r)); // the releaser kept `active` for us
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

type G = typeof globalThis & {
  __signalPostmakerSemaphores?: Map<string, Semaphore>;
  __signalPostmakerRuns?: RunSlots;
};

const semaphores = () => ((globalThis as G).__signalPostmakerSemaphores ??= new Map());

/** Holds the connector's process-wide slot (unlimited for connectors without a row, e.g. `mock`, `local`). */
export async function acquireConnector(connector: string): Promise<() => void> {
  const key = semaphoreKey(connector);
  const limit = CONNECTOR_LIMITS[key];
  if (limit === undefined) return () => undefined;
  let s = semaphores().get(key);
  if (!s) semaphores().set(key, (s = new Semaphore(limit)));
  return s.acquire();
}

export const connectorActive = (connector: string): number => semaphores().get(semaphoreKey(connector))?.active ?? 0;

// ---- run slots -------------------------------------------------------------------------------------------------

interface RunSlots {
  running: Map<string, { projectId: string; recipeId: string }>;
  waiting: { runId: string; projectId: string; recipeId: string; go: () => void }[];
}

const slots = (): RunSlots => ((globalThis as G).__signalPostmakerRuns ??= { running: new Map(), waiting: [] });

function fits(s: RunSlots, projectId: string, recipeId: string): boolean {
  let perProject = 0;
  for (const r of s.running.values()) {
    if (r.recipeId === recipeId) return false;
    if (r.projectId === projectId) perProject += 1;
  }
  return perProject < RUNS_PER_PROJECT;
}

function pump(s: RunSlots): void {
  for (let i = 0; i < s.waiting.length; ) {
    const w = s.waiting[i]!;
    if (fits(s, w.projectId, w.recipeId)) {
      s.waiting.splice(i, 1);
      s.running.set(w.runId, { projectId: w.projectId, recipeId: w.recipeId });
      w.go();
    } else i += 1;
  }
}

/**
 * Takes a run slot. `queued` is true when the run must wait (the caller writes `status: 'queued'`); `ready` resolves
 * when the slot is held. `release` frees it (idempotent) and starts the next waiting run that fits.
 */
export function takeRunSlot(runId: string, projectId: string, recipeId: string): { queued: boolean; ready: Promise<void>; release: () => void } {
  const s = slots();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    s.running.delete(runId);
    s.waiting = s.waiting.filter((w) => w.runId !== runId);
    pump(s);
  };
  if (fits(s, projectId, recipeId) && !s.waiting.some((w) => w.projectId === projectId)) {
    s.running.set(runId, { projectId, recipeId });
    return { queued: false, ready: Promise.resolve(), release };
  }
  let go!: () => void;
  const ready = new Promise<void>((r) => (go = r));
  s.waiting.push({ runId, projectId, recipeId, go });
  return { queued: true, ready, release };
}

/** True when this process holds a slot for the run (a run without one after a restart was interrupted). */
export const holdsRunSlot = (runId: string): boolean => slots().running.has(runId) || slots().waiting.some((w) => w.runId === runId);

export const runningRuns = (): string[] => [...slots().running.keys()];

/** Test hook: forget every slot and semaphore (simulates a process restart). */
export function _resetSchedulerState(): void {
  (globalThis as G).__signalPostmakerSemaphores = new Map();
  (globalThis as G).__signalPostmakerRuns = { running: new Map(), waiting: [] };
}

// ---- plan execution --------------------------------------------------------------------------------------------

export type StartOutcome = 'done' | 'failed' | 'needs-you' | { pause: 'cap' | 'day-ceiling' | 'gate' };

export interface PlanCallbacks {
  /** In-plan parents of a node (only these are waited for; others are already current or locked). */
  parents(nodeId: string): string[];
  /** Runs one node; resolves with its outcome. A pause outcome means the node did not start. */
  start(nodeId: string): Promise<StartOutcome>;
}

export interface PlanResult {
  done: string[];
  failed: string[];
  needsYou: string[];
  /** Nodes held by pause-for-edit. */
  pausedForEdit: string[];
  /** Nodes not started because a parent failed or the run paused. */
  notStarted: string[];
  pause: 'cap' | 'day-ceiling' | 'gate' | 'edit' | null;
  /** The node the cap/gate pause happened before. */
  pausedAt: string | null;
  /** Stop was called: no node started after it (nodes in progress finished). */
  stopped: boolean;
}

/** A pause-for-edit hold: `settle(true)` keeps it (the edit landed), `settle(false)` lets the nodes run again. */
export interface EditHold {
  held: string[];
  settle(keep: boolean): void;
}

export class PlanExecutor {
  private held = new Set<string>();
  private started = new Set<string>();
  private stopNew = false;
  private stopCalled = false;
  /** Edits whose write has not landed yet: the plan does not end while one is open (its hold may be lifted). */
  private openEdits = 0;
  private wake: (() => void) | null = null;
  constructor(
    private plan: string[],
    private cb: PlanCallbacks,
    private limit = NODES_PER_RUN,
  ) {}

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /**
   * Pause-for-edit: hold every not-yet-started node in `nodes` (the edited node's descendants) until `settle`. A
   * refused edit calls `settle(false)` and the nodes run as if nothing happened.
   */
  hold(nodes: Iterable<string>): EditHold {
    const out: string[] = [];
    for (const n of nodes) {
      if (!this.plan.includes(n) || this.started.has(n) || this.held.has(n)) continue;
      this.held.add(n);
      out.push(n);
    }
    this.openEdits += 1;
    let settled = false;
    return {
      held: out,
      settle: (keep) => {
        if (settled) return;
        settled = true;
        this.openEdits -= 1;
        if (!keep) for (const n of out) this.held.delete(n);
        this.poke();
      },
    };
  }

  /** Stop starting new nodes (Stop); nodes in progress finish. */
  stop(): void {
    this.stopNew = true;
    this.stopCalled = true;
    this.poke();
  }

  get stopped(): boolean {
    return this.stopCalled;
  }

  async execute(): Promise<PlanResult> {
    const state = new Map<string, 'done' | 'failed' | 'needs-you' | 'running'>();
    const res: PlanResult = { done: [], failed: [], needsYou: [], pausedForEdit: [], notStarted: [], pause: null, pausedAt: null, stopped: false };
    const inflight = new Map<string, Promise<void>>();
    // A node starts when every in-plan parent is done; a failed, needs-you or held parent keeps it (and its own
    // descendants) from ever starting, so the loop ends when nothing is in flight.
    const ready = (id: string) => !this.started.has(id) && !this.held.has(id) && this.cb.parents(id).every((p) => !this.plan.includes(p) || state.get(p) === 'done');

    for (;;) {
      if (!this.stopNew) {
        for (const id of this.plan) {
          if (inflight.size >= this.limit) break;
          if (!ready(id)) continue;
          this.started.add(id);
          state.set(id, 'running');
          const p = this.cb
            .start(id)
            .then(
              (o) => {
                if (typeof o === 'object') {
                  this.started.delete(id);
                  state.delete(id);
                  this.stopNew = true;
                  if (!res.pause) {
                    res.pause = o.pause;
                    res.pausedAt = id;
                  }
                  return;
                }
                state.set(id, o);
              },
              () => void state.set(id, 'failed'),
            )
            .finally(() => inflight.delete(id));
          inflight.set(id, p);
        }
      }
      if (inflight.size === 0 && (this.openEdits === 0 || this.stopNew)) break;
      const woken = new Promise<void>((r) => (this.wake = r));
      await Promise.race([...inflight.values(), woken]);
      this.wake = null;
    }
    res.stopped = this.stopCalled;
    for (const id of this.plan) {
      const s = state.get(id);
      if (s === 'done') res.done.push(id);
      else if (s === 'failed') res.failed.push(id);
      else if (s === 'needs-you') res.needsYou.push(id);
      else if (this.held.has(id)) res.pausedForEdit.push(id);
      else res.notStarted.push(id);
    }
    if (!res.pause && res.pausedForEdit.length) res.pause = 'edit';
    return res;
  }
}
