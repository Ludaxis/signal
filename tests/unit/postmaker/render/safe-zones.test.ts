// Quality: safeZones.ts exports the union table; for each canvas a box at the
// text-rectangle corners passes and a box 1 px into any reserve fails, including the right rail at (961, 1100).
import { describe, expect, it } from 'vitest';
import { boxOf, checkBox, REEL_BANDS, SAFE_ZONES, textBox, type CanvasId } from '@/lib/studio/postmaker/render/safeZones';

const CANVASES = Object.keys(SAFE_ZONES) as CanvasId[];
const px = (x: number, y: number) => ({ x, y, width: 1, height: 1 });

describe('safe zones (quality)', () => {
  it('holds the reel union: top 0-267, bottom 1500-1919, sides 60, right rail x ≥ 960 from y 1100', () => {
    const r = Object.fromEntries(SAFE_ZONES.reel.reserves.map((x) => [x.id, x.box]));
    expect(r.top).toEqual(boxOf([0, 1079], [0, 267]));
    expect(r.bottom).toEqual(boxOf([0, 1079], [1500, 1919]));
    expect(r['side-left']).toEqual(boxOf([0, 59], [0, 1919]));
    expect(r['side-right']).toEqual(boxOf([1021, 1079], [0, 1919]));
    expect(r['right-rail']).toEqual(boxOf([960, 1079], [1100, 1919]));
    expect(SAFE_ZONES.reel.text).toEqual({ x: [108, 972], y: [316, 1452], rail: { fromY: 1100, x1: 912 } });
    expect(SAFE_ZONES.story.text).toEqual({ x: [108, 972], y: [298, 1612] });
    expect(SAFE_ZONES['feed-portrait'].text).toEqual({ x: [108, 972], y: [150, 1200] });
    expect(SAFE_ZONES['feed-square'].text).toEqual({ x: [108, 972], y: [108, 972] });
    expect(REEL_BANDS.headline).toEqual([360, 700]);
  });

  for (const c of CANVASES) {
    it(`${c}: a box at each text-rectangle corner passes`, () => {
      const t = SAFE_ZONES[c].text;
      const right = (y: number) => (t.rail && y >= t.rail.fromY ? t.rail.x1 : t.x[1]);
      for (const [x, y] of [
        [t.x[0], t.y[0]],
        [right(t.y[0]), t.y[0]],
        [t.x[0], t.y[1]],
        [right(t.y[1]), t.y[1]],
      ] as const)
        expect(checkBox(c, px(x, y)), `${c} (${x}, ${y})`).toEqual([]);
      expect(checkBox(c, textBox(c, { belowRail: Boolean(t.rail) }))).toEqual([]);
    });

    it(`${c}: a box 1 px into any reserve fails`, () => {
      const z = SAFE_ZONES[c];
      for (const r of z.reserves) {
        // The reserve's pixel nearest the text area.
        const x = Math.min(Math.max(r.box.x, z.text.x[0]), r.box.x + r.box.width - 1);
        const y = Math.min(Math.max(r.box.y, z.text.y[0]), r.box.y + r.box.height - 1);
        const v = checkBox(c, px(x, y), { text: false, critical: true });
        expect(v.map((e) => e.zone), `${c} ${r.id} at (${x}, ${y})`).toContain(r.id);
      }
      // and 1 px outside the text area on every side
      const t = z.text;
      for (const [x, y] of [
        [t.x[0] - 1, t.y[0]],
        [t.x[1] + 1, t.y[0]],
        [t.x[0], t.y[0] - 1],
        [t.x[0], t.y[1] + 1],
      ] as const)
        expect(checkBox(c, px(x, y)).length, `${c} (${x}, ${y})`).toBeGreaterThan(0);
    });
  }

  it('the right rail fails at (961, 1100) for text and for faces, and 913 fails for text below the rail', () => {
    expect(checkBox('reel', px(961, 1100)).map((v) => v.rule)).toContain('right-rail');
    expect(checkBox('reel', px(961, 1100), { text: false, critical: true }).map((v) => v.zone)).toContain('right-rail');
    expect(checkBox('reel', px(961, 1099), { text: false, critical: true })).toEqual([]);
    expect(checkBox('reel', px(913, 1100)).map((v) => v.zone)).toEqual(['text-rail']);
    expect(checkBox('reel', px(912, 1100))).toEqual([]);
  });

  it('feed and cover crops: critical content outside the centred crops fails', () => {
    expect(checkBox('feed-portrait', boxOf([200, 300], [100, 200]), { text: false, critical: true }).map((v) => v.zone)).toContain('grid-1x1');
    expect(checkBox('reel-cover', boxOf([200, 300], [300, 400]), { text: false, critical: true }).map((v) => v.zone)).toContain('cover-1x1');
  });
});
