// @vitest-environment node
// contracts and adapters: the validators with the tolerances, the contract diff of, and the
// free adapters as pure functions over fixture documents.
import './guard';
import { describe, expect, it } from 'vitest';
import { checkRule, contractDiff, lineBand } from '@/lib/studio/postmaker/graph/contracts';
import { ADAPTERS, layoutMotion, motionContract, rebuildTimeline, recomputeCaptions, relintPostCopy, replanMix, retimeHolds, type AlignmentDoc, type ScriptDoc } from '@/lib/studio/postmaker/graph/adapters';
import type { ExpectRule, PipelineNode } from '@/lib/studio/postmaker/types';

const rule = (id: string, key: ExpectRule['key'], tolerance: ExpectRule['tolerance'], adapter: string | null = null): ExpectRule => ({ id, from: 'up', key, tolerance, label: id, adapter });

const align = (ms: Record<string, number>, beats: Record<string, string>): AlignmentDoc => ({
  lang: 'en',
  lines: Object.entries(ms).map(([id, m]) => ({ id, beatId: beats[id]!, ms: m, words: ['one', 'two', 'three', 'four', 'five'].map((t, i) => ({ token: t, startMs: (m / 5) * i, endMs: (m / 5) * (i + 1) })) })),
});

describe('validators (tolerances)', () => {
  it('lineMs: ±8 % or ±250 ms, whichever is larger, with the violation text the retry gets', () => {
    const r = rule('voice.lineMs.within', 'lineMs', { pct: 8, ms: 250 });
    expect(lineBand(2500, { pct: 8, ms: 250 })).toEqual([2250, 2750]);
    expect(lineBand(5000, { pct: 8, ms: 250 })).toEqual([4600, 5400]);
    expect(checkRule(r, { lineMs: { l03: 2500 } }, { lineMs: { l03: 2625 } }).ok).toBe(true);
    const bad = checkRule(r, { lineMs: { l03: 2500 } }, { lineMs: { l03: 3000 } });
    expect(bad).toMatchObject({ ok: false, text: 'Line l03 must be 2,250-2,750 ms; your take was 3,000 ms' });
    expect(checkRule(r, { lineMs: { l03: 2500 } }, { lineMs: {} }).text).toBe('Line l03 is missing');
  });

  it('clip maximum (lip-sync ≤ 20 s), anchors ±40 px, tempo ±1 BPM, frames exact or ±n, exact keys, recompute', () => {
    expect(checkRule(rule('voice.clip.maxMs', 'lineMs', { ms: 20000 }), {}, { lineMs: { l01: 19999 } }).ok).toBe(true);
    expect(checkRule(rule('voice.clip.maxMs', 'lineMs', { ms: 20000 }), {}, { lineMs: { l01: 20001 } }).ok).toBe(false);
    const a = rule('art.anchors.within', 'anchors', { px: 40 });
    expect(checkRule(a, { anchors: { b01: { x: 0, y: 0, h: 100 } } }, { anchors: { b01: { x: 40, y: -40, h: 140 } } }).ok).toBe(true);
    expect(checkRule(a, { anchors: { b01: { x: 0, y: 0, h: 100 } } }, { anchors: { b01: { x: 41, y: 0, h: 100 } } }).ok).toBe(false);
    const t = rule('music.tempo.within', 'tempo', { bpm: 1 });
    expect(checkRule(t, { tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 } }, { tempo: { bpm: 101, downbeatMs: 0, chantBeatsPerCard: 2 } }).ok).toBe(true);
    expect(checkRule(t, { tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 } }, { tempo: { bpm: 102, downbeatMs: 0, chantBeatsPerCard: 2 } }).ok).toBe(false);
    expect(checkRule(rule('x', 'totalFrames', 'exact'), { totalFrames: 900 }, { totalFrames: 901 }).ok).toBe(false);
    expect(checkRule(rule('x', 'totalFrames', { frames: 1 }), { totalFrames: 900 }, { totalFrames: 901 }).ok).toBe(true);
    expect(checkRule(rule('x', 'lineIds', 'exact'), { lineIds: ['l01', 'l02'] }, { lineIds: ['l01', 'l03'] }).ok).toBe(false);
    expect(checkRule(rule('x', 'cta', 'exact'), { cta: { en: 'Go' } }, { cta: { en: 'Go' } }).ok).toBe(true);
    expect(checkRule(rule('x', 'wordTimings', 'recompute'), { wordTimings: {} }, {}).ok).toBe(true);
  });

  it('beatFrames: ±6 frames per beat and ±15 frames total', () => {
    const r = rule('x', 'beatFrames', { frames: 6 });
    const before = { beatFrames: { b01: [0, 100] as [number, number], b02: [100, 200] as [number, number], b03: [200, 300] as [number, number] } };
    expect(checkRule(r, before, { beatFrames: { b01: [0, 106], b02: [106, 211], b03: [211, 311] } }).ok).toBe(true);
    expect(checkRule(r, before, { beatFrames: { b01: [0, 107], b02: [107, 207], b03: [207, 307] } }).ok).toBe(false);
    expect(checkRule(r, before, { beatFrames: { b01: [0, 106], b02: [106, 212], b03: [212, 318] } }).text).toMatch(/within 15 frames; it moved 18 frames/);
  });
});

describe('contract diff', () => {
  it('names changed sub-keys and only beats whose length changed', () => {
    const d = contractDiff(
      { lineMs: { l02: 2500, l03: 2500 }, beatFrames: { b01: [0, 90], b02: [90, 250], b03: [250, 310] }, totalFrames: 310, tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 } },
      { lineMs: { l02: 2500, l03: 3000 }, beatFrames: { b01: [0, 90], b02: [90, 265], b03: [265, 325] }, totalFrames: 325, tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 } },
      (k) => (k.startsWith('lineMs') ? ['motion:fa'] : ['compose:fa']),
    );
    expect(d).toEqual([
      { key: 'beatFrames.b02', from: [90, 250], to: [90, 265], dependents: ['compose:fa'] },
      { key: 'lineMs.l03', from: 2500, to: 3000, dependents: ['motion:fa'] },
      { key: 'totalFrames', from: 310, to: 325, dependents: ['compose:fa'] },
    ]);
    expect(contractDiff({ tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 } }, { tempo: { bpm: 103, downbeatMs: 0, chantBeatsPerCard: 2 } })[0]!.key).toBe('tempo.bpm');
  });
});

describe('free adapters (pure)', () => {
  const beats = [
    { id: 'b01', targetMs: 3000 },
    { id: 'b02', targetMs: 8000 },
    { id: 'b03', targetMs: 2000 },
  ];
  const lineBeats = { l01: 'b01', l02: 'b02', l03: 'b02' };
  const a0 = align({ l01: 2500, l02: 2500, l03: 2500 }, lineBeats);

  it('motion layout and motion.retimeHolds keep beats and holds; a 5 % longer line moves the length by ≤ 15 frames', () => {
    const m = layoutMotion(beats, a0, 12);
    expect(m.beats.map((b) => [b.id, b.startFrame, b.endFrame])).toEqual([
      ['b01', 0, 87],
      ['b02', 87, 249],
      ['b03', 249, 309],
    ]);
    const a5 = align({ l01: 2500, l02: 2500, l03: 2625 }, lineBeats);
    const r = retimeHolds(m, a5);
    expect(r.beats.map((b) => b.holdFrames)).toEqual([12, 12, 12]);
    expect(r.beats[2]!.endFrame - r.beats[2]!.startFrame).toBe(60); // a beat without lines keeps its length
    expect(r.totalFrames - m.totalFrames).toBeGreaterThan(0);
    expect(r.totalFrames - m.totalFrames).toBeLessThanOrEqual(15);
    expect(motionContract(r).beatFrames!.b02).toEqual([87, 253]);
  });

  it('captions.recompute, compose.rebuild, mix.replan and post-copy.relint follow their inputs', () => {
    const c = recomputeCaptions(a0);
    expect(c.pages.filter((p) => p.lineId === 'l01').map((p) => p.text)).toEqual(['one two three four', 'five']);
    expect(c.pages.find((p) => p.lineId === 'l03')!.beatOffsetMs).toBe(2500); // after l02 in the same beat
    const m = layoutMotion(beats, a0, 12);
    const t = rebuildTimeline(m, c);
    expect(t.durationInFrames).toBe(m.totalFrames);
    expect(t.captions[0]).toMatchObject({ lineId: 'l01', from: 0 });
    expect(replanMix(t).durationFrames).toBe(m.totalFrames);
    const script = { beats: [], lines: [], tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 }, cta: { en: 'Play tonight' } } as ScriptDoc;
    expect(relintPostCopy({ lang: 'en', caption: 'Hello', cta: '', hashtags: [], lint: [] }, script)).toMatchObject({ cta: 'Play tonight', lint: ['The caption does not carry the call to action.'] });
    const node = { id: 'compose:en' } as PipelineNode;
    expect(ADAPTERS['compose.rebuild']!.run({ node, current: {}, inputs: { motion: m, captions: c } }).provides.totalFrames).toBe(m.totalFrames);
    expect(Object.fromEntries(Object.entries(ADAPTERS).map(([k, v]) => [k, v.follows]))).toEqual({
      'captions.recompute': true,
      'motion.retimeHolds': false,
      'compose.rebuild': true,
      'mix.replan': true,
      'post-copy.relint': false,
    });
  });
});
