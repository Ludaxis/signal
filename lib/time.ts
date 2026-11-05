// Studio time-zone helpers. All calendar dates are YYYY-MM-DD in the Studio's time zone
// (NEXT_PUBLIC_SIGNAL_TIME_ZONE, default UTC); all instants are ISO 8601 UTC. Never hard-code
// an offset: zones with daylight saving change offset twice a year.

function pickZone(): string {
  const z = (process.env.NEXT_PUBLIC_SIGNAL_TIME_ZONE ?? '').trim();
  if (!z) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: z });
    return z;
  } catch {
    return 'UTC';
  }
}

/** The IANA time zone every calendar day, posting time and daily window is expressed in. */
export const TIMEZONE = pickZone();

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface ZonedParts {
  date: string;
  time: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  offsetMinutes: number;
}

function toDate(input: string | Date | number): Date {
  return input instanceof Date ? input : new Date(input);
}

export function zonedParts(input: string | Date | number): ZonedParts {
  const d = toDate(input);
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(d)) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  const second = Number(map.second);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
    year,
    month,
    day,
    hour,
    minute,
    offsetMinutes,
  };
}

export function offsetMinutesAt(input: string | Date | number): number {
  return zonedParts(input).offsetMinutes;
}

/** "UTC+2", "UTC+1", "UTC+5:30". */
export function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function formatYmd(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Pure calendar arithmetic (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return formatYmd(Date.UTC(y, m - 1, d + days, 12));
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(date: string): number {
  const [y, m, d] = parseDate(date);
  return (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() + 6) % 7;
}

export function startOfWeek(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function todayInZone(now: Date | number = Date.now()): string {
  return zonedParts(now).date;
}

export function isValidDate(date: string | null | undefined): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = parseDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export type WallToUtcResult =
  | { ok: true; iso: string }
  | { ok: false; reason: 'gap' | 'fold' | 'invalid'; message: string };

/**
 * Converts wall time in the Studio time zone to UTC. Like the API, rejects a time that does
 * not exist (spring-forward gap) or exists twice (autumn fold).
 */
export function zonedToUtc(date: string, time: string): WallToUtcResult {
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!isValidDate(date) || !tm) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date and time.' };
  }
  const [y, m, d] = parseDate(date);
  const wall = Date.UTC(y, m - 1, d, Number(tm[1]), Number(tm[2]));
  const offsets = new Set([
    offsetMinutesAt(wall - 86_400_000),
    offsetMinutesAt(wall),
    offsetMinutesAt(wall + 86_400_000),
  ]);
  const matches: number[] = [];
  for (const off of offsets) {
    const utc = wall - off * 60_000;
    const back = zonedParts(utc);
    if (back.date === date && back.time === time) matches.push(utc);
  }
  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'gap',
      message: `${time} does not exist on ${formatDateLabel(date)} in ${TIMEZONE} (clocks go forward). Pick another time.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'fold',
      message: `${time} happens twice on ${formatDateLabel(date)} in ${TIMEZONE} (clocks go back). Pick another time.`,
    };
  }
  return { ok: true, iso: new Date(matches[0]!).toISOString() };
}

export interface DstChange {
  date: string;
  instant: string;
  fromOffset: number;
  toOffset: number;
  direction: 'back' | 'forward';
  /** Local wall time just before the change, e.g. "03:00". */
  fromLocal: string;
  /** Local wall time just after the change, e.g. "02:00". */
  toLocal: string;
}

/** Finds daylight-saving changes on the given calendar dates (Studio time zone). */
export function dstChanges(dates: string[]): DstChange[] {
  const out: DstChange[] = [];
  for (const date of dates) {
    const [y, m, d] = parseDate(date);
    let lo = Date.UTC(y, m - 1, d, 0, 0) - 3 * 3_600_000;
    let hi = Date.UTC(y, m - 1, d, 23, 59) - 0;
    const fromOffset = offsetMinutesAt(lo);
    const toOffset = offsetMinutesAt(hi);
    if (fromOffset === toOffset) continue;
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetMinutesAt(mid) === fromOffset) lo = mid;
      else hi = mid;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (ms: number) => {
      const t = new Date(ms);
      return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
    };
    out.push({
      date,
      instant: new Date(hi).toISOString(),
      fromOffset,
      toOffset,
      direction: toOffset < fromOffset ? 'back' : 'forward',
      fromLocal: local(hi + fromOffset * 60_000),
      toLocal: local(hi + toOffset * 60_000),
    });
  }
  return out;
}

export function describeDstChange(c: DstChange): string {
  const hours = Math.abs(c.fromOffset - c.toOffset) / 60;
  const unit = hours === 1 ? 'hour' : 'hours';
  return c.direction === 'back'
    ? `Clocks go back ${hours} ${unit} on ${formatDateLabel(c.date, true)}: at ${c.fromLocal} it becomes ${c.toLocal} (${formatOffset(c.fromOffset)} → ${formatOffset(c.toOffset)}).`
    : `Clocks go forward ${hours} ${unit} on ${formatDateLabel(c.date, true)}: at ${c.fromLocal} it becomes ${c.toLocal} (${formatOffset(c.fromOffset)} → ${formatOffset(c.toOffset)}).`;
}

const dayLabel = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const longDayLabel = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** "Mon 19 Oct" (or "Monday 19 October" when long). Input is a calendar date in the Studio time zone. */
export function formatDateLabel(date: string, long = false): string {
  const [y, m, d] = parseDate(date);
  return (long ? longDayLabel : dayLabel).format(new Date(Date.UTC(y, m - 1, d, 12))).replace(',', '');
}

/** "18:00" in the Studio time zone. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return zonedParts(iso).time;
}

/** "Mon 19 Oct, 18:00" in the Studio time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = zonedParts(iso);
  return `${formatDateLabel(p.date)}, ${p.time}`;
}

/** "19–25 Oct 2026" style range label for a week. */
export function formatWeekRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const [y1, m1, d1] = parseDate(weekStart);
  const [y2, m2, d2] = parseDate(end);
  const month = (y: number, m: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(new Date(Date.UTC(y, m - 1, 15)));
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${month(y2, m2)} ${y2}`;
  if (y1 === y2) return `${d1} ${month(y1, m1)} – ${d2} ${month(y2, m2)} ${y2}`;
  return `${d1} ${month(y1, m1)} ${y1} – ${d2} ${month(y2, m2)} ${y2}`;
}

/** UTC instant of a wall time in the Studio time zone, throwing on gap/fold (fixtures and defaults only). */
export function zonedInstant(date: string, time: string): string {
  const r = zonedToUtc(date, time);
  if (!r.ok) throw new Error(r.message);
  return r.iso;
}
