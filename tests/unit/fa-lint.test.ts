import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintFa, textGateBlockers } from '@/lib/studio/lang/fa/lint';
import { buildHashtagsFa } from '@/lib/studio/lang/fa/hashtags';
import { breakFa, checkBreaks, measureWithFont, widthTestFa } from '@/lib/studio/lang/fa/breaks';
import { normalizeFa } from '@/lib/studio/lang/fa/normalize';
import misspellings from '@/lib/studio/lang/fa/data/misspellings.json';
import { loadWoff2ForMetrics } from './woff2-font';

const Z = '\u200C';
const errors = (s: string, ctx = {}) => lintFa(s, ctx).filter((i) => i.severity === 'error');

describe('lintFa', () => {
  it('1: «آیا میای؟» returns exactly one error, SK-Q1 spanning «آیا»', () => {
    const e = errors('آیا میای؟');
    expect(e).toHaveLength(1);
    expect(e[0]!.ruleId).toBe('SK-Q1');
    expect(e[0]!.span).toEqual([0, 3]);
  });

  it('2: register mix and را after a noun', () => {
    const issues = lintFa(`می${Z}خوام کتاب را بخونم`, { register: 'colloquial' });
    const ids = issues.map((i) => i.ruleId);
    expect(ids).toContain('SK-X3');
    const r = issues.find((i) => i.ruleId === 'SK-R1');
    expect(r?.suggestion).toBe('کتاب رو');
  });

  it('3: copula suggestions (SK-C3, SK-C4, SK-C5)', () => {
    expect(lintFa('پایه است').find((i) => i.ruleId === 'SK-C4')?.suggestion).toBe(`پایه${Z}ست`);
    expect(lintFa('کجا است').find((i) => i.ruleId === 'SK-C3')?.suggestion).toBe('کجاست');
    expect(lintFa('تو است').find((i) => i.ruleId === 'SK-C5')?.suggestion).toBe('توئه');
    expect(lintFa('خوب است').find((i) => i.ruleId === 'SK-C1')?.suggestion).toBe('خوبه');
    expect(lintFa('عالی است').find((i) => i.ruleId === 'SK-C2')?.suggestion).toBe('عالیه');
  });

  it('4: SK-N2 deny-listed shift, SK-N1 in colloquial only', () => {
    expect(lintFa('ایرون').map((i) => i.ruleId)).toContain('SK-N2');
    expect(lintFa('خانه').find((i) => i.ruleId === 'SK-N1')?.suggestion).toBe('خونه');
    const formal = [...lintFa('ایرون', { register: 'formal' }), ...lintFa('خانه', { register: 'formal' })].map((i) => i.ruleId);
    expect(formal).not.toContain('SK-N1');
    expect(formal).not.toContain('SK-N2');
  });

  it('5: a CTA slot in the neutral register fails on a colloquial-only particle', () => {
    const e = errors('نصب کنید دیگه', { register: 'neutral', slot: 'cta-pill' });
    expect(e.map((i) => i.ruleId)).toContain('REG-N');
    expect(errors('نصب کنید', { register: 'neutral', slot: 'cta-pill' })).toEqual([]);
  });

  it('flags Latin runs outside the glossary, digits, elongation, emoji and claims', () => {
    expect(errors('این Zentrix خیلی خوبه').map((i) => i.ruleId)).toContain('MX-1');
    expect(errors('این Zentrix خیلی خوبه', { glossary: ['Zentrix'] }).map((i) => i.ruleId)).not.toContain('MX-1');
    expect(errors('POV: شب بازی', { slot: 'pov-pill' }).map((i) => i.ruleId)).not.toContain('MX-1');
    expect(errors('15 تا').map((i) => i.ruleId)).toContain('NU-1');
    expect(errors('خیلییی خوبه').map((i) => i.ruleId)).toContain('SK-X1');
    expect(lintFa('خیلییی خوبه', { narrated: false, slot: 'sticker' }).find((i) => i.ruleId === 'SK-X1')?.severity).toBe('warning');
    expect(errors('سلام 😄').map((i) => i.ruleId)).toContain('EMO-1');
    expect(errors('رایگان نصب کن').map((i) => i.ruleId)).toContain('CLAIM-1');
    expect(errors('رایگان نصب کن', { claimsAllowFree: true }).map((i) => i.ruleId)).not.toContain('CLAIM-1');
    expect(errors('چی؟؟').map((i) => i.ruleId)).toContain('SK-Q5');
    expect(lintFa('۵ تا حرف').find((i) => i.ruleId === 'NU-2')?.suggestion).toBe('پنج');
    expect(lintFa('۵ GB').map((i) => i.ruleId)).toContain('MX-2');
  });

  it('6: hashtags — underscore, no ZWNJ, editor for heh+ZWNJ, max 5', () => {
    const r = buildHashtagsFa(['بازی فکری', `بی${Z}نظیر`, `خونه${Z}ی ما`]);
    expect(r.tags).toEqual(['#بازی_فکری', '#بینظیر']);
    expect(r.tags.join('')).not.toContain(Z);
    expect(r.needsEditor.map((x) => x.phrase)).toEqual([`خونه${Z}ی ما`]);
    const six = buildHashtagsFa(['word game', 'puzzle', 'family night', 'بازی', 'شب', 'one more']);
    expect(six.tags).toHaveLength(5);
    expect(six.rejected).toEqual([{ phrase: 'one more', reason: 'HT-1' }]);
    expect(buildHashtagsFa(['بازی ۲']).rejected[0]?.reason).toBe('HT-4');
    expect(buildHashtagsFa(['word game']).tags).toEqual(['#WordGame']);
  });

  it('7: breakFa breaks after «،» and never inside an ezafe chain', () => {
    const text = `همه دور کرسی${Z}ان، یکی هندونه می${Z}بُره`;
    expect(breakFa(text, 'kinetic-caption')).toEqual([`همه دور کرسی${Z}ان،`, `یکی هندونه می${Z}بُره`]);
    // ezafe between token 2 («دور») and token 3 («کرسی\u200Cان»)
    const dor = text.indexOf('دور');
    const spans = [{ d: [dor, dor + 3] as [number, number], ezafeAfter: true }];
    const lines = breakFa(text, 'kinetic-caption', spans);
    expect(lines.some((l) => l.endsWith('دور'))).toBe(false);
    // a line without punctuation: without the span the balanced break falls between دور and کرسی\u200Cان
    const plain = `همه دور کرسی${Z}ان نشستن امشب`;
    const d2 = plain.indexOf('دور');
    const withEzafe = breakFa(plain, 'kinetic-caption', [{ d: [d2, d2 + 3], ezafeAfter: true }]);
    for (const l of withEzafe.slice(0, -1)) expect(l.endsWith('دور')).toBe(false);
    expect(checkBreaks(['همه دور', `کرسی${Z}ان نشستن امشب`], 'kinetic-caption', [{ d: [d2, d2 + 3], ezafeAfter: true }]).map((i) => i.ruleId)).toContain('LB-2');
    expect(checkBreaks(['امروز رفتیم به', 'خونه'], 'kinetic-caption').map((i) => i.ruleId)).toEqual(expect.arrayContaining(['LB-3', 'LB-5']));
  });

  it('8: the width test fails a kinetic-caption line wider than 960 px and names the line id', () => {
    // Measured with the bundled text face (public/fonts, sha256-pinned in fonts.lock.json): real advance widths,
    // Arabic joining forms and kerning, at the slot's largest size (92 px).
    const font = loadWoff2ForMetrics(path.resolve(__dirname, '../../public/fonts/vazirmatn/Vazirmatn-Variable.woff2'));
    const measure = measureWithFont(font);
    expect(measure('شب یلداست', 92)).toBeLessThan(960);
    const fails = widthTestFa(
      [
        { id: 'l01', text: 'شب یلداست' },
        { id: 'l02', text: 'این یه خط خیلی خیلی بلنده که جا نمیشه' },
      ],
      'kinetic-caption',
      measure,
    );
    expect(fails.map((f) => f.lineId)).toEqual(['l02']);
    expect(fails[0]!.widthPx).toBeGreaterThan(960);
  });
});

describe('misspellings block the text gate until fixed or overridden', () => {
  it('every error entry in misspellings.json blocks; an override with a reason unblocks', () => {
    for (const e of misspellings.entries.filter((x) => x.severity === 'error')) {
      const issues = lintFa(e.wrong).filter((i) => i.ruleId === e.ruleId);
      expect(issues.length, e.wrong).toBeGreaterThan(0);
      const blockers = textGateBlockers(issues);
      expect(blockers.length, e.wrong).toBeGreaterThan(0);
      const i = issues[0]!;
      expect(textGateBlockers([i], [{ ruleId: i.ruleId, span: i.span, reason: '' }])).toHaveLength(1);
      expect(textGateBlockers([i], [{ ruleId: i.ruleId, span: i.span, reason: 'editor: intended spelling' }])).toHaveLength(0);
    }
  });

  it('lint runs clean on normalised everyday colloquial text', () => {
    const t = normalizeFa('امشب میام خونه\u200Cتون، یه کم دیر میشه.').text;
    expect(errors(t)).toEqual([]);
  });
});
