// Calendar repeat slots (Repeat templates' slots appear as pipeline slots did).
// A pipeline's posts reach the Calendar as planned posts once the daily run makes them; with Pipelines gone, the
// Calendar also shows the slots a Repeat template will fill, so the "next post" the Pipelines card used to name is not
// lost. Only slots the daily run will really make are listed:
// - Post maker on and not paused, and the Repeat switch on. While it is off nothing repeats,
//   so nothing is listed (moved pipelines pause until Repeat is on).
// - Proven templates with Repeat on and their own schedule (a campaign-slot template follows its campaign's slots).
// - A slot already started (a package marked with the owner's id, its old `pl-…` id included, or the slot ledger) is
//   left out: the post itself is on the Calendar. A post made for a time the schedule no longer has fills one open
//   slot of its day, as the daily run counts it (pipelines/store.ts `upcomingSlots`).
// - Only future slots. Days follow the project's time zone (`scheduleSlots` reads the current project, so the caller
//   runs inside withProject(project)).
// Read only: no file is written, nothing is scheduled or run. Generic core: no project names.
import { addDays } from '@/lib/time';
import type { PackageView } from '../content';
import { scheduleSlots } from '../pipelines/store';
import { todayIn } from '../time';
import { repeatAllowed, slotsMadeBy } from './repeat-state';
import { postmakerRoot } from './store/paths';
import { listTemplates } from './store/templates';
import type { ProjectLike, Template } from './types';

export interface RepeatSlot {
  /** The template id (the Proven screen's `t=`). */
  template: string;
  /** The template's name (user content). */
  name: string;
  /** The slot's instant (ISO, UTC). */
  at: string;
}

/** The templates whose Repeat makes posts on their own schedule (proven, Repeat on, not a campaign-slot template). */
export const scheduledRepeat = (t: Template): boolean => t.status === 'proven' && t.repeat?.enabled === true && t.inputs.kind !== 'campaign-slot';

/**
 * The open repeat slots of `project` between `fromDate` and `toDate` (project-zone dates, inclusive), in time order.
 * Empty while the Repeat switch is off. Call inside withProject(project).
 */
export async function repeatSlotsIn(project: Pick<ProjectLike, 'contentDir' | 'timeZone'>, fromDate: string, toDate: string, packages: readonly PackageView[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RepeatSlot[]> {
  if (!(await repeatAllowed(env)).enabled) return [];
  const root = postmakerRoot(project);
  const templates = (await listTemplates(root).catch(() => [] as Template[])).filter(scheduledRepeat);
  if (!templates.length) return [];
  const today = todayIn(project, now);
  const from = fromDate < today ? today : fromDate;
  if (from > toDate) return [];
  const out: RepeatSlot[] = [];
  for (const t of templates) {
    const r = t.repeat!;
    const owners = [...new Set([t.migratedFrom ?? t.id, t.id])];
    const made = new Map<string, string>();
    for (const p of packages) if (p.pipeline && owners.includes(p.pipeline.id)) made.set(p.pipeline.slotAt, p.id);
    for (const [at, e] of await slotsMadeBy(root, owners)) if (!made.has(at)) made.set(at, e.recipeId);
    // perWeek counts from the week's Monday (as the daily run does), so the slots start there and the past is dropped.
    const slots = scheduleSlots({ perWeek: r.perWeek, days: r.days, times: r.times, makeAheadDays: r.makeAheadDays }, addDays(from, -6), toDate);
    const exact = new Set(slots.map((s) => s.at));
    const spare = new Map<string, number>();
    for (const at of made.keys()) {
      if (exact.has(at) || !Number.isFinite(Date.parse(at))) continue;
      const day = todayIn(project, Date.parse(at));
      spare.set(day, (spare.get(day) ?? 0) + 1);
    }
    for (const s of slots) {
      if (made.has(s.at)) continue;
      const left = spare.get(s.date) ?? 0;
      if (left > 0) {
        spare.set(s.date, left - 1);
        continue;
      }
      if (s.date < from || Date.parse(s.at) <= now) continue;
      out.push({ template: t.id, name: t.name, at: s.at });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.template < b.template ? -1 : 1));
}
