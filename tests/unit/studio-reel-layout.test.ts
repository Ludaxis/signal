import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { brandGeometry, brandLayers, brandVariantFor, loadKit, REEL_SAFE, type Kit } from '@/lib/studio/render';

// Geometry of the brand mark against Instagram's Reels safe area (top 268 px, bottom 420 px, x 60..1020).
const kits: [string, () => Promise<Kit>][] = [
  [
    'Studio font with an icon',
    async () => {
      const kit = await loadKit('Demo');
      kit.icon = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#3c24c0' } }).png().toBuffer();
      return kit;
    },
  ],
  ['Studio font without an icon', () => loadKit('Demo')],
];

const bottom = (b: { top: number; height: number }) => b.top + b.height;
const right = (b: { left: number; width: number }) => b.left + b.width;

describe.each(kits)('Brand mark layout (%s)', (_name, make) => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await make();
  });

  it('puts the AI label top-left and the brand mark in the header row, inside the safe area', () => {
    expect(brandVariantFor(1080, 1920)).toBe('reel');
    const g = brandGeometry(kit, 1080, 1920);
    expect(g.variant).toBe('reel');
    expect(g.pill.top).toBeGreaterThanOrEqual(REEL_SAFE.top);
    expect(g.pill.left).toBe(REEL_SAFE.left);
    for (const b of [g.pill, g.name, ...(g.icon ? [g.icon] : [])]) {
      expect(b.top).toBeGreaterThanOrEqual(REEL_SAFE.top);
      expect(bottom(b)).toBeLessThanOrEqual(REEL_SAFE.bottom);
      expect(b.left).toBeGreaterThanOrEqual(REEL_SAFE.left);
      expect(right(b)).toBeLessThanOrEqual(REEL_SAFE.right);
    }
    // Pill and brand mark do not overlap.
    expect(right(g.pill)).toBeLessThan((g.icon ?? g.name).left);
    expect(kit.icon ? Boolean(g.icon) : g.icon === null).toBe(true);
  });

  it('leaves the 1080x1350 post brand mark exactly where it was', async () => {
    expect(brandVariantFor(1080, 1350)).toBe('post');
    const W = 1080;
    const H = 1350;
    const k = kit.icon ? 64 : 0;
    const nw = kit.font.getAdvanceWidth(kit.brandName, 36);
    const lw = kit.font.getAdvanceWidth('AI-generated content', 24);
    const x = W - 40 - nw - (k ? k + 14 : 0);
    const g = brandGeometry(kit, W, H);
    expect(g.variant).toBe('post');
    expect(g.pill).toEqual({ left: 40, top: H - 40 - 46, width: Math.ceil(lw) + 40, height: 46 });
    expect(g.icon).toEqual(k ? { left: Math.round(x), top: H - 104, width: 64, height: 64 } : null);
    expect(g.name).toEqual({ left: Math.round(x + (k ? k + 14 : 0)), top: H - 104 + 12, width: Math.ceil(nw) + 4, height: 46 });
    const layers = await brandLayers(kit, W, H);
    expect(layers.map((l) => [l.left, l.top])).toEqual([...(k ? [[Math.round(x), 1246]] : []), [Math.round(x + (k ? 78 : 0)), 1258], [40, 1264]]);
  });
});
