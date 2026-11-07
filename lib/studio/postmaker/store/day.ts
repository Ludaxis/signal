// Calendar days and wall times in a project's own IANA time zone. Uses Intl, so daylight-saving changes are
// exact; a project without `timeZone` uses DEFAULT_TIME_ZONE from lib/studio/time, the one default for the Studio.
// An unknown zone is not replaced by the default here: it fails with a 'time-zone' error, so a typo cannot move a ledger day.
import { DEFAULT_TIME_ZONE } from '@/lib/studio/time';
import { PostmakerError } from '../errors';
import type { ProjectLike } from '../types';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new PostmakerError(400, 'time-zone', `Unknown time zone ${timeZone}.`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(timeZone: string, instant: string | number | Date): Record<string, string> {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new PostmakerError(400, 'time', 'Invalid time.');
  const map: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(d)) map[p.type] = p.value;
  return map;
}

/** The project's time zone, or the Studio default when it has none. */
export const zoneOf = (p: Pick<ProjectLike, 'timeZone'> | null | undefined): string => p?.timeZone || DEFAULT_TIME_ZONE;

/** 'YYYY-MM-DD' of `instant` in `timeZone`. */
export function dayIn(timeZone: string, instant: string | number | Date): string {
  const m = parts(timeZone, instant);
  return `${m.year}-${m.month}-${m.day}`;
}

/** 'HH:MM:SS' (24 h) of `instant` in `timeZone`. */
export function timeIn(timeZone: string, instant: string | number | Date): string {
  const m = parts(timeZone, instant);
  return `${String(Number(m.hour) % 24).padStart(2, '0')}:${m.minute}:${m.second}`;
}

/** 'YYYY-MM' of `instant` in `timeZone` (informational month totals). */
export const monthIn = (timeZone: string, instant: string | number | Date) => dayIn(timeZone, instant).slice(0, 7);
