// (beat loops on the tempo map at 100 and 120 BPM; crowd offsets) and the seeded idles (blink, breath).
import { describe, expect, it } from 'vitest';
import { BLINK_MAX, BLINK_MIN, blinkSchedule, blinkEyeAt, bounceTracks, breathAmount, breathPhase, crowdOffset, danceKeys, swayAt, BOUNCE_PX } from '@/lib/studio/postmaker/anim/loops';
import { beatFrame, beatsIn, framesPerBeat } from '@/lib/studio/postmaker/anim/tempo';
import { beatGrid } from '@/lib/studio/postmaker/render/layout';
import type { TempoMap } from '@/lib/studio/postmaker/anim/types';

const at = (bpm: number, firstDownbeatFrame = 0): TempoMap => ({ bpm, firstDownbeatFrame, beatsPerBar: 4 });

describe('tempo map', () => {
  it('beat frames match the layout engine grid (100 BPM: 18 f, 120 BPM: 15 f)', () => {
    expect(framesPerBeat(at(100))).toBe(18);
    expect(framesPerBeat(at(120))).toBe(15);
    for (const bpm of [100, 120, 96, 128]) expect(beatsIn(at(bpm), 0, 600).map((b) => b.frame)).toEqual(beatGrid(bpm, 0, 600).beats);
    expect(beatsIn(at(100, 9), 0, 40).map((b) => b.frame)).toEqual([9, 27]);
  });
});

describe.each([100, 120])('beat loops at %i BPM', (bpm) => {
  const t = at(bpm, 4);
  const beats = new Set(beatsIn(t, 0, 600).map((b) => b.frame));
  it('bounce-beat: every squash key and every down key sits exactly on a beat frame; the lift on the half-beat', () => {
    const tr = bounceTracks(t, 0, 600);
    const squash = tr.hipSy.filter((k) => k.value !== 1).map((k) => k.frame).filter((f) => f >= 0 && f < 600);
    expect(squash.length).toBe(beats.size);
    for (const f of squash) expect(beats.has(f), `squash at ${f}`).toBe(true);
    const down = tr.hipY.filter((k) => k.value === 0 && k.frame >= 0 && k.frame < 600).map((k) => k.frame);
    expect(new Set(down)).toEqual(beats);
    for (const k of tr.hipY.filter((x) => x.value === -BOUNCE_PX)) expect(beats.has(k.frame)).toBe(false);
  });
  it('dance-A/B: one pose key per beat, exactly on the beat frames, alternating; dance-B starts on the other pose', () => {
    const a = danceKeys(t, 'dance-A', 0, 600);
    const b = danceKeys(t, 'dance-B', 0, 600);
    expect(a.map((k) => k.frame)).toEqual([...beats]);
    for (let i = 1; i < a.length; i++) expect(a[i]!.pose).not.toBe(a[i - 1]!.pose);
    expect(b.map((k) => k.pose)).toEqual(a.map((k) => (k.pose === 'dance-A' ? 'dance-B' : 'dance-A')));
    // two bars: the second bar is the mirrored routine
    const firstBar = a.findIndex((k) => (k.frame - 4) % (4 * framesPerBeat(t)) === 0);
    expect(a.slice(firstBar, firstBar + 8).map((k) => k.mirrored)).toEqual([false, false, false, false, true, true, true, true]);
  });
  it('crowd: bounce-beat shifted by a seeded offset within ±2 frames', () => {
    const offsets = Array.from({ length: 40 }, (_, i) => crowdOffset(7, `char-extra-${i}`, i));
    for (const o of offsets) expect(Math.abs(o)).toBeLessThanOrEqual(2);
    expect(new Set(offsets).size).toBeGreaterThan(2); // not lockstep
    expect(Array.from({ length: 40 }, (_, i) => crowdOffset(7, `char-extra-${i}`, i))).toEqual(offsets); // seeded
    expect(Array.from({ length: 40 }, (_, i) => crowdOffset(8, `char-extra-${i}`, i))).not.toEqual(offsets);
    const o = offsets.find((x) => x !== 0)!;
    const shifted = bounceTracks(t, 0, 600, o).hipSy.filter((k) => k.value !== 1 && k.frame >= 10 && k.frame < 590).map((k) => k.frame - o);
    for (const f of shifted) expect(beats.has(f)).toBe(true);
  });
  it('beat frames are whole frames', () => {
    for (let k = 0; k < 30; k++) expect(Number.isInteger(beatFrame(t, k))).toBe(true);
  });
});

describe('idle loops', () => {
  it('blink: seeded 2-5 s intervals, 4 frames half → closed → half → open, ~10 % double blinks', () => {
    const s = blinkSchedule(1, 'char-a', 0, 30 * 600);
    const singles = s.filter((b, i) => !(b.double && i > 0 && s[i - 1]!.double && b.at - s[i - 1]!.at === 5));
    for (let i = 1; i < singles.length; i++) {
      const gap = singles[i]!.at - singles[i - 1]!.at;
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX);
    }
    const share = singles.filter((b) => b.double).length / singles.length;
    expect(share).toBeGreaterThan(0.04);
    expect(share).toBeLessThan(0.18);
    const b = singles[0]!.at;
    expect([0, 1, 2, 3, 4].map((k) => blinkEyeAt(s, b + k))).toEqual(['half', 'closed', 'half', 'open', null]);
    expect(blinkSchedule(1, 'char-a', 0, 3000)).toEqual(blinkSchedule(1, 'char-a', 0, 3000));
    expect(blinkSchedule(2, 'char-a', 0, 3000)).not.toEqual(blinkSchedule(1, 'char-a', 0, 3000));
    expect(blinkSchedule(1, 'char-b', 0, 3000)).not.toEqual(blinkSchedule(1, 'char-a', 0, 3000));
  });
  it('breath: a 72-frame sine with a seeded phase per character; sway 90 f with the head 2 frames behind', () => {
    const p = breathPhase(3, 'char-a');
    expect(breathAmount(0, p)).toBeCloseTo(breathAmount(72, p), 10);
    expect(Math.max(...Array.from({ length: 72 }, (_, f) => breathAmount(f, p)))).toBeCloseTo(1, 2);
    expect(breathPhase(3, 'char-a')).toBe(p);
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map((c) => breathPhase(3, `char-${c}`))).size).toBeGreaterThan(1);
    expect(swayAt(22.5).hipRot).toBeCloseTo(1.5, 6);
    expect(swayAt(24.5).headRot).toBeCloseTo(-0.8, 6);
    expect(swayAt(90).hipRot).toBeCloseTo(0, 6);
  });
});
