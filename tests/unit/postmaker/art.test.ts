// @vitest-environment node
// `art` (roles doc, quality bar): the ScenePlan Rejects (one failing fixture per rule), the
// deterministic plan for the fixture recipe passing with a clean safe-zone report, the live path through the art
// director (fake AgentCall) and its fallback when the agent cannot run, and the project-neutral role prompt.
// . No vendor, agent or Codex call: the network guard stays empty.
import { postmakerAgentPrompt } from '@/lib/studio/team/roles';
import { maintainerDenylist } from '../name-denylist';
import { networkGuardLog, tmp } from './guard';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reservesFor } from '@/lib/studio/postmaker/checks/renderMeasurements';
import { safeZoneReport } from '@/lib/studio/postmaker/checks/safeZoneReport';
import { PostmakerError } from '@/lib/studio/postmaker/errors';
import { ART_REJECTS, ArtPlanRejected, artContext, artExecutor, plannedLayout, planScenes, scenePlanIssues, validateScenePlan, type ArtAsset, type ArtContext, type ArtWorld, type ScenePlan, type ScenesDoc } from '@/lib/studio/postmaker/executors/art';
import { packWorlds } from '@/lib/studio/postmaker/executors/creative-world';
import { artWorldFor, readRequests, recordAssetRequests } from '@/lib/studio/postmaker/executors/art-assets';
import type { AgentCall } from '@/lib/studio/postmaker/executors/agent';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { loadPack, type LoadedPack } from '@/lib/studio/postmaker/pack/load';
import type { Recipe, RecipeBeat } from '@/lib/studio/postmaker/types';
import { fixtureBuilders, sliceFixture } from './slice-harness';

// ---- a synthetic world (generic ids only) -------------------------------------------------------------------------

const lic = (o: Partial<ArtAsset['licence']> = {}): ArtAsset['licence'] => ({ allowedUses: ['organic'], expiresAt: null, aiGenerated: false, type: 'owned', ...o });
const asset = (id: string, kind: ArtAsset['kind'], o: Partial<ArtAsset> = {}): ArtAsset => ({ id, kind, tags: [], status: 'approved', licence: lic(), ...o });
const LIB: ArtAsset[] = [
  asset('bg-a', 'background'),
  asset('bg-b', 'background'),
  asset('bg-draft', 'background', { status: 'draft' }),
  asset('stk-star', 'sticker'),
  asset('stk-words', 'sticker', { tags: ['text'], dims: { w: 400, h: 200 } }),
  asset('ui-phone', 'ui', { tags: ['phone-frame'] }),
  asset('char-a', 'character'),
  asset('char-b', 'character'),
];
const WORLD: ArtWorld = {
  library: LIB,
  rigs: { 'char-a': { views: ['front', 'three-quarter-L'], poses: ['neutral', 'look-phone', 'surprised'] }, 'char-b': { views: ['front'], poses: ['neutral', 'hands-hips'] } },
  template: {
    segments: [
      { id: 'hook', shot: 'wide', require: ['stickers>=1'] },
      { id: 'story', shot: 'medium', require: ['newCharacter'] },
      { id: 'demo', shot: 'insert', require: ['phoneInsert'] },
    ],
    cast: { lead: 'char-a', foil: 'char-b' },
  },
  names: [],
};
const BEATS: RecipeBeat[] = [
  { id: 'b01', start: 0, end: 3, segment: 'hook', name: '', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '' },
  { id: 'b02', start: 3, end: 6, segment: 'story', name: '', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '' },
  { id: 'b03', start: 6, end: 9, segment: 'story', name: '', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '' },
  { id: 'b04', start: 9, end: 12, segment: 'demo', name: '', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '' },
];
const recipeOf = (beats: RecipeBeat[], shape: Recipe['shape'] = '9:16') => ({ id: 'rc-20261107-abcd', shape, beats }) as unknown as Recipe;
const ctxOf = (o: { final?: boolean; cut?: string[]; world?: ArtWorld } = {}): ArtContext => artContext({ recipe: recipeOf(BEATS), params: { final: o.final === true, cutSegments: o.cut ?? [] }, byPort: {}, now: () => Date.parse('2026-11-07T00:00:00Z') }, o.world ?? WORLD);

const input = (o: Partial<ExecInput> & { recipe: Recipe }): ExecInput =>
  ({ node: { id: 'art', kind: 'art', lang: null, params: {} }, lang: null, inputs: [], byPort: {}, params: {}, seed: 1, mode: 'mock', connector: 'mock', note: null, beats: null, pinnedBeats: [], previous: null, violations: [], take: 1, context: null, runId: 'run-20261107-101500-ab12', now: () => Date.parse('2026-11-07T00:00:00Z'), signal: new AbortController().signal, ...o }) as ExecInput;

const clone = (p: ScenePlan): ScenePlan => JSON.parse(JSON.stringify(p)) as ScenePlan;
const beat = (p: ScenePlan, id: string) => p.beats.find((b) => b.beatId === id)!;
const codes = (p: ScenePlan, ctx: ArtContext) => [...new Set(scenePlanIssues(p, ctx).map((i) => i.code))];
function rejected(p: ScenePlan, ctx: ArtContext): ArtPlanRejected {
  try {
    validateScenePlan(p, ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(ArtPlanRejected);
    return e as ArtPlanRejected;
  }
  throw new Error('expected a rejection');
}

/** Platform, vendor and font words stay out of the built-in role prompts; a maintainer's own names come from SIGNAL_NAME_DENYLIST. */
const PROMPT_WORDS = /harfino|instagram|tiktok|app store|google play|vazirmatn|instrument sans|tehran|suno|elevenlabs|higgsfield/i;

describe('ScenePlan Rejects: one failing fixture per rule', () => {
  const ctx = ctxOf();
  const base = planScenes(ctx);

  it('the deterministic plan of the synthetic world passes every rule', () => {
    expect(scenePlanIssues(base, ctx)).toEqual([]);
    expect(base.beats.map((b) => [b.beatId, b.shot, b.preset, b.background])).toEqual([
      ['b01', 'wide', 'hook', 'bg-a'],
      ['b02', 'medium', 'story', 'bg-b'],
      ['b03', 'medium', 'story', 'bg-b'],
      ['b04', 'insert', 'demo-chant', 'bg-a'],
    ]);
    expect(beat(base, 'b02').cast.map((c) => c.charId)).toEqual(['char-a', 'char-b']);
    expect(beat(base, 'b04').ui).toEqual({ phoneFrame: 'ui-phone', screens: [] });
  });

  it('rule 1, unapproved asset: a draft background fails a final run (a draft run may use it); retired always fails', () => {
    const p = clone(base);
    beat(p, 'b02').background = 'bg-draft';
    beat(p, 'b03').background = 'bg-draft';
    expect(scenePlanIssues(p, ctx)).toEqual([]);
    const e = rejected(p, ctxOf({ final: true }));
    expect(e.code).toBe(ART_REJECTS.unapproved);
    expect(e.status).toBe(422);
    const retired = ctxOf({ world: { ...WORLD, library: LIB.map((a) => (a.id === 'bg-draft' ? { ...a, status: 'retired' as const } : a)) } });
    expect(codes(p, retired)).toEqual([ART_REJECTS.unapproved]);
  });

  it('rule 2, safe zones: a face in the right rail, a face in the top reserve, a text sticker in the bottom reserve', () => {
    const rail = clone(base);
    beat(rail, 'b01').cast[0]!.anchor = { x: 990, y: 1600, h: 806 };
    expect(rejected(rail, ctx).code).toBe(ART_REJECTS.safeZone);
    expect(scenePlanIssues(rail, ctx)[0]!.text).toMatch(/right-rail|side-right/);
    const top = clone(base);
    beat(top, 'b01').cast[0]!.anchor = { x: 540, y: 600, h: 806 };
    expect(codes(top, ctx)).toEqual([ART_REJECTS.safeZone]);
    const words = clone(base);
    beat(words, 'b01').stickers.push({ assetId: 'stk-words', x: 540, y: 1650, enterOffsetFrames: 6 });
    expect(codes(words, ctx)).toEqual([ART_REJECTS.safeZone]);
    // a plain sticker is decoration and may sit anywhere
    const plain = clone(base);
    beat(plain, 'b01').stickers.push({ assetId: 'stk-star', x: 540, y: 1650, enterOffsetFrames: 6 });
    expect(scenePlanIssues(plain, ctx)).toEqual([]);
  });

  it('rule 3, a face box over the chosen text zone fails; moving captions to the lower band fixes it', () => {
    const p = clone(base);
    beat(p, 'b01').cast[0]!.anchor = { x: 540, y: 1000, h: 806 }; // head top at y 597, inside the headline band
    expect(rejected(p, ctx).code).toBe(ART_REJECTS.faceOverText);
    beat(p, 'b01').textZone = 'lower';
    expect(scenePlanIssues(p, ctx)).toEqual([]);
  });

  it('rule 4, a shot that differs from the template beat', () => {
    const p = clone(base);
    beat(p, 'b04').shot = 'card';
    expect(rejected(p, ctx).code).toBe(ART_REJECTS.shot);
  });

  it('rule 5, a pose or a view the rig lacks, and a character with no rig', () => {
    const pose = clone(base);
    beat(pose, 'b02').cast[1]!.pose = 'cheer';
    expect(rejected(pose, ctx).code).toBe(ART_REJECTS.rig);
    const view = clone(base);
    beat(view, 'b02').cast[1]!.view = 'profile-L';
    expect(rejected(view, ctx).code).toBe(ART_REJECTS.rig);
    const norig = ctxOf({ world: { ...WORLD, rigs: { 'char-a': WORLD.rigs['char-a']! } } });
    expect(codes(base, norig)).toEqual([ART_REJECTS.rig]);
  });

  it('rule 6, the background changes inside a segment, unless the node or the template says the segment cuts', () => {
    const p = clone(base);
    beat(p, 'b03').background = 'bg-a';
    expect(rejected(p, ctx).code).toBe(ART_REJECTS.background);
    expect(scenePlanIssues(p, ctxOf({ cut: ['story'] }))).toEqual([]);
    const cutWorld: ArtWorld = { ...WORLD, template: { ...WORLD.template!, segments: WORLD.template!.segments.map((s) => (s.id === 'story' ? { ...s, cut: true } : s)) } };
    const tctx = ctxOf({ world: cutWorld });
    expect(tctx.cutSegments).toEqual(['story']);
    expect(scenePlanIssues(p, tctx)).toEqual([]);
  });

  it('structure: unknown ids, wrong kinds, a missing beat and an unknown pose id are refused', () => {
    const p = clone(base);
    beat(p, 'b01').background = 'stk-star';
    expect(codes(p, ctx)).toContain('art.asset-kind');
    const q = clone(base);
    beat(q, 'b01').stickers.push({ assetId: 'stk-none', x: 300, y: 900, enterOffsetFrames: 0 });
    expect(codes(q, ctx)).toContain('art.asset-unknown');
    expect(codes({ ...base, beats: base.beats.slice(1) }, ctx)).toContain('art.beats');
    const r = clone(base) as unknown as { beats: { cast: { pose: string }[] }[] };
    r.beats[0]!.cast[0]!.pose = 'moonwalk';
    expect(() => validateScenePlan(r, ctx)).toThrow(/pose/);
  });
});

// ---- the fixture pack and recipe ------------------------------------------------------------------------------------

const shared: { dir: string; pack: LoadedPack | null } = { dir: '', pack: null };
beforeAll(async () => {
  shared.dir = mkdtempSync(path.join(os.tmpdir(), 'signal-art-'));
  const { buildPack } = await fixtureBuilders();
  const built = await buildPack(path.join(shared.dir, 'pack'));
  shared.pack = await loadPack(built.dir, { now: Date.parse('2026-11-07T00:00:00Z') });
}, 60_000);
afterAll(() => rmSync(shared.dir, { recursive: true, force: true }));

const fixtureRecipe = (): Recipe => ({ ...sliceFixture().recipe, id: 'rc-20261107-abcd', version: 1 }) as unknown as Recipe;

describe('the default rig loader casts the Tier A lead', () => {
  it('with the pack rig loader the template lead (Tier A) is castable and leads the hook; the Tier B foil joins the story', async () => {
    const worlds = packWorlds(tmp.root, async () => shared.pack!);
    const world = await artWorldFor(tmp.root, shared.pack!, { loadRig: worlds.artRig });
    expect(world.rigs['char-cutout']).toMatchObject({ tier: 'A', views: ['front', 'three-quarter-L'] });
    const r = await artExecutor({ world: async () => world }).run(input({ recipe: fixtureRecipe() }));
    const doc = r.outputs[0]!.data as ScenesDoc;
    expect(doc.beats[0]!.cast.map((c) => c.charId)).toEqual(['char-cutout']);
    expect(doc.beats[1]!.cast.map((c) => c.charId)).toEqual(['char-cutout', 'char-elder']);
  });
});

describe('the mock plan for the fixture recipe', () => {
  it('passes, cast only what the Tier B rigs can do, its safe-zone report is clean, and missing stickers become pending requests', async () => {
    const world = await artWorldFor(tmp.root, shared.pack!);
    expect(world.rigs).toEqual({ 'char-lead': { tier: 'B', views: ['front'], poses: ['neutral'] }, 'char-elder': { tier: 'B', views: ['front'], poses: ['neutral'] } });
    expect(world.template?.cast.lead).toBe('char-cutout'); // The Tier A rig leads; without a rig loader it is not castable
    expect(world.names.length).toBeGreaterThan(0); // from the pack glossary, never from core
    const recipe = fixtureRecipe();
    const ex = artExecutor({ world: async () => world, onRequests: (reqs, i, w) => recordAssetRequests(tmp.root, reqs, { recipeId: i.recipe.id, nodeId: i.node.id, runId: i.runId, canvas: 'reel', names: w.names, now: i.now }) });
    const r = await ex.run(input({ recipe }));
    expect(r.status).toBe('ok');
    const doc = r.outputs[0]!.data as ScenesDoc;
    expect(doc.source).toBe('library');
    expect(doc.beats.map((b) => b.shot)).toEqual(['wide', 'medium', 'card', 'insert', 'card', 'card', 'card']);
    expect(doc.beats.every((b) => b.background === 'bg-living-room-night')).toBe(true);
    expect(doc.aiGenerated).toBe(false);
    // re-check the stored plan with the validator, then the report over its planned layout
    const ctx = artContext({ recipe, params: {}, byPort: {}, now: () => 0 }, world);
    expect(scenePlanIssues({ beats: doc.beats.map((b) => {
      const { id, anchors, ...rest } = b;
      void id;
      void anchors;
      return rest;
    }), newAssets: [], contractNotes: [] }, ctx)).toEqual([]);
    const report = safeZoneReport(plannedLayout(doc, ctx), reservesFor({ width: 1080, height: 1920 }));
    expect(report.ok).toBe(true);
    expect(report.intersections).toEqual([]);
    expect(r.provides.textZones).toEqual(Object.fromEntries(doc.beats.map((b) => [b.beatId, b.textZone])));
    // the library has no stickers: the template's sticker counts become pending requests, nothing is generated
    const reqs = await readRequests(tmp.root);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((q) => q.status === 'pending' && q.kind === 'sticker' && q.waiting === 'Needs you: press Run' && q.lint.length === 0)).toBe(true);
    expect(r.checks?.find((c) => c.id === 'art.missing-assets')).toMatchObject({ required: false, ok: false });
    // the same run again records nothing new
    await ex.run(input({ recipe }));
    expect((await readRequests(tmp.root)).length).toBe(reqs.length);
  });

  it('with no pack the step keeps its fake; with no background it records the request and waits for a person', async () => {
    const fallback = { kind: 'art' as const, implVersion: 'art-fake', deterministic: true, estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'mock', verified: true }), run: async () => ({ outputs: [], provides: {}, costUsd: 0 }) };
    await expect(artExecutor({ world: async () => null, fallback }).run(input({ recipe: recipeOf(BEATS) }))).resolves.toMatchObject({ outputs: [] });
    const bare: ArtWorld = { ...WORLD, library: LIB.filter((a) => a.kind !== 'background') };
    const ex = artExecutor({ world: async () => bare, onRequests: (reqs) => recordAssetRequests(tmp.root, reqs, { canvas: 'reel' }) });
    await expect(ex.run(input({ recipe: recipeOf(BEATS) }))).rejects.toSatisfy((e: unknown) => e instanceof PostmakerError && e.code === 'needs_you');
    expect((await readRequests(tmp.root)).map((q) => [q.kind, q.status])).toEqual([['background', 'pending']]);
  });
});

describe('the live path: the art director proposes, code decides', () => {
  const recipe = recipeOf(BEATS);
  const answer = planScenes(ctxOf());

  it('a valid answer is used as the plan, within the role envelope (sonnet, $0.60, 4 turns)', async () => {
    const seen: { agent: string; model: string; budget: number; turns: number; prompt: string }[] = [];
    const call: AgentCall = async (req) => {
      seen.push({ agent: req.agent, model: req.envelope.model, budget: req.envelope.budgetUsd, turns: req.envelope.maxTurns, prompt: req.prompt });
      return { text: JSON.stringify(answer), costUsd: 0.1, model: 'sonnet' };
    };
    const r = await artExecutor({ world: async () => ({ ...WORLD, rejectedPrompts: ['a plain rejected test wording'] }), call }).run(input({ recipe, mode: 'live', connector: 'pack' }));
    expect((r.outputs[0]!.data as ScenesDoc).source).toBe('art-director');
    expect(r.costUsd).toBe(0.1);
    expect(seen.map((s) => [s.agent, s.model, s.budget, s.turns])).toEqual([['art-director', 'sonnet', 0.6, 4]]);
    expect(seen[0]!.prompt).toContain('# Art director');
    expect(seen[0]!.prompt).toContain('"ui-phone"');
    expect(seen[0]!.prompt).toContain('a plain rejected test wording'); // a rejected wording is final: the director is told
  });

  it('an answer that breaks a rule fails the step with the rule code and carries the billed cost', async () => {
    const bad = clone(answer);
    beat(bad, 'b04').shot = 'card';
    const call: AgentCall = async () => ({ text: JSON.stringify(bad), costUsd: 0.2, model: 'sonnet' });
    const e = (await artExecutor({ world: async () => WORLD, call }).run(input({ recipe, mode: 'live', connector: 'pack' })).catch((x: unknown) => x)) as ArtPlanRejected & { costUsd?: number };
    expect(e.code).toBe(ART_REJECTS.shot);
    expect(e.costUsd).toBe(0.2);
  });

  it('when the art director cannot run (agents off, not attended, not connected) the library plan is used', async () => {
    for (const err of [new PostmakerError(403, 'forbidden', 'off'), new PostmakerError(409, 'needs_you', 'Needs you: press Run')]) {
      const r = await artExecutor({ world: async () => WORLD, call: async () => Promise.reject(err) }).run(input({ recipe, mode: 'live', connector: 'pack' }));
      expect((r.outputs[0]!.data as ScenesDoc).source).toBe('library');
      expect(r.checks?.find((c) => c.id === 'art.director')).toMatchObject({ ok: true, required: false });
    }
    const r = await artExecutor({ world: async () => WORLD, call: null }).run(input({ recipe, mode: 'live', connector: 'pack' }));
    expect((r.outputs[0]!.data as ScenesDoc).source).toBe('library');
  });
});

describe('the art-director role prompt is project-neutral', () => {
  it('names no project, brand, person, city, store or font, and keeps the gated-request rule', () => {
    const text = postmakerAgentPrompt('art-director');
    const deny = maintainerDenylist();
    expect(text.split('\n').filter((l) => PROMPT_WORDS.test(l) || deny?.test(l))).toEqual([]);
    expect(text).toMatch(/newAssets/);
    expect(text).toMatch(/at most 600 characters/);
  });
  it('the network guard saw no attempt', () => {
    expect(networkGuardLog()).toEqual([]);
  });
});
