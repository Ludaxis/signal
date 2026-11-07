// Quality (offline part): the prefixes of a 6-letter Persian word give 6 steps, the first 5
// ending with U+200D; the font coverage check reports a ZWJ glyph in the bundled display face. The golden frames of
// the same reveal are the @render suite's (render-golden.test.ts). Also: faces are verified by their pinned sha256.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionMeasure } from '@/lib/studio/postmaker/executors/captions';
import { coreFonts, FontHashError, fontLog, measuringFont, resolveFonts, verifyFonts, zwjCoverage } from '@/lib/studio/postmaker/render/fonts';
import { lettersOf, letterStagger, ZWJ, zwjPrefixes, zwjStepFrames } from '@/lib/studio/postmaker/render/zwj';

const WORD = 'حرفینو'; // a fictional six-letter word [Pack example: the fixture pack's placeholder brand]

describe('ZWJ prefix reveal', () => {
  it('a 6-letter word gives 6 steps; steps 1-5 end with ZWJ; step 6 is the word', () => {
    const steps = zwjPrefixes(WORD);
    expect(lettersOf(WORD)).toHaveLength(6);
    expect(steps).toHaveLength(6);
    steps.slice(0, 5).forEach((s, k) => {
      expect(s.endsWith(ZWJ)).toBe(true);
      expect(s.replace(ZWJ, '')).toBe([...WORD].slice(0, k + 1).join(''));
    });
    expect(steps[5]).toBe(WORD);
  });

  it('combining marks stay with their letter', () => {
    expect(lettersOf('بَد')).toEqual(['بَ', 'د']);
  });

  it('frames follow preset reveal: S + 6, then one step every 5 frames; en letters every 3 frames', () => {
    expect(zwjStepFrames(100, 6)).toEqual([106, 111, 116, 121, 126, 131]);
    const en = letterStagger(100, 'Abc');
    expect(en.letters.map((l) => l.at)).toEqual([106, 109, 112]);
    expect(en.punchAt).toBe(121);
  });

  it('the font coverage check reports a ZWJ glyph in both core Persian faces', () => {
    for (const f of coreFonts().filter((x) => x.role !== 'latin')) expect(zwjCoverage(f), f.family).toMatchObject({ zwj: true, zwnj: true });
  });
});

describe('bundled faces', () => {
  it('core faces are Vazirmatn (text), Estedad (display) and Instrument Sans (latin), pinned by sha256, and the log lists every hash', () => {
    const fonts = coreFonts();
    expect(fonts.map((f) => [f.family, f.role])).toEqual([
      ['Vazirmatn', 'text'],
      ['Estedad', 'display'],
      ['Instrument Sans', 'latin'],
    ]);
    expect(() => verifyFonts(fonts)).not.toThrow();
    expect(fontLog(fonts)).toEqual(fonts.map((f) => `font ${f.family} (${f.role}) sha256 ${f.sha256}`));
  });

  it('without a pack Latin face the render uses the core Latin face (no warning); a pack Latin face still wins', () => {
    const core = resolveFonts();
    expect(core.warnings).toEqual([]);
    const latin = core.fonts.find((f) => f.role === 'latin')!;
    expect(latin).toMatchObject({ family: 'Instrument Sans', src: 'fonts/instrument-sans/InstrumentSans-Latin-700.woff2', weights: '700' });
    expect(measuringFont(latin).measure('Your turn tonight.', 64, 700)).toBeGreaterThan(0);
    // English captions are measured with it, not with the Persian face's Latin glyphs.
    expect(captionMeasure('en', core.fonts).font.family).toBe('Instrument Sans');
    expect(captionMeasure('fa', core.fonts).font.family).toBe('Vazirmatn');
    const packLatin = { ...latin, family: 'Pack Sans' };
    expect(resolveFonts([packLatin]).fonts.find((f) => f.role === 'latin')!.family).toBe('Pack Sans');
  });

  it('refuses a face whose bytes do not match its pin', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'signal-font-'));
    try {
      const f = coreFonts()[0]!;
      const copy = path.join(dir, 'x.woff2');
      copyFileSync(f.file, copy);
      writeFileSync(copy, Buffer.concat([Buffer.from('x'), Buffer.from(f.file)]));
      expect(() => verifyFonts([{ ...f, file: copy }])).toThrow(FontHashError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('measures shaped Persian widths, wider at heavier weights (variable HVAR)', () => {
    const font = measuringFont(coreFonts()[0]!);
    const w4 = font.measure('سلام دنیا', 80, 400);
    const w8 = font.measure('سلام دنیا', 80, 800);
    expect(w4).toBeGreaterThan(200);
    expect(w8).toBeGreaterThan(w4);
    // joining forms are narrower than three isolated letters
    expect(font.measure('ببب', 80)).toBeLessThan(3 * font.measure('ب', 80));
  });
});
