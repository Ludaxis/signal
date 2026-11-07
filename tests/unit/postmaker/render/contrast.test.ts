// Quality: text on the highlight marker switches to a computed contrast colour (≥ 4.5:1 against the marker).
// The emphasis word keeps the pack accent on the plate; compose reports (non-blocking) when that is under 3:1.
import { describe, expect, it } from 'vitest';
import { contrastRatio, contrastText, HIGHLIGHT_MIN_CONTRAST, luminance, tokenColour } from '@/lib/studio/postmaker/render/contrast';
import { timelineChecks } from '@/lib/studio/postmaker/executors/compose';
import { CORE_PALETTE, layoutTimeline } from '@/lib/studio/postmaker/render/layout';

describe('WCAG contrast', () => {
  it('luminance and ratio', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(luminance('#000')).toBe(0);
    expect(luminance('red')).toBeNull();
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#16161D', '#F2B705')).toBeGreaterThan(HIGHLIGHT_MIN_CONTRAST);
  });

  it('keeps the first candidate that reaches 4.5:1, else falls back to near-black or white', () => {
    expect(contrastText('#F2B705', ['#16161D', '#FFFFFF'])).toBe('#16161D');
    expect(contrastText('#FFE066', ['#FFFFFF', '#F4EFE6'])).toBe('#16161D'); // a light accent under light text
    expect(contrastText('#2B2D42', ['#16161D', '#FFFFFF'])).toBe('#FFFFFF'); // a dark accent under dark text
  });
});

describe('the highlighted token colour', () => {
  const t = { enter: 10, highlight: true };
  const land = 16; // enter + 6; the marker grows over 5 frames from land + 2
  it('core palette: text stays the palette text colour (it already passes on #F2B705)', () => {
    expect(tokenColour(t, land + 6, { colour: CORE_PALETTE.text, accent: CORE_PALETTE.accent, plate: CORE_PALETTE.plate })).toBe(CORE_PALETTE.text);
  });
  it('a light accent with light text: the token switches once the marker is half grown, and the result passes 4.5:1', () => {
    const o = { colour: '#FFFFFF', accent: '#FFE066', plate: '#2B2D42' };
    expect(tokenColour(t, land + 2, o)).toBe('#FFFFFF'); // marker not started
    const c = tokenColour(t, land + 6, o);
    expect(c).toBe('#2B2D42'); // the plate colour is the next candidate
    expect(contrastRatio(c, o.accent)).toBeGreaterThanOrEqual(HIGHLIGHT_MIN_CONTRAST);
  });
  it('emphasis is a marker word: never accent-coloured text; ink on the accent once the marker is half grown', () => {
    const o = { colour: '#FFFFFF', accent: '#F2B705', plate: '#16161D' };
    expect(tokenColour({ enter: 10, emphasis: true }, land, o)).toBe('#FFFFFF'); // marker not started
    const c = tokenColour({ enter: 10, emphasis: true }, land + 6, o);
    expect(c).not.toBe(o.accent);
    expect(c).toBe('#16161D');
    expect(contrastRatio(c, o.accent)).toBeGreaterThanOrEqual(HIGHLIGHT_MIN_CONTRAST);
  });
});

describe('compose reports emphasis ink that cannot reach 4.5:1 on the marker', () => {
  const timeline = (accent: string) =>
    layoutTimeline({
      lang: 'en',
      beats: [{ id: 'b01', segment: 'story', techniques: [], from: 0, to: 120 }],
      pages: [{ lineId: 'l01', beatId: 'b01', text: 'make a word tonight', beatOffsetMs: 0, durationMs: 2000, emphasis: 2 }],
      tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
      brand: null,
      endcard: { tagline: '', sub: null, cta: '', iconText: '' },
      aiLabel: 'Made with AI',
      palette: { ...CORE_PALETTE, accent },
      fonts: [],
      mock: false,
      seed: 1,
    });
  it('a mid-grey accent no ink reads on: a non-blocking check names the colours', () => {
    const c = timelineChecks(timeline('#777777'), 'compose:en').find((x) => x.id === 'compose:en:contrast:emphasis');
    expect(c).toMatchObject({ ok: false, required: false });
    expect(c!.evidence).toMatch(/ on #777777$/);
  });
  it('the core accent takes the palette ink and adds no check', () => {
    expect(timelineChecks(timeline(CORE_PALETTE.accent), 'compose:en').find((x) => x.id === 'compose:en:contrast:emphasis')).toBeUndefined();
  });
});
