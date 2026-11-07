// motion presets (the animation guide ids): six presets, only the six curve ids and the seven
// transition ids, the frame table, and the curve shapes of quality.
import { describe, expect, it } from 'vitest';
import { CURVE_IDS, curveAt, curveFrames, SETTLE_NATURAL_FRAMES, springAt, stickerWobbleDeg, highlightProgress } from '@/lib/studio/postmaker/render/curves';
import { PRESET_IDS, PRESETS, presetForSegment, segmentBounds, TRANSITION_IDS } from '@/lib/studio/postmaker/render/presets';

describe('segment motion presets', () => {
  it('has exactly the six preset ids with the frame table', () => {
    expect([...PRESET_IDS]).toEqual(['hook', 'story', 'interrupt', 'demo-chant', 'reveal', 'endcard']);
    expect(PRESET_IDS.map((p) => [p, PRESETS[p].shot, PRESETS[p].defaultFrames, PRESETS[p].minFrames, PRESETS[p].maxFrames])).toEqual([
      ['hook', 'wide', 690, 180, null],
      ['story', 'medium', 510, 120, null],
      ['interrupt', 'card', 210, 60, 210],
      ['demo-chant', 'insert', [240, 150], [150, 90], null],
      ['reveal', 'card', 210, 60, null],
      ['endcard', 'card', 270, 180, 270],
    ]);
  });

  it('every row uses only the core curve ids and transition ids', () => {
    for (const p of PRESET_IDS)
      for (const r of PRESETS[p].rows) {
        if (r.curve !== null) expect(CURVE_IDS, `${p}/${r.id}`).toContain(r.curve);
        if (r.transition) expect(TRANSITION_IDS, `${p}/${r.id}`).toContain(r.transition);
      }
    expect(PRESETS.hook.rows.map((r) => r.id)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']);
    expect(PRESETS['demo-chant'].rows.filter((r) => r.part === 'chant').map((r) => r.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
  });

  it('maps segments to presets and binds demo and chant separately', () => {
    expect(presetForSegment('escalation')).toBe('story');
    expect(presetForSegment('chant')).toBe('demo-chant');
    expect(segmentBounds('demo')).toEqual({ min: 150, max: null });
    expect(segmentBounds('chant')).toEqual({ min: 90, max: null });
    expect(segmentBounds('endcard')).toEqual({ min: 180, max: 270 });
  });
});

describe('curves (quality)', () => {
  it('pop-in: 0.80 → 1.06 → 1.00 over 6 + 3 frames, opacity 0 → 1', () => {
    expect(curveFrames('pop-in')).toBe(9);
    expect(curveAt('pop-in', -1)).toMatchObject({ opacity: 0, scale: 0.8 });
    expect(curveAt('pop-in', 0).scale).toBeCloseTo(0.8);
    expect(curveAt('pop-in', 6).scale).toBeCloseTo(1.06);
    expect(curveAt('pop-in', 6).opacity).toBe(1);
    expect(curveAt('pop-in', 9)).toEqual({ opacity: 1, scale: 1, x: 0, y: 0 });
  });

  it('slide-in, punch, out-fast and whip have their frame counts and end states', () => {
    expect(curveAt('slide-in', 0)).toMatchObject({ opacity: 0, y: 24 });
    expect(curveAt('slide-in', 6)).toMatchObject({ opacity: 1, y: 0 });
    expect(curveAt('punch', 3).scale).toBeCloseTo(1.08);
    expect(curveAt('punch', 3, { peak: 1.04 }).scale).toBeCloseTo(1.04);
    expect(curveAt('punch', 7).scale).toBe(1);
    expect(curveAt('out-fast', 4).opacity).toBe(0);
    expect(curveAt('out-fast', 2).opacity).toBeGreaterThan(0.5); // easeIn: not linear
    expect(curveAt('whip', 7, { dir: -1 }).x).toBeCloseTo(-1080);
  });

  it('settle: the spring overshoots about 11 % and settles in about 16 frames (measured)', () => {
    let peak = 0;
    for (let f = 0; f < 60; f++) peak = Math.max(peak, springAt(f / 30));
    expect(peak).toBeGreaterThan(1.08);
    expect(peak).toBeLessThan(1.14);
    expect(SETTLE_NATURAL_FRAMES).toBeGreaterThanOrEqual(14);
    expect(SETTLE_NATURAL_FRAMES).toBeLessThanOrEqual(20);
  });

  it('component motion: highlight 5 frames, sticker wobble ±6° decaying over 12 frames', () => {
    expect(highlightProgress(0)).toBe(0);
    expect(highlightProgress(5)).toBe(1);
    expect(Math.max(...Array.from({ length: 12 }, (_, f) => Math.abs(stickerWobbleDeg(f))))).toBeLessThanOrEqual(6);
    expect(stickerWobbleDeg(12)).toBe(0);
  });
});
