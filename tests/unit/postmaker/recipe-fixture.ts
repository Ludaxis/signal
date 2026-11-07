// A synthetic 7-beat story-spine recipe for the Post maker engine tests, with one dialogue beat. The lines
// are invented; the Persian ones are taken from fictional pack-example script (they pass the Persian linter).
// A placeholder speaker id, no project, brand or person names.
import type { BuildOptions } from '@/lib/studio/postmaker/graph/build';
import type { RecipeDraft } from '@/lib/studio/postmaker/store/recipes';
import type { Lang, RecipeBeat } from '@/lib/studio/postmaker/types';

export const PROJECT = { id: 'example-project', timeZone: 'Asia/Tehran' };
export const T0 = Date.parse('2026-11-06T10:00:00.000Z');

const beat = (id: string, start: number, end: number, segment: RecipeBeat['segment'], techniques: string[], fa: string, en: string): RecipeBeat => ({
  id,
  start,
  end,
  segment,
  name: `${segment} ${id}`,
  purpose: 'synthetic',
  visual: 'flat illustrated room',
  techniques,
  onScreenText: { fa, en },
  audio: 'narration',
  motion: 'gentle',
});

export const BEATS: RecipeBeat[] = [
  beat('b01', 0, 6, 'hook', ['pov-hook', 'word-kinetic-caption'], 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.', "Grandma's house is loud tonight."),
  beat('b02', 6, 14, 'story', ['dialogue'], 'همه دور کرسی‌ان، یکی هندونه می‌بره، یکی فال می‌گیره.\nمنم این‌ور، غرق بازی‌ام.', "Someone's slicing pie, someone's telling fortunes,\nand I'm deep in a game."),
  beat('b03', 14, 16, 'interrupt', ['pattern-interrupt-card'], 'بیا یه فال حافظ برات بگیرم!', '"Come here, let me read your palm!"'),
  beat('b04', 16, 24, 'demo', ['phone-demo', 'finger-swipe', 'color-card-chant'], 'ببین: حروف رو می‌کشم، کلمه درمیاد.', 'Look: drag the letters, the word pops out.'),
  beat('b05', 24, 26, 'escalation', ['crowd-escalation'], 'حالا کل فامیل ریختن سر گوشیم!', "Now the whole family's on my phone!"),
  beat('b06', 26, 28, 'reveal', ['letter-reveal'], '', ''),
  beat('b07', 28, 30, 'endcard', ['end-card-cta'], 'امشب نوبت توئه!', 'Your turn tonight.'),
];

export function recipeDraft(langs: Lang[] = ['fa', 'en']): RecipeDraft {
  return {
    referenceId: 'ref-20261106-0a0a',
    projectId: PROJECT.id,
    campaignId: null,
    packId: 'example-pack',
    languages: langs,
    lengthSec: 30,
    shape: '9:16',
    fps: 30,
    capUsd: 0,
    beats: BEATS.map((b) => ({ ...b, onScreenText: Object.fromEntries(langs.map((l) => [l, b.onScreenText[l] ?? ''])) })),
    style: { captions: 'word-pop', pace: 'fast', palette: ['#ffffff'], type: 'display', voice: 'narrator', music: 'library' },
    assets: [],
    tempo: { bpm: 100, downbeatMs: 0 },
    evidence: { sheets: [], cuts: [6, 14, 16, 24, 26, 28], silences: [], loudnessLufs: null },
    stopAfterRecipe: false,
  };
}

export const FACES: BuildOptions = { faces: ['char-host'] };
