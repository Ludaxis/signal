// Proven helpers: URL state for the template screen, the pills, the
// variant line, the length chips with what cannot be made, the Repeat form's field errors and the next campaign
// slot that prefills Make a post.
import { describe, expect, it } from 'vitest';
import { nextSlot, pmLocation, pmParams, repeatErrors, repeatForm, repeatInput, REPEAT_DEFAULT, sameRepeat, templatePills, variantLengths, variantLine } from '@/app/studio/postmaker/model';
import { checkRepeat } from '@/lib/studio/postmaker/template-rules';

describe('URL state for Proven', () => {
  it('reads and writes t=<templateId>; a malformed id is dropped; a recipe wins', () => {
    expect(pmLocation('?tab=postmaker&t=tpl-20261107-ab12')).toMatchObject({ t: 'tpl-20261107-ab12', r: null });
    expect(pmLocation('?tab=postmaker&t=../x').t).toBeNull();
    expect(pmLocation('?tab=postmaker&t=tpl-20261107-ab12&r=rc-20261107-ab12').t).toBeNull();
    expect(pmParams({ t: 'tpl-20261107-ab12', view: 'proven' })).toEqual({ t: 'tpl-20261107-ab12' });
    expect(pmParams({ t: 'tpl-20261107-ab12', r: 'rc-20261107-ab12', s: 'pipeline' })).toEqual({ r: 'rc-20261107-ab12', s: 'pipeline' });
  });
});

describe('pills and lines', () => {
  const rep = { ...checkRepeat({ perWeek: 3, days: [0], times: ['18:00'], makeAheadDays: 3, dailyUsd: 2, approve: 'ask' }), enabled: true };
  it('Repeats is a modifier only while Repeat is on and the template is not retired', () => {
    expect(templatePills({ status: 'proven', repeat: null })).toEqual(['Proven']);
    expect(templatePills({ status: 'proven', repeat: rep })).toEqual(['Proven', 'Repeats']);
    expect(templatePills({ status: 'draft', repeat: { ...rep, enabled: false } })).toEqual(['Draft']);
    expect(templatePills({ status: 'retired', repeat: rep })).toEqual(['Retired']);
  });
  it('a variant line falls back to the template for what it leaves out', () => {
    const base = { languages: ['fa', 'en'] as ('fa' | 'en')[], lengthSec: 45, shape: '9:16' as const };
    expect(variantLine({}, base)).toBe('Persian + English · 45 s · 9:16');
    expect(variantLine({ lang: 'en', lengthSec: 30 }, base)).toBe('English · 30 s · 9:16');
  });
  it('length chips: 15 s cannot be made by the core template (30-90 s); the template length is offered', () => {
    expect(variantLengths(45)).toEqual([
      { sec: 15, ok: false },
      { sec: 30, ok: true },
      { sec: 45, ok: true },
      { sec: 60, ok: true },
    ]);
  });
});

describe('the Repeat form', () => {
  it('the default is off and valid; it round-trips through the server rule unchanged', () => {
    const input = repeatInput(REPEAT_DEFAULT)!;
    expect(input).toEqual({ enabled: false, perWeek: 3, days: [0, 2, 4], times: ['18:00'], makeAheadDays: 3, dailyUsd: 2, approve: 'ask' });
    const stored = checkRepeat(input);
    expect(sameRepeat(repeatInput(repeatForm(stored)), stored)).toBe(true);
  });
  it('each out-of-range field is named', () => {
    const f = { ...REPEAT_DEFAULT, perWeek: '15', makeAheadDays: '0', dailyUsd: '25', times: ['25:00'], days: [] };
    expect(repeatErrors(f)).toEqual({ perWeek: true, days: true, times: true, makeAheadDays: true, dailyUsd: true });
    expect(repeatInput(f)).toBeNull();
    expect(repeatErrors({ ...REPEAT_DEFAULT, dailyUsd: '0.49' })).toEqual({ dailyUsd: true });
    expect(repeatErrors({ ...REPEAT_DEFAULT, dailyUsd: '$0.50', perWeek: '14', makeAheadDays: '7' })).toEqual({});
    expect(repeatErrors({ ...REPEAT_DEFAULT, times: ['18:00', '18:00'] })).toEqual({ times: true });
    expect(repeatErrors({ ...REPEAT_DEFAULT, perWeek: '2.5' })).toEqual({ perWeek: true });
  });
});

describe('Make a post prefill: the next planned slot of an attached campaign', () => {
  const NOW = Date.parse('2026-11-07T10:00:00Z');
  const slot = (id: string, at: string, o: Record<string, unknown> = {}) => ({ id, at, status: 'planned' as const, angle: `Angle ${id}`, ...o });
  it('earliest future planned slot naming no other template; past, made and other-template slots are skipped', () => {
    const plans = {
      'c-20261101-aaaa': { slots: [slot('s1', '2026-11-06T18:00:00Z'), slot('s2', '2026-11-09T18:00:00Z'), slot('s3', '2026-11-08T18:00:00Z', { status: 'made' })] },
      'c-20261101-bbbb': { slots: [slot('s4', '2026-11-08T09:00:00Z', { templateId: 'tpl-20261107-ffff' }), slot('s5', '2026-11-08T12:00:00Z', { templateId: 'tpl-20261107-ab12' })] },
    };
    expect(nextSlot('tpl-20261107-ab12', ['c-20261101-aaaa', 'c-20261101-bbbb'], plans, NOW)).toMatchObject({ campaignId: 'c-20261101-bbbb', slot: { id: 's5' }, topic: 'Angle s5' });
    expect(nextSlot('tpl-20261107-ab12', ['c-20261101-aaaa'], plans, NOW)).toMatchObject({ slot: { id: 's2' } });
    expect(nextSlot('tpl-20261107-ab12', [], plans, NOW)).toBeNull();
  });
});
