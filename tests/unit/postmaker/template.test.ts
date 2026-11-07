// @vitest-environment node
// Pack templates (project-): the schema and cross-field checks, and the core scaling
// rule. Quality bar on the fixture pack's pov-story-spine template ([Pack example]): scaling to 85,
// 30 and 45 s without overrides (each at its variant's BPM) keeps every segment inside its limits and sums to the
// total ±1 frame, with no escalation at 30 s; the variant overrides give the boundaries exactly; a 5 s end card
// is rejected. Every scaled segment also fits the motion presets (segmentBounds).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { defaultBpm, parseTemplate, scaleTemplate, scaleVariant, variantBpm, type PackTemplate, type ScaledTemplate } from '@/lib/studio/postmaker/pack/template';
import { segmentBounds } from '@/lib/studio/postmaker/render/presets';

const FILE = path.resolve(__dirname, '../../fixtures/postmaker/pack-example/templates/pov-story-spine.json');
const raw = () => JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown> & { segments: Record<string, unknown>[] };
const tpl = (): PackTemplate => parseTemplate(raw(), { fileId: 'pov-story-spine', packLanguages: ['fa', 'en'], characterIds: ['char-lead', 'char-elder'] });
const variant = (id: string) => tpl().variants!.find((v) => v.id === id)!;

const code = (fn: () => unknown, c: string) => {
  try {
    fn();
  } catch (e) {
    expect(isPostmakerError(e, c), String(e)).toBe(true);
    return (e as Error).message;
  }
  throw new Error(`expected ${c}`);
};

function inLimits(t: PackTemplate, s: ScaledTemplate) {
  expect(s.boundaries[0]).toBe(0);
  expect(s.boundaries.at(-1)).toBe(Math.round(s.totalSec * 30));
  expect(Math.abs(s.segments.reduce((a, x) => a + x.sec, 0) * 30 - s.totalSec * 30)).toBeLessThanOrEqual(1);
  for (const x of s.segments) {
    const seg = t.segments.find((y) => y.id === x.id)!;
    expect(x.sec, x.id).toBeGreaterThanOrEqual(seg.minSec - 1e-6);
    if (seg.maxSec !== undefined) expect(x.sec, x.id).toBeLessThanOrEqual(seg.maxSec + 1e-6);
    const p = segmentBounds(x.id);
    expect(x.to - x.from, `${x.id} frames vs preset min`).toBeGreaterThanOrEqual(p.min);
    if (p.max !== null) expect(x.to - x.from, `${x.id} frames vs preset max`).toBeLessThanOrEqual(p.max);
  }
}

describe('template file', () => {
  it('the fixture template parses with its four variants and the default options', () => {
    const t = tpl();
    expect(t).toMatchObject({ id: 'pov-story-spine', builder: 'story-spine@1', fps: 30, options: { storyboard: false, draftPreview: false } });
    expect(t.variants!.map((v) => v.id)).toEqual(['v1-hero', 'v2-cutdown', 'v3-setting-swap', 'slice-30']);
    expect(defaultBpm(t)).toBe(109);
  });

  it('refuses a wrong file name, shares that do not add up, an unknown token, a mismatched preset, an unknown cast id and a template too short for its segments', () => {
    code(() => parseTemplate(raw(), { fileId: 'other' }), 'template.id-mismatch');
    code(() => parseTemplate({ ...raw(), segments: raw().segments.map((s, i) => (i === 0 ? { ...s, share: 0.5 } : s)) }), 'template.shares');
    code(() => parseTemplate({ ...raw(), segments: raw().segments.map((s, i) => (i === 0 ? { ...s, require: ['sparkles'] } : s)) }), 'template.token-unknown');
    code(() => parseTemplate({ ...raw(), segments: raw().segments.map((s, i) => (i === 0 ? { ...s, preset: 'endcard' } : s)) }), 'template.preset-mismatch');
    code(() => parseTemplate(raw(), { characterIds: ['char-lead'] }), 'template.cast-unknown');
    code(() => parseTemplate({ ...raw(), durationSec: { min: 20, max: 90 } }), 'template.too-short');
    code(() => parseTemplate({ ...raw(), segments: [...raw().segments].reverse() }), 'template.invalid');
  });

  it('refuses a variant whose declared BPM is outside the template tempo range', () => {
    const r = raw() as unknown as { tempo: { bpmRange: [number, number] }; variants: { id: string; bpm?: number }[] };
    const [lo, hi] = r.tempo.bpmRange;
    for (const bpm of [lo - 1, hi + 1]) {
      const bad = { ...r, variants: r.variants.map((v, i) => (i === 0 ? { ...v, bpm } : v)) };
      expect(() => parseTemplate(bad)).toThrow(new RegExp(`Variant ${r.variants[0]!.id} is set to ${bpm} BPM; this template allows ${lo} to ${hi} BPM`));
      code(() => parseTemplate(bad), 'template.invalid');
    }
    const edge = { ...r, variants: r.variants.map((v, i) => (i === 0 ? { ...v, bpm: lo } : i === 1 ? { ...v, bpm: hi } : v)) };
    expect(parseTemplate(edge).variants![0]!.bpm).toBe(lo);
  });
});

describe('scaling and', () => {
  it('the worked example: 30 s at 120 BPM drops escalation and gives frames 0, 183, 318, 390, 540, 660, 720, 900', () => {
    const t = tpl();
    const s = scaleTemplate(t, { totalSec: 30, bpm: 120 });
    expect(s.segments.map((x) => x.id)).toEqual(['hook', 'story', 'interrupt', 'demo', 'chant', 'reveal', 'endcard']);
    expect(s.boundaries).toEqual([0, 183, 318, 390, 540, 660, 720, 900]);
    inLimits(t, s);
  });

  it('85, 30 and 45 s without overrides (at V1, V2 and V3 BPM) stay inside every limit; escalation only above 40 s', () => {
    const t = tpl();
    for (const [sec, bpm] of [[85, 100], [30, 120], [45, 110]] as const) {
      const s = scaleTemplate(t, { totalSec: sec, bpm });
      inLimits(t, s);
      expect(s.segments.some((x) => x.id === 'escalation'), `${sec} s`).toBe(sec >= 40);
    }
  });

  it('with the variant overrides the boundaries equal the table exactly', () => {
    const t = tpl();
    const table: Record<string, number[]> = {
      'v1-hero': [0, 23, 40, 47, 55, 60, 69, 76, 85],
      'v2-cutdown': [0, 6, 10, 12, 17, 20, 23, 30],
      'v3-setting-swap': [0, 9, 17, 20, 27, 31, 35, 38, 45],
    };
    for (const [id, secs] of Object.entries(table)) {
      const v = variant(id);
      const s = scaleTemplate(t, { totalSec: v.lengthSec, bpm: v.bpm, segmentSec: v.segmentSec });
      expect(s.boundaries, id).toEqual(secs.map((x) => x * 30));
      inLimits(t, s);
    }
  });

  it('the slice-30 variant gives the slice recipe fixture its beat boundaries (100 BPM: chant cards on downbeats)', () => {
    const t = tpl();
    const v = variant('slice-30');
    const s = scaleTemplate(t, { totalSec: 30, bpm: v.bpm, segmentSec: v.segmentSec });
    inLimits(t, s);
    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../fixtures/postmaker/recipe-story-spine.json'), 'utf8')) as { recipe: { beats: { segment: string; start: number; end: number }[]; tempo: { bpm: number } } };
    expect(fixture.recipe.beats.map((b) => [b.segment, Math.round(b.start * 30), Math.round(b.end * 30)])).toEqual(s.segments.map((x) => [x.id, x.from, x.to]));
    const chant = s.segments.find((x) => x.id === 'chant')!;
    const beatFrames = (60 / fixture.recipe.tempo.bpm) * 30;
    expect(chant.from % beatFrames).toBe(0); // the first chant card starts on a beat of the declared grid
    expect(Math.floor((chant.to - chant.from) / (2 * beatFrames))).toBeGreaterThanOrEqual(3); // colourCards>=3
  });

  it('an override set that breaks a limit is rejected: an end card of 5 s, a missing segment, a wrong total', () => {
    const t = tpl();
    const v2 = variant('v2-cutdown').segmentSec!;
    expect(code(() => scaleTemplate(t, { totalSec: 30, segmentSec: { ...v2, endcard: 5, hook: 8 } }), 'template.override-invalid')).toMatch(/endcard/);
    const { reveal: _r, ...missing } = v2;
    void _r;
    code(() => scaleTemplate(t, { totalSec: 30, segmentSec: missing }), 'template.override-invalid');
    code(() => scaleTemplate(t, { totalSec: 30, segmentSec: { ...v2, endcard: 8 } }), 'template.override-invalid');
    code(() => scaleTemplate(t, { totalSec: 30, segmentSec: { ...v2, escalation: 1 } }), 'template.override-invalid');
  });

  it('documents a limit of the template: at 30 s and its default 109 BPM the hook cannot absorb the bars (template.cannot-scale)', () => {
    const t = tpl();
    expect(code(() => scaleTemplate(t, { totalSec: 30 }), 'template.cannot-scale')).toMatch(/hook/);
    code(() => scaleTemplate(t, { totalSec: 95, bpm: 100 }), 'template.cannot-scale');
  });
});

describe('the variant BPM in the scaling rule', () => {
  it('a variant scales at its declared BPM; a variant without one at the template default; an unknown variant is 404', () => {
    const t = tpl();
    for (const v of t.variants!) {
      const s = scaleVariant(t, v.id);
      expect(s.bpm, v.id).toBe(v.bpm);
      expect(s).toEqual(scaleTemplate(t, { totalSec: v.lengthSec, bpm: v.bpm, segmentSec: v.segmentSec }));
    }
    // without overrides the BPM moves the bars: 85 s at the variant's 100 BPM vs the default 109
    const plain = { ...t, variants: [{ id: 'at-100', label: 'At 100', lengthSec: 85, bpm: 100 }, { id: 'no-bpm', label: 'Default', lengthSec: 85 }] };
    const at100 = scaleVariant(plain, 'at-100');
    expect(at100).toEqual(scaleTemplate(plain, { totalSec: 85, bpm: 100 }));
    expect(at100.barSec).toBe(2.4);
    const def = scaleVariant(plain, 'no-bpm');
    expect(def.bpm).toBe(defaultBpm(t));
    expect(variantBpm(t, null)).toBe(defaultBpm(t));
    expect(def.barSec).not.toBe(at100.barSec);
    code(() => scaleVariant(t, 'missing'), 'template.variant-unknown');
  });
});
