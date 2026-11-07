// Layout engine: quality (RTL reveal order) and the preset frame rules the composition draws.
import { describe, expect, it } from 'vitest';
import { beatGrid, layoutTimeline, type ComposeLayoutInput } from '@/lib/studio/postmaker/render/layout';
import type { CardEl, EndCardEl, RevealEl, TextEl } from '@/lib/studio/postmaker/render/timeline';
import { measuringFont, coreFonts } from '@/lib/studio/postmaker/render/fonts';

const base = (over: Partial<ComposeLayoutInput> = {}): ComposeLayoutInput => ({
  lang: 'fa',
  beats: [
    { id: 'b01', segment: 'hook', techniques: ['emoji-sticker'], from: 0, to: 180 },
    { id: 'b02', segment: 'chant', techniques: [], from: 180, to: 324 },
    { id: 'b03', segment: 'reveal', techniques: [], from: 324, to: 414 },
    { id: 'b04', segment: 'endcard', techniques: [], from: 414, to: 624 },
  ],
  pages: [
    { lineId: 'l01', beatId: 'b01', text: 'یه روز یه بازی', beatOffsetMs: 0, durationMs: 1600, words: ['یه', 'روز', 'یه', 'بازی'].map((text, k) => ({ text, latin: false, beatOffsetMs: k * 400 })) },
    { lineId: 'l01', beatId: 'b01', text: 'پیدا کردم که باحاله', beatOffsetMs: 1600, durationMs: 1600, words: ['پیدا', 'کردم', 'که', 'باحاله'].map((text, k) => ({ text, latin: false, beatOffsetMs: 1600 + k * 400 })) },
  ],
  tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
  brand: { text: 'حرفینو', latin: false },
  endcard: { tagline: 'هر روز یه کلمه', sub: null, cta: 'همین الان بازی کن', iconText: 'ح' },
  aiLabel: 'AI',
  fonts: [],
  mock: true,
  seed: 7,
  ...over,
});

/** x of each token in a right-to-left line laid out from the right edge of the text box (the browser's RTL flow). */
function rtlX(tokens: string[], measure: (t: string) => number, right = 972) {
  let x = right;
  const space = measure(' ');
  return tokens.map((t) => {
    const w = measure(t);
    const left = x - w;
    x = left - space;
    return left;
  });
}

describe('layout engine', () => {
  it('acceptance 4: for a 4-token Persian page, the token with the largest x has the earliest entry frame', () => {
    const t = layoutTimeline(base());
    const page = t.elements.find((e): e is TextEl => e.kind === 'caption')!;
    const tokens = page.lines.flat();
    expect(tokens).toHaveLength(4);
    const font = measuringFont(coreFonts()[0]!);
    const xs = rtlX(tokens.map((x) => x.text), (s) => font.measure(s, page.sizePx, 800));
    const largest = xs.indexOf(Math.max(...xs));
    const earliest = tokens.reduce((b, x, k) => (x.enter < tokens[b]!.enter ? k : b), 0);
    expect(largest).toBe(0);
    expect(earliest).toBe(largest);
    expect(tokens.map((x) => x.enter)).toEqual([...tokens.map((x) => x.enter)].sort((a, b) => a - b));
  });

  it('hook: first token legible by frame 15, page exits before the next page enters, hook complete recorded', () => {
    const t = layoutTimeline(base());
    const pages = t.elements.filter((e): e is TextEl => e.kind === 'caption');
    expect(t.marks.firstHookTokenOpaque).toBeLessThanOrEqual(15);
    expect(pages[0]!.to).toBeLessThanOrEqual(pages[1]!.lines[0]![0]!.enter);
    expect(t.marks.hookComplete).toBe(pages[1]!.lines.flat().at(-1)!.enter + 6);
  });

  it('chant: cards cut on beat onsets of the declared grid, n × bf frames, adjacent colours differ', () => {
    const t = layoutTimeline(base());
    const cards = t.elements.filter((e): e is CardEl => e.kind === 'card');
    const g = beatGrid(100, 0, 624);
    expect(g.bf).toBe(18);
    expect(cards.length).toBe(4);
    for (const c of cards) {
      expect(g.beats).toContain(c.from);
      expect(c.to - c.from).toBe(36);
      expect(c.text).toBe('حرفینو');
    }
    for (let k = 1; k < cards.length; k++) expect(cards[k]!.colour).not.toBe(cards[k - 1]!.colour);
  });

  it('reveal (fa): six ZWJ steps from S + 6, one every 5 frames, punch on the full word; en uses letter stagger', () => {
    const fa = layoutTimeline(base()).elements.find((e): e is RevealEl => e.kind === 'reveal')!;
    expect(fa.mode).toBe('zwj-prefix');
    expect(fa.steps.map((s) => s.at)).toEqual([330, 335, 340, 345, 350, 355]);
    expect(fa.punchAt).toBe(355);
    const en = layoutTimeline(base({ lang: 'en', brand: { text: 'Wordo', latin: true } })).elements.find((e): e is RevealEl => e.kind === 'reveal')!;
    expect(en.mode).toBe('letter-stagger');
    expect(en.steps.map((s) => s.text).join('')).toBe('Wordo');
  });

  it('end card: tagline tokens stagger 5 frames from S + 14, CTA after the sub-line, pulses stop by E − 31', () => {
    const e = layoutTimeline(base()).elements.find((x): x is EndCardEl => x.kind === 'endcard')!;
    expect(e.tagline.map((t) => t.enter)).toEqual([428, 433, 438, 443]);
    expect(e.pulses.every((p) => p <= 624 - 31)).toBe(true);
    expect(e.cta.text).toBe('همین الان بازی کن');
  });

  it('keeps the TimelineDoc fields for the contracts and adapters', () => {
    const t = layoutTimeline(base());
    expect(t.durationInFrames).toBe(624);
    expect(t.layers.map((l) => l.beatId)).toEqual(['b01', 'b02', 'b03', 'b04']);
    expect(t.coverFrame).toBe(623);
    expect(t.mock).toBe(true);
  });
});
