// Mix plan (quality targets) and the ffmpeg loudness parsing used by loudness.json.
import { describe, expect, it } from 'vitest';
import { dbAt, duckDepth, gainAt, lineWindow, MIX_TARGETS, planMix, plannedNarrationDelta, sampleVoice } from '@/lib/studio/postmaker/render/mixPlan';
import { windowEbur128Args } from '@/lib/studio/postmaker/executors/mix';
import { loudnormApplyArgs, parseEbur128, withinTarget } from '@/lib/studio/postmaker/render/loudness';

const input = {
  durationFrames: 300,
  segments: [
    { beatId: 'b01', segment: 'hook' as const, from: 0, to: 120 },
    { beatId: 'b02', segment: 'interrupt' as const, from: 120, to: 180 },
    { beatId: 'b03', segment: 'chant' as const, from: 180, to: 300 },
  ],
  voice: [{ id: 'v1', lineId: 'l01', src: 'jobs/x/v1.wav', from: 30, frames: 60, measuredLufs: -20 }],
  music: { src: 'jobs/x/music.wav', measuredLufs: -18 },
};

describe('mix plan', () => {
  it('narration gain brings each line to −16 LUFS', () => {
    expect(planMix(input).voice[0]!.gainDb).toBe(4);
  });

  it('ducks the music by −10 dB under speech with a 4-frame ramp in and a 10-frame ramp out', () => {
    const c = planMix(input).music!.curve;
    const db = (f: number) => 20 * Math.log10(gainAt(c, f));
    expect(db(10)).toBeCloseTo(0, 1); // bed at −18 LUFS = measured level
    expect(db(26)).toBeCloseTo(0, 1); // ramp starts 4 frames before speech
    expect(db(28)).toBeCloseTo(-5, 1);
    expect(db(40)).toBeCloseTo(MIX_TARGETS.duckDb, 1);
    expect(db(95)).toBeCloseTo(-5, 1); // 5 frames into the 10-frame ramp out
    expect(db(101)).toBeCloseTo(0, 1);
  });

  it('drops the music to silence in the interrupt and lifts it to −12 LUFS in the chant', () => {
    const c = planMix(input).music!.curve;
    expect(gainAt(c, 150)).toBe(0);
    expect(20 * Math.log10(gainAt(c, 250))).toBeCloseTo(-12 - -18, 1);
  });

  it('keeps the MixPlanDoc fields (durationFrames, cues)', () => {
    const p = planMix(input);
    expect(p.durationFrames).toBe(300);
    expect(p.cues).toEqual([
      { beatId: 'b01', atFrame: 0 },
      { beatId: 'b02', atFrame: 120 },
      { beatId: 'b03', atFrame: 180 },
    ]);
  });
});

describe('narration versus bed (quality: ≥ 8 dB at 3 sampled lines)', () => {
  const chantInput = {
    ...input,
    voice: [
      { id: 'v1', lineId: 'l01', src: 'a', from: 30, frames: 60, measuredLufs: -20 },
      { id: 'v2', lineId: 'l02', src: 'b', from: 130, frames: 30, measuredLufs: -16 },
      { id: 'v3', lineId: 'l03', src: 'c', from: 200, frames: 150, measuredLufs: -19 },
      { id: 'v4', lineId: 'l04', src: 'd', from: 290, frames: 0, measuredLufs: null },
    ],
  };

  it('the duck deepens to −12 dB where the bed is louder, so speech stays 8 dB above it; −10 dB under the normal bed', () => {
    expect(duckDepth(MIX_TARGETS.bedLufs)).toBe(-10);
    expect(duckDepth(MIX_TARGETS.fullLufs)).toBe(-12);
    const c = planMix(chantInput).music!.curve;
    expect(dbAt(c, 250)).toBeCloseTo(-12 - -18 - 12, 1); // chant level, ducked by 12
    expect(dbAt(c, 60)).toBeCloseTo(-10, 1); // hook bed, ducked by 10
  });

  it('samples first, middle and last line; the window is the middle 3 s', () => {
    const p = planMix(chantInput);
    expect(sampleVoice(p).map((c) => c.lineId)).toEqual(['l01', 'l02', 'l03']);
    expect(lineWindow({ from: 200, frames: 150 })).toEqual({ from: 230, frames: 90 });
    expect(lineWindow({ from: 30, frames: 60 })).toEqual({ from: 30, frames: 60 });
  });

  it('planned deltas: 12 dB under the bed, silence in the interrupt, 8 dB in the chant (all pass)', () => {
    const p = planMix(chantInput);
    const d = sampleVoice(p).map((c) => plannedNarrationDelta(p, c, { voice: chantInput.voice.find((v) => v.id === c.id)!.measuredLufs, music: -18 }));
    expect(d.map((x) => [x.lineId, x.deltaDb, x.ok])).toEqual([
      ['l01', 12, true],
      ['l02', 54, true],
      ['l03', 8, true],
    ]);
  });

  it('a −9 dB duck under a −12 LUFS chant bed would fail (5 dB)', () => {
    const p = planMix(chantInput);
    const shallow = { ...p, music: { ...p.music!, curve: p.music!.curve.map(([f, db]) => [f, f >= 200 && db > -50 ? 6 - 9 : db] as [number, number]) } };
    const c = sampleVoice(p)[2]!;
    expect(plannedNarrationDelta(shallow, c, { voice: -19, music: -18 })).toMatchObject({ deltaDb: 5, ok: false });
  });

  it('the measuring window runs ebur128 on the stem at its planned gain', () => {
    expect(windowEbur128Args('v.wav', 1, 3, -10)).toEqual(['-hide_banner', '-nostats', '-ss', '1.000', '-t', '3.000', '-i', 'v.wav', '-filter_complex', 'volume=-10.00dB,ebur128=peak=true', '-f', 'null', '-']);
  });
});

describe('loudness (two-pass loudnorm, ebur128)', () => {
  it('pass 2 applies the pass-1 measurement linearly to −14 LUFS at 48 kHz, aiming 1 dB under the −1.0 dBTP limit', () => {
    const a = loudnormApplyArgs('in.wav', 'out.wav', { inputI: -23.1, inputTp: -6.2, inputLra: 4.1, inputThresh: -33.4, targetOffset: 0.3 });
    expect(a.join(' ')).toContain('loudnorm=I=-14:TP=-2:LRA=11:measured_I=-23.1:measured_TP=-6.2:measured_LRA=4.1:measured_thresh=-33.4:offset=0.3:linear=true');
    expect(a.slice(-7)).toEqual(['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', 'out.wav']);
  });

  it('reads the ebur128 summary and checks −14 ± 1 LUFS and true peak ≤ −1.0 dBTP', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.5 LUFS\n\n  Loudness range:\n    LRA:         3.1 LU\n    Threshold: -34.6 LUFS\n    LRA low:   -16.0 LUFS\n    LRA high:  -12.9 LUFS\n\n  True peak:\n    Peak:       -1.4 dBFS`;
    const m = parseEbur128(stderr);
    expect(m).toEqual({ integratedLufs: -14.2, lraLu: 3.1, truePeakDbtp: -1.4 });
    expect(withinTarget(m)).toBe(true);
    expect(withinTarget({ ...m, truePeakDbtp: -0.5 })).toBe(false);
    expect(withinTarget({ ...m, integratedLufs: -15.3 })).toBe(false);
  });
});
