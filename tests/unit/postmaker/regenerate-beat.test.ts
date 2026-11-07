// @vitest-environment node
// `recipe.regenerate-beat`: the deconstructor reads the reference again (the note goes with it); only the
// named beat takes the new content, with its id, segment and timing kept; every other beat is byte-identical
// (RG-03 style: same canonical JSON, same hash). The recipe's next version puts `script` and everything after it out
// of date ("The recipe changed"), and a Run then makes the script again. Fakes and the built-in mock deconstruction
// only; network guard on.
import './guard';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { REASON_RECIPE } from '@/lib/studio/postmaker/graph/status';
import { mergeBeat } from '@/lib/studio/postmaker/regenerate-beat';
import { addReferenceFile } from '@/lib/studio/postmaker/references';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, engineFor, handleAction, type Deconstruct, type DeconstructInput } from '@/lib/studio/postmaker/service';
import { hashJson } from '@/lib/studio/postmaker/store/objects';
import { refDir, refFile } from '@/lib/studio/postmaker/store/paths';
import { readRecipe } from '@/lib/studio/postmaker/store/recipes';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { Recipe } from '@/lib/studio/postmaker/types';
import { postsProject, withPostsProject } from './accept-fixtures';
import { BEATS, runAll, setup } from './engine-fixtures';
import { tmp } from './guard';
import { png } from './media-fixtures';

withPostsProject();

const actor = { email: 'owner@example.test' };

beforeEach(() => {
  _resetEngineState();
  _resetSchedulerState();
  process.env.SIGNAL_FEATURE_POSTMAKER = '1';
});
afterEach(() => {
  _setServiceDeps({});
  _resetEngineState();
  _resetSchedulerState();
});

/** A deconstructor whose reading differs from the fixture on every beat (the timing and segments too). */
function freshReader(seen: DeconstructInput[]): Deconstruct {
  return async (input) => {
    seen.push(input);
    return {
      campaignId: null,
      packId: null,
      languages: input.options.languages,
      lengthSec: input.options.lengthSec,
      shape: input.options.shape,
      fps: 30,
      capUsd: 0,
      beats: BEATS.map((b, i) => ({ ...b, start: b.start + 0.5 * (i > 0 ? 1 : 0), segment: 'other', name: `fresh ${b.id}`, purpose: 'fresh purpose', visual: 'fresh visual', techniques: ['word-kinetic-caption'], onScreenText: { en: `fresh line ${b.id}`, fa: 'خط تازه' }, audio: 'fresh audio', motion: 'fresh motion' })),
      style: { captions: 'line', pace: 'calm', palette: [], type: 'x', voice: 'x', music: 'x' },
      assets: [],
      tempo: null,
      evidence: { sheets: [], cuts: [], silences: [], loudnessLufs: null },
      stopAfterRecipe: true,
    };
  };
}

const v1Ref = 'ref-20261106-0a0a';
const canon = (r: Recipe) => Object.fromEntries(r.beats.map((b) => [b.id, hashJson(b)]));

describe('recipe.regenerate-beat', () => {
  it('changes only that beat (timing kept), pinned beats byte-identical; script and its dependents go out of date; a Run makes the script again', async () => {
    const fakes = { counters: newCounters() };
    const s = await setup({ langs: ['en'], fakes });
    await runAll(s.engine, s.recipeId);
    // the fixture recipe's reference (a page link record: no file is read by the fake reader)
    mkdirSync(refDir(tmp.root, v1Ref), { recursive: true });
    writeFileSync(refFile(tmp.root, v1Ref), JSON.stringify({ schema: 'signal.pm.reference/1', id: v1Ref, kind: 'page', file: null, sha256: '0'.repeat(64), url: 'https://example.com/', probe: null, rights: 'own', addedAt: '2026-11-06T10:00:00.000Z', addedBy: actor.email }));
    const seen: DeconstructInput[] = [];
    _setServiceDeps({ executors: defaultExecutors({ fakes }), deconstruct: freshReader(seen), buildOptions: () => ({}) });
    const { engine } = await engineFor(postsProject());
    expect(Object.values(await engine.status(s.recipeId)).some((x) => x.outOfDate)).toBe(false);
    const v1 = (await readRecipe(tmp.root, s.recipeId))!;
    const scriptBefore = (await readVersion(tmp.root, s.recipeId, 'script', 1))!;
    expect(scriptBefore.recipe).toEqual({ version: 1, beats: hashJson(v1.beats) });

    const r = await handleAction(postsProject(), actor, { action: 'recipe.regenerate-beat', recipeId: s.recipeId, beatId: 'b03', note: 'warmer' });
    expect(r.status).toBe(200);
    const body = r.body as { recipe: Recipe; changed: boolean; outOfDate: string[] };
    expect(body.changed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.beat).toEqual({ id: 'b03', note: 'warmer' });
    const v2 = (await readRecipe(tmp.root, s.recipeId))!;
    expect(v2.version).toBe(2);
    expect(body.recipe).toEqual(v2);
    const [h1, h2] = [canon(v1), canon(v2)];
    for (const id of Object.keys(h1)) if (id !== 'b03') expect(h2[id], id).toBe(h1[id]); // pinned: byte-identical
    expect(h2.b03).not.toBe(h1.b03);
    const before = v1.beats.find((b) => b.id === 'b03')!;
    expect(v2.beats.find((b) => b.id === 'b03')).toEqual({ ...before, name: 'fresh b03', purpose: 'fresh purpose', visual: 'fresh visual', techniques: ['word-kinetic-caption'], onScreenText: { en: 'fresh line b03' }, audio: 'fresh audio', motion: 'fresh motion' });
    // everything but the beats is the same recipe
    const { beats: _b1, version: _n1, ...rest1 } = v1;
    const { beats: _b2, version: _n2, ...rest2 } = v2;
    void [_b1, _b2, _n1, _n2];
    expect(rest2).toEqual(rest1);

    const st = await engine.status(s.recipeId);
    expect(st.script).toMatchObject({ outOfDate: true, reasons: [REASON_RECIPE] });
    for (const n of s.pipeline.nodes) expect(st[n.id]!.outOfDate, n.id).toBe(true); // every step reads the script
    expect(body.outOfDate.sort()).toEqual(s.pipeline.nodes.map((n) => n.id).sort());
    // no step got a new version
    expect((await readHead(tmp.root, s.recipeId, 'script')).current).toBe(1);

    // a Run makes the script again from the new beats (no reuse of the old version)
    const scripts = fakes.counters.runs['script'];
    await runAll(engine, s.recipeId);
    expect(fakes.counters.runs['script']).toBe(scripts! + 1);
    expect((await readVersion(tmp.root, s.recipeId, 'script', 2))!.recipe).toEqual({ version: 2, beats: hashJson(v2.beats) });
    expect(Object.values(await engine.status(s.recipeId)).some((x) => x.outOfDate)).toBe(false);
  });

  it('through the built-in mock reader: an edited beat comes back from the reference, the rest stay; an unchanged reading writes no version', async () => {
    _setServiceDeps({ buildOptions: () => ({}) });
    const ref = await addReferenceFile(tmp.root, postsProject(), new Blob([new Uint8Array(png(1080, 1920))]).stream(), { by: actor.email });
    const made = await handleAction(postsProject(), actor, { action: 'analyse', referenceId: ref.id, options: { languages: ['en'], lengthSec: 20, shape: '9:16' } });
    const recipeId = (made.body as { recipeId: string }).recipeId;
    const v1 = (await readRecipe(tmp.root, recipeId))!;
    // the person edits b02 by hand
    const edited = v1.beats.map((b) => (b.id === 'b02' ? { ...b, name: 'my own words', purpose: 'mine' } : b));
    await handleAction(postsProject(), actor, { action: 'recipe.update', recipeId, baseVersion: 1, patch: { beats: edited } });
    const v2 = (await readRecipe(tmp.root, recipeId))!;
    const r = await handleAction(postsProject(), actor, { action: 'recipe.regenerate-beat', recipeId, beatId: 'b02' });
    expect((r.body as { changed: boolean; outOfDate: string[] }).changed).toBe(true);
    expect((r.body as { outOfDate: string[] }).outOfDate).toEqual([]); // no pipeline yet
    const v3 = (await readRecipe(tmp.root, recipeId))!;
    expect(v3.version).toBe(3);
    expect(v3.beats.find((b) => b.id === 'b02')).toEqual(v1.beats.find((b) => b.id === 'b02'));
    for (const b of v3.beats) if (b.id !== 'b02') expect(hashJson(b)).toBe(hashJson(v2.beats.find((x) => x.id === b.id)!));
    const again = await handleAction(postsProject(), actor, { action: 'recipe.regenerate-beat', recipeId, beatId: 'b01' });
    expect((again.body as { changed: boolean; recipe: Recipe }).changed).toBe(false);
    expect((await readRecipe(tmp.root, recipeId))!.version).toBe(3);
    await expect(handleAction(postsProject(), actor, { action: 'recipe.regenerate-beat', recipeId, beatId: 'b09' })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'not_found'));
  });

  it('mergeBeat refuses a beat the new reading does not have', () => {
    expect(() => mergeBeat(BEATS, BEATS.slice(0, 2), 'b05', ['en'])).toThrow(/no beat at this place/);
    const out = mergeBeat(BEATS, BEATS, 'b02', ['en', 'fa']);
    out.forEach((b, i) => expect(b === BEATS[i] || b.id === 'b02').toBe(true)); // the others are the very objects
  });
});
