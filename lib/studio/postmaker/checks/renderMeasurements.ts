// The `measurements` JSON port of `render:<lang>` (RenderMeasurements contract, fed by): what the
// deterministic check reads for C3 (safe zones), C11 (AI label), the bundled-font audit and the chant cards.
// Basis: the timeline the render drew, laid out with the composition's own slots at rest (render/slots.ts, the same
// boxes safe-zone report uses), sampled every 3rd frame plus every cut frame. These are layout measurements,
// not pixel reads of the encoded video; luminance and loudness are not measured here (the check reads the master's
// loudness from the mix and reports luminance as not measured).
import type { Box as RenderBox } from '../render/safeZones';
import { SAFE_ZONES, type CanvasId } from '../render/safeZones';
import type { Timeline } from '../render/timeline';
import type { RenderMeasurements } from '../executors/check';
import { slotsOf, type FaceMeasure } from './safeZone';
import type { LayoutLayer, Reserve } from './safeZoneReport';
import { sampleFrames } from './safeZoneReport';

export const MEASUREMENTS_BASIS = 'timeline slots at rest, every 3rd frame and every cut frame (layout, not pixel-measured)';

/** boxes are {x, y, width, height}; check boxes are {x, y, w, h}. */
export const toCheckBox = (b: RenderBox) => ({ x: b.x, y: b.y, w: b.width, h: b.height });

const layerKind = (kind: string): LayoutLayer['kind'] => (kind === 'phone' ? 'product' : 'text');

export function renderMeasurements(t: Timeline, o: { measure?: FaceMeasure } = {}): RenderMeasurements & { basis: string } {
  const slots = slotsOf(t, o.measure);
  const frames = sampleFrames(t.durationInFrames, t.cutFrames);
  const label = slots.find((s) => s.kind === 'ai-label');
  return {
    basis: MEASUREMENTS_BASIS,
    layout: frames.map((frame) => ({
      frame,
      layers: slots.filter((s) => s.kind !== 'ai-label' && frame >= s.from && frame < s.to).map((s) => ({ id: s.id, kind: layerKind(s.kind), box: toCheckBox(s.box) })),
    })),
    cutFrames: [...t.cutFrames],
    // The composition draws the AI pill on every frame (StorySpine), at its fixed slot.
    aiLabel: label ? frames.map((frame) => ({ frame, present: true, box: toCheckBox(label.box) })) : [],
    fonts: t.fonts.map((f) => ({ family: f.family, sha256: f.sha256 })),
    chantCards: t.elements.filter((e) => e.kind === 'card' && e.text).map((e) => ({ from: e.from, to: e.to })),
  };
}

const CANVAS_BY_SIZE: Record<string, CanvasId> = { '1080x1920': 'reel', '1080x1350': 'feed-portrait', '1080x1080': 'feed-square' };

/** platform reserves for a canvas, in the check's box shape (CheckDeps.reserves). Unknown sizes: none. */
export function reservesFor(canvas: { width: number; height: number }): Reserve[] {
  const id = CANVAS_BY_SIZE[`${canvas.width}x${canvas.height}`];
  return id ? SAFE_ZONES[id].reserves.map((r) => ({ id: r.id, box: toCheckBox(r.box) })) : [];
}
