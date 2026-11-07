// The spend ledger: postmaker/ledger.jsonl, append-only, written under a process-wide mutex. Before every paid
// call the runner reserves the call's upper bound against the run cap and the project's day ceiling; afterwards it
// settles the real cost (or the reserve, when the cost is unknown) or releases the reservation (the call never
// started). Arithmetic is in whole micro-dollars, so sums never drift. Day totals use the project's time zone;
// a reservation and its settlement count on the day the reservation was made.
// A connector with a record also has its own day cap (`spend_cap_usd_per_day`, follow-up
// 2), enforced beside the run cap and the project day ceiling. It counts that connector's lines in every project
// in this ledger (one record bills one vendor account), on the reserving project's day.
import { randomBytes } from 'node:crypto';
import { PostmakerError } from '../errors';
import type { LedgerLine, ProjectLike } from '../types';
import { dayIn, monthIn, zoneOf } from './day';
import { appendLine, readJsonLines } from './fs';
import { withLock } from './mutex';
import { ledgerFile } from './paths';

/** Per-project day ceiling default, editable in Connections (`postmaker.dailyUsd`). No monthly cap. */
export const DAY_CEILING_USD_DEFAULT = 20;

const MICRO = 1_000_000;
const toMicro = (usd: number) => Math.round(usd * MICRO);
const toUsd = (micro: number) => micro / MICRO;

function money(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new PostmakerError(400, 'validation', `${what} must be a dollar amount ≥ 0.`);
  return toMicro(v);
}

type Reserve = Extract<LedgerLine, { t: 'reserve' }>;
interface Entry {
  reserve: Reserve;
  micro: number;
  state: 'open' | 'settled' | 'released';
  settledMicro: number;
}

async function readState(root: string): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>();
  for (const line of await readJsonLines<LedgerLine>(ledgerFile(root))) {
    if (line.t === 'reserve') map.set(line.id, { reserve: line, micro: toMicro(line.usd), state: 'open', settledMicro: 0 });
    else {
      const e = map.get(line.id);
      if (!e || e.state !== 'open') continue; // ignored: writers refuse these, so only a hand-edited file has them
      if (line.t === 'settle') {
        e.state = 'settled';
        e.settledMicro = toMicro(line.usd);
      } else e.state = 'released';
    }
  }
  return map;
}

export interface LedgerTotals {
  run: { spentUsd: number; reservedUsd: number } | null;
  day: { day: string; settledUsd: number; reservedUsd: number };
  /** Informational only ("spent this month" in Connections); there is no monthly cap. */
  month: { month: string; spentUsd: number };
}

function totalsOf(
  map: Map<string, Entry>,
  projectId: string,
  timeZone: string,
  runId: string | null,
  now: number,
  connector: string | null = null,
): { run: { spent: number; reserved: number }; day: { day: string; settled: number; reserved: number }; month: { month: string; spent: number }; connectorDay: number } {
  const day = dayIn(timeZone, now);
  const month = monthIn(timeZone, now);
  const run = { spent: 0, reserved: 0 };
  const d = { day, settled: 0, reserved: 0 };
  const m = { month, spent: 0 };
  let connectorDay = 0;
  for (const e of map.values()) {
    const r = e.reserve;
    if (runId !== null && r.runId === runId) {
      if (e.state === 'settled') run.spent += e.settledMicro;
      if (e.state === 'open') run.reserved += e.micro;
    }
    if (connector !== null && r.connector === connector && dayIn(timeZone, Date.parse(r.at)) === day) {
      if (e.state === 'settled') connectorDay += e.settledMicro;
      if (e.state === 'open') connectorDay += e.micro;
    }
    if (r.project !== projectId) continue;
    const at = Date.parse(r.at);
    if (dayIn(timeZone, at) === day) {
      if (e.state === 'settled') d.settled += e.settledMicro;
      if (e.state === 'open') d.reserved += e.micro;
    }
    if (monthIn(timeZone, at) === month && e.state === 'settled') m.spent += e.settledMicro;
  }
  return { run, day: d, month: m, connectorDay };
}

export async function ledgerTotals(root: string, o: { project: Pick<ProjectLike, 'id' | 'timeZone'>; runId?: string; now?: number }): Promise<LedgerTotals> {
  const map = await readState(root);
  const t = totalsOf(map, o.project.id, zoneOf(o.project), o.runId ?? null, o.now ?? Date.now());
  return {
    run: o.runId ? { spentUsd: toUsd(t.run.spent), reservedUsd: toUsd(t.run.reserved) } : null,
    day: { day: t.day.day, settledUsd: toUsd(t.day.settled), reservedUsd: toUsd(t.day.reserved) },
    month: { month: t.month.month, spentUsd: toUsd(t.month.spent) },
  };
}

export interface ReserveInput {
  project: Pick<ProjectLike, 'id' | 'timeZone'>;
  runId: string;
  nodeId: string;
  connector: string;
  usd: number; // the call's upper bound (estimate.usdHigh)
  runCapUsd: number;
  dayCeilingUsd?: number;
  /** The connector's own day cap (signal.config.json postmaker.dayCapUsd); null or absent = none applies. */
  connectorDayCapUsd?: number | null;
  now?: number;
}

/** Which limit stopped a reservation: the run cap, the project's day ceiling or the connector's own day cap. */
export type ReserveLimit = 'run-cap' | 'project-day' | 'connector-day';

export type ReserveResult =
  | { ok: true; id: string; line: Reserve }
  | { ok: false; pausedFor: 'cap' | 'day-ceiling'; limit: ReserveLimit; text: string; totals: LedgerTotals };

const lockKey = (root: string) => `pm-ledger:${ledgerFile(root)}`;

/**
 * Reserves `usd` only when `runSpent + runReserved + usd ≤ runCap`, `daySettled + dayReserved + usd ≤ dayCeiling` and,
 * when the connector has a day cap, `connectorDay + usd ≤ connectorDayCap`. Otherwise nothing is written and the run
 * must pause before the node (`pausedFor`; a connector cap pauses as `day-ceiling` with `limit: 'connector-day'`).
 */
export async function reserve(root: string, input: ReserveInput): Promise<ReserveResult> {
  const usd = money(input.usd, 'The reservation');
  const cap = money(input.runCapUsd, 'The run cap');
  const ceiling = money(input.dayCeilingUsd ?? DAY_CEILING_USD_DEFAULT, 'The day ceiling');
  const connectorCap = input.connectorDayCapUsd === undefined || input.connectorDayCapUsd === null ? null : money(input.connectorDayCapUsd, 'The connector day cap');
  const now = input.now ?? Date.now();
  const tz = zoneOf(input.project);
  dayIn(tz, now); // validates the zone before anything is written
  return withLock(lockKey(root), async () => {
    const map = await readState(root);
    const t = totalsOf(map, input.project.id, tz, input.runId, now, connectorCap === null ? null : input.connector);
    const fail = (pausedFor: 'cap' | 'day-ceiling', limit: ReserveLimit, text: string): ReserveResult => ({
      ok: false,
      pausedFor,
      limit,
      text,
      totals: {
        run: { spentUsd: toUsd(t.run.spent), reservedUsd: toUsd(t.run.reserved) },
        day: { day: t.day.day, settledUsd: toUsd(t.day.settled), reservedUsd: toUsd(t.day.reserved) },
        month: { month: t.month.month, spentUsd: toUsd(t.month.spent) },
      },
    });
    if (t.run.spent + t.run.reserved + usd > cap) return fail('cap', 'run-cap', 'cap reached');
    if (t.day.settled + t.day.reserved + usd > ceiling) return fail('day-ceiling', 'project-day', 'day ceiling reached');
    if (connectorCap !== null && t.connectorDay + usd > connectorCap) return fail('day-ceiling', 'connector-day', 'connector day cap reached');
    const line: Reserve = {
      t: 'reserve',
      id: `lg-${randomBytes(6).toString('hex')}`,
      at: new Date(now).toISOString(),
      project: input.project.id,
      runId: input.runId,
      nodeId: input.nodeId,
      connector: input.connector,
      usd: toUsd(usd),
    };
    await appendLine(ledgerFile(root), JSON.stringify(line));
    return { ok: true, id: line.id, line };
  });
}

/**
 * Settles a reservation with the real cost. `known: false` (a failed billed run, a connector that cannot report cost)
 * settles at the reserved upper bound (the agentSpendOf pattern), whatever `usd` says.
 */
export async function settle(root: string, id: string, o: { usd: number; known: boolean; note?: string; now?: number }): Promise<{ usd: number }> {
  if (o.known) money(o.usd, 'The cost');
  return withLock(lockKey(root), async () => {
    const e = (await readState(root)).get(id);
    if (!e) throw new PostmakerError(404, 'not_found', 'Unknown reservation.');
    if (e.state !== 'open') throw new PostmakerError(409, 'conflict', `This reservation is already ${e.state}.`);
    const usd = o.known ? toUsd(toMicro(o.usd)) : e.reserve.usd;
    const line: LedgerLine = { t: 'settle', id, at: new Date(o.now ?? Date.now()).toISOString(), usd, known: o.known, ...(o.note ? { note: o.note } : {}) };
    await appendLine(ledgerFile(root), JSON.stringify(line));
    return { usd };
  });
}

/** Releases a reservation whose call never started. */
export function release(root: string, id: string, o: { now?: number } = {}): Promise<void> {
  return withLock(lockKey(root), async () => {
    const e = (await readState(root)).get(id);
    if (!e) throw new PostmakerError(404, 'not_found', 'Unknown reservation.');
    if (e.state !== 'open') throw new PostmakerError(409, 'conflict', `This reservation is already ${e.state}.`);
    await appendLine(ledgerFile(root), JSON.stringify({ t: 'release', id, at: new Date(o.now ?? Date.now()).toISOString() } satisfies LedgerLine));
  });
}

/** Open reservations of a run (for Stop and crash recovery). */
export async function openReservations(root: string, runId: string): Promise<Reserve[]> {
  return [...(await readState(root)).values()].filter((e) => e.state === 'open' && e.reserve.runId === runId).map((e) => e.reserve);
}
