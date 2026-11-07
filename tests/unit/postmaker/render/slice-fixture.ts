// The 30 s render-slice fixture (its beat structure): hook 0-6 s, story 6-14 s, interrupt 14-16 s,
// demo 16-16.8 s then six 2-beat chant cards on the 100 BPM grid (16.8-24 s), reveal 24-27 s, end card 27-30 s
// = 900 frames. [Pack example] Lines come from the fictional pack-example script (fixture); the brand
// «حرفینو» / Harfino is that pack's fictional placeholder and lives only in test fixtures.
import type { RecipeDraft } from '@/lib/studio/postmaker/store/recipes';
import type { Lang, PipelineNode, RecipeBeat } from '@/lib/studio/postmaker/types';

const beat = (id: string, start: number, end: number, segment: RecipeBeat['segment'], techniques: string[], fa: string, en: string): RecipeBeat => ({
  id,
  start,
  end,
  segment,
  name: `${segment} ${id}`,
  purpose: 'synthetic',
  visual: 'flat colour card',
  techniques,
  onScreenText: { fa, en },
  audio: 'narration',
  motion: 'gentle',
});

export const SLICE_BRAND: Record<Lang, string> = { fa: 'حرفینو', en: 'Harfino' };
export const SLICE_TAGLINE: Record<Lang, string> = { fa: 'هر شب یه کلمه', en: 'A new word every night' };

export const SLICE_BEATS: RecipeBeat[] = [
  beat('b01', 0, 6, 'hook', ['pov-hook', 'word-kinetic-caption', 'emoji-sticker', 'highlight-marker'], 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.', "Grandma's house is loud tonight."),
  beat('b02', 6, 14, 'story', ['dialogue', 'emphasis-punch'], 'همه دور کرسی‌ان، یکی هندونه می‌بره، یکی فال می‌گیره.\nمنم این‌ور، غرق بازی‌ام.', "Someone's slicing pie, someone's telling fortunes,\nand I'm deep in a game."),
  beat('b03', 14, 16, 'interrupt', ['pattern-interrupt-card'], 'بیا یه فال حافظ برات بگیرم!', '"Come here, let me read your palm!"'),
  beat('b04', 16, 16.8, 'demo', ['phone-demo', 'finger-swipe'], '', ''),
  beat('b05', 16.8, 24, 'chant', ['color-card-chant', 'beat-sync-cuts'], '', ''),
  beat('b06', 24, 27, 'reveal', ['letter-reveal', 'confetti'], '', ''),
  beat('b07', 27, 30, 'endcard', ['end-card-cta'], 'امشب نوبت توئه!', 'Your turn tonight.'),
];

/** Line lengths (ms) so every beat lasts its target: speech + a 12-frame hold (frames = ceil(ms × 30 / 1000)). */
export const SLICE_VOICE_MS: Record<string, number> = { l01: 5600, l02: 3800, l03: 3800, l04: 1600, l05: 2600 };

export function sliceRecipe(langs: Lang[] = ['fa', 'en']): RecipeDraft {
  return {
    referenceId: 'ref-20261106-0a0a',
    projectId: 'example-project',
    campaignId: null,
    packId: 'example-pack',
    languages: langs,
    lengthSec: 30,
    shape: '9:16',
    fps: 30,
    capUsd: 0,
    beats: SLICE_BEATS.map((b) => ({ ...b, onScreenText: Object.fromEntries(langs.map((l) => [l, b.onScreenText[l] ?? ''])) })),
    style: { captions: 'word-pop', pace: 'fast', palette: ['#ffffff'], type: 'display', voice: 'narrator', music: 'library' },
    assets: [],
    tempo: { bpm: 100, downbeatMs: 0 },
    evidence: { sheets: [], cuts: [6, 14, 16, 16.8, 24, 27], silences: [], loudnessLufs: null },
    stopAfterRecipe: false,
  };
}

/** Pipeline params for the slice: a fixed 12-frame hold and the fixture brand for compose. */
export function sliceParams(nodes: PipelineNode[]): PipelineNode[] {
  return nodes.map((n) => {
    if (n.kind === 'motion') return { ...n, params: { ...n.params, holdFrames: 12 } };
    if (n.kind === 'compose') return { ...n, params: { ...n.params, brand: SLICE_BRAND, tagline: SLICE_TAGLINE } };
    return n;
  });
}
