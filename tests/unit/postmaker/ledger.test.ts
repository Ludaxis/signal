// @vitest-environment node
// The spend ledger: reserve/settle/release arithmetic, the run cap and day ceiling, day rollover at the
// project's time zone across the DST change, and concurrent reserves under the mutex.
import './guard';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { dayIn } from '@/lib/studio/postmaker/store/day';
import { DAY_CEILING_USD_DEFAULT, ledgerTotals, openReservations, release, reserve, settle } from '@/lib/studio/postmaker/store/ledger';
import { ledgerFile } from '@/lib/studio/postmaker/store/paths';
import type { LedgerLine } from '@/lib/studio/postmaker/types';
import { tmp } from './guard';

const AMS = { id: 'example-project', timeZone: 'Europe/Berlin' };
const R1 = 'run-20261106-100000-aaaa';
const R2 = 'run-20261106-110000-bbbb';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const base = { project: AMS, runId: R1, nodeId: 'voice:fa', connector: 'mock-vendor', runCapUsd: 10, now: NOW };
const lines = () =>
  readFileSync(ledgerFile(tmp.root), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LedgerLine);

const okId = async (p: ReturnType<typeof reserve>) => {
  const r = await p;
  if (!r.ok) throw new Error(`expected a reservation, got ${r.pausedFor}`);
  return r.id;
};

describe('the connector day cap', () => {
  it('a connector day cap stops the connector beside the run cap and the project day ceiling, across projects, per day', async () => {
    const OTHER = { id: 'other-project', timeZone: 'Europe/Berlin' };
    const capped = { ...base, connector: 'elevenlabs', connectorDayCapUsd: 1 };
    await okId(reserve(tmp.root, { ...capped, usd: 0.6 }));
    // another project on the same vendor account counts toward the same cap
    const b = await okId(reserve(tmp.root, { ...capped, project: OTHER, runId: R2, usd: 0.3 }));
    const r = await reserve(tmp.root, { ...capped, usd: 0.2 });
    expect(r).toMatchObject({ ok: false, pausedFor: 'day-ceiling', limit: 'connector-day', text: 'connector day cap reached' });
    // other connectors are not limited by it; a settled lower cost frees the rest of the cap
    await okId(reserve(tmp.root, { ...base, connector: 'sync', usd: 0.5 }));
    await settle(tmp.root, b, { usd: 0.1, known: true });
    await okId(reserve(tmp.root, { ...capped, usd: 0.2 }));
    // the next day in the project's zone starts again
    await okId(reserve(tmp.root, { ...capped, usd: 0.9, now: NOW + 86_400_000 }));
    // no cap given = none applies; the run cap and project ceiling still come first
    expect(await reserve(tmp.root, { ...capped, connectorDayCapUsd: null, usd: 0.5 })).toMatchObject({ ok: true });
    expect(await reserve(tmp.root, { ...capped, runCapUsd: 0.1, usd: 0.5 })).toMatchObject({ ok: false, pausedFor: 'cap', limit: 'run-cap' });
    expect(await reserve(tmp.root, { ...capped, dayCeilingUsd: 0.1, usd: 0.5 })).toMatchObject({ ok: false, pausedFor: 'day-ceiling', limit: 'project-day' });
    await expect(reserve(tmp.root, { ...capped, connectorDayCapUsd: -1, usd: 0.1 })).rejects.toThrow();
  });
});

describe('reserve, settle, release arithmetic', () => {
  it('outstanding reserves and settlements add up exactly (micro-dollars, no float drift)', async () => {
    const a = await okId(reserve(tmp.root, { ...base, usd: 0.1 }));
    const b = await okId(reserve(tmp.root, { ...base, usd: 0.2 }));
    const c = await okId(reserve(tmp.root, { ...base, usd: 0.3 }));
    let t = await ledgerTotals(tmp.root, { project: AMS, runId: R1, now: NOW });
    expect(t.run).toEqual({ spentUsd: 0, reservedUsd: 0.6 });
    expect(t.day).toMatchObject({ day: '2026-11-06', settledUsd: 0, reservedUsd: 0.6 });

    await settle(tmp.root, a, { usd: 0.07, known: true });
    await release(tmp.root, b);
    const unknown = await settle(tmp.root, c, { usd: 0, known: false }); // unknown cost counts at the reserve
    expect(unknown.usd).toBe(0.3);
    t = await ledgerTotals(tmp.root, { project: AMS, runId: R1, now: NOW });
    expect(t.run).toEqual({ spentUsd: 0.37, reservedUsd: 0 });
    expect(t.day).toMatchObject({ settledUsd: 0.37, reservedUsd: 0 });
    expect(t.month).toEqual({ month: '2026-11', spentUsd: 0.37 });
    expect(lines().map((l) => l.t)).toEqual(['reserve', 'reserve', 'reserve', 'settle', 'release', 'settle']);
  });

  it('a settled or released reservation cannot be settled or released again; unknown ids are 404', async () => {
    const a = await okId(reserve(tmp.root, { ...base, usd: 1 }));
    await settle(tmp.root, a, { usd: 0.5, known: true });
    await expect(settle(tmp.root, a, { usd: 0.5, known: true })).rejects.toSatisfy((e) => isPostmakerError(e, 'conflict'));
    await expect(release(tmp.root, a)).rejects.toSatisfy((e) => isPostmakerError(e, 'conflict'));
    await expect(release(tmp.root, 'lg-000000000000')).rejects.toSatisfy((e) => isPostmakerError(e, 'not_found'));
    await expect(reserve(tmp.root, { ...base, usd: -1 })).rejects.toThrow();
    await expect(reserve(tmp.root, { ...base, usd: Number.NaN })).rejects.toThrow();
  });

  it('a subscription-billed call settles $0 known', async () => {
    const a = await okId(reserve(tmp.root, { ...base, usd: 1.2 }));
    await settle(tmp.root, a, { usd: 0, known: true, note: 'Claude plan' });
    expect((await ledgerTotals(tmp.root, { project: AMS, runId: R1, now: NOW })).run).toEqual({ spentUsd: 0, reservedUsd: 0 });
  });
});

describe('run cap and day ceiling', () => {
  it('shape: cap $1.00, a $1.20 call pauses with cap and writes nothing', async () => {
    const r = await reserve(tmp.root, { ...base, runCapUsd: 1, usd: 1.2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.pausedFor).toBe('cap');
    expect(await openReservations(tmp.root, R1)).toEqual([]);
  });

  it('counts spent + outstanding against the cap, exactly at the boundary', async () => {
    const a = await okId(reserve(tmp.root, { ...base, runCapUsd: 1, usd: 0.6 }));
    expect((await reserve(tmp.root, { ...base, runCapUsd: 1, usd: 0.41 })).ok).toBe(false);
    expect((await reserve(tmp.root, { ...base, runCapUsd: 1, usd: 0.4 })).ok).toBe(true); // 0.6 + 0.4 = 1.0 exactly
    await release(tmp.root, a);
    expect((await reserve(tmp.root, { ...base, runCapUsd: 1, usd: 0.6 })).ok).toBe(true);
  });

  it('the day ceiling ($20 default) spans every run of the project, not other projects', async () => {
    expect(DAY_CEILING_USD_DEFAULT).toBe(20);
    await okId(reserve(tmp.root, { ...base, runCapUsd: 100, usd: 12 }));
    const r = await reserve(tmp.root, { ...base, runId: R2, runCapUsd: 100, usd: 9 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pausedFor).toBe('day-ceiling');
      expect(r.totals.day.reservedUsd).toBe(12);
    }
    expect((await reserve(tmp.root, { ...base, runId: R2, runCapUsd: 100, usd: 8 })).ok).toBe(true);
    expect((await reserve(tmp.root, { ...base, project: { id: 'other-project', timeZone: 'Europe/Berlin' }, runId: R2, runCapUsd: 100, usd: 15 })).ok).toBe(true);
    expect((await reserve(tmp.root, { ...base, runId: R2, runCapUsd: 100, usd: 1, dayCeilingUsd: 25 })).ok).toBe(true);
  });
});

describe('day rollover at the project time zone', () => {
  it('the Berlin day of 2026-10-25 lasts 25 hours (clocks go back) and rolls over at local midnight', async () => {
    // 2026-10-24T22:00Z = 00:00 CEST on the 25th; 2026-10-25T23:00Z = 00:00 CET on the 26th.
    expect(dayIn('Europe/Berlin', Date.parse('2026-10-24T21:59:59Z'))).toBe('2026-10-24');
    expect(dayIn('Europe/Berlin', Date.parse('2026-10-24T22:00:00Z'))).toBe('2026-10-25');
    expect(dayIn('Europe/Berlin', Date.parse('2026-10-25T22:59:59Z'))).toBe('2026-10-25');
    expect(dayIn('Europe/Berlin', Date.parse('2026-10-25T23:00:00Z'))).toBe('2026-10-26');

    const ceil = { ...base, runCapUsd: 100, dayCeilingUsd: 10 };
    await okId(reserve(tmp.root, { ...ceil, usd: 6, now: Date.parse('2026-10-24T22:30:00Z') })); // 00:30 CEST, day 25
    expect((await reserve(tmp.root, { ...ceil, usd: 5, now: Date.parse('2026-10-25T22:30:00Z') })).ok).toBe(false); // 23:30 CET, still day 25
    expect((await reserve(tmp.root, { ...ceil, usd: 5, now: Date.parse('2026-10-25T23:00:00Z') })).ok).toBe(true); // 00:00 CET, day 26
    const t = await ledgerTotals(tmp.root, { project: AMS, now: Date.parse('2026-10-25T23:30:00Z') });
    expect(t.day).toEqual({ day: '2026-10-26', settledUsd: 0, reservedUsd: 5 });
  });

  it('the same instants fall on other days for a project in Asia/Tehran (UTC+3:30)', async () => {
    const teh = { id: 'example-project', timeZone: 'Asia/Tehran' };
    const ceil = { ...base, project: teh, runCapUsd: 100, dayCeilingUsd: 10 };
    await okId(reserve(tmp.root, { ...ceil, usd: 6, now: Date.parse('2026-11-06T20:29:00Z') })); // 23:59 on the 6th
    expect((await reserve(tmp.root, { ...ceil, usd: 6, now: Date.parse('2026-11-06T20:30:00Z') })).ok).toBe(true); // 00:00 on the 7th
    // Seen from Berlin both reservations are on the 6th.
    expect((await ledgerTotals(tmp.root, { project: { id: 'example-project', timeZone: 'Europe/Berlin' }, now: NOW })).day.reservedUsd).toBe(12);
  });

  it('a project without a time zone uses the Studio default zone; an unknown zone is refused before writing', async () => {
    const t = await ledgerTotals(tmp.root, { project: { id: 'example-project' }, now: Date.parse('2026-10-24T22:30:00Z') });
    expect(t.day.day).toBe('2026-10-25');
    await expect(reserve(tmp.root, { ...base, project: { id: 'p', timeZone: 'Mars/Base' }, usd: 1 })).rejects.toSatisfy((e) => isPostmakerError(e, 'time-zone'));
  });
});

describe('concurrent reserves under the mutex', () => {
  it('50 concurrent $1 reserves against a $7 cap: exactly 7 succeed and the ledger never exceeds the cap', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(tmp.root, { ...base, runCapUsd: 7, usd: 1 })));
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    const reserved = lines().filter((l) => l.t === 'reserve');
    expect(reserved).toHaveLength(7);
    expect(reserved.reduce((s, l) => s + (l.t === 'reserve' ? l.usd : 0), 0)).toBe(7);
  });

  it('two runs racing for one day ceiling never exceed it together', async () => {
    const mk = (runId: string) => reserve(tmp.root, { ...base, runId, runCapUsd: 100, dayCeilingUsd: 5, usd: 0.5 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => mk(i % 2 ? R1 : R2)));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect((await ledgerTotals(tmp.root, { project: AMS, now: NOW })).day.reservedUsd).toBe(5);
  });
});
