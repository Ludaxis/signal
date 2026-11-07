import { describe, expect, it } from 'vitest';
import { TIMEZONE, isTimeZone, todayInZone, zoneCity, zonedToUtc } from '@/lib/time';
import { DEFAULT_TIME_ZONE, dstChangesIn, formatIn, instantIn, partsIn, projectTimeZone, timeZoneLabel, todayIn, wallToUtcIn } from '@/lib/studio/time';

// The test env sets a European Studio zone with daylight saving; Europe/Berlin shares its clock changes.
const BER = { timeZone: 'Europe/Berlin' };
const TEH = { timeZone: 'Asia/Tehran' };
const NONE = {}; // a project made before project time zones

describe('project time zones', () => {
  it('defaults to the Studio zone', () => {
    expect(DEFAULT_TIME_ZONE).toBe(TIMEZONE);
    expect(projectTimeZone(NONE)).toBe(TIMEZONE);
    expect(projectTimeZone(null)).toBe(TIMEZONE);
    expect(projectTimeZone({ timeZone: 'Not/AZone' })).toBe(TIMEZONE);
    expect(projectTimeZone(TEH)).toBe('Asia/Tehran');
    expect(projectTimeZone('Asia/Tehran')).toBe('Asia/Tehran');
    expect(isTimeZone('Asia/Tehran')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(zoneCity('America/New_York')).toBe('New York');
    expect(zoneCity('Europe/Berlin')).toBe('Berlin');
  });

  it('todayIn follows the 2026-10-25 clock change, like the Studio-zone helper', () => {
    for (const iso of ['2026-10-24T21:59:00Z', '2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T22:59:00Z', '2026-10-25T23:00:00Z']) {
      expect(todayIn(NONE, Date.parse(iso))).toBe(todayInZone(Date.parse(iso)));
      expect(todayIn(BER, Date.parse(iso))).toBe(todayInZone(Date.parse(iso)));
    }
    expect(todayIn(BER, Date.parse('2026-10-24T21:59:00Z'))).toBe('2026-10-24');
    expect(todayIn(BER, Date.parse('2026-10-24T22:00:00Z'))).toBe('2026-10-25');
    expect(todayIn(BER, Date.parse('2026-10-25T22:59:00Z'))).toBe('2026-10-25');
    expect(todayIn(BER, Date.parse('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
    expect(partsIn(BER, '2026-10-25T00:59:00Z').offsetMinutes).toBe(120);
    expect(partsIn(BER, '2026-10-25T01:00:00Z').offsetMinutes).toBe(60);
    expect(instantIn(BER, '2026-10-24', '18:00')).toBe('2026-10-24T16:00:00.000Z');
    expect(instantIn(BER, '2026-10-25', '18:00')).toBe('2026-10-25T17:00:00.000Z');
    expect(formatIn(BER, '2026-10-25T17:00:00Z')).toBe('Sun 25 Oct, 18:00');
    const fold = wallToUtcIn(BER, '2026-10-25', '02:30');
    expect(fold.ok).toBe(false);
    if (!fold.ok) expect(fold.message).toBe('02:30 happens twice on Sun 25 Oct in Europe/Berlin (clocks go back). Pick another time.');
    expect(dstChangesIn(BER, ['2026-10-24', '2026-10-25'])).toEqual([expect.objectContaining({ date: '2026-10-25', direction: 'back', fromLocal: '03:00', toLocal: '02:00' })]);
  });

  it('uses Asia/Tehran (UTC+3:30, no DST) when the project sets it', () => {
    expect(todayIn(TEH, Date.parse('2026-10-25T20:29:00Z'))).toBe('2026-10-25');
    expect(todayIn(TEH, Date.parse('2026-10-25T20:30:00Z'))).toBe('2026-10-26');
    expect(todayIn(BER, Date.parse('2026-10-25T20:30:00Z'))).toBe('2026-10-25');
    expect(partsIn(TEH, '2026-10-24T12:00:00Z').offsetMinutes).toBe(210);
    expect(partsIn(TEH, '2026-10-26T12:00:00Z').offsetMinutes).toBe(210);
    expect(instantIn(TEH, '2026-10-25', '18:00')).toBe('2026-10-25T14:30:00.000Z');
    expect(formatIn(TEH, '2026-10-25T14:30:00Z')).toBe('Sun 25 Oct, 18:00');
    expect(dstChangesIn(TEH, ['2026-10-24', '2026-10-25', '2026-10-26'])).toEqual([]);
    expect(zonedToUtc('2026-10-25', '02:30', 'Asia/Tehran')).toEqual({ ok: true, iso: '2026-10-24T23:00:00.000Z' });
  });

  it('labels times with the project zone', () => {
    expect(timeZoneLabel(BER)).toBe('Times in Europe/Berlin');
    expect(timeZoneLabel(TEH)).toBe('Times in Asia/Tehran');
    expect(formatIn(TEH, null)).toBe('—');
  });
});
