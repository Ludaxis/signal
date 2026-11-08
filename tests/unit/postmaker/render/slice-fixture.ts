// The 30 s render-slice fixture (its beat structure; the fixture changed, not the
// presets): it was a hand cut whose hook sentence completed at frame 135/124 and whose end card lasted 90 frames,
// against the pacing targets (hook complete by frame 60; end card 180-270 frames). It now takes the pack template's
// own `slice-30` cut and lines from the slice recipe fixture (recipe-story-spine.json): hook 0-6 s, story 6-10.4 s,
// interrupt 10.4-12.4 s, demo 12.4-17.4 s, chant 17.4-21 s (two-beat cards on the 100 BPM grid), reveal 21-23.4 s,
// end card 23.4-30 s = 900 frames, with the hook's first sentence short enough to complete by frame 60.
// [Pack example] Lines come from the fictional pack-example script (fixture); the brand «حرفینو» / Harfino
// is that pack's fictional placeholder and lives only in test fixtures.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RecipeDraft } from '@/lib/studio/postmaker/store/recipes';
import type { Lang, PipelineNode, RecipeBeat } from '@/lib/studio/postmaker/types';

interface RecipeFixture {
  holdFrames: number;
  voiceMs: Record<string, number>;
  recipe: { beats: RecipeBeat[]; tempo: { bpm: number; downbeatMs: number } };
}
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../fixtures/postmaker/recipe-story-spine.json'), 'utf8')) as RecipeFixture;

export const SLICE_BRAND: Record<Lang, string> = { fa: 'حرفینو', en: 'Harfino' };
export const SLICE_TAGLINE: Record<Lang, string> = { fa: 'هر شب یه کلمه', en: 'A new word every night' };

export const SLICE_BEATS: RecipeBeat[] = FIXTURE.recipe.beats;

/** Line lengths (ms) so every spoken beat lasts its target: speech + the fixture hold (frames = ceil(ms × 30 / 1000)). */
export const SLICE_VOICE_MS: Record<string, number> = FIXTURE.voiceMs;
export const SLICE_HOLD_FRAMES = FIXTURE.holdFrames;

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
    tempo: FIXTURE.recipe.tempo,
    evidence: { sheets: [], cuts: SLICE_BEATS.slice(1).map((b) => b.start), silences: [], loudnessLufs: null },
    stopAfterRecipe: false,
  };
}

/** Pipeline params for the slice: the fixture hold and the fixture brand for compose. */
export function sliceParams(nodes: PipelineNode[]): PipelineNode[] {
  return nodes.map((n) => {
    if (n.kind === 'motion') return { ...n, params: { ...n.params, holdFrames: SLICE_HOLD_FRAMES } };
    if (n.kind === 'compose') return { ...n, params: { ...n.params, brand: SLICE_BRAND, tagline: SLICE_TAGLINE } };
    return n;
  });
}
