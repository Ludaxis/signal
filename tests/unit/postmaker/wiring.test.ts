// @vitest-environment node
// The service's executor registry runs script and
// post-copy, check and render chain; render:<lang> emits the `measurements` port and compose:<lang> the
// `preview` strip that check reads, with reserves; the detected text of a reference goes to
// refs/<id>/ and never into the recipe. Offline: fake 2-frame renderer, no agent call (mock mode), network guard on;
// only the bundled ffmpeg may be spawned (to make and read the synthetic reference).
import child_process from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { reservesFor, renderMeasurements } from '@/lib/studio/postmaker/checks/renderMeasurements';
import { KINDS } from '@/lib/studio/postmaker/graph/kinds';
import { implVersionsOf } from '@/lib/studio/postmaker/executors';
import { fakeRenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { RenderMeasurements } from '@/lib/studio/postmaker/executors/check';
import { DETECTED_TEXT_FILE, saveDetectedText } from '@/lib/studio/postmaker/references';
import { analyseDeconstruct, connectorCanSee, VISION_FALLBACK_NOTE } from '@/lib/studio/postmaker/service';
import { connectorById } from '@/lib/studio/postmaker/connectors';
import { PostmakerError } from '@/lib/studio/postmaker/errors';
import type { AgentCall } from '@/lib/studio/postmaker/executors/agent';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { getBytes, getJson } from '@/lib/studio/postmaker/store/objects';
import { refDir } from '@/lib/studio/postmaker/store/paths';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { CheckResult, PreviewStrip, Reference } from '@/lib/studio/postmaker/types';
import { serviceExecutors } from '@/lib/studio/postmaker/wiring';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';

const realSpawn = child_process.spawn;
const FFMPEG = ffmpegStatic as string;
const allowFfmpeg = ((bin: string, args: string[], opts: object) => {
  if (bin !== FFMPEG) throw new Error(`spawn of ${bin} is not allowed here`);
  return realSpawn(bin, args, opts);
}) as unknown as Spawn;

async function current<T>(recipeId: string, nodeId: string, port: string): Promise<T> {
  const h = await readHead(tmp.root, recipeId, nodeId);
  const v = (await readVersion(tmp.root, recipeId, nodeId, h.current!))!;
  return getJson<T>(tmp.root, v.outputs.find((o) => o.port === port && o.kind === 'json')!.sha256);
}

describe('service registry', () => {
  it('real script, post-copy and check; the render chain only with a renderer, fakes otherwise', () => {
    const fake = implVersionsOf(serviceExecutors({ root: tmp.root, render: null, claudeCli: null }));
    expect(fake).toMatchObject({ script: 'script@2', 'post-copy': 'post-copy@2', check: 'check@2', compose: 'compose@1', render: 'render@1', mix: 'mix@1' });
    const real = implVersionsOf(serviceExecutors({ root: tmp.root, render: fakeRenderChain(), claudeCli: null }));
    expect(real).toMatchObject({ captions: 'captions@2', compose: 'compose@4', mix: 'mix@3', render: 'render@3' });
  });

  it('every port the render chain writes is declared in KINDS', () => {
    expect(KINDS.compose.outputs).toEqual(['timeline', 'preview']);
    expect(KINDS.mix.outputs).toEqual(['mixPlan', 'master', 'loudness']);
    expect(KINDS.render.outputs).toEqual(['video', 'cover', 'log', 'measurements']);
  });
});

describe('feeds', () => {
  it('a mock run: compose emits the PreviewStrip, render the measurements, and the check measures safe zones, AI label and fonts', async () => {
    const executors = serviceExecutors({ root: tmp.root, render: fakeRenderChain(), claudeCli: null, renderDeps: { ffmpeg: null, workDir: (r, n) => `${tmp.dir}/work/${r}/${n.replace(/:/g, '-')}` } });
    const s = await setup({ build: {}, deps: { executors } });
    const run = await runAll(s.engine, s.recipeId);
    expect(run.steps.find((x) => x.nodeId === 'check')?.status).toBe('done');
    for (const lang of ['fa', 'en'] as const) {
      const strip = await current<PreviewStrip>(s.recipeId, `compose:${lang}`, 'preview');
      expect(strip).toMatchObject({ lang, fps: 30, width: 540, height: 960 });
      expect(strip.frames.length).toBeGreaterThan(0);
      for (const f of strip.frames) expect((await getBytes(tmp.root, f.sha256)).length).toBeGreaterThan(0);
      const m = await current<RenderMeasurements & { basis: string }>(s.recipeId, `render:${lang}`, 'measurements');
      expect(m.basis).toMatch(/not pixel-measured/);
      expect(m.layout!.length).toBeGreaterThan(0);
      expect(m.aiLabel!.every((f) => f.present)).toBe(true);
      expect(m.fonts!.length).toBeGreaterThan(0);
    }
    const score = await current<CheckResult>(s.recipeId, 'check', 'score');
    expect(score.reviewer).toBe('deterministic-only');
    for (const sheet of score.sheets) {
      const row = (id: string) => sheet.checks.find((c) => c.id === id)!;
      expect(row('safe-zones').measured, `${sheet.lang} safe zones`).toBe(true);
      expect(row('ai-label').measured, `${sheet.lang} ai label`).toBe(true);
      expect(row('fonts').measured, `${sheet.lang} fonts`).toBe(true);
    }
  }, 60_000);

  it('reserves come from safeZones in the check box shape; unknown canvases have none', () => {
    const r = reservesFor({ width: 1080, height: 1920 });
    expect(r.find((x) => x.id === 'top')!.box).toEqual({ x: 0, y: 0, w: 1080, h: 268 });
    expect(r.map((x) => x.id)).toContain('right-rail');
    expect(reservesFor({ width: 640, height: 480 })).toEqual([]);
    expect(typeof renderMeasurements).toBe('function');
  });
});

async function syntheticReference(id = 'ref-20261106-0001'): Promise<{ ref: Reference; dir: string }> {
  const dir = refDir(tmp.root, id);
  mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'source.mp4');
  await new Promise<void>((resolve, reject) => {
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=360x640:r=30:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src];
    const p = realSpawn(FFMPEG, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
  });
  const ref: Reference = { schema: 'signal.pm.reference/1', id, kind: 'video', file: 'source.mp4', sha256: null, url: null, probe: null, rights: 'own', addedAt: '2026-11-06T00:00:00.000Z', addedBy: 'tester@example.test' };
  writeFileSync(path.join(dir, 'ref.json'), JSON.stringify(ref));
  return { ref, dir };
}

const PROJECT = () => ({ id: 'fixture', handle: 'x', contentDir: tmp.contentDir, timeZone: 'Europe/Berlin', pack: null }) as never;

describe('analyse as the deconstruction; detected text under refs/<id>/', () => {
  it('a dropped video is read at its cuts (mock); the detected text is stored beside the reference, never in the recipe', async () => {
    const { ref, dir } = await syntheticReference();
    const id = ref.id;
    const d = analyseDeconstruct({ root: tmp.root, live: false, call: null, tools: { ffmpeg: FFMPEG, ffprobe: null, spawn: allowFfmpeg } });
    const draft = await d({ reference: ref, options: { languages: ['en'], lengthSec: 30, shape: '9:16' }, project: { id: 'fixture', handle: 'x', contentDir: tmp.contentDir, timeZone: 'Europe/Berlin', pack: null } as never });
    expect(draft.beats.length).toBeGreaterThan(0);
    expect(draft.evidence.cuts.length).toBeGreaterThan(0);
    expect(JSON.stringify(draft)).not.toMatch(/detectedText/);
    const stored = JSON.parse(readFileSync(path.join(dir, DETECTED_TEXT_FILE), 'utf8'));
    expect(stored).toMatchObject({ schema: 'signal.pm.detected-text/1', referenceId: id, lines: [] });
    await saveDetectedText(tmp.root, id, ['Some read line']);
    expect(JSON.parse(readFileSync(path.join(dir, DETECTED_TEXT_FILE), 'utf8')).lines).toEqual(['Some read line']);
    expect(existsSync(path.join(dir, 'ref.json'))).toBe(true);
  }, 60_000);

  it('a live connector that cannot do vision yet: Make-it still reaches a recipe on this computer, $0, with a plain note (review finding)', async () => {
    expect(connectorCanSee(connectorById('claude-cli') as never)).toBe(false);
    expect(connectorCanSee({ capabilities: [{ id: 'llm.vision', source: 'x', readAt: '2026-11-07' }] } as never)).toBe(true);
    const { ref, dir } = await syntheticReference();
    const tools = { ffmpeg: FFMPEG, ffprobe: null, spawn: allowFfmpeg };
    let calls = 0;
    const refusing: AgentCall = async (req) => {
      calls++;
      if (req.files?.length) throw new PostmakerError(403, 'forbidden', 'Vision mode needs its security review first.');
      throw new Error('only vision calls are expected');
    };
    // The registry says vision waits for its review: no call at all.
    const quiet = await analyseDeconstruct({ root: tmp.root, live: true, vision: false, call: refusing, tools })({ reference: ref, options: { languages: ['en'], lengthSec: 30, shape: '9:16' }, project: PROJECT() });
    expect(calls).toBe(0);
    expect(quiet.beats.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path.join(dir, DETECTED_TEXT_FILE), 'utf8')).note).toBe(VISION_FALLBACK_NOTE);
    // A connector that refuses vision at call time: one refused call, then the same read on this computer.
    const fallback = await analyseDeconstruct({ root: tmp.root, live: true, vision: true, call: refusing, tools })({ reference: ref, options: { languages: ['en'], lengthSec: 30, shape: '9:16' }, project: PROJECT() });
    expect(calls).toBe(1);
    expect(fallback.beats).toEqual(quiet.beats);
    expect(fallback.evidence.cuts).toEqual(quiet.evidence.cuts);
    expect(JSON.parse(readFileSync(path.join(dir, DETECTED_TEXT_FILE), 'utf8')).note).toBe(VISION_FALLBACK_NOTE);
    // Any other live failure still fails the read (no silent mock).
    const broken: AgentCall = async () => {
      throw new PostmakerError(502, 'invalid-answer', 'The agent did not return valid JSON.');
    };
    await expect(analyseDeconstruct({ root: tmp.root, live: true, vision: true, call: broken, tools })({ reference: ref, options: { languages: ['en'], lengthSec: 30, shape: '9:16' }, project: PROJECT() })).rejects.toMatchObject({ status: 502 });
  }, 60_000);
});
