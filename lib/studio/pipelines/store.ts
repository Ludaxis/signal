// Server-only: pipelines on disk (<project content parent>/pipelines/<id>.json, state in <id>.state.json),
// validation with clamping, and the slot calendar (days × times, Studio time zone wall clock, DST-safe).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { addDays, zonedToUtc, todayInZone, weekdayIndex } from '@/lib/time';
import { ContentError, writeJsonReplace } from '../content';
import { ANY_PROJECT_FORMATS, FORMATS, type Format } from '../generate';
import { currentProject } from '../projects';
import { SOURCE_KINDS, type Idea, type Pipeline, type PipelineSlot, type PipelineState, type PipelineSteps, type SourceKind } from './types';

export const ID_RE = /^pl-\d{8}-[a-z0-9]{4}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAMPAIGN_RE = /^c-\d{8}-[a-z0-9]{4}$/;
export const PER_WEEK = { min: 1, max: 14, default: 3 } as const;
export const MAKE_AHEAD = { min: 1, max: 7, default: 3 } as const;
export const DAILY_USD = { min: 0, max: 20, default: 3 } as const;
export const LIST_MAX = 60;

export const pipelinesDir = () => path.join(path.dirname(currentProject().contentDir), 'pipelines');
const file = (id: string) => {
  if (!ID_RE.test(id)) throw new ContentError(404, 'Unknown pipeline.');
  return path.join(pipelinesDir(), `${id}.json`);
};
const stateFile = (id: string) => file(id).replace(/\.json$/, '.state.json');

// ---- defaults and validation -----------------------------------------------------------------------
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const clampUsd = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);

/** Formats this project can make. */
export function projectFormats(): Format[] {
  return [...ANY_PROJECT_FORMATS];
}

/** A pipeline that works with no setup: new website pages → website posts, Mon/Wed/Fri 18:00, reviewed, you approve. */
export function defaultSteps(): PipelineSteps {
  return {
    source: { kind: 'website', list: [], campaign: null },
    make: { format: 'website-card', template: '', captionStyle: '' },
    review: { enabled: true },
    approve: { mode: 'ask' },
    schedule: { perWeek: PER_WEEK.default, days: [0, 2, 4], times: ['18:00'], makeAheadDays: MAKE_AHEAD.default },
    budget: { dailyUsd: DAILY_USD.default },
  };
}

/** Turns any raw steps (stored or patched) into valid steps: unknown keys dropped, numbers clamped, formats checked. */
export function cleanSteps(raw: unknown, base: PipelineSteps = defaultSteps(), formats: Format[] = projectFormats()): PipelineSteps {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PipelineSteps, Record<string, unknown>>>;
  const src = { ...base.source, ...(o.source ?? {}) } as Record<string, unknown>;
  const mk = { ...base.make, ...(o.make ?? {}) } as Record<string, unknown>;
  const rv = { ...base.review, ...(o.review ?? {}) } as Record<string, unknown>;
  const ap = { ...base.approve, ...(o.approve ?? {}) } as Record<string, unknown>;
  const sc = { ...base.schedule, ...(o.schedule ?? {}) } as Record<string, unknown>;
  const bd = { ...base.budget, ...(o.budget ?? {}) } as Record<string, unknown>;

  const kind: SourceKind = SOURCE_KINDS.includes(src.kind as SourceKind) ? (src.kind as SourceKind) : base.source.kind;
  const list = Array.isArray(src.list) ? src.list.map((x) => str(x, 300)).filter(Boolean).slice(0, LIST_MAX) : [];
  const campaign = typeof src.campaign === 'string' && CAMPAIGN_RE.test(src.campaign) ? src.campaign : null;

  const format = isFormat(mk.format) && formats.includes(mk.format) ? mk.format : formats.includes(base.make.format) ? base.make.format : (formats[0] ?? 'website-card');

  const days = [...new Set((Array.isArray(sc.days) ? sc.days : []).map((d) => Math.round(Number(d))).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  const times = [...new Set((Array.isArray(sc.times) ? sc.times : []).map((t) => str(t, 5)).filter((t) => TIME_RE.test(t)))].sort().slice(0, 4);

  return {
    source: { kind, list, campaign },
    make: { format, template: str(mk.template, 800), captionStyle: str(mk.captionStyle, 200) },
    review: { enabled: rv.enabled !== false },
    approve: { mode: ap.mode === 'trusted' ? 'trusted' : 'ask' },
    schedule: {
      perWeek: clampInt(sc.perWeek, PER_WEEK.min, PER_WEEK.max, base.schedule.perWeek),
      days: days.length ? days : base.schedule.days.length ? base.schedule.days : [0, 2, 4],
      times: times.length ? times : base.schedule.times.length ? base.schedule.times : ['18:00'],
      makeAheadDays: clampInt(sc.makeAheadDays, MAKE_AHEAD.min, MAKE_AHEAD.max, base.schedule.makeAheadDays),
    },
    budget: { dailyUsd: clampUsd(bd.dailyUsd, DAILY_USD.min, DAILY_USD.max, base.budget.dailyUsd) },
  };
}

/** Checks a pipeline's source can work at all; returns problems in plain words (empty = fine). */
export function stepProblems(p: Pick<Pipeline, 'steps'>): string[] {
  const out: string[] = [];
  const s = p.steps.source;
  if (s.kind === 'list' && !s.list.length) out.push('The list is empty. Add a topic.');
  if (s.kind === 'campaign' && !s.campaign) out.push('Pick a campaign.');
  if ((s.kind === 'list' || s.kind === 'ideas') && p.steps.make.format === 'website-card') out.push('Website posts come from pages, not topics. Pick another post type.');
  return out;
}

export function cleanPipeline(raw: unknown, base?: Pipeline, now = Date.now()): Pipeline {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const steps = cleanSteps(o.steps, base?.steps ?? defaultSteps());
  const name = str(o.name, 60) || base?.name || defaultName(steps);
  return {
    id: base?.id ?? (typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : newPipelineId(now)),
    name,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : (base?.enabled ?? false),
    archived: typeof o.archived === 'boolean' ? o.archived : (base?.archived ?? false),
    steps,
    createdAt: base?.createdAt ?? (typeof o.createdAt === 'string' && Number.isFinite(Date.parse(o.createdAt)) ? new Date(o.createdAt).toISOString() : new Date(now).toISOString()),
    updatedAt: new Date(now).toISOString(),
  };
}

const SOURCE_WORD: Record<SourceKind, string> = { ideas: 'Ideas', list: 'My list', website: 'Website', campaign: 'Campaign' };
export function defaultName(steps: PipelineSteps): string {
  return `${SOURCE_WORD[steps.source.kind]} → posts`;
}
export const newPipelineId = (now = Date.now()) => `pl-${todayInZone(now).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;

// ---- storage -----------------------------------------------------------------------------------------
async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ f, 'utf8')) as T;
  } catch {
    return null;
  }
}

const isoOr = (v: unknown, dflt: string) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : dflt);

/** A stored file, made valid again (a hand-edited or older file never breaks the list). */
function fromDisk(raw: unknown): Pipeline | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const steps = cleanSteps(o.steps);
  const createdAt = isoOr(o.createdAt, new Date(0).toISOString());
  return { id: o.id, name: str(o.name, 60) || defaultName(steps), enabled: o.enabled === true, archived: o.archived === true, steps, createdAt, updatedAt: isoOr(o.updatedAt, createdAt) };
}

/** Every pipeline (archived ones too when asked), oldest first. */
export async function listPipelines(o: { archived?: boolean } = {}): Promise<Pipeline[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/* turbopackIgnore: true */ pipelinesDir())).filter((n) => /^pl-\d{8}-[a-z0-9]{4}\.json$/.test(n));
  } catch {
    return [];
  }
  const out: Pipeline[] = [];
  for (const n of names.sort()) {
    const p = fromDisk(await readJson(path.join(pipelinesDir(), n)));
    if (!p || (p.archived && !o.archived)) continue;
    out.push(p);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getPipeline(id: string): Promise<Pipeline> {
  const p = fromDisk(await readJson(file(id)));
  if (!p) throw new ContentError(404, 'Unknown pipeline.');
  return p;
}

async function save(p: Pipeline): Promise<Pipeline> {
  await fs.mkdir(/* turbopackIgnore: true */ pipelinesDir(), { recursive: true });
  await writeJsonReplace(file(p.id), p);
  return p;
}

export async function createPipeline(input: unknown, now = Date.now()): Promise<Pipeline> {
  const p = cleanPipeline(input, undefined, now);
  p.id = newPipelineId(now);
  p.createdAt = new Date(now).toISOString();
  p.archived = false;
  return save(p);
}

/** A pipeline that is still in the list: a removed (archived) one is 404 for every action but reading it. */
export async function getLivePipeline(id: string): Promise<Pipeline> {
  const p = await getPipeline(id);
  if (p.archived) throw new ContentError(404, 'This pipeline was removed.');
  return p;
}

/** Patch: name, enabled and any subset of steps (each step merged over the stored one). A removed pipeline is never changed. */
export async function updatePipeline(id: string, patch: unknown, now = Date.now()): Promise<Pipeline> {
  const cur = await getLivePipeline(id);
  const o = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const next = cleanPipeline({ name: o.name, enabled: o.enabled, steps: o.steps }, cur, now);
  return save(next);
}

/** Delete = archive: the file stays, the pipeline leaves the list and never runs. */
export async function archivePipeline(id: string, now = Date.now()): Promise<Pipeline> {
  const cur = await getPipeline(id);
  return save({ ...cur, enabled: false, archived: true, updatedAt: new Date(now).toISOString() });
}

// ---- state (runner only) -----------------------------------------------------------------------------
export function emptyState(): PipelineState {
  return { listNext: 0, ideas: [], lastRunAt: null, lastResult: null };
}
export async function readState(id: string): Promise<PipelineState> {
  const s = await readJson<Partial<PipelineState>>(stateFile(id));
  const d = emptyState();
  if (!s || typeof s !== 'object') return d;
  const ideas = Array.isArray(s.ideas) ? s.ideas.filter((i): i is Idea => Boolean(i) && typeof i === 'object' && typeof (i as Idea).topic === 'string').slice(0, 30) : [];
  return { listNext: Number.isInteger(s.listNext) && (s.listNext as number) >= 0 ? (s.listNext as number) : 0, ideas, lastRunAt: typeof s.lastRunAt === 'string' ? s.lastRunAt : null, lastResult: typeof s.lastResult === 'string' ? s.lastResult.slice(0, 300) : null };
}
export async function writeState(id: string, s: PipelineState): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ pipelinesDir(), { recursive: true });
  await writeJsonReplace(stateFile(id), s);
}

// ---- the slot calendar -------------------------------------------------------------------------------
/** ISO week key (Monday's date) of a date. */
const weekOf = (date: string) => addDays(date, -weekdayIndex(date));

/**
 * The slots a schedule asks for between `fromDate` and `toDate` (inclusive, Studio-zone dates), in time order:
 * every chosen day × every time, at most `perWeek` per Monday-to-Sunday week (earliest first). A wall time
 * that does not exist (spring-forward gap) or exists twice (autumn fold) is left out for that day.
 */
export function scheduleSlots(s: Pipeline['steps']['schedule'], fromDate: string, toDate: string): Omit<PipelineSlot, 'packageId'>[] {
  const out: Omit<PipelineSlot, 'packageId'>[] = [];
  const perWeek = new Map<string, number>();
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    if (!s.days.includes(weekdayIndex(d))) continue;
    const wk = weekOf(d);
    for (const t of [...s.times].sort()) {
      if ((perWeek.get(wk) ?? 0) >= s.perWeek) break;
      const r = zonedToUtc(d, t);
      if (!r.ok) continue;
      out.push({ id: `${d}-${t}`, date: d, time: t, at: r.iso });
      perWeek.set(wk, (perWeek.get(wk) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Upcoming slots inside the make-ahead horizon, from now (slots already past are not caught up):
 * today … today + makeAheadDays. A slot that already has a package carries its id; the rest are open.
 * `made` is slotAt → package id (pipeline.json) for every post this pipeline made, discarded ones too.
 * A post made for another time on the same calendar day (the schedule's time was changed after it was
 * made) still covers one slot of that day, so a day never gets more posts than the schedule asks for.
 * `perWeek` counts the slots this schedule asks for, including made ones.
 */
export function upcomingSlots(p: Pick<Pipeline, 'steps'>, made: Map<string, string>, now = Date.now()): PipelineSlot[] {
  const today = todayInZone(now);
  // Count the week from its Monday so perWeek is honoured across the horizon, then keep only future slots.
  const from = weekOf(today);
  const to = addDays(today, p.steps.schedule.makeAheadDays);
  const slots: PipelineSlot[] = scheduleSlots(p.steps.schedule, from, to)
    .filter((sl) => Date.parse(sl.at) > now)
    .map((sl) => ({ ...sl, packageId: made.get(sl.at) ?? null }));
  // Posts made for a time the schedule no longer has: they fill that day's open slots, earliest first.
  const spare = new Map<string, string[]>();
  const exact = new Set(slots.map((sl) => sl.at));
  for (const [at, id] of made) {
    if (exact.has(at) || !Number.isFinite(Date.parse(at))) continue;
    const day = todayInZone(Date.parse(at));
    spare.set(day, [...(spare.get(day) ?? []), id]);
  }
  for (const sl of slots) {
    if (sl.packageId) continue;
    const id = spare.get(sl.date)?.shift();
    if (id) sl.packageId = id;
  }
  return slots;
}
