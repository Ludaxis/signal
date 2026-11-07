// Product mock for image generation (codex / higgsfield-image): a flat card PNG of the requested size with
// the prompt's first 60 characters and a "MOCK" label, made with sharp from an SVG (no process, no network).
import sharp from 'sharp';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export const mockCardText = (prompt: string): string => [...prompt.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');

export async function mockCardPng(prompt: string, width: number, height: number): Promise<Buffer> {
  const w = Math.max(16, Math.min(4096, Math.round(width)));
  const h = Math.max(16, Math.min(4096, Math.round(height)));
  const fs = Math.max(12, Math.round(w / 28));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#d9d4cc"/><text x="50%" y="12%" text-anchor="middle" font-size="${fs * 2}" font-family="sans-serif" fill="#5a5550">MOCK</text><text x="50%" y="50%" text-anchor="middle" font-size="${fs}" font-family="sans-serif" fill="#2b2926">${esc(mockCardText(prompt))}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
