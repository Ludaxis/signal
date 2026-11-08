// Quality bar acceptance 5 on the character track: «بیا پیش ما» with the fixture alignment (40 ms per character,
// shorter than two frames) placed at a line start frame shows `M` for at least 2 frames from every ب، پ، م onset;
// the mouth rests on X after 6 silent frames; Latin lines use the 8-class mapping. Persian forms are proposed until
// a named native editor signs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { latinVisemeOf, REST_AFTER_FRAMES, visemeTrack, type VisemeLine } from '@/lib/studio/postmaker/anim/visemeTrack';

const ALIGN = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../lib/studio/lang/fa/__fixtures__/mock-alignments.json'), 'utf8')) as { items: { text: string; characters: string[]; startMs: number[]; endMs: number[] }[] };
const item = ALIGN.items.find((i) => i.text === 'بیا پیش ما')!;
const line = (startFrame: number): VisemeLine => ({ lineId: 'l01', lang: 'fa', text: item.text, alignment: { characters: item.characters, startMs: item.startMs, endMs: item.endMs }, startFrame });

describe('viseme track (quality bar acceptance 5)', () => {
  it('«بیا پیش ما»: every ب، پ، م onset shows M for at least 2 frames, at the line position', () => {
    for (const start of [0, 37]) {
      const t = visemeTrack([line(start)], 0, 120);
      const bilabials = item.characters.filter((c) => 'بپم'.includes(c)).length;
      expect(t.mOnsets).toHaveLength(bilabials);
      expect(bilabials).toBe(3);
      for (const o of t.mOnsets) {
        expect(o.frame).toBeGreaterThanOrEqual(start);
        expect(t.frames[o.frame - t.from], `M at ${o.frame}`).toBe('M');
        expect(t.frames[o.frame + 1 - t.from], `M at ${o.frame + 1}`).toBe('M');
      }
    }
  });

  it('rests on X after 6 silent frames, and before the line starts', () => {
    const t = visemeTrack([line(30)], 0, 120);
    const last = 30 + Math.ceil((Math.max(...item.endMs) / 1000) * 30) - 1;
    expect(t.frames.slice(0, 30).every((v) => v === 'X')).toBe(true);
    const tail = t.frames.slice(last + 1, last + 1 + REST_AFTER_FRAMES);
    expect(tail.every((v) => v === t.frames[last])).toBe(true);
    expect(t.frames.slice(last + 1 + REST_AFTER_FRAMES).every((v) => v === 'X')).toBe(true);
  });

  it('Latin: the 8-class mapping; m/b/p held 2 frames', () => {
    expect(['m', 'b', 'p', 'f', 'v', 'l', 'd', 'o', 'u', 'a', 'e', ' ', '!'].map((c) => latinVisemeOf(c))).toEqual(['M', 'M', 'M', 'F', 'F', 'L', 'L', 'O', 'U', 'A', 'E', null, null]);
    expect(latinVisemeOf('k')).toBe('X');
    expect(latinVisemeOf('k', -20)).toBe('E');
    const chars = [...'make my day'];
    const t = visemeTrack([{ lineId: 'l02', lang: 'en', text: chars.join(''), alignment: { characters: chars, startMs: chars.map((_, i) => i * 40), endMs: chars.map((_, i) => i * 40 + 40) }, startFrame: 10 }], 0, 60);
    expect(t.mOnsets.map((o) => o.frame)).toEqual([10, 16]); // characters 0 and 5 at 40 ms each
    for (const o of t.mOnsets) expect(t.frames.slice(o.frame, o.frame + 2)).toEqual(['M', 'M']);
  });
});
