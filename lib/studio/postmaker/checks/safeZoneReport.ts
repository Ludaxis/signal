// C3 safe-zone report (C3 evidence): a box-intersection list per sampled frame. Video samples
// every 3rd frame and every cut frame. The reserve rectangles come from the one shared module
// `postmaker/render/safeZones.ts` and are passed in; this file holds no platform numbers.
// Boxes are half-open pixel rectangles: x in [x, x + w), y in [y, y + h).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Reserve {
  id: string;
  box: Box;
}

/** One laid-out layer at one frame (from the render child's measurements). Decoration may cross a reserve (C3 = 3). */
export interface LayoutLayer {
  id: string;
  kind: 'text' | 'face' | 'logo' | 'product' | 'decoration';
  box: Box;
}

export interface LayoutFrame {
  frame: number;
  layers: LayoutLayer[];
}

export interface Intersection {
  frame: number;
  layerId: string;
  reserveId: string;
}

export interface SafeZoneReport {
  ok: boolean;
  sampled: number[];
  intersections: Intersection[];
  /** Decoration crossing a reserve (allowed, but it keeps C3 below 5 only when meaningful content does). */
  decoration: Intersection[];
}

export const intersects = (a: Box, b: Box): boolean => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every 3rd frame from 0, plus every cut frame, in order. */
export function sampleFrames(totalFrames: number, cutFrames: readonly number[] = []): number[] {
  const s = new Set<number>();
  for (let f = 0; f < totalFrames; f += 3) s.add(f);
  for (const c of cutFrames) if (c >= 0 && c < totalFrames) s.add(c);
  return [...s].sort((a, b) => a - b);
}

/**
 * Intersections of meaningful layers (text, faces, logos, the product) with any reserve, on the sampled frames that
 * have measurements. `ok` needs at least one measured frame and zero meaningful intersections.
 */
export function safeZoneReport(frames: readonly LayoutFrame[], reserves: readonly Reserve[], o: { totalFrames?: number; cutFrames?: readonly number[] } = {}): SafeZoneReport {
  const want = o.totalFrames !== undefined ? new Set(sampleFrames(o.totalFrames, o.cutFrames)) : null;
  const intersections: Intersection[] = [];
  const decoration: Intersection[] = [];
  const sampled: number[] = [];
  for (const f of [...frames].sort((a, b) => a.frame - b.frame)) {
    if (want && !want.has(f.frame)) continue;
    sampled.push(f.frame);
    for (const l of f.layers)
      for (const r of reserves) {
        if (!intersects(l.box, r.box)) continue;
        (l.kind === 'decoration' ? decoration : intersections).push({ frame: f.frame, layerId: l.id, reserveId: r.id });
      }
  }
  return { ok: sampled.length > 0 && reserves.length > 0 && intersections.length === 0, sampled, intersections, decoration };
}
