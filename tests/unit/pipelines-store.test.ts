// Pipelines: defaults, validation and clamping, storage (create/update/archive) and the slot calendar (days × times, DST).
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archivePipeline, cleanSteps, createPipeline, defaultSteps, getPipeline, listPipelines, readState, scheduleSlots, stepProblems, updatePipeline, upcomingSlots, writeState } from '@/lib/studio/pipelines/store';
import { NOW, setupAutopilotProject, teardownAutopilotProject } from './autopilot-helpers';
import { P1, pipelineFile, readPipeline, writePipeline } from './pipelines-helpers';

beforeEach(() => setupAutopilotProject());
afterEach(() => teardownAutopilotProject());

describe('defaults and validation', () => {
  it('works with no setup: website pages → website posts, Mon/Wed/Fri 18:00, reviewed, ask me, $3/day', () => {
    expect(defaultSteps()).toEqual({
      source: { kind: 'website', list: [], campaign: null },
      make: { format: 'website-card', template: '', captionStyle: '' },
      review: { enabled: true },
      approve: { mode: 'ask' },
      schedule: { perWeek: 3, days: [0, 2, 4], times: ['18:00'], makeAheadDays: 3 },
      budget: { dailyUsd: 3 },
    });
    expect(cleanSteps(undefined)).toEqual(defaultSteps());
    expect(cleanSteps('garbage')).toEqual(defaultSteps());
  });
  it('clamps numbers, drops bad days/times/formats and unknown keys, keeps the list in order', () => {
    const s = cleanSteps({
      source: { kind: 'list', list: ['  First  topic ', '', 42, 'Second'], campaign: 'nope', extra: 1 },
      make: { format: 'not-a-format', template: 'x'.repeat(2000), captionStyle: 'warm' },
      review: { enabled: 'yes' },
      approve: { mode: 'always' },
      schedule: { perWeek: 99, days: [7, -1, 3, 3, '1'], times: ['25:00', '09:5', '18:00', '07:30', '18:00'], makeAheadDays: 0 },
      budget: { dailyUsd: '250' },
    });
    expect(s.source).toEqual({ kind: 'list', list: ['First topic', 'Second'], campaign: null });
    expect(s.make.format).toBe('website-card'); // the default stays when the format is unknown
    expect(s.make.template).toHaveLength(800);
    expect(s.review.enabled).toBe(true); // only false switches it off
    expect(s.approve.mode).toBe('ask');
    expect(s.schedule).toEqual({ perWeek: 14, days: [1, 3], times: ['07:30', '18:00'], makeAheadDays: 1 });
    expect(s.budget.dailyUsd).toBe(20);
    expect(Object.keys(s.source)).toEqual(['kind', 'list', 'campaign']);
    // an empty days or times list falls back rather than making a pipeline that never fires
    expect(cleanSteps({ schedule: { days: [], times: [] } }).schedule).toMatchObject({ days: [0, 2, 4], times: ['18:00'] });
    expect(cleanSteps({ source: { campaign: 'c-20261101-aaaa', kind: 'campaign' } }).source.campaign).toBe('c-20261101-aaaa');
    expect(cleanSteps({ budget: { dailyUsd: -4 } }).budget.dailyUsd).toBe(0);
    expect(cleanSteps({ budget: { dailyUsd: 1.239 } }).budget.dailyUsd).toBe(1.24);
  });
  it('merges a patch over the stored steps, one step at a time', () => {
    const base = cleanSteps({ source: { kind: 'list', list: ['a'] }, schedule: { perWeek: 5, days: [0, 1, 2, 3, 4] } });
    const next = cleanSteps({ schedule: { times: ['09:00'] }, approve: { mode: 'trusted' } }, base);
    expect(next.source).toEqual(base.source);
    expect(next.schedule).toEqual({ perWeek: 5, days: [0, 1, 2, 3, 4], times: ['09:00'], makeAheadDays: 3 });
    expect(next.approve.mode).toBe('trusted');
  });
  it('names the problems that stop a source from working', () => {
    expect(stepProblems({ steps: cleanSteps({ source: { kind: 'list' }, make: { format: 'higgsfield-image' } }) })).toEqual(['The list is empty. Add a topic.']);
    expect(stepProblems({ steps: cleanSteps({ source: { kind: 'campaign' } }) })).toEqual(['Pick a campaign.']);
    expect(stepProblems({ steps: cleanSteps({ source: { kind: 'list', list: ['a'] } }) })).toEqual(['Website posts come from pages, not topics. Pick another post type.']);
    expect(stepProblems({ steps: cleanSteps({ source: { kind: 'ideas' }, make: { format: 'codex-post' } }) })).toEqual([]);
    expect(stepProblems({ steps: defaultSteps() })).toEqual([]);
  });
});

describe('storage', () => {
  it('creates with defaults and a name, lists oldest first, updates in place, archives instead of deleting', async () => {
    const a = await createPipeline({}, NOW);
    expect(a.id).toMatch(/^pl-20261105-[a-z0-9]{4}$/);
    expect(a).toMatchObject({ name: 'Website → posts', enabled: false, archived: false, steps: defaultSteps(), createdAt: new Date(NOW).toISOString() });
    const b = await createPipeline({ name: '  Daily  ideas ', enabled: true, steps: { source: { kind: 'ideas' }, schedule: { perWeek: 7, days: [0, 1, 2, 3, 4, 5, 6] } } }, NOW + 1000);
    expect(b).toMatchObject({ name: 'Daily ideas', enabled: true });
    expect(b.steps.source.kind).toBe('ideas');
    expect((await listPipelines()).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(existsSync(pipelineFile(a.id))).toBe(true);

    const u = await updatePipeline(a.id, { name: 'Blog', steps: { schedule: { times: ['12:00', '20:00'] }, review: { enabled: false } } }, NOW + 2000);
    expect(u).toMatchObject({ id: a.id, name: 'Blog', createdAt: a.createdAt, updatedAt: new Date(NOW + 2000).toISOString() });
    expect(u.steps.schedule).toEqual({ perWeek: 3, days: [0, 2, 4], times: ['12:00', '20:00'], makeAheadDays: 3 });
    expect(u.steps.review.enabled).toBe(false);
    expect(u.steps.source).toEqual(a.steps.source);
    expect(readPipeline(a.id).name).toBe('Blog');
    // unknown keys and ids never land on disk
    await updatePipeline(a.id, { id: 'pl-99999999-zzzz', archived: true, steps: { source: { kind: 'list', list: ['x'], rogue: 1 } } } as unknown as Record<string, unknown>);
    const raw = JSON.parse(readFileSync(pipelineFile(a.id), 'utf8')) as Record<string, unknown>;
    expect(raw.id).toBe(a.id);
    expect(raw.archived).toBe(false);
    expect((raw.steps as { source: Record<string, unknown> }).source).toEqual({ kind: 'list', list: ['x'], campaign: null });

    const d = await archivePipeline(a.id, NOW + 3000);
    expect(d).toMatchObject({ archived: true, enabled: false });
    expect(existsSync(pipelineFile(a.id))).toBe(true);
    expect((await listPipelines()).map((p) => p.id)).toEqual([b.id]);
    expect((await listPipelines({ archived: true })).map((p) => p.id)).toEqual([a.id, b.id]);
    await expect(getPipeline('pl-20261105-nope')).rejects.toMatchObject({ status: 404 });
    await expect(getPipeline('../etc')).rejects.toMatchObject({ status: 404 });
    await expect(updatePipeline('bad', {})).rejects.toMatchObject({ status: 404 });
  });
  it('reads a hand-edited or older file without breaking the list', async () => {
    writePipeline(P1);
    const raw = JSON.parse(readFileSync(pipelineFile(P1), 'utf8')) as Record<string, unknown>;
    delete raw.steps;
    delete raw.createdAt;
    raw.name = 7;
    raw.enabled = 'true';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(pipelineFile(P1), JSON.stringify(raw));
    const [p] = await listPipelines();
    expect(p).toMatchObject({ id: P1, name: 'Website → posts', enabled: false, steps: defaultSteps() });
    writeFileSync(pipelineFile(P1), '{not json');
    expect(await listPipelines()).toEqual([]);
  });
  it('state is separate from the settings and tolerant of junk', async () => {
    writePipeline(P1);
    expect(await readState(P1)).toEqual({ listNext: 0, ideas: [], lastRunAt: null, lastResult: null });
    await writeState(P1, { listNext: 2, ideas: [{ topic: 'a' }, { nope: 1 } as never], lastRunAt: 'x', lastResult: 'ok' });
    expect(await readState(P1)).toEqual({ listNext: 2, ideas: [{ topic: 'a' }], lastRunAt: 'x', lastResult: 'ok' });
    expect(readPipeline(P1).steps).toEqual(defaultSteps()); // settings untouched
  });
});

describe('slot calendar', () => {
  const sched = (o: Partial<ReturnType<typeof defaultSteps>['schedule']> = {}) => ({ ...defaultSteps().schedule, ...o });
  it('days × times inside the range, in time order, Studio time zone wall clock', () => {
    // 2026-11-02 is a Monday
    const slots = scheduleSlots(sched({ days: [0, 2], times: ['18:00', '09:00'], perWeek: 14 }), '2026-11-02', '2026-11-08');
    expect(slots.map((s) => s.id)).toEqual(['2026-11-02-09:00', '2026-11-02-18:00', '2026-11-04-09:00', '2026-11-04-18:00']);
    expect(slots[0]).toEqual({ id: '2026-11-02-09:00', date: '2026-11-02', time: '09:00', at: '2026-11-02T08:00:00.000Z' }); // CET = UTC+1
  });
  it('caps at perWeek per Monday-to-Sunday week, earliest first', () => {
    const slots = scheduleSlots(sched({ days: [0, 2, 4], times: ['18:00'], perWeek: 2 }), '2026-11-02', '2026-11-15');
    expect(slots.map((s) => s.date)).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
    const daily = scheduleSlots(sched({ days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00', '20:00'], perWeek: 14 }), '2026-11-02', '2026-11-08');
    expect(daily).toHaveLength(14);
  });
  it('handles DST: summer offset, a gap hour is left out, a fold hour is left out', () => {
    // 2026-07-01 is a Wednesday: CEST = UTC+2
    expect(scheduleSlots(sched({ days: [2], times: ['18:00'] }), '2026-07-01', '2026-07-01')[0]!.at).toBe('2026-07-01T16:00:00.000Z');
    // 2026-03-29 (Sunday): 02:30 does not exist; 2026-10-25 (Sunday): 02:30 exists twice. Both are skipped, other times stay.
    expect(scheduleSlots(sched({ days: [6], times: ['02:30', '18:00'], perWeek: 14 }), '2026-03-29', '2026-03-29').map((s) => s.time)).toEqual(['18:00']);
    expect(scheduleSlots(sched({ days: [6], times: ['02:30', '18:00'], perWeek: 14 }), '2026-10-25', '2026-10-25').map((s) => s.at)).toEqual(['2026-10-25T17:00:00.000Z']);
    // the day after the autumn change is CET again
    expect(scheduleSlots(sched({ days: [0], times: ['18:00'] }), '2026-10-26', '2026-10-26')[0]!.at).toBe('2026-10-26T17:00:00.000Z');
  });
  it('upcomingSlots: only future slots inside make-ahead, with the package that already fills a slot', () => {
    // NOW = Thursday 2026-11-05 08:30 CET; Mon/Wed/Fri 18:00, 5 days ahead → Fri 06, Mon 09 (Wed 11 is beyond 10)
    const p = { steps: cleanSteps({ schedule: { makeAheadDays: 5 } }) };
    const made = new Map([['2026-11-06T17:00:00.000Z', '12']]);
    expect(upcomingSlots(p, made, NOW)).toEqual([
      { id: '2026-11-06-18:00', date: '2026-11-06', time: '18:00', at: '2026-11-06T17:00:00.000Z', packageId: '12' },
      { id: '2026-11-09-18:00', date: '2026-11-09', time: '18:00', at: '2026-11-09T17:00:00.000Z', packageId: null },
    ]);
    // with 3 days ahead only Friday is inside; after Friday 18:00 that slot is gone and is never caught up
    const p3 = { steps: cleanSteps({ schedule: { makeAheadDays: 3 } }) };
    expect(upcomingSlots(p3, new Map(), NOW).map((s) => s.id)).toEqual(['2026-11-06-18:00']);
    expect(upcomingSlots(p3, new Map(), Date.parse('2026-11-06T18:01:00+01:00')).map((s) => s.id)).toEqual(['2026-11-09-18:00']);
    // the week's perWeek counts Monday's slot even though it is past: 1/week Mon/Wed/Fri → only Monday fires, nothing left this week
    const weekly = { steps: cleanSteps({ schedule: { perWeek: 1, makeAheadDays: 7 } }) };
    expect(upcomingSlots(weekly, new Map(), NOW).map((s) => s.id)).toEqual(['2026-11-09-18:00']);
  });
  it('upcomingSlots: a post made for a time the schedule no longer has still covers one slot of its day', () => {
    // made at Monday 18:00, then the time was changed to 19:00 → Monday is still covered, Friday is open
    const moved = { steps: cleanSteps({ schedule: { times: ['19:00'], makeAheadDays: 5 } }) };
    const made = new Map([['2026-11-09T17:00:00.000Z', '12']]);
    expect(upcomingSlots(moved, made, NOW).map((s) => [s.id, s.packageId])).toEqual([['2026-11-06-19:00', null], ['2026-11-09-19:00', '12']]);
    // two times a day: one moved post covers the earliest open slot only; an exact match keeps its own slot
    const two = { steps: cleanSteps({ schedule: { times: ['12:00', '19:00'], perWeek: 14, makeAheadDays: 5 } }) };
    expect(upcomingSlots(two, made, NOW).map((s) => [s.id, s.packageId])).toEqual([['2026-11-06-12:00', null], ['2026-11-06-19:00', null], ['2026-11-09-12:00', '12'], ['2026-11-09-19:00', null]]);
    const both = new Map([['2026-11-09T17:00:00.000Z', '12'], ['2026-11-09T18:00:00.000Z', '13']]);
    expect(upcomingSlots(two, both, NOW).map((s) => [s.id, s.packageId])).toEqual([['2026-11-06-12:00', null], ['2026-11-06-19:00', null], ['2026-11-09-12:00', '12'], ['2026-11-09-19:00', '13']]);
    // never more covered slots than the schedule has for that day: a third post of the day is simply spare
    const three = new Map([...both, ['2026-11-09T10:00:00.000Z', '14']]);
    expect(upcomingSlots(two, three, NOW).filter((s) => s.date === '2026-11-09').map((s) => s.packageId)).toEqual(['12', '13']);
  });
});
