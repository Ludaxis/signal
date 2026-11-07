// Quality (pacing lint) and 7 (flash lint, C12) on timeline JSON; every violation names its frame.
import { describe, expect, it } from 'vitest';
import { colourChanges, flashLint, pacingLint } from '@/lib/studio/postmaker/checks/timelineLints';

const grid = { bpm: 100, bf: 18, beats: Array.from({ length: 40 }, (_, j) => j * 18), chantBeatsPerCard: 2 as const };

describe('pacing lint', () => {
  it('passes a clean timeline', () => {
    const t = {
      durationInFrames: 300,
      events: [0, 30, 90, 180, 216, 252].map((frame) => ({ frame, kind: 'page' as const })),
      marks: { hookComplete: 58, firstHookTokenOpaque: 9 },
      segments: [{ beatId: 'b01', segment: 'hook' as const, preset: 'hook' as const, from: 0, to: 180 }],
      grid,
      elements: [
        { kind: 'card', from: 180, to: 216 },
        { kind: 'card', from: 216, to: 252 },
      ],
    };
    expect(pacingLint(t)).toEqual([]);
  });

  it('reports a 121-frame gap, a late hook, off-grid and over-long cards and a short end card, each with its frame', () => {
    const t = {
      durationInFrames: 700,
      events: [0, 121, 200, 300, 400, 500, 600].map((frame) => ({ frame, kind: 'cut' as const })),
      marks: { hookComplete: 61, firstHookTokenOpaque: 9 },
      segments: [
        { beatId: 'b01', segment: 'hook' as const, preset: 'hook' as const, from: 0, to: 121 },
        { beatId: 'b09', segment: 'endcard' as const, preset: 'endcard' as const, from: 530, to: 700 },
      ],
      grid,
      elements: [
        { kind: 'card', from: 400, to: 465 },
        { kind: 'card', from: 475, to: 505 },
      ],
    };
    const v = pacingLint(t);
    expect(v.map((x) => [x.rule, x.frame])).toEqual([
      ['beat-gap', 0],
      ['hook-complete', 61],
      ['chant-length', 400],
      ['chant-downbeat', 400],
      ['chant-downbeat', 475],
      ['endcard-length', 530],
    ]);
    expect(v[0]!.message).toContain('121');
  });
});

describe('flash lint (C12)', () => {
  const cards = (len: number, n = 9) => Array.from({ length: n }, (_, k) => ({ kind: 'card', from: k * len, to: (k + 1) * len, colour: ['#E4572E', '#29335C', '#F3A712'][k % 3] }));
  it('chant cards at 10 frames each (3 per second) fail', () => {
    const v = flashLint({ elements: cards(10) });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'flash', frame: 10 });
  });
  it('chant cards at 30 frames each pass', () => {
    expect(flashLint({ elements: cards(30) })).toEqual([]);
  });
});

describe('flash lint counts the reveal fill and the end card (review fix)', () => {
  const bg = '#F4EFE6';
  // the last chant card at 10-25, the reveal 25-35 (fixed dark fill), the end card from 35: three changes in 25 frames
  const elements = [
    { kind: 'scene', from: 0, to: 10, background: bg },
    { kind: 'card', from: 10, to: 25, colour: '#E4572E' },
    { kind: 'scene', from: 25, to: 35, background: bg },
    { kind: 'reveal', from: 25, to: 35, colour: '#F2B705' },
    { kind: 'scene', from: 35, to: 300, background: bg },
    { kind: 'endcard', from: 35, to: 300, colour: bg },
  ];
  it('card → reveal → end card inside one second fails at the first change', () => {
    expect(colourChanges(elements)).toEqual([10, 25, 35]);
    expect(flashLint({ elements })).toEqual([expect.objectContaining({ rule: 'flash', frame: 10 })]);
  });
  it('without the reveal and end card fills (the old rule) only two changes would be seen', () => {
    expect(colourChanges(elements.filter((e) => e.kind === 'scene' || e.kind === 'card'))).toEqual([10, 25]);
  });
  it('the same sequence spread over more than a second passes; a reveal over its own scene is one change, not two', () => {
    const spread = [
      { kind: 'scene', from: 0, to: 10, background: bg },
      { kind: 'card', from: 10, to: 60, colour: '#E4572E' },
      { kind: 'scene', from: 60, to: 150, background: bg },
      { kind: 'reveal', from: 60, to: 150, colour: '#F2B705' },
      { kind: 'scene', from: 150, to: 300, background: bg },
      { kind: 'endcard', from: 150, to: 300, colour: bg },
    ];
    expect(colourChanges(spread)).toEqual([10, 60, 150]);
    expect(flashLint({ elements: spread })).toEqual([]);
  });
});
