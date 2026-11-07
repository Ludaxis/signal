// Slot geometry (quality): where StorySpine places each layer, in reel pixels. The composition draws from these
// numbers and the safe-zone report (checks/safeZone.ts) checks the same boxes, so the two cannot drift apart.
// Pure module: imports only render/.
import { AI_LABEL_ANCHOR, REEL_BANDS, SAFE_ZONES, type Box } from './safeZones';
import type { EndCardEl, TextEl } from './timeline';
import { typeScale } from './typeScale';

const T = SAFE_ZONES.reel.text;
/** The text column: columns 108-972 (865 px); under the right rail (y ≥ 1100) it ends at 912 (805 px). */
export const TEXT_LEFT = T.x[0];
export const TEXT_WIDTH = T.x[1] - T.x[0] + 1;
export const TEXT_WIDTH_BELOW_RAIL = (T.rail?.x1 ?? T.x[1]) - T.x[0] + 1;
/** The plate's padding around a caption page (the plate itself is decoration; the text keeps the column). */
export const PLATE_PAD = { x: 28, y: 20 } as const;

/** The column a text layer is placed in. The lower band sits under the rail, so it gets the narrower column. */
export function textSlot(zone: TextEl['zone']): { left: number; width: number; top: number } {
  if (zone === 'lower') return { left: TEXT_LEFT, width: TEXT_WIDTH_BELOW_RAIL, top: REEL_BANDS.lower[0] };
  if (zone === 'top-row') return { left: TEXT_LEFT, width: TEXT_WIDTH, top: REEL_BANDS.topRow[0] };
  return { left: TEXT_LEFT, width: TEXT_WIDTH, top: REEL_BANDS.headline[0] };
}

/** The phone insert at rest (demo preset). */
export const PHONE_SLOT: Box = { x: 290, y: 720, width: 500, height: 720 };

/** The end-card column: icon, tagline, sub-line and CTA stacked with a 36 px gap, from y 420. */
export const ENDCARD_SLOT = { left: TEXT_LEFT, width: TEXT_WIDTH, top: 420, gap: 36, icon: 240, ctaPadY: 22, ctaFont: { fa: 56, en: 52 } } as const;

const px = (n: number) => Math.ceil(n);

/** The box of a text layer's lines (inside the plate padding when it has a plate). */
export function textLayerBox(el: Pick<TextEl, 'zone' | 'lines' | 'sizePx' | 'lineHeight' | 'style'>): Box {
  const s = textSlot(el.zone);
  const padded = el.style === 'plate' || el.style === 'plate-highlight' || el.style === 'bubble';
  return { x: s.left, y: s.top + (padded ? PLATE_PAD.y : 0), width: s.width, height: px(Math.max(1, el.lines.length) * el.sizePx * el.lineHeight) };
}

/** The end card's whole column (icon to CTA). */
export function endCardBox(el: Pick<EndCardEl, 'lang' | 'sub'>): Box {
  const tag = typeScale('endcard-tagline', el.lang);
  const sub = typeScale('endcard-sub', el.lang);
  const g = ENDCARD_SLOT.gap;
  const cta = ENDCARD_SLOT.ctaFont[el.lang] * 1.25 + 2 * ENDCARD_SLOT.ctaPadY;
  const h = ENDCARD_SLOT.icon + g + tag.size * (tag.lineHeight ?? 1.3) + (el.sub ? g + sub.size * (sub.lineHeight ?? 1.4) : 0) + g + cta;
  return { x: ENDCARD_SLOT.left, y: ENDCARD_SLOT.top, width: ENDCARD_SLOT.width, height: px(h) };
}

/** A word centred on the frame (chant card, reveal) at `sizePx`; `widthPx` from the bundled face when measured. */
export function centredWordBox(sizePx: number, lineHeight: number, widthPx: number): Box {
  const w = px(widthPx);
  const h = px(sizePx * lineHeight);
  return { x: Math.round(540 - w / 2), y: Math.round(960 - h / 2), width: w, height: h };
}

/** The AI pill (static, every frame). */
export function aiLabelBox(lang: 'fa' | 'en', widthPx: number): Box {
  const t = typeScale('ai-label', lang);
  return { x: AI_LABEL_ANCHOR.x, y: AI_LABEL_ANCHOR.y, width: px(widthPx + 36), height: t.size + 20 };
}
