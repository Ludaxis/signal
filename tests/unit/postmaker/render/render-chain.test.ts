// The render chain in the engine (offline, CI): a mock make-it run with the real captions, compose, mix and
// render executors over the fake 2-frame renderer reaches Proof; the render forces the MOCK layer for a mock
// lineage; the render log lists each font family with its sha256; the renderer injects into remotion
// connector (makeRemotion({ render })). No Chrome, no child process, no network (the guard is installed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tmp } from '../guard';
import { runAll, setup } from '../engine-fixtures';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { getBytes, getJson } from '@/lib/studio/postmaker/store/objects';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { makeRemotion } from '@/lib/studio/postmaker/connectors/local';
import { coreFonts } from '@/lib/studio/postmaker/render/fonts';
import { browserFileOk, fakeRenderChain, makeChildRenderChain, remotionRenderer, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { FAKE_MP4_BASE64 } from '@/lib/studio/postmaker/render/fakeMp4';
import { ctxOf } from '../connectors/fakes';

async function outputJson<T>(recipeId: string, nodeId: string, port: string): Promise<T> {
  const h = await readHead(tmp.root, recipeId, nodeId);
  const v = (await readVersion(tmp.root, recipeId, nodeId, h.current!))!;
  return getJson<T>(tmp.root, v.outputs.find((o) => o.port === port)!.sha256);
}

describe('render chain in a mock run (fake renderer)', () => {
  it('reaches Proof with real captions/compose/mix/render; every render is MOCK and logs font hashes', async () => {
    const calls: { tasks: number; files: number }[] = [];
    const inner = fakeRenderChain();
    const chain: RenderChain = { id: 'fake', run: async (t, o) => (calls.push({ tasks: t.length, files: o.publicFiles.length }), inner.run(t, o)) };
    const fakes = { counters: newCounters() };
    const s = await setup({ fakes, deps: { executors: defaultExecutors({ fakes, render: { chain, ffmpeg: null, readObject: (sha) => getBytes(tmp.root, sha), workDir: (r, n) => `${tmp.dir}/work/${r}/${n.replace(/:/g, '-')}` } }) } });
    const run = await runAll(s.engine, s.recipeId);
    expect(run.status).toBe('done');
    expect(run.steps.every((x) => x.status === 'done' && x.mode === 'mock')).toBe(true);

    for (const lang of ['fa', 'en'] as const) {
      const t = await outputJson<Timeline>(s.recipeId, `compose:${lang}`, 'timeline');
      expect(t.schema).toBe('signal.pm.timeline/1');
      expect(t.mock).toBe(true);
      expect(t.lang).toBe(lang);
      expect(t.elements.some((e) => e.kind === 'caption')).toBe(true);
      const log = await outputJson<{ fonts: string[]; mock: boolean; renderer: string }>(s.recipeId, `render:${lang}`, 'log');
      expect(log.mock).toBe(true);
      expect(log.renderer).toBe('fake');
      for (const f of coreFonts()) expect(log.fonts).toContain(`font ${f.family} (${f.role}) sha256 ${f.sha256}`);
      const h = await readHead(tmp.root, s.recipeId, `render:${lang}`);
      const v = (await readVersion(tmp.root, s.recipeId, `render:${lang}`, h.current!))!;
      const video = v.outputs.find((o) => o.port === 'video')!;
      expect((await getBytes(tmp.root, video.sha256)).toString('base64')).toBe(FAKE_MP4_BASE64);
      expect(v.outputs.find((o) => o.port === 'cover')!.mime).toBe('image/png');
    }
    // compose previews (stills) + mix (AudioMaster) + render (video + cover), per language
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.files >= 2)).toBe(true);
  }, 60_000);
});

describe('remotion connector injection (makeRemotion({ render }))', () => {
  it('the connector renders through the chain once a renderer is injected; without one it refuses', async () => {
    const c = makeRemotion({ render: remotionRenderer(fakeRenderChain()), resolve: () => '/x' });
    const out = `${tmp.dir}/v.mp4`;
    const r = await c.mock({ composition: 'StorySpine', props: { timeline: { durationInFrames: 30 } }, out, frames: 30 }, ctxOf({ workDir: tmp.dir }));
    expect(r).toMatchObject({ file: out, mode: 'mock', frames: 2 });
    await expect(makeRemotion({ resolve: () => '/x' }).mock({ composition: 'StorySpine', props: {}, out, frames: 1 }, ctxOf({ workDir: tmp.dir }))).rejects.toMatchObject({ status: 503 });
  });
});

describe('browserExecutable must be the program file ', () => {
  it('a folder or a missing path fails fast with a plain reason and never starts the render child', async () => {
    const browserDir = `${tmp.dir}/chrome-headless-shell-mac-arm64`;
    mkdirSync(browserDir, { recursive: true });
    const binary = `${browserDir}/chrome-headless-shell`;
    writeFileSync(binary, '');
    expect(browserFileOk(binary)).toBe(true);
    expect(browserFileOk(browserDir)).toBe(false);
    expect(browserFileOk(`${tmp.dir}/missing`)).toBe(false);
    let spawned = 0;
    const spawn = (() => {
      spawned++;
      throw new Error('the render child must not start');
    }) as unknown as typeof import('node:child_process').spawn;
    for (const browserExecutable of [browserDir, `${tmp.dir}/missing`]) {
      const chain = makeChildRenderChain({ browserExecutable, cacheDir: `${tmp.dir}/cache`, renderServiceDir: tmp.dir, spawn });
      await expect(chain.run([], { publicFiles: [], workDir: `${tmp.dir}/work` })).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/program file, not a folder/) });
    }
    expect(spawned).toBe(0);
  });
});
