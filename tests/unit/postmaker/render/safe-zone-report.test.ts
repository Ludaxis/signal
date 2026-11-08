// The S5 safe-zone report (quality automated check, rubric C3): every 3rd frame and every cut frame, the
// composition's slot boxes (render/slots.ts) against the reserves, text area and rail; zero intersections pass.
// Also runs the 30 s slice fixture through the engine on the fake renderer: its timelines must pass the safe-zone
// report and the flash lint (both required checks), so the @render slice cannot stop on them.
import { describe, expect, it } from 'vitest';
import { tmp } from '../guard';
import { pacingLint } from '@/lib/studio/postmaker/checks/timelineLints';
import { safeZoneReport } from '@/lib/studio/postmaker/checks/safeZone';
import { buildPipeline } from '@/lib/studio/postmaker/graph/build';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { faceMeasure, timelineChecks } from '@/lib/studio/postmaker/executors/compose';
import { timelineFonts } from '@/lib/studio/postmaker/executors/render-chain';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { coreFonts } from '@/lib/studio/postmaker/render/fonts';
import { layoutTimeline } from '@/lib/studio/postmaker/render/layout';
import { fakeRenderChain } from '@/lib/studio/postmaker/render/renderer';
import { textLayerBox, TEXT_WIDTH_BELOW_RAIL, textSlot } from '@/lib/studio/postmaker/render/slots';
import type { TextEl, Timeline } from '@/lib/studio/postmaker/render/timeline';
import { PostmakerEngine } from '@/lib/studio/postmaker/runner';
import { getBytes, getJson } from '@/lib/studio/postmaker/store/objects';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { createRecipe, writePipelineVersion } from '@/lib/studio/postmaker/store/recipes';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { SLICE_VOICE_MS, sliceParams, sliceRecipe } from './slice-fixture';

const fonts = coreFonts();
const measure = faceMeasure(fonts)!;

function base(brand = 'حرفینو'): Timeline {
  return layoutTimeline({
    lang: 'fa',
    beats: [
      { id: 'b01', segment: 'hook', techniques: [], from: 0, to: 100 },
      { id: 'b02', segment: 'chant', techniques: [], from: 100, to: 172 },
      { id: 'b03', segment: 'reveal', techniques: [], from: 172, to: 262 },
      { id: 'b04', segment: 'endcard', techniques: [], from: 262, to: 472 },
    ],
    pages: [{ lineId: 'l01', beatId: 'b01', text: 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.', beatOffsetMs: 0, durationMs: 2000, breaks: [3] }],
    tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
    brand: { text: brand, latin: false },
    endcard: { tagline: 'هر شب یه کلمه', sub: null, cta: 'امشب نوبت توئه!', iconText: 'ح' },
    aiLabel: 'ساخته‌شده با هوش مصنوعی',
    fonts: timelineFonts(fonts),
    mock: false,
    seed: 1,
  });
}

describe('safe-zone report (S5, C3)', () => {
  it('a composed timeline is clear: zero intersections over every 3rd frame and every cut frame', () => {
    const t = base();
    const r = safeZoneReport(t, { measure });
    expect(r.hits).toEqual([]);
    expect(r.sampling).toBe('every 3rd frame and every cut frame');
    // frames 0, 3, … 471 plus the cuts that are not multiples of 3 (100 is a cut: 100 % 3 = 1)
    expect(t.cutFrames).toContain(100);
    expect(r.framesChecked).toBe(Math.ceil(472 / 3) + t.cutFrames.filter((f) => f % 3 !== 0).length);
    expect(timelineChecks(t, 'compose:fa', { measure }).find((c) => c.id === 'compose:fa:safe-zone')).toMatchObject({ ok: true, required: true });
  });

  it('a two-line caption in the lower band runs into the bottom reserve; the hit names the frame and the layer', () => {
    const t = base();
    const cap = t.elements.find((e): e is TextEl => e.kind === 'caption')!;
    const low = { ...cap, id: 'page-low', zone: 'lower' as const, lines: [cap.lines[0]!, cap.lines[0]!] };
    const r = safeZoneReport({ ...t, elements: [...t.elements, low] }, { measure });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]).toMatchObject({ frame: low.from + ((3 - (low.from % 3)) % 3), layer: 'page-low' });
    expect(new Set(r.hits.map((h) => h.zone))).toEqual(new Set(['bottom', 'text']));
    const c = timelineChecks({ ...t, elements: [...t.elements, low] }, 'compose:fa', { measure }).find((x) => x.id === 'compose:fa:safe-zone')!;
    expect(c).toMatchObject({ ok: false, required: true });
    expect(c.evidence).toContain('layer page-low');
  });

  it('the lower band uses the column that ends at the rail (x 912), so one line there is clear', () => {
    expect(textSlot('lower')).toEqual({ left: 108, width: TEXT_WIDTH_BELOW_RAIL, top: 1380 });
    expect(TEXT_WIDTH_BELOW_RAIL).toBe(805);
    const b = textLayerBox({ zone: 'lower', lines: [[]], sizePx: 40, lineHeight: 1.2, style: 'outline' });
    expect(b.x + b.width - 1).toBe(912);
  });

  it('a chant word measured wider than the text area fails; unmeasured it is assumed to fit', () => {
    const t = base('حرفینوحرفینوحرفینو');
    const r = safeZoneReport(t, { measure });
    expect(r.hits.some((h) => h.layer.startsWith('card-') && h.zone === 'text')).toBe(true);
    expect(r.hits.some((h) => h.layer.startsWith('reveal-'))).toBe(true);
    expect(safeZoneReport(t).hits.filter((h) => h.layer.startsWith('card-'))).toEqual([]);
  });
});

describe('the slice fixture passes the required compose checks (fake renderer)', () => {
  it('fa and en: safe zones clear, no flash, pacing lint clean (the fixture takes the template slice-30 cut)', async () => {
    const now = { t: Date.parse('2026-11-06T10:00:00.000Z') };
    const { recipe } = await createRecipe(tmp.root, { id: 'example-project', timeZone: 'Asia/Tehran' }, sliceRecipe(), { now: now.t, id: 'rc-20261106-0901' });
    const built = buildPipeline(recipe, { faces: [] });
    await writePipelineVersion(tmp.root, recipe.id, { ...built, nodes: sliceParams(built.nodes) }, { now: now.t });
    const fakes = { counters: newCounters(), voiceMs: (lineId: string) => SLICE_VOICE_MS[lineId] };
    const engine = new PostmakerEngine({
      root: tmp.root,
      project: { id: 'example-project', timeZone: 'Asia/Tehran' } as never,
      executors: defaultExecutors({ fakes, render: { chain: fakeRenderChain(), ffmpeg: null, readObject: (sha) => getBytes(tmp.root, sha), fonts: () => fonts, workDir: (r, n) => `${tmp.dir}/work/${r}/${n.replace(/:/g, '-')}` } }),
      packLock: null,
      now: () => (now.t += 1000),
    });
    const { estimate } = await engine.estimate(recipe.id, { all: true });
    const run = await (await engine.run({ recipeId: recipe.id, scope: { all: true }, estimateToken: estimate.token })).done;
    expect(run.status).toBe('done');
    for (const lang of ['fa', 'en'] as const) {
      const v = (await readVersion(tmp.root, recipe.id, `compose:${lang}`, (await readHead(tmp.root, recipe.id, `compose:${lang}`)).current!))!;
      const zone = v.checks.find((c) => c.id === `compose:${lang}:safe-zone`)!;
      expect(zone, zone.evidence).toMatchObject({ ok: true, required: true });
      expect(v.checks.find((c) => c.id === `compose:${lang}:flash`)).toBeUndefined();
      expect(v.checks.filter((c) => c.required && !c.ok)).toEqual([]);
      const t = await getJson<Timeline>(tmp.root, v.outputs.find((o) => o.port === 'timeline')!.sha256);
      expect(safeZoneReport(t, { measure }).hits).toEqual([]);
      // Hook complete by frame 60, end card 180-270 frames, no pacing note at all
      expect(t.durationInFrames).toBe(900);
      expect(t.marks.hookComplete).toBeLessThanOrEqual(60);
      const end = t.segments.find((x) => x.segment === 'endcard')!;
      expect(end.to - end.from).toBeGreaterThanOrEqual(180);
      expect(end.to - end.from).toBeLessThanOrEqual(270);
      expect(pacingLint(t)).toEqual([]);
      expect(v.checks.filter((c) => c.id.includes(':pacing:'))).toEqual([]);
    }
  }, 60_000);
});
