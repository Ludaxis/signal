// Captions against the voice alignment (C12, caption-to-alignment match): every spoken
// word is captioned, in order, and each caption page starts on its first word (±1 frame). Coverage = captioned
// spoken words ÷ spoken words; C12 at 5 needs 100 %.
import type { AlignmentDoc, CaptionsDoc } from '../graph/adapters';

const norm = (s: string) => s.normalize('NFC').replace(/[\s‌]+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(' ').filter(Boolean);

export interface CaptionReport {
  spoken: number;
  captioned: number;
  pct: number;
  /** First line where the caption words differ from the spoken words, or a page starts off its word. */
  mismatch: { lineId: string; text: string } | null;
  ok: boolean;
}

export function captionCoverage(alignment: AlignmentDoc, captions: CaptionsDoc, fps = 30): CaptionReport {
  let spoken = 0;
  let captioned = 0;
  let mismatch: CaptionReport['mismatch'] = null;
  const frameTol = 1000 / fps + 1e-6;
  const base = new Map<string, number>();
  for (const line of alignment.lines) {
    const offset = base.get(line.beatId) ?? 0;
    base.set(line.beatId, offset + line.ms);
    const words = line.words.map((w) => ({ ...w, token: norm(w.token) }));
    spoken += words.length;
    const pages = captions.pages.filter((p) => p.lineId === line.id);
    let k = 0;
    for (const p of pages) {
      const pt = tokens(p.text);
      const first = words[k];
      if (first && Math.abs(p.beatOffsetMs - (offset + first.startMs)) > frameTol && !mismatch) mismatch = { lineId: line.id, text: p.text };
      for (const tok of pt) {
        if (words[k] && words[k]!.token === tok) {
          captioned++;
          k++;
        } else if (!mismatch) mismatch = { lineId: line.id, text: p.text };
      }
    }
    if (k < words.length && !mismatch) mismatch = { lineId: line.id, text: words.slice(k).map((w) => w.token).join(' ') };
  }
  const pct = spoken ? Math.floor((captioned / spoken) * 1000) / 10 : 100;
  return { spoken, captioned, pct, mismatch, ok: mismatch === null && captioned === spoken };
}
