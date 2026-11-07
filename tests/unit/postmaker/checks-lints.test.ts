// @vitest-environment node
// deterministic checks: (pacing lint with frame numbers) and 7 (flash lint),
// acceptance 7 (C5 tier ceiling), the C3 safe-zone report, loudness, caption coverage, AI label, fonts, frame count,
// lip-sync QA, and the caps they put on drafted scores. The reserve rectangles here are a test fixture shaped like the
// reel row; the real table is render/safeZones.ts.
import { describe, expect, it } from 'vitest';
import { aiLabelCheck, provenanceGaps } from '@/lib/studio/postmaker/checks/aiLabel';
import { captionCoverage } from '@/lib/studio/postmaker/checks/captionCoverage';
import { runDeterministic } from '@/lib/studio/postmaker/checks/deterministic';
import { cardTrace, flashLint, relativeLuminance } from '@/lib/studio/postmaker/checks/flash';
import { fontsCheck, frameCountCheck } from '@/lib/studio/postmaker/checks/fonts';
import { lipsyncFallback, lipsyncLineQa, peakLag } from '@/lib/studio/postmaker/checks/lipsyncQa';
import { loudnessCheck, narrationDeltaCheck, parseLoudnorm } from '@/lib/studio/postmaker/checks/loudness';
import { beatOnsets, pacingLint } from '@/lib/studio/postmaker/checks/pacing';
import { safeZoneReport, sampleFrames } from '@/lib/studio/postmaker/checks/safeZoneReport';
import { draftSheet } from '@/lib/studio/postmaker/checks/sheet';
import { c5Ceiling, clampToCeiling } from '@/lib/studio/postmaker/checks/tierCeiling';
import { recomputeCaptions } from '@/lib/studio/postmaker/graph/adapters';
import { RESERVES, alignment, answer, baseSubject, timeline } from './check-fixtures';

describe('pacing lint', () => {
  it('passes a clean timeline', () => {
    const r = pacingLint(timeline());
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.longestGap.frames).toBe(60);
    expect(r.endCardFrames).toBe(240);
    expect(r.maxChantOffset).toBe(0);
  });
  it('reports every violation with its frame number', () => {
    const r = pacingLint(
      timeline({
        events: [0, 60, 300, 360, 420],
        hookCompleteFrame: 75,
        chantCards: [
          { from: 360, to: 380 }, // 20 frames: too short
          { from: 400, to: 436 }, // 4 frames off the nearest onset (396)
        ],
        endCard: { from: 800, to: 900 }, // 100 frames
      }),
    );
    expect(r.ok).toBe(false);
    const by = (id: string) => r.violations.filter((v) => v.id === id).map((v) => v.frame);
    expect(by('gap')).toEqual([60, 420]); // 60→300 = 240 frames, 420→900 = 480 frames
    expect(by('hook')).toEqual([75]);
    expect(by('chant-length')).toEqual([360]);
    expect(by('chant-off-beat')).toEqual([400]);
    expect(by('end-card')).toEqual([800]);
    expect(r.violations.find((v) => v.id === 'gap')!.text).toBe('No beat for 240 frames from frame 60.');
  });
  it('a gap of exactly 120 frames, a hook at frame 60, chant cards of 30 and 60 frames and ±2 frames pass', () => {
    const r = pacingLint(timeline({ events: Array.from({ length: 8 }, (_, i) => i * 120), hookCompleteFrame: 60, chantCards: [{ from: 362, to: 392 }, { from: 394, to: 454 }], endCard: { from: 720, to: 900 } }));
    expect(r.violations).toEqual([]);
  });
  it('chant cards may start on any beat onset of the declared grid, not only downbeats', () => {
    expect(beatOnsets({ bpm: 100, downbeatMs: 300 }, 30, 60)).toEqual([9, 27, 45, 63]);
    expect(pacingLint(timeline({ chantCards: [{ from: 18, to: 54 }, { from: 54, to: 90 }] })).violations).toEqual([]); // onsets 18 and 54 are not downbeats of 4/4
  });
  it('chant cards without a declared beat grid are refused', () => {
    expect(pacingLint(timeline({ beatGrid: null })).violations.map((v) => v.id)).toEqual(['no-grid']);
  });
});

describe('flash lint (C12)', () => {
  const dark = relativeLuminance(20, 20, 40);
  const bright = relativeLuminance(255, 230, 60);
  const chant = (frames: number, n = 10) => cardTrace(Array.from({ length: n }, (_, i) => ({ frames, luminance: i % 2 ? bright : dark })));
  it('chant cards at 10 frames each (3 per second) fail', () => {
    const r = flashLint(chant(10), 30);
    expect(r.ok).toBe(false);
    expect(r.worst.count).toBeGreaterThan(3);
    expect(r.text).toMatch(/flashes within 1 s from frame \d+/);
  });
  it('chant cards at 30 frames each pass', () => {
    const r = flashLint(chant(30), 30);
    expect(r.ok).toBe(true);
    expect(r.worst.count).toBeLessThanOrEqual(3);
  });
  it('small or bright-only changes are not flashes; a gradual fade is one change', () => {
    expect(flashLint(cardTrace(Array.from({ length: 12 }, (_, i) => ({ frames: 5, luminance: i % 2 ? 0.5 : 0.55 }))), 30).events).toEqual([]);
    expect(flashLint(cardTrace(Array.from({ length: 12 }, (_, i) => ({ frames: 5, luminance: i % 2 ? 0.85 : 0.98 }))), 30).events).toEqual([]);
    expect(flashLint(Array.from({ length: 30 }, (_, i) => i / 29), 30).events).toHaveLength(1);
  });
});

describe('C5 tier ceiling', () => {
  it('a character-led run with a Tier B lead cannot record C5 = 4 or 5 unless the character is on screen ≤ 20 %', () => {
    const over = c5Ceiling([{ id: 'char-host', tier: 'B', onScreenFrames: 600 }], 900);
    expect(over).toMatchObject({ max: 3, limitedBy: 'char-host' });
    expect(clampToCeiling(5, over)).toBe(3);
    expect(clampToCeiling(4, over)).toBe(3);
    const under = c5Ceiling([{ id: 'char-host', tier: 'B', onScreenFrames: 180 }], 900);
    expect(under.max).toBe(4);
    expect(clampToCeiling(5, under)).toBe(4);
  });
  it('Tier A reaches 5; Tier C needs the on-model review for 4; the lowest character wins', () => {
    expect(c5Ceiling([{ id: 'a', tier: 'A', onScreenFrames: 900 }], 900).max).toBe(5);
    expect(c5Ceiling([{ id: 'c', tier: 'C', onScreenFrames: 300 }], 900).max).toBe(3);
    expect(c5Ceiling([{ id: 'c', tier: 'C', onScreenFrames: 300, onModelReviewed: true }], 900).max).toBe(4);
    expect(c5Ceiling([{ id: 'a', tier: 'A', onScreenFrames: 900 }, { id: 'b', tier: 'B', onScreenFrames: 500 }], 900)).toMatchObject({ max: 3, limitedBy: 'b' });
    expect(c5Ceiling([{ id: 'b', tier: 'B', onScreenFrames: 500 }], 900, { characterLed: false }).max).toBe(5);
  });
  it('the drafted sheet caps a reviewer C5 = 5 over a Tier B lead (with the cap as evidence)', () => {
    const subject = baseSubject({ characters: { list: [{ id: 'char-host', tier: 'B', onScreenFrames: 600 }] } });
    const sheet = draftSheet({ lang: 'en', medium: 'video', report: runDeterministic(subject), answer: answer(5), scoredBy: 'agent-sdk', unscoredReason: null });
    const c5 = sheet.scores.find((s) => s.criterion === 'C5')!;
    expect(c5.score).toBe(3);
    expect(c5.evidence.some((e) => e.ref === 'rig:char-host')).toBe(true);
    expect(c5.note).toContain('Capped at 3');
  });
});

describe('C3 safe-zone report', () => {
  it('samples every 3rd frame and every cut frame', () => {
    expect(sampleFrames(10, [4, 5])).toEqual([0, 3, 4, 5, 6, 9]);
  });
  it('zero intersections pass; text in a reserve or on the right rail fails; decoration is listed apart', () => {
    const ok = safeZoneReport([{ frame: 0, layers: [{ id: 'hook', kind: 'text', box: { x: 108, y: 316, w: 864, h: 300 } }] }], RESERVES);
    expect(ok).toMatchObject({ ok: true, intersections: [] });
    const bad = safeZoneReport(
      [
        { frame: 0, layers: [{ id: 'caption', kind: 'text', box: { x: 108, y: 1452, w: 600, h: 49 } }] },
        { frame: 3, layers: [{ id: 'face', kind: 'face', box: { x: 900, y: 1100, w: 61, h: 100 } }, { id: 'confetti', kind: 'decoration', box: { x: 0, y: 0, w: 1080, h: 300 } }] },
      ],
      RESERVES,
    );
    expect(bad.ok).toBe(false);
    expect(bad.intersections).toEqual([
      { frame: 0, layerId: 'caption', reserveId: 'bottom' },
      { frame: 3, layerId: 'face', reserveId: 'rail' },
    ]);
    expect(bad.decoration.map((d) => d.reserveId)).toEqual(['top', 'left', 'right']);
  });
  it('no measured frame is not a pass', () => {
    expect(safeZoneReport([], RESERVES).ok).toBe(false);
  });
});

describe('loudness, captions, AI label, fonts, frame count, lip-sync', () => {
  it('parses the loudnorm print and checks −14 ±1 LUFS and ≤ −1.0 dBTP', () => {
    const print = '[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-14.20",\n\t"input_tp" : "-1.50",\n\t"input_lra" : "5.10",\n\t"input_thresh" : "-24.3"\n}\n';
    const m = parseLoudnorm(print)!;
    expect(m).toEqual({ i: -14.2, tp: -1.5, lra: 5.1 });
    expect(loudnessCheck(m).ok).toBe(true);
    expect(loudnessCheck({ i: -11.9, tp: -0.4, lra: 4 }).reasons).toEqual(['Loudness -11.9 LUFS, needs −14 ±1.', 'Peak -0.4 dBTP, needs −1.0 or lower.']);
    expect(parseLoudnorm('no json here')).toBeNull();
    expect(narrationDeltaCheck([{ lineId: 'l01', narrationLufs: -12, bedLufs: -22 }, { lineId: 'l02', narrationLufs: -13, bedLufs: -20 }])).toEqual({ ok: false, worst: { lineId: 'l02', delta: 7 } });
  });
  it('caption coverage is 100 % when pages are the alignment words; a dropped word fails', () => {
    const a = alignment();
    const pages = recomputeCaptions(a);
    expect(captionCoverage(a, pages)).toMatchObject({ ok: true, pct: 100, spoken: 7, captioned: 7 });
    const dropped = { ...pages, pages: pages.pages.map((p, i) => (i === 0 ? { ...p, text: p.text.split(' ').slice(0, -1).join(' ') } : p)) };
    const r = captionCoverage(a, dropped);
    expect(r.ok).toBe(false);
    expect(r.mismatch?.lineId).toBe('l01');
    expect(r.pct).toBeLessThan(100);
  });
  it('AI label: first and last frame, inside the text rectangle, and the flag agrees with the provenance', () => {
    const rect = { x: 108, y: 268, w: 864, h: 1184 };
    const box = { x: 108, y: 280, w: 200, h: 40 };
    expect(aiLabelCheck({ totalFrames: 900, frames: [{ frame: 0, present: true, box }, { frame: 899, present: true, box }], textRect: rect, metaFlag: true, aiUsed: true }).ok).toBe(true);
    const r = aiLabelCheck({ totalFrames: 900, frames: [{ frame: 0, present: true, box: { ...box, y: 200 } }], textRect: rect, metaFlag: false, aiUsed: true });
    expect(r.reasons).toEqual(['AI label missing on frame 899.', 'AI label outside the safe area on frame 0.', 'The AI flag does not match the assets.']);
    expect(provenanceGaps([{ id: 'bg-1', kind: 'background', licence: { type: 'owned', holder: 'Studio', source: 'pack', acquiredAt: '2026-01-01', allowedUses: ['organic'], aiGenerated: false } }, { id: 'vo-1', kind: 'voice', licence: { type: 'vendor-output', holder: 'Studio', source: 'tts', acquiredAt: '2026-01-01', allowedUses: ['organic'], aiGenerated: true } }, { id: 'x', kind: 'sticker', licence: null }])).toEqual(['vo-1', 'x']);
  });
  it('fonts: bundled files with matching hashes only; frame counts agree', () => {
    const allowed = [{ family: 'CoreText', sha256: 'a'.repeat(64) }];
    expect(fontsCheck([{ family: 'CoreText', sha256: 'a'.repeat(64) }], allowed).ok).toBe(true);
    expect(fontsCheck([{ family: 'CoreText', sha256: null }], allowed).reasons).toEqual(['Font CoreText is not a bundled file.']);
    expect(fontsCheck([], allowed).ok).toBe(false);
    expect(frameCountCheck({ video: 900, timeline: 900, master: 901 })).toEqual({ ok: true, measured: true, reason: null });
    expect(frameCountCheck({ video: 899, timeline: 900, master: null }).ok).toBe(false);
    expect(frameCountCheck({ video: null, timeline: 900, master: null }).measured).toBe(false);
  });
  it('lip-sync QA: peak lag ≤ 1 frame and ≥ 80 % mouth coverage; one fallback per mode', () => {
    const rms = Array.from({ length: 60 }, (_, i) => (Math.floor(i / 6) % 2 ? 0.8 : 0.05));
    const shift = (xs: number[], k: number) => xs.map((_, i) => xs[i - k] ?? 0.05);
    expect(peakLag(shift(rms, 1), rms)).toBe(1);
    expect(lipsyncLineQa({ lineId: 'l01', mode: 'viseme', mouth: shift(rms, 1), rms }).ok).toBe(true);
    const late = lipsyncLineQa({ lineId: 'l02', mode: 'vendor', mouth: shift(rms, 3), rms });
    expect(late.ok).toBe(false);
    expect(late.reasons[0]).toBe('Lip-sync on line l02 is 3 frames off.');
    const shut = lipsyncLineQa({ lineId: 'l03', mode: 'viseme', mouth: rms.map(() => 0), rms });
    expect(shut.reasons.some((x) => x.includes('Mouth moves on 0 %'))).toBe(true);
    expect(lipsyncFallback('vendor', 'A')).toBe('viseme');
    expect(lipsyncFallback('vendor', 'B')).toBe('none');
    expect(lipsyncFallback('none', 'A')).toBeNull();
  });
});

describe('deterministic report and caps', () => {
  it('unmeasured inputs fail their rows and keep the hard gates below 5', () => {
    const r = runDeterministic({ ...baseSubject(), loudness: null, layout: null, aiLabel: null, fonts: null, captions: null });
    expect(r.checks.map((c) => [c.id, c.ok, c.measured])).toEqual([
      ['loudness', false, false],
      ['safe-zones', false, false],
      ['caption-match', false, false],
      ['ai-label', false, false],
      ['fonts', false, false],
      ['frame-count', true, true],
    ]);
    expect(r.checks[0]!.reason).toBe('Not measured yet.');
    const sheet = draftSheet({ lang: 'en', medium: 'video', report: r, answer: answer(5), scoredBy: 'agent-sdk', unscoredReason: null });
    expect(sheet.scores.find((s) => s.criterion === 'C3')!.score).toBe(4);
    expect(sheet.scores.find((s) => s.criterion === 'C11')!.score).toBe(4);
    expect(sheet.verdict).toBe('regenerate');
  });
  it('a fully measured clean subject lets a 5 stand; failures cap the score and carry frame numbers', () => {
    const clean = runDeterministic(baseSubject());
    expect(clean.checks.every((c) => c.ok)).toBe(true);
    const good = draftSheet({ lang: 'en', medium: 'video', report: clean, answer: answer(5), scoredBy: 'agent-sdk', unscoredReason: null });
    expect(good.verdict).toBe('premium');
    expect(good.scores.find((s) => s.criterion === 'C9')!.evidence.some((e) => e.ref === 'loudness:master')).toBe(true);
    const dark = relativeLuminance(20, 20, 40);
    const bright = relativeLuminance(255, 255, 255);
    const bad = runDeterministic(baseSubject({ luminance: cardTrace(Array.from({ length: 12 }, (_, i) => ({ frames: 10, luminance: i % 2 ? bright : dark }))), loudness: { i: -9, tp: 0, lra: 3 } }));
    expect(bad.findings.find((f) => f.id === 'flash')!.frame).toBeGreaterThan(0);
    const s = draftSheet({ lang: 'en', medium: 'video', report: bad, answer: answer(5), scoredBy: 'agent-sdk', unscoredReason: null });
    expect(s.scores.find((x) => x.criterion === 'C12')).toMatchObject({ score: 1, owningStep: 'motion' });
    expect(s.scores.find((x) => x.criterion === 'C9')!.score).toBe(1);
  });
  it('with no reviewer answer every applicable row stays unscored with its measured evidence', () => {
    const s = draftSheet({ lang: 'en', medium: 'video', report: runDeterministic(baseSubject()), answer: null, scoredBy: 'deterministic-only', unscoredReason: null });
    expect(s.verdict).toBe('unscored');
    expect(s.unscoredReason).toBe('No reviewer was available. Score it yourself, or accept as draft.');
    expect(s.scores.every((x) => x.score === null)).toBe(true);
    expect(s.scores.find((x) => x.criterion === 'C3')!.evidence[0]!.ref).toBe('check:safe-zones');
  });
});
