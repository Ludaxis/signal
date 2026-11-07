// Safe zones: the one module that holds the platform reserves for every canvas.
// The renderer, the deterministic checks, Proof's overlay and the render workspace all read these numbers. The numbers are volatile (platform UI changes); edit them here only.
//
// Ranges in the quality bar are inclusive pixel rows/columns ("top 0-267" = rows 0…267). A `Box` is
// { x, y, width, height } in canvas pixels; it covers columns x…x+width−1 and rows y…y+height−1.
// Pure module: no imports, so the Remotion bundle and the render workspace can import it.

export type CanvasId = 'reel' | 'story' | 'feed-portrait' | 'feed-square' | 'reel-cover';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An inclusive pixel range [first, last]. */
export type Span = [number, number];

export interface TextArea {
  x: Span;
  y: Span;
  /** From this row down, text must end at `x1` (the reel's right rail). */
  rail?: { fromY: number; x1: number };
}

export interface CanvasZone {
  id: CanvasId;
  width: number;
  height: number;
  /** Areas where no text and no face may be (platform UI). */
  reserves: { id: string; box: Box }[];
  /** Where text may sit (the 48 px gutter is already applied). */
  text: TextArea;
  /** Critical content (hook, product, faces) must also sit inside every one of these crops. */
  crops: { id: string; box: Box }[];
}

const W = 1080;
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
/** A box from inclusive ranges. */
export const boxOf = (x: Span, y: Span): Box => box(x[0], y[0], x[1] - x[0] + 1, y[1] - y[0] + 1);

const SIDES = (h: number) => [
  { id: 'side-left', box: boxOf([0, 59], [0, h - 1]) },
  { id: 'side-right', box: boxOf([1021, 1079], [0, h - 1]) },
];

const REEL: CanvasZone = {
  id: 'reel',
  width: W,
  height: 1920,
  reserves: [
    { id: 'top', box: boxOf([0, 1079], [0, 267]) },
    { id: 'bottom', box: boxOf([0, 1079], [1500, 1919]) },
    ...SIDES(1920),
    // Right rail (like, comment, share): no text or faces at x ≥ 960 when y ≥ 1100.
    { id: 'right-rail', box: boxOf([960, 1079], [1100, 1919]) },
  ],
  text: { x: [108, 972], y: [316, 1452], rail: { fromY: 1100, x1: 912 } },
  crops: [],
};

export const SAFE_ZONES: Record<CanvasId, CanvasZone> = {
  reel: REEL,
  story: {
    id: 'story',
    width: W,
    height: 1920,
    reserves: [{ id: 'top', box: boxOf([0, 1079], [0, 249]) }, { id: 'bottom', box: boxOf([0, 1079], [1660, 1919]) }, ...SIDES(1920)],
    text: { x: [108, 972], y: [298, 1612] },
    crops: [],
  },
  'feed-portrait': {
    id: 'feed-portrait',
    width: W,
    height: 1350,
    reserves: SIDES(1350),
    text: { x: [108, 972], y: [150, 1200] },
    crops: [
      { id: 'grid-1x1', box: boxOf([0, 1079], [135, 1215]) },
      { id: 'grid-3x4', box: boxOf([34, 1046], [0, 1349]) },
    ],
  },
  'feed-square': {
    id: 'feed-square',
    width: W,
    height: 1080,
    reserves: SIDES(1080),
    text: { x: [108, 972], y: [108, 972] },
    crops: [],
  },
  'reel-cover': {
    ...REEL,
    id: 'reel-cover',
    text: { x: [108, 972], y: [420, 1452], rail: { fromY: 1100, x1: 912 } },
    crops: [
      { id: 'cover-3x4', box: boxOf([0, 1079], [240, 1680]) },
      { id: 'cover-1x1', box: boxOf([0, 1079], [420, 1500]) },
    ],
  },
};

/** Reel layout bands (extending BRAND_KI). Inclusive rows. */
export const REEL_BANDS = {
  topRow: [268, 344] as Span,
  headline: [360, 700] as Span,
  action: [700, 1380] as Span,
  lower: [1380, 1452] as Span,
  bottomReserve: [1500, 1919] as Span,
} as const;

/** The AI pill's anchor on every frame: top row, x 108 (presets "apply to every preset"). */
export const AI_LABEL_ANCHOR = { x: 108, y: 280 } as const;

export const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export interface ZoneViolation {
  rule: 'reserve' | 'text-area' | 'right-rail' | 'crop';
  zone: string;
  message: string;
}

/**
 * Checks one box. `text` boxes must sit inside the text area (and respect the rail); every box with `critical`
 * (faces, hook, product) must avoid every reserve and sit inside every crop. A text box is critical by default.
 */
export function checkBox(canvas: CanvasId, b: Box, o: { text?: boolean; critical?: boolean } = {}): ZoneViolation[] {
  const z = SAFE_ZONES[canvas];
  const text = o.text ?? true;
  const critical = o.critical ?? text;
  const out: ZoneViolation[] = [];
  const x1 = b.x + b.width - 1;
  const y1 = b.y + b.height - 1;
  if (critical) {
    for (const r of z.reserves) if (intersects(r.box, b)) out.push({ rule: r.id === 'right-rail' ? 'right-rail' : 'reserve', zone: r.id, message: `Inside the ${r.id} reserve` });
    for (const c of z.crops) if (!contains(c.box, b)) out.push({ rule: 'crop', zone: c.id, message: `Outside the ${c.id} crop` });
  }
  if (text) {
    const t = z.text;
    if (b.x < t.x[0] || x1 > t.x[1] || b.y < t.y[0] || y1 > t.y[1]) out.push({ rule: 'text-area', zone: 'text', message: 'Outside the text area' });
    else if (t.rail && y1 >= t.rail.fromY && x1 > t.rail.x1) out.push({ rule: 'right-rail', zone: 'text-rail', message: `Text below y ${t.rail.fromY} must end by x ${t.rail.x1}` });
  }
  return out;
}

/** The text area as a box (for layout); `belowRail` gives the narrower rect used under the rail. */
export function textBox(canvas: CanvasId, o: { belowRail?: boolean } = {}): Box {
  const t = SAFE_ZONES[canvas].text;
  const x1 = o.belowRail && t.rail ? t.rail.x1 : t.x[1];
  return boxOf([t.x[0], x1], t.y);
}

/**
 * Insets of the reel reserves (top, right, bottom, left) for renderers that lay out with insets. The right inset
 * is the side reserve only; the right rail is a separate rule (`checkBox`).
 */
export function reelInsets(): { top: number; right: number; bottom: number; left: number } {
  return { top: 268, right: 60, bottom: 420, left: 60 };
}
