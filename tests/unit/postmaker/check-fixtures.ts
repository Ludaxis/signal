// Shared fixtures for the check tests: synthetic reserves shaped like reel row (the real
// table is render/safeZones.ts), a clean timeline, an alignment, a reviewer answer and a fully measured
// subject. All synthetic; no reference material.
import type { CheckSubject } from '@/lib/studio/postmaker/checks/deterministic';
import type { PacingTimeline } from '@/lib/studio/postmaker/checks/pacing';
import { CRITERIA_IDS, type ReviewerAnswer } from '@/lib/studio/postmaker/checks/rubric';
import type { Reserve } from '@/lib/studio/postmaker/checks/safeZoneReport';
import { recomputeCaptions, type AlignmentDoc } from '@/lib/studio/postmaker/graph/adapters';

export const RESERVES: Reserve[] = [
  { id: 'top', box: { x: 0, y: 0, w: 1080, h: 268 } },
  { id: 'bottom', box: { x: 0, y: 1500, w: 1080, h: 420 } },
  { id: 'left', box: { x: 0, y: 0, w: 60, h: 1920 } },
  { id: 'right', box: { x: 1021, y: 0, w: 59, h: 1920 } },
  { id: 'rail', box: { x: 960, y: 1100, w: 120, h: 820 } },
];

/** A clean 30 s reel timeline: a beat every 60 frames, hook by 45, two chant cards on the 100 BPM grid, an 8 s end card. */
export function timeline(o: Partial<PacingTimeline> = {}): PacingTimeline {
  return {
    fps: 30,
    totalFrames: 900,
    hookCompleteFrame: 45,
    events: Array.from({ length: 15 }, (_, i) => i * 60),
    chantCards: [
      { from: 360, to: 396 },
      { from: 396, to: 432 },
    ],
    beatGrid: { bpm: 100, downbeatMs: 0 }, // a beat every 18 frames
    endCard: { from: 660, to: 900 },
    ...o,
  };
}

export function alignment(): AlignmentDoc {
  return {
    lang: 'en',
    lines: [
      { id: 'l01', beatId: 'b01', ms: 1500, words: [{ token: 'Five', startMs: 0, endMs: 300 }, { token: 'letters', startMs: 300, endMs: 700 }, { token: 'make', startMs: 700, endMs: 1000 }, { token: 'one', startMs: 1000, endMs: 1200 }, { token: 'word', startMs: 1200, endMs: 1500 }] },
      { id: 'l02', beatId: 'b02', ms: 800, words: [{ token: 'Try', startMs: 0, endMs: 400 }, { token: 'it', startMs: 400, endMs: 800 }] },
    ],
  };
}

export function answer(score: 1 | 2 | 3 | 4 | 5): ReviewerAnswer {
  return { scores: CRITERIA_IDS.map((c) => ({ criterion: c, applicable: true, score, evidence: [{ kind: 'frame' as const, ref: 'frame:60' }], note: '' })), throughline: 'A puzzle, then the payoff.', summary: 'Fixture.' };
}

export function baseSubject(o: Partial<CheckSubject> = {}): CheckSubject {
  const a = alignment();
  const box = { x: 108, y: 280, w: 200, h: 40 };
  return {
    lang: 'en',
    medium: 'video',
    fps: 30,
    frames: { video: 900, timeline: 900, master: 900 },
    loudness: { i: -14.1, tp: -1.4, lra: 5 },
    layout: { frames: [{ frame: 0, layers: [{ id: 'hook', kind: 'text', box: { x: 108, y: 316, w: 864, h: 300 } }] }], reserves: RESERVES, cutFrames: [] },
    captions: { alignment: a, pages: recomputeCaptions(a) },
    aiLabel: { totalFrames: 900, frames: [{ frame: 0, present: true, box }, { frame: 899, present: true, box }], metaFlag: true, aiUsed: true },
    provenance: [{ id: 'bg-1', kind: 'background', licence: { type: 'owned', holder: 'Studio', source: 'pack', acquiredAt: '2026-01-01', allowedUses: ['organic'], aiGenerated: false } }],
    fonts: { used: [{ family: 'CoreText', sha256: 'a'.repeat(64) }], allowed: [{ family: 'CoreText', sha256: 'a'.repeat(64) }] },
    pacing: timeline(),
    luminance: Array.from({ length: 900 }, () => 0.4),
    characters: { list: [{ id: 'char-host', tier: 'A', onScreenFrames: 600 }] },
    lipsync: null,
    langLint: { errors: 0, ruleIds: [] },
    signoffs: [],
    hashes: {},
    strip: null,
    summary: { hook: 'Five letters make one word', caption: 'Try it.', beats: [] },
    ...o,
  };
}
