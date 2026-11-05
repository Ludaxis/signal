import { describe, expect, it } from 'vitest';
import {
  addDays,
  zonedParts,
  zonedToUtc,
  describeDstChange,
  dstChanges,
  formatDateLabel,
  formatOffset,
  formatTime,
  formatWeekRange,
  isValidDate,
  startOfWeek,
  todayInZone,
  weekDates,
} from '@/lib/time';

describe('Amsterdam calendar helpers', () => {
  it('builds the DST week of 2026-10-19 Monday to Sunday', () => {
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19');
    expect(startOfWeek('2026-10-19')).toBe('2026-10-19');
    expect(weekDates('2026-10-19')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(formatWeekRange('2026-10-19')).toBe('19–25 Oct 2026');
    expect(formatWeekRange('2026-10-26')).toBe('26 Oct – 1 Nov 2026');
  });

  it('keeps 18:00 wall time across the change: 16:00Z on Saturday, 17:00Z on Sunday', () => {
    expect(zonedToUtc('2026-10-24', '18:00')).toEqual({ ok: true, iso: '2026-10-24T16:00:00.000Z' });
    expect(zonedToUtc('2026-10-25', '18:00')).toEqual({ ok: true, iso: '2026-10-25T17:00:00.000Z' });
    expect(formatTime('2026-10-24T16:00:00.000000Z')).toBe('18:00');
    expect(formatTime('2026-10-25T17:00:00Z')).toBe('18:00');
  });

  it('reports offsets on both sides of the change', () => {
    expect(zonedParts('2026-10-25T00:59:00Z').offsetMinutes).toBe(120);
    expect(zonedParts('2026-10-25T01:00:00Z').offsetMinutes).toBe(60);
    expect(formatOffset(120)).toBe('UTC+2');
    expect(formatOffset(60)).toBe('UTC+1');
    expect(formatOffset(330)).toBe('UTC+5:30');
  });

  it('rejects the autumn fold (02:30 happens twice) and the spring gap', () => {
    const fold = zonedToUtc('2026-10-25', '02:30');
    expect(fold.ok).toBe(false);
    if (!fold.ok) expect(fold.reason).toBe('fold');
    const gap = zonedToUtc('2026-03-29', '02:30');
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.reason).toBe('gap');
    expect(zonedToUtc('2026-10-25', '03:00')).toEqual({ ok: true, iso: '2026-10-25T02:00:00.000Z' });
    expect(zonedToUtc('2026-13-01', '10:00').ok).toBe(false);
  });

  it('finds exactly one DST change in the week, at 03:00 → 02:00 on Sunday 25 October', () => {
    const changes = dstChanges(weekDates('2026-10-19'));
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.date).toBe('2026-10-25');
    expect(c.direction).toBe('back');
    expect(c.fromOffset).toBe(120);
    expect(c.toOffset).toBe(60);
    expect(c.fromLocal).toBe('03:00');
    expect(c.toLocal).toBe('02:00');
    expect(c.instant.startsWith('2026-10-25T01:00')).toBe(true);
    expect(describeDstChange(c)).toBe('Clocks go back 1 hour on Sunday 25 October: at 03:00 it becomes 02:00 (UTC+2 → UTC+1).');
    expect(dstChanges(weekDates('2026-10-26'))).toEqual([]);
    expect(dstChanges(weekDates('2026-03-23'))[0]?.direction).toBe('forward');
  });

  it('derives today in Amsterdam, not UTC', () => {
    expect(todayInZone(Date.parse('2026-10-18T22:30:00Z'))).toBe('2026-10-19');
    expect(todayInZone(Date.parse('2026-10-25T23:30:00Z'))).toBe('2026-10-26');
  });

  it('formats labels and validates dates', () => {
    expect(formatDateLabel('2026-10-25')).toBe('Sun 25 Oct');
    expect(formatDateLabel('2026-10-25', true)).toBe('Sunday 25 October');
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-10-25')).toBe(true);
  });
});
