// Project time zones for Studio code (client and server safe: no Node imports).
// A project may set `timeZone` (an IANA id); projects without one use DEFAULT_TIME_ZONE, so every
// project made before project time zones keeps its days, slots and labels exactly as before. DST
// comes from Intl (lib/time.ts), never from a fixed offset.
import {
  TIMEZONE,
  dstChanges,
  formatDateLabel,
  isTimeZone,
  zonedInstant as zoneInstant,
  zonedParts as zoneParts,
  zonedToUtc as zoneToUtc,
  type DstChange,
  type WallToUtcResult,
  type ZonedParts as ZoneParts,
} from '@/lib/time';

/** The zone of a project that sets none: the Studio zone (NEXT_PUBLIC_SIGNAL_TIME_ZONE, default UTC). */
export const DEFAULT_TIME_ZONE = TIMEZONE;

/** Anything with an optional project time zone: a Project record, a payload row, or nothing. */
export type Zoned = { timeZone?: string | null } | string | null | undefined;

/** The project's IANA time zone, or the default when it sets none or an unknown one. */
export function projectTimeZone(p?: Zoned): string {
  const tz = typeof p === 'string' ? p : p?.timeZone;
  return isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

/** Today's date (YYYY-MM-DD) in the project's time zone. */
export function todayIn(p: Zoned, now: Date | number = Date.now()): string {
  return zoneParts(now, projectTimeZone(p)).date;
}

/** Wall-clock parts of an instant in the project's time zone. */
export function partsIn(p: Zoned, input: string | Date | number): ZoneParts {
  return zoneParts(input, projectTimeZone(p));
}

/** "Mon 19 Oct, 18:00" (24-hour) in the project's time zone; "—" for no date. */
export function formatIn(p: Zoned, input: string | Date | number | null | undefined): string {
  if (input === null || input === undefined || input === '') return '—';
  const x = partsIn(p, input);
  return `${formatDateLabel(x.date)}, ${x.time}`;
}

/** UTC instant of a wall time in the project's zone, refusing times the clock change skips or repeats. */
export function wallToUtcIn(p: Zoned, date: string, time: string): WallToUtcResult {
  return zoneToUtc(date, time, projectTimeZone(p));
}

/** Like wallToUtcIn, throwing on a gap or fold (defaults and fixtures only). */
export function instantIn(p: Zoned, date: string, time: string): string {
  return zoneInstant(date, time, projectTimeZone(p));
}

/** Clock changes on the given dates in the project's zone. */
export function dstChangesIn(p: Zoned, dates: string[]): DstChange[] {
  return dstChanges(dates, projectTimeZone(p));
}

/** The one line that says which zone times are shown in, e.g. "Times in Asia/Tehran". */
export function timeZoneLabel(p: Zoned): string {
  return `Times in ${projectTimeZone(p)}`;
}

/**
 * "Wed 18 Nov" in the project's time zone (en-GB), with the year only when it is not the current one
 * (in that zone); "—" for no date.
 */
export function formatDateIn(p: Zoned, input: string | Date | number | null | undefined, now: Date | number = Date.now()): string {
  if (input === null || input === undefined || input === '') return '—';
  const d = partsIn(p, input).date;
  const year = d.slice(0, 4);
  return year === todayIn(p, now).slice(0, 4) ? formatDateLabel(d) : `${formatDateLabel(d)} ${year}`;
}

/** "Wed 18 Nov, 18:00" (24-hour) in the project's time zone, with the year rule of formatDateIn; "—" for no date. */
export function formatWhenIn(p: Zoned, input: string | Date | number | null | undefined, now: Date | number = Date.now()): string {
  if (input === null || input === undefined || input === '') return '—';
  return `${formatDateIn(p, input, now)}, ${partsIn(p, input).time}`;
}
