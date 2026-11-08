// @vitest-environment node
// `step.edit` with `output.replaceFile`: a step upload is typed by magic bytes (a wrong magic byte is 400),
// held to its size limit, and the edit checks the port type (an image port takes an image; a JSON port takes no file:
// 400 wrong-type). A valid PNG on the render's cover makes version n+1 "Edited by you" with the upload's bytes as an
// object, and every dependent is out of date. Synthetic media only (media-fixtures.ts); fakes; network guard on.
import './guard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, engineFor, handleAction } from '@/lib/studio/postmaker/service';
import { getBytes } from '@/lib/studio/postmaker/store/objects';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { addUpload, AUDIO_MAX_BYTES, readUpload, sniffUpload } from '@/lib/studio/postmaker/uploads';
import { postsProject, withPostsProject } from './accept-fixtures';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';
import { jpeg, mp4, png, wav } from './media-fixtures';

withPostsProject();

const actor = { email: 'owner@example.test' };
const stream = (buf: Buffer, size = 64 * 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size)));
      c.close();
    },
  });

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

async function ranRecipe() {
  const fakes = { counters: newCounters() };
  const s = await setup({ langs: ['en'], fakes });
  await runAll(s.engine, s.recipeId);
  _setServiceDeps({ executors: defaultExecutors({ fakes }), buildOptions: () => ({}) });
  return s;
}

describe('step uploads (magic bytes, limits)', () => {
  it('types a file by its first bytes: PNG, JPG, MP4 and WAV are kept with their measures; other bytes are 400', async () => {
    const p = await addUpload(tmp.root, stream(png(1080, 1920)), { by: 'owner@example.test' });
    expect(p).toMatchObject({ kind: 'image', mime: 'image/png', ext: 'png', meta: { width: 1080, height: 1920 } });
    expect(p.id).toMatch(/^up-[0-9a-f]{16}$/);
    expect((await readUpload(tmp.root, p.id)).upload.sha256).toBe(p.sha256);
    expect(await addUpload(tmp.root, stream(jpeg()), { by: 'x' })).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(await addUpload(tmp.root, stream(mp4({ seconds: 4 })), { by: 'x' })).toMatchObject({ kind: 'video', mime: 'video/mp4', meta: { durationMs: 4000 } });
    expect(await addUpload(tmp.root, stream(wav(750)), { by: 'x' })).toMatchObject({ kind: 'audio', mime: 'audio/wav', meta: { sampleRate: 48_000, durationMs: 750 } });
    // a PNG name and type header do not matter: the bytes are text
    const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg> not a png at all');
    await expect(addUpload(tmp.root, stream(bad), { by: 'x' })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
    const flipped = png();
    flipped[1] = 0x51; // one wrong magic byte
    await expect(addUpload(tmp.root, stream(flipped), { by: 'x' })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
    expect(sniffUpload(flipped)).toBeNull();
  });

  it('holds each type to its limit while streaming, and refuses a declared length over 500 MB before reading', async () => {
    const big = Buffer.concat([png(), Buffer.alloc(20 * 1024 * 1024)]);
    await expect(addUpload(tmp.root, stream(big, 1024 * 1024), { by: 'x' })).rejects.toThrow('Images can be up to 20 MB.');
    await expect(addUpload(tmp.root, stream(png()), { by: 'x', declaredBytes: 600 * 1024 * 1024 })).rejects.toThrow('Files can be up to 500 MB.');
    const hugeWav = Buffer.concat([wav(10), Buffer.alloc(AUDIO_MAX_BYTES)]);
    await expect(addUpload(tmp.root, stream(hugeWav, 4 * 1024 * 1024), { by: 'x' })).rejects.toThrow('Sounds can be up to 100 MB.');
    await expect(readUpload(tmp.root, 'up-0000000000000000')).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'not_found'));
    await expect(readUpload(tmp.root, '../etc')).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
  });
});

describe('step.edit with replaceFile', () => {
  it('a valid PNG replaces the cover: version n+1 edited by you, the bytes stored as an object, dependents out of date', async () => {
    const { recipeId } = await ranRecipe();
    const base = (await readHead(tmp.root, recipeId, 'render:en')).current!;
    const before = (await readVersion(tmp.root, recipeId, 'render:en', base))!;
    const bytes = png(1080, 1920);
    const up = await addUpload(tmp.root, stream(bytes), { by: actor.email });
    const r = await handleAction(postsProject(), actor, { action: 'step.edit', recipeId, nodeId: 'render:en', baseVersion: base, output: { replaceFile: { port: 'cover', uploadId: up.id } } });
    expect(r.status).toBe(200);
    const v = (r.body as { version: { n: number; source: string; editedByUser: boolean; outputs: { port: string; sha256: string; mime: string; name: string; meta?: unknown }[] }; adapted: string[] }).version;
    expect(v).toMatchObject({ n: base + 1, source: 'edit', editedByUser: true });
    const cover = v.outputs.find((o) => o.port === 'cover')!;
    expect(cover).toMatchObject({ sha256: up.sha256, mime: 'image/png', name: 'cover.en.png', meta: { width: 1080, height: 1920 } });
    expect(Buffer.compare(await getBytes(tmp.root, cover.sha256, { verify: true }), bytes)).toBe(0);
    // the other outputs are untouched
    expect(v.outputs.find((o) => o.port === 'video')!.sha256).toBe(before.outputs.find((o) => o.port === 'video')!.sha256);
    expect((r.body as { adapted: string[] }).adapted).toEqual([]);
    const { engine } = await engineFor(postsProject());
    const st = await engine.status(recipeId);
    expect(st.check).toMatchObject({ outOfDate: true, reasons: ['render:en changed'] });
    expect(st['render:en']!.outOfDate).toBe(false);
  });

  it('refuses a wrong port type (400 wrong-type), a JSON port, an unknown port and upload, and a file with a JSON edit', async () => {
    const { recipeId } = await ranRecipe();
    const head = async (id: string) => (await readHead(tmp.root, recipeId, id)).current!;
    const img = await addUpload(tmp.root, stream(png()), { by: actor.email });
    const sound = await addUpload(tmp.root, stream(wav()), { by: actor.email });
    const edit = (nodeId: string, baseVersion: number, port: string, uploadId: string) => handleAction(postsProject(), actor, { action: 'step.edit', recipeId, nodeId, baseVersion, output: { replaceFile: { port, uploadId } } });
    const wrong = (e: unknown) => isPostmakerError(e, 'wrong-type') && (e as { status: number }).status === 400;
    await expect(edit('render:en', await head('render:en'), 'video', img.id)).rejects.toSatisfy(wrong); // image on a video port
    await expect(edit('music', await head('music'), 'track', img.id)).rejects.toSatisfy(wrong); // image on a sound port
    await expect(edit('compose:en', await head('compose:en'), 'timeline', img.id)).rejects.toSatisfy(wrong); // a JSON port
    await expect(edit('render:en', await head('render:en'), 'nope', img.id)).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
    await expect(edit('render:en', await head('render:en'), 'cover', 'up-00000000000000ff')).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'not_found'));
    await expect(handleAction(postsProject(), actor, { action: 'step.edit', recipeId, nodeId: 'render:en', baseVersion: await head('render:en'), output: { json: { x: 1 }, replaceFile: { port: 'cover', uploadId: img.id } } })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
    // nothing was written by the refusals
    expect(await head('render:en')).toBe(1);
    // a sound on the music track is accepted; the steps that read it are out of date
    const ok = await edit('music', await head('music'), 'track', sound.id);
    expect(ok.status).toBe(200);
    const { engine } = await engineFor(postsProject());
    const st = await engine.status(recipeId);
    expect(st['mix:en']!.outOfDate).toBe(true);
  });
});
