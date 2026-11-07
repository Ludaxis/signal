// Quality: typeScale('caption','fa') returns a size between 70 and 92 and a line-height of
// 1.45; a text layer below the absolute minimum fails the render validation with the layer id.
import { describe, expect, it } from 'vitest';
import { faSizeOf, MIN_SIZE, TYPE_TABLE, typeScale, validateTextLayers, type TypeRole } from '@/lib/studio/postmaker/render/typeScale';

describe('type scale (quality)', () => {
  it("typeScale('caption','fa') is 70-92 px with line-height 1.45", () => {
    const t = typeScale('caption', 'fa');
    expect(t.size).toBeGreaterThanOrEqual(70);
    expect(t.size).toBeLessThanOrEqual(92);
    expect(t.size % 2).toBe(0);
    expect(t.lineHeight).toBe(1.45);
    expect(typeScale('caption', 'en')).toMatchObject({ range: [64, 84], lineHeight: 1.15 });
  });

  it('FA sizes follow EN × 1.1 (the table is authoritative, within 2 px), FA leading is larger', () => {
    for (const role of Object.keys(TYPE_TABLE) as TypeRole[]) {
      const r = TYPE_TABLE[role];
      expect(Math.abs(faSizeOf(r.en[0]) - r.fa[0]), role).toBeLessThanOrEqual(2);
      expect(Math.abs(faSizeOf(r.en[1]) - r.fa[1]), role).toBeLessThanOrEqual(2);
      if (r.lh.en !== null) expect(r.lh.fa!, role).toBeGreaterThan(r.lh.en);
    }
  });

  it('a layer below the absolute minimum fails with its layer id; the AI label keeps its own size', () => {
    const v = validateTextLayers([
      { id: 'page-l01-0', role: 'caption', lang: 'fa', sizePx: 82 },
      { id: 'tag-l02', role: 'tag', lang: 'fa', sizePx: 38 },
      { id: 'tag-l03', role: 'tag', lang: 'en', sizePx: 34 },
      { id: 'ai', role: 'ai-label', lang: 'fa', sizePx: 26 },
    ]);
    expect(v.filter((x) => x.rule === 'below-minimum').map((x) => x.layerId)).toEqual(['tag-l02', 'tag-l03']);
    expect(v[0]!.message).toContain('tag-l02');
    expect(MIN_SIZE.video).toEqual({ en: 36, fa: 40 });
  });
});
