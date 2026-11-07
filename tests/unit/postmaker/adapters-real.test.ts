// @vitest-environment node
// with the bundled faces, the free adapters `captions.recompute` and `compose.rebuild`
// call buildCaptions / composeTimeline, so an adapted version is what the executor itself would write
// (pages measured with the bundled font, the StorySpine timeline, the executor's checks). Without faces (the fakes)
// they keep the simple document functions. Offline: fake 2-frame renderer, mock providers, no ffmpeg.
import './guard';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, recomputeCaptions, type AlignmentDoc, type CaptionsDoc, type MotionDoc } from '@/lib/studio/postmaker/graph/adapters';
import { buildCaptions, captionMeasure, captionsExecutor, type CaptionsDocX } from '@/lib/studio/postmaker/executors/captions';
import { composeTimeline, type ComposeParams } from '@/lib/studio/postmaker/executors/compose';
import { timelineFonts } from '@/lib/studio/postmaker/executors/render-chain';
import { resolveFonts } from '@/lib/studio/postmaker/render/fonts';
import { fakeRenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { getJson } from '@/lib/studio/postmaker/store/objects';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { PipelineNode } from '@/lib/studio/postmaker/types';
import { serviceExecutors } from '@/lib/studio/postmaker/wiring';
import { BEATS, runAll, scriptedVoice, setup } from './engine-fixtures';
import { tmp } from './guard';

const fonts = () => resolveFonts().fonts;
const node = (id: string, kind: PipelineNode['kind']) => ({ id, kind, lang: 'en', params: {}, inputs: [], expects: [] }) as unknown as PipelineNode;
const alignment: AlignmentDoc = {
  lang: 'en',
  lines: [
    { id: 'l01', beatId: 'b01', ms: 2400, words: ['Grandma’s', 'house', 'is', 'loud', 'tonight.'].map((token, i) => ({ token, startMs: i * 450, endMs: i * 450 + 400 })) },
    { id: 'l02', beatId: 'b02', ms: 1800, words: ['Your', 'turn', 'now.'].map((token, i) => ({ token, startMs: i * 550, endMs: i * 550 + 500 })) },
  ],
};
const recipe = { beats: BEATS.map((b) => (b.id === 'b01' ? { ...b, techniques: [...b.techniques, 'highlight-marker'] } : b)), tempo: null };

describe('captions.recompute', () => {
  it('without faces: the simple pages (fakes); with faces: buildCaptions with the beats’ techniques and its checks', () => {
    const plain = ADAPTERS['captions.recompute']!.run({ node: node('captions:en', 'captions'), current: {}, inputs: { alignment } });
    expect(plain.data.captionPages).toEqual(recomputeCaptions(alignment));
    expect(plain.checks).toBeUndefined();

    const real = ADAPTERS['captions.recompute']!.run({ node: node('captions:en', 'captions'), current: {}, inputs: { alignment }, recipe: recipe as never, fonts: fonts() });
    const { measure, font } = captionMeasure('en', fonts());
    const expected = buildCaptions({ lang: 'en', alignment, measure, highlightBeats: new Set(['b01']), emphasisBeats: new Set(), font: { family: font.family, sha256: font.sha256 } });
    expect(real.data.captionPages).toEqual(expected.doc);
    expect(real.checks).toEqual(expected.checks);
    const doc = real.data.captionPages as CaptionsDocX;
    expect(doc.font?.sha256).toBe(font.sha256);
    expect(doc.pages.find((p) => p.beatId === 'b01')!.highlight).not.toBeNull();
    expect(doc.pages.find((p) => p.beatId === 'b02')!.highlight).toBeNull();
  });
});

describe('captions.recompute equals buildCaptions (golden JSON)', () => {
  it('the adapter with the bundled faces writes exactly the pinned pages and checks, which are buildCaptions for the same inputs', async () => {
    const real = ADAPTERS['captions.recompute']!.run({ node: node('captions:en', 'captions'), current: {}, inputs: { alignment }, recipe: recipe as never, fonts: fonts() });
    const { measure, font } = captionMeasure('en', fonts());
    const expected = buildCaptions({ lang: 'en', alignment, measure, highlightBeats: new Set(['b01']), emphasisBeats: new Set(), font: { family: font.family, sha256: font.sha256 } });
    const golden = { captionPages: real.data.captionPages, checks: real.checks };
    expect(golden).toEqual({ captionPages: expected.doc, checks: expected.checks });
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot('./fixtures/captions-recompute.golden.json');
  });

  it('through the engine: the adapted captions version equals the captions executor run on the new alignment', async () => {
    const voice = scriptedVoice();
    const executors = serviceExecutors({ root: tmp.root, render: fakeRenderChain(), claudeCli: null, fakes: { voiceMs: voice.fn }, renderDeps: { ffmpeg: null, workDir: (r, n) => `${tmp.dir}/work/${r}/${n.replace(/:/g, '-')}` } });
    const { engine, recipeId, recipe: rc } = await setup({ langs: ['en'], build: {}, deps: { executors, adapterFonts: fonts } });
    await runAll(engine, recipeId);
    voice.scale['l02:en'] = 1.04;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:en', mode: 'keep-contracts' });
    expect(r.outcome).toBe('ok');
    const cap = (await readVersion(tmp.root, recipeId, 'captions:en', 2))!;
    expect(cap.source).toBe('adapt');
    const v2 = (await readVersion(tmp.root, recipeId, 'voice:en', 2))!;
    const newAlignment = await getJson<AlignmentDoc>(tmp.root, v2.outputs.find((o) => o.port === 'alignment')!.sha256);
    const direct = await captionsExecutor({ fonts }).run({ lang: 'en', recipe: rc, byPort: { alignment: newAlignment } } as never);
    const adapted = await getJson<CaptionsDocX>(tmp.root, cap.outputs.find((o) => o.port === 'captionPages')!.sha256);
    expect(adapted).toEqual(direct.outputs[0]!.data);
    expect(cap.checks).toEqual(direct.checks);
  }, 60_000);
});

describe('compose.rebuild', () => {
  it('with faces: composeTimeline with lineMs, params, seed and the mock flag; provides totalFrames and coverFrame', () => {
    const motion: MotionDoc = { fps: 30, beats: [{ id: 'b01', startFrame: 0, endFrame: 90, holdFrames: 6, lines: ['l01'] }, { id: 'b02', startFrame: 90, endFrame: 160, holdFrames: 6, lines: ['l02'] }], totalFrames: 160, cutFrames: [90] };
    const { measure, font } = captionMeasure('en', fonts());
    const captions = buildCaptions({ lang: 'en', alignment, measure, font: { family: font.family, sha256: font.sha256 } }).doc as CaptionsDoc;
    const params: ComposeParams = { brand: { en: 'Example' } };
    const a = { node: node('compose:en', 'compose'), current: {}, inputs: { motion, captions }, recipe: recipe as never, fonts: fonts(), lineMs: { l01: 2400, l02: 1800 }, params: params as Record<string, unknown>, seed: 7, mock: true };
    const out = ADAPTERS['compose.rebuild']!.run(a);
    const expected = composeTimeline({ lang: 'en', recipe: recipe as never, motion, captions, lineMs: a.lineMs, params, mock: true, seed: 7, fonts: timelineFonts(fonts()) });
    expect(out.data.timeline).toEqual(expected);
    expect(out.provides).toEqual({ totalFrames: expected.durationInFrames, coverFrame: expected.coverFrame });
    expect(out.checks!.some((c) => c.id === 'compose:en:safe-zone')).toBe(true);
    const t = out.data.timeline as Timeline;
    expect(t.mock).toBe(true);
    expect(t.audio.filter((c) => c.kind === 'voice').map((c) => [c.lineId, c.frames])).toEqual([['l01', 72], ['l02', 54]]);
    // without faces: the fakes' document function
    const plain = ADAPTERS['compose.rebuild']!.run({ node: node('compose:en', 'compose'), current: {}, inputs: { motion, captions } });
    expect(plain.data.timeline).toMatchObject({ fps: 30, durationInFrames: 160 });
    expect(plain.checks).toBeUndefined();
  });
});

describe('the engine passes the adapter args (service wiring with the render chain)', () => {
  it('a 5 % longer take adapts captions and compose with the real builders', async () => {
    const voice = scriptedVoice();
    const executors = serviceExecutors({ root: tmp.root, render: fakeRenderChain(), claudeCli: null, fakes: { voiceMs: voice.fn }, renderDeps: { ffmpeg: null, workDir: (r, n) => `${tmp.dir}/work/${r}/${n.replace(/:/g, '-')}` } });
    const { engine, recipeId } = await setup({ langs: ['en'], build: {}, deps: { executors, adapterFonts: fonts } });
    await runAll(engine, recipeId);
    voice.scale['l03:en'] = 1.05;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:en', mode: 'keep-contracts' });
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    expect(r.adapted).toEqual(expect.arrayContaining(['captions:en', 'compose:en']));
    const cap = (await readVersion(tmp.root, recipeId, 'captions:en', 2))!;
    expect(cap.source).toBe('adapt');
    const pages = await getJson<CaptionsDocX>(tmp.root, cap.outputs.find((o) => o.port === 'captionPages')!.sha256);
    expect(pages.sizePx).toBeGreaterThan(0);
    expect(pages.font).not.toBeNull();
    const comp = (await readVersion(tmp.root, recipeId, 'compose:en', 2))!;
    expect(comp.source).toBe('adapt');
    const t = await getJson<Timeline>(tmp.root, comp.outputs.find((o) => o.port === 'timeline')!.sha256);
    expect(t.mock).toBe(true); // a mock lineage: MOCK on every frame
    expect(Array.isArray(t.elements)).toBe(true);
    expect(comp.checks.some((c) => c.id === 'compose:en:safe-zone')).toBe(true);
    expect(comp.provides.totalFrames).toBe(t.durationInFrames);
  }, 60_000);
});
