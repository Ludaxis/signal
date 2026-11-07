// Frame comparison for the @render suite: pixel-diff ratio (quality: ≤ 0.5 %) and SSIM on luma
// (≥ 0.98), both on raw RGB decoded with sharp. Goldens are cropped to the band that holds the
// subject so they stay small and the diff measures the text, not the background.
import sharp from 'sharp';

export interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

export async function rawOf(file: string | Buffer, crop?: { left: number; top: number; width: number; height: number }): Promise<Raw> {
  let img = sharp(file).removeAlpha();
  if (crop) img = img.extract(crop);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Share of pixels whose largest channel difference exceeds `threshold` (0-255). */
export function diffRatio(a: Raw, b: Raw, threshold = 48): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let diff = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const d = Math.max(Math.abs(a.data[o]! - b.data[o]!), Math.abs(a.data[o + 1]! - b.data[o + 1]!), Math.abs(a.data[o + 2]! - b.data[o + 2]!));
    if (d > threshold) diff++;
  }
  return diff / n;
}

const luma = (r: Raw) => {
  const out = new Float64Array(r.width * r.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * r.data[i * 3]! + 0.587 * r.data[i * 3 + 1]! + 0.114 * r.data[i * 3 + 2]!;
  return out;
};

/** Mean SSIM over 8×8 windows (stride 4) on luma. */
export function ssim(a: Raw, b: Raw): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const x = luma(a);
  const y = luma(b);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let count = 0;
  for (let j = 0; j + 8 <= a.height; j += 4)
    for (let i = 0; i + 8 <= a.width; i += 4) {
      let mx = 0;
      let my = 0;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        const k = (j + v) * a.width + i + u;
        mx += x[k]!;
        my += y[k]!;
      }
      mx /= 64;
      my /= 64;
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        const k = (j + v) * a.width + i + u;
        sx += (x[k]! - mx) ** 2;
        sy += (y[k]! - my) ** 2;
        sxy += (x[k]! - mx) * (y[k]! - my);
      }
      sx /= 63;
      sy /= 63;
      sxy /= 63;
      sum += ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx * mx + my * my + C1) * (sx + sy + C2));
      count++;
    }
  return count ? sum / count : 0;
}

/** Share of pixels in a region close to a colour (per-channel distance ≤ tol). */
export function colourShare(r: Raw, box: { x: number; y: number; width: number; height: number }, rgb: { r: number; g: number; b: number }, tol = 60): number {
  let hit = 0;
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++) {
      const o = (y * r.width + x) * 3;
      if (Math.abs(r.data[o]! - rgb.r) <= tol && Math.abs(r.data[o + 1]! - rgb.g) <= tol && Math.abs(r.data[o + 2]! - rgb.b) <= tol) hit++;
    }
  return hit / (box.width * box.height);
}
