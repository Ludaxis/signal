// Text contrast (quality, WCAG 2.x relative luminance): text on the highlight marker switches to a computed
// contrast colour of at least 4.5:1 against the marker. Pure module (imports only render/curves), so the Remotion
// bundle can use it.
import { highlightProgress } from './curves';

const hex = (c: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const s = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join('') : m[1]!;
  return [0, 2, 4].map((k) => parseInt(s.slice(k, k + 2), 16)) as [number, number, number];
};

/** WCAG relative luminance of a #rgb / #rrggbb colour (0 black … 1 white); null for anything else. */
export function luminance(c: string): number | null {
  const rgb = hex(c);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1…21); 1 when either colour cannot be read. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 1;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const HIGHLIGHT_MIN_CONTRAST = 4.5;

/**
 * The text colour on a background: the first candidate (in preference order, the palette's text colour first)
 * that reaches `min`; when none does, near-black or white, whichever contrasts more.
 */
export function contrastText(background: string, candidates: string[], min = HIGHLIGHT_MIN_CONTRAST): string {
  for (const c of candidates) if (contrastRatio(c, background) >= min) return c;
  return contrastRatio('#16161D', background) >= contrastRatio('#FFFFFF', background) ? '#16161D' : '#FFFFFF';
}

/**
 * The token's colour at a frame. A highlighted or emphasised word sits on the marker (pack accent fill): once the marker is half grown its text switches to the ink colour that reads on the accent (the palette
 * text first, then the plate, ≥ 4.5:1). Text is never drawn in the accent colour.
 */
export function tokenColour(t: { enter: number; emphasis?: boolean; highlight?: boolean }, frame: number, o: { colour: string; accent: string; plate: string | null }): string {
  const land = t.enter + 6;
  if ((t.highlight || t.emphasis) && highlightProgress(frame - (land + 2)) >= 0.5) return markerInk(o);
  return o.colour;
}

/** The ink colour of a word on the accent marker. */
export const markerInk = (o: { colour: string; accent: string; plate: string | null }): string => contrastText(o.accent, [o.colour, o.plate ?? '#FFFFFF']);
