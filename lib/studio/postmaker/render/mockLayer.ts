// The MOCK layer's geometry and colours, shared by the component and the pixel
// checks. Two parts: a translucent diagonal stripe across the frame, so a reviewer in Proof can still
// read the captions and the end card under it, and two solid MOCK bands inside the top and bottom platform reserves
// (quality: no content may sit there), which the pixel check reads on every frame. Pure module: no imports.

export const MOCK_TEXT = 'MOCK';
export const MOCK_COLOUR = { r: 230, g: 30, b: 60 } as const;
/** The diagonal stripe's opacity (the letters on it are white at the same opacity plus 0.15). */
export const MOCK_STRIPE_OPACITY = 0.4;
/** Solid bands inside the reel reserves (top rows 0-267, bottom rows 1500-1919). */
export const MOCK_BANDS = [
  { id: 'top', y: 96, height: 140 },
  { id: 'bottom', y: 1680, height: 160 },
] as const;
/** The fixed region the pixel check reads: the bottom band's upper strip, clear of its letters. */
export const MOCK_PROBE = { x: 60, y: 1688, width: 960, height: 28 } as const;
