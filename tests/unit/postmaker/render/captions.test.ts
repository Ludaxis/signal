// Captions (quality -): pages of 3-5 words, ≤ 2 lines, 0.8-2.5 s, never across punctuation when
// a clean cut exists, the bundled-font width test authoritative; Latin runs one unit; Persian per word.
import { describe, expect, it } from 'vitest';
import { breakPage, buildCaptions, CAPTION_MAX_PX, captionMeasure, captionUnits } from '@/lib/studio/postmaker/executors/captions';
import { coreFonts } from '@/lib/studio/postmaker/render/fonts';
import type { AlignmentDoc } from '@/lib/studio/postmaker/graph/adapters';

const words = (text: string, msPerWord = 400) => text.split(' ').map((token, k) => ({ token, startMs: k * msPerWord, endMs: (k + 1) * msPerWord - 20 }));
const align = (lang: 'fa' | 'en', lines: { id: string; text: string; ms?: number }[]): AlignmentDoc => ({
  lang,
  lines: lines.map((l) => ({ id: l.id, beatId: 'b01', ms: l.ms ?? l.text.split(' ').length * 400, words: words(l.text) })),
});
const fa = captionMeasure('fa', coreFonts());

describe('caption paging', () => {
  it('a Persian line of 8 words makes pages of 3-5 words, each 0.8-2.5 s, in reading order', () => {
    const { doc, checks } = buildCaptions({ lang: 'fa', alignment: align('fa', [{ id: 'l01', text: 'امروز یه بازی جدید پیدا کردم که خیلی باحاله' }]), measure: fa.measure });
    expect(doc.pages.length).toBeGreaterThanOrEqual(2);
    for (const p of doc.pages) {
      expect(p.words.length).toBeGreaterThanOrEqual(3);
      expect(p.words.length).toBeLessThanOrEqual(5);
      expect(p.durationMs).toBeGreaterThanOrEqual(800);
      expect(p.durationMs).toBeLessThanOrEqual(2500);
      expect(p.widthPx).toBeLessThanOrEqual(CAPTION_MAX_PX);
    }
    expect(doc.pages.flatMap((p) => p.words.map((w) => w.text)).join(' ')).toBe('امروز یه بازی جدید پیدا کردم که خیلی باحاله');
    expect(checks.filter((c) => c.required)).toEqual([]);
    expect(doc.sizePx).toBe(82);
  });

  it('cuts after punctuation rather than inside a page', () => {
    const { doc } = buildCaptions({ lang: 'fa', alignment: align('fa', [{ id: 'l01', text: '۵ تا حرف بهم داد؛ گفت یه کلمه بساز.' }]), measure: fa.measure });
    expect(doc.pages[0]!.text).toBe('۵ تا حرف بهم داد؛');
  });

  it('keeps consecutive Latin words as one unit (one <bdi> run) and a ZWNJ inside its token', () => {
    const u = captionUnits(words('با Word Craft می‌خوام بازی کنم'));
    expect(u.map((x) => x.text)).toEqual(['با', 'Word Craft', 'می‌خوام', 'بازی', 'کنم']);
    expect(u[1]!.latin).toBe(true);
    expect(captionUnits(words('Tap the tiles now'), 'en').map((x) => x.text)).toEqual(['Tap', 'the', 'tiles', 'now']);
  });

  it('the width test is authoritative: a line too wide for the text area is broken into 2 lines, and fails when nothing fits', () => {
    const ws = ['کتاب'];
    while (fa.measure(ws.join(' ')) <= CAPTION_MAX_PX) ws.push('کتاب');
    expect(fa.measure(ws.join(' '))).toBeGreaterThan(CAPTION_MAX_PX);
    const b = breakPage(ws, 'fa', fa.measure, CAPTION_MAX_PX);
    expect(b.fits).toBe(true);
    expect(b.widthPx).toBeLessThanOrEqual(CAPTION_MAX_PX);
    expect(b.breaks).toHaveLength(1);
    const { checks } = buildCaptions({ lang: 'fa', alignment: align('fa', [{ id: 'l09', text: 'خیلی‌خیلی‌خیلی‌خیلی‌خیلی‌خیلی‌خیلی‌طولانی' }]), measure: fa.measure });
    expect(checks.map((c) => c.id)).toContain('captions:fa:width:l09:0');
  });

  it('marks one highlight and one emphasis token per page only on beats that ask for them', () => {
    const a = align('en', [{ id: 'l01', text: 'Tap the tiles and make a brand new word' }]);
    const m = (t: string) => t.length * 40;
    expect(buildCaptions({ lang: 'en', alignment: a, measure: m }).doc.pages.every((p) => p.highlight === null && p.emphasis === null)).toBe(true);
    const on = buildCaptions({ lang: 'en', alignment: a, measure: m, highlightBeats: new Set(['b01']), emphasisBeats: new Set(['b01']) });
    expect(on.doc.pages.every((p) => p.highlight !== null && p.emphasis !== null)).toBe(true);
  });
});
