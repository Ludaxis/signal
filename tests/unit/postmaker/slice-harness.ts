// The Proof-slice harness: the fixture pack built from
// tests/fixtures/postmaker/pack-example, the synthetic 10 s reference, the 30 s slice recipe, a project whose pack is
// that build, and the service calls the slice makes. Shared by the CI slice test (fake 2-frame renderer) and the
// local slice run (real Remotion renders, render/slice-run.test.ts). [Pack example] everything pack-specific comes
// from the fixture files; nothing here is core.
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AnalyseTools } from '@/lib/studio/postmaker/executors/analyse';
import { analyseReference, recipeFields } from '@/lib/studio/postmaker/executors/analyse';
import type { FakeConfig } from '@/lib/studio/postmaker/executors/fakes';
import { saveDetectedText, addReferenceFile, referenceSource } from '@/lib/studio/postmaker/references';
import type { RenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Deconstruct, ServiceProject } from '@/lib/studio/postmaker/service';
import { readEvents, readRun } from '@/lib/studio/postmaker/store/runs';
import type { Lang, Recipe, Run } from '@/lib/studio/postmaker/types';
import type { RenderChainDeps } from '@/lib/studio/postmaker/executors/render-chain';
import { serviceExecutors } from '@/lib/studio/postmaker/wiring';
import { PostmakerError } from '@/lib/studio/postmaker/errors';
import { loadProjectPack } from '@/lib/studio/postmaker/pack/load';

export const WEB = path.resolve(__dirname, '../../..');
export const FIXTURES = path.join(WEB, 'tests/fixtures/postmaker');
export const PACK_SOURCE = path.join(FIXTURES, 'pack-example');

export interface SliceFixture {
  template: { id: string; variant: string };
  holdFrames: number;
  voiceMs: Record<string, number>;
  recipe: Pick<Recipe, 'campaignId' | 'packId' | 'languages' | 'lengthSec' | 'shape' | 'fps' | 'capUsd' | 'beats' | 'style' | 'assets' | 'tempo' | 'stopAfterRecipe'>;
}

export const sliceFixture = (): SliceFixture => JSON.parse(readFileSync(path.join(FIXTURES, 'recipe-story-spine.json'), 'utf8')) as SliceFixture;

/** The 20 nodes of the slice graph (no lip-sync, no b-roll). */
export const SLICE_NODES = [
  'script', 'art', 'music', 'check',
  ...['narration-text', 'voice', 'motion', 'captions', 'compose', 'mix', 'render', 'post-copy'].flatMap((k) => [`${k}:fa`, `${k}:en`]),
];
export const laneOf = (lang: Lang) => SLICE_NODES.filter((n) => n.endsWith(`:${lang}`));

type Builders = { buildPack: (out: string, o?: { webDir?: string }) => Promise<{ dir: string; library: { id: string; kind: string; file: string; sha256: string }[] }>; makeRef: (o: { out: string; ffmpeg?: string; spawn?: unknown }) => Promise<string> };

/** The fixture scripts (plain .mjs, also runnable by hand). */
export async function fixtureBuilders(): Promise<Builders> {
  const pack = (await import(/* @vite-ignore */ path.join(FIXTURES, 'make-pack.mjs'))) as Pick<Builders, 'buildPack'>;
  const ref = (await import(/* @vite-ignore */ path.join(FIXTURES, 'make-ref.mjs'))) as Pick<Builders, 'makeRef'>;
  return { buildPack: pack.buildPack, makeRef: ref.makeRef };
}

/** A project whose content folder sits in `dir` and whose pack is the built fixture pack. */
export const sliceProject = (dir: string, packDir: string): ServiceProject => ({ id: 'example-project', handle: '@example', contentDir: path.join(dir, 'posts'), timeZone: 'Asia/Tehran', pack: { dir: packDir } });

/** Drops the reference file through the same upload path the API uses. */
export async function uploadReference(root: string, project: ServiceProject, file: string, now?: number) {
  const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
  return addReferenceFile(root, project, body, { by: 'slice@example.test', rights: 'own', ...(now ? { now } : {}) });
}

/**
 * The slice deconstruction: analyse pre-processing runs for real on the dropped reference (probe, cuts, the
 * contact sheet, audio stats; mock read, $0, detected text kept under refs/<id>/), and the beats come from the pack
 * template scaled to the requested length (the slice-30 variant) with the fixture script's lines. It stands in for
 * the deconstructor plus a later template step; the reference evidence is the real one.
 */
export function templateDeconstruct(o: { root: string; tools: AnalyseTools; workDir: string; fixture?: SliceFixture }): Deconstruct {
  const f = o.fixture ?? sliceFixture();
  return async ({ reference, options }) => {
    const src = referenceSource(o.root, reference);
    if (!src) throw new PostmakerError(400, 'validation', 'The slice needs a video reference.');
    const r = await analyseReference({ src, workDir: o.workDir, languages: options.languages, lengthSec: options.lengthSec, shape: options.shape, mode: 'mock', call: null, root: o.root, tools: o.tools });
    await saveDetectedText(o.root, reference.id, r.detectedText);
    const { evidence } = recipeFields(r);
    return { ...f.recipe, languages: options.languages, lengthSec: options.lengthSec, shape: options.shape, beats: f.recipe.beats.map((b) => ({ ...b, onScreenText: Object.fromEntries(options.languages.map((l) => [l, b.onScreenText[l] ?? ''])) })), evidence };
  };
}

/** The scripted mock voice: each line lasts the fixture's budget (× a per-line scale a test may change). */
export function sliceVoice(fixture: SliceFixture = sliceFixture()) {
  const scale: Record<string, number> = {};
  const fn: NonNullable<FakeConfig['voiceMs']> = (lineId, lang) => Math.round((fixture.voiceMs[lineId] ?? 2500) * (scale[`${lineId}:${lang}`] ?? 1));
  return { fn, scale };
}

/**
 * The service registry (script and post-copy in mock mode, check, render chain) with the slice
 * voice. With the project, the creative chain runs on its pack as the service wires it (art, motion, music,
 * SFX, and compose drawing the characters and backgrounds).
 */
export function sliceExecutors(o: { root: string; render: RenderChain; fakes: FakeConfig; renderDeps?: Omit<Partial<RenderChainDeps>, 'chain'>; project?: ServiceProject }) {
  const project = o.project;
  return serviceExecutors({ root: o.root, render: o.render, claudeCli: null, fakes: o.fakes, renderDeps: o.renderDeps, ...(project ? { loadPack: () => loadProjectPack(project, o.root) } : {}) });
}

/** Polls the run until it stops (done, needs-you, failed, stopped) and, when done, until it waits at Proof. */
export async function waitForRun(root: string, runId: string, o: { timeoutMs?: number; proof?: boolean } = {}): Promise<Run> {
  const end = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const r = await readRun(root, runId);
    if (r && r.status !== 'running' && r.status !== 'queued') {
      const atProofNext = r.status === 'done' && !r.packageIds.length && r.steps.some((x) => x.nodeId === 'check' && x.status === 'done');
      // markAtProof runs after the run settles: a done run whose check ran moves to needs-you · check, and the status
      // turns needs-you just before the Proof gate event is appended, so a run at Proof also waits for that event.
      const atProof = r.status === 'needs-you' && r.pausedFor === 'check';
      const gateWritten = !atProof || (await readEvents(root, runId)).events.at(-1)?.kind === 'gate.waiting';
      if (!(o.proof ?? true) || (!atProofNext && gateWritten)) return r;
    }
    if (Date.now() > end) throw new Error(`run ${runId} did not stop in time (${r?.status}/${r?.pausedFor})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
