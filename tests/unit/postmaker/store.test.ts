// @vitest-environment node
// The Post maker store: objects (0600, write-once, verify), step versions, heads, recipes, runs and events,
// templates, pins, schema refusal, path safety.
import './guard';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { commitVersion } from '@/lib/studio/postmaker/store/commit';
import { checkSchema } from '@/lib/studio/postmaker/store/fs';
import { lockStep, readHead, setCurrent, unlockStep } from '@/lib/studio/postmaker/store/heads';
import { getBytes, getJson, hasObject, putBytes, putFile, putJson } from '@/lib/studio/postmaker/store/objects';
import { addPins, isPinned, readPins } from '@/lib/studio/postmaker/store/pins';
import {
  assertNodeId,
  headFile,
  newRecipeId,
  newRunId,
  objectPath,
  packDirOf,
  postmakerRoot,
  stepVersionFile,
  versionFile,
} from '@/lib/studio/postmaker/store/paths';
import { createRecipe, openStore, readPipeline, readRecipe, readRecipeIndex, writePipelineVersion, writeRecipeVersion, type RecipeDraft } from '@/lib/studio/postmaker/store/recipes';
import { _forgetEventSeqs, appendEvent, createRun, listRunIds, readEvents, readRun, updateRun } from '@/lib/studio/postmaker/store/runs';
import { createTemplate, listTemplates, readTemplate, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import { readVersion, versionHash, writeVersion } from '@/lib/studio/postmaker/store/versions';
import type { Run, Template } from '@/lib/studio/postmaker/types';
import { versionDraft } from './fixtures';
import { tmp } from './guard';

const RC = 'rc-20261106-77b2';
const mode = (f: string) => statSync(f).mode & 0o777;
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(isPostmakerError(e, code), `expected ${code}, got ${String((e as Error | null)?.message ?? e)}`).toBe(true);
  return e as Error & { status: number };
};

const recipeDraft = (): RecipeDraft => ({
  referenceId: 'ref-20261106-a3f9',
  projectId: 'example-project',
  campaignId: null,
  packId: null,
  languages: ['fa', 'en'],
  lengthSec: 30,
  shape: '9:16',
  fps: 30,
  capUsd: 5,
  beats: [],
  style: { captions: 'word-pop', pace: 'fast', palette: [], type: 'display', voice: 'narrator', music: 'upbeat' },
  assets: [],
  tempo: null,
  evidence: { sheets: [], cuts: [], silences: [], loudnessLufs: null },
  stopAfterRecipe: false,
});

describe('objects', () => {
  it('stores bytes at objects/sha256/<aa>/<sha> with mode 0600, once', async () => {
    const r = await putBytes(tmp.root, 'hello');
    const f = objectPath(tmp.root, r.sha256);
    expect(f).toBe(path.join(tmp.root, 'objects', 'sha256', r.sha256.slice(0, 2), r.sha256));
    expect(mode(f)).toBe(0o600);
    expect(mode(path.dirname(f))).toBe(0o700);
    expect((await putBytes(tmp.root, 'hello')).existed).toBe(true);
    expect((await getBytes(tmp.root, r.sha256)).toString()).toBe('hello');
    expect(await hasObject(tmp.root, r.sha256)).toBe(true);
    expect(await hasObject(tmp.root, '../../etc/passwd')).toBe(false);
  });

  it('copies a media file in, leaving the source untouched', async () => {
    const src = path.join(tmp.dir, 'take.wav');
    writeFileSync(src, Buffer.from([1, 2, 3, 4]));
    const r = await putFile(tmp.root, src);
    expect(r.bytes).toBe(4);
    expect(existsSync(src)).toBe(true);
    expect([...(await getBytes(tmp.root, r.sha256, { verify: true }))]).toEqual([1, 2, 3, 4]);
  });

  it('JSON objects hold the canonical bytes', async () => {
    const r = await putJson(tmp.root, { b: 1, a: 2 });
    expect(readFileSync(objectPath(tmp.root, r.sha256), 'utf8')).toBe('{"a":2,"b":1}');
    expect(await getJson(tmp.root, r.sha256)).toEqual({ a: 2, b: 1 });
  });

  it('verify refuses an object whose bytes changed; a missing object is 404', async () => {
    const r = await putBytes(tmp.root, 'original');
    writeFileSync(objectPath(tmp.root, r.sha256), 'tampered');
    await rejects(getBytes(tmp.root, r.sha256, { verify: true }), 'object-changed');
    await rejects(getBytes(tmp.root, 'a'.repeat(64)), 'object-missing');
  });

  it('refuses ids that are not a sha256 before touching the disk', () => {
    expect(() => objectPath(tmp.root, '../x')).toThrow();
  });
});

describe('step versions are write-once', () => {
  it('a second write of the same version fails with 409, the file is unchanged', async () => {
    const { version } = await commitVersion(tmp.root, versionDraft(RC, 'voice:fa'));
    const file = stepVersionFile(tmp.root, RC, 'voice:fa', 1);
    const before = readFileSync(file, 'utf8');
    expect(mode(file)).toBe(0o600);
    const changed = { ...version, note: 'different' };
    const e = await rejects(writeVersion(tmp.root, { ...changed, hash: versionHash(changed) }), 'exists');
    expect(e.status).toBe(409);
    await rejects(writeVersion(tmp.root, version), 'exists');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('numbers versions 1, 2, 3 and moves the head', async () => {
    for (let i = 0; i < 3; i++) await commitVersion(tmp.root, versionDraft(RC, 'script', { note: `take ${i}` }));
    expect((await readHead(tmp.root, RC, 'script')).current).toBe(3);
    expect((await readVersion(tmp.root, RC, 'script', 2))?.note).toBe('take 1');
  });

  it('hash = sha256(JCS(version without hash)); a hand-edited version is refused on read', async () => {
    const { version } = await commitVersion(tmp.root, versionDraft(RC, 'captions:en'));
    expect(version.hash).toBe(versionHash(version));
    const file = stepVersionFile(tmp.root, RC, 'captions:en', 1);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"note": null', '"note": "sneaky"'));
    await rejects(readVersion(tmp.root, RC, 'captions:en', 1), 'version-changed');
  });

  it('a version may not name an output object that is not stored', async () => {
    const out = { port: 'audio', name: 'l01.wav', kind: 'audio' as const, mime: 'audio/wav', sha256: 'b'.repeat(64), bytes: 1 };
    await rejects(commitVersion(tmp.root, versionDraft(RC, 'voice:en', { outputs: [out] })), 'object-missing');
    expect((await readHead(tmp.root, RC, 'voice:en')).current).toBeNull();
  });

  it('a locked node refuses new versions; a candidate does not become current', async () => {
    await commitVersion(tmp.root, versionDraft(RC, 'art'));
    await lockStep(tmp.root, RC, 'art', 'editor@example.test');
    const e = await rejects(commitVersion(tmp.root, versionDraft(RC, 'art')), 'locked');
    expect(e.message).toBe('Unlock to regenerate');
    await unlockStep(tmp.root, RC, 'art');
    const { version, head } = await commitVersion(tmp.root, versionDraft(RC, 'art', { status: 'candidate' }));
    expect(version.n).toBe(2);
    expect(head.current).toBe(1);
    await rejects(setCurrent(tmp.root, RC, 'art', 2), 'candidate');
    expect((await setCurrent(tmp.root, RC, 'art', 2, { allowCandidate: true })).current).toBe(2);
  });

  it('implVersion must name the node kind', async () => {
    await rejects(commitVersion(tmp.root, versionDraft(RC, 'mix:fa', { implVersion: 'voice@1' })), 'validation');
  });
});

describe('heads', () => {
  it('an unknown node has an empty head; the head can only point at existing versions', async () => {
    expect(await readHead(tmp.root, RC, 'music')).toMatchObject({ current: null, locked: false, skipped: false });
    await rejects(setCurrent(tmp.root, RC, 'music', 1), 'version-missing');
    expect(existsSync(headFile(tmp.root, RC, 'music'))).toBe(false);
    await commitVersion(tmp.root, versionDraft(RC, 'music'));
    await commitVersion(tmp.root, versionDraft(RC, 'music'));
    expect((await setCurrent(tmp.root, RC, 'music', 1)).current).toBe(1);
    expect(mode(headFile(tmp.root, RC, 'music'))).toBe(0o600);
  });

  it('node ids are checked: kinds from the catalogue, `:lang`, `#n`, nothing else', () => {
    expect(assertNodeId('voice:fa')).toBe('voice');
    expect(assertNodeId('broll#2')).toBe('broll');
    expect(assertNodeId('post-copy:en')).toBe('post-copy');
    for (const bad of ['../x', 'voice/fa', 'voice:fa/..', 'unknown', 'voice:FA', '', 'voice:fa#0']) expect(() => assertNodeId(bad), bad).toThrow();
  });
});

describe('recipes and pipelines', () => {
  it('creates a recipe workspace and writes versions with optimistic concurrency', async () => {
    const { index, recipe } = await createRecipe(tmp.root, { id: 'example-project', timeZone: 'Asia/Tehran' }, recipeDraft(), { now: Date.parse('2026-11-06T21:00:00Z') });
    expect(index.id).toMatch(/^rc-20261107-[0-9a-f]{4}$/); // 00:30 next day in Tehran
    expect(recipe.version).toBe(1);
    expect(readFileSync(versionFile(tmp.root), 'utf8')).toBe('2\n');
    const v2 = await writeRecipeVersion(tmp.root, index.id, { ...recipeDraft(), lengthSec: 45 }, { baseVersion: 1 });
    expect(v2.version).toBe(2);
    const e = await rejects(writeRecipeVersion(tmp.root, index.id, recipeDraft(), { baseVersion: 1 }), 'conflict');
    expect(e.message).toBe('Changed since you opened it');
    expect((await readRecipe(tmp.root, index.id))?.lengthSec).toBe(45);
    expect((await readRecipe(tmp.root, index.id, 1))?.lengthSec).toBe(30);
    const p = await writePipelineVersion(tmp.root, index.id, { builtFrom: { recipeVersion: 2, builder: 'story-spine@1' }, nodes: [], edges: [] });
    expect(p.version).toBe(1);
    expect((await readPipeline(tmp.root, index.id))?.builtFrom.recipeVersion).toBe(2);
    expect((await readRecipeIndex(tmp.root, index.id))?.pipeline).toBe(1);
  });

  it('refuses a store or a file made by a newer Signal', async () => {
    await openStore(tmp.root);
    writeFileSync(versionFile(tmp.root), '3\n');
    const e = await rejects(openStore(tmp.root), 'schema-newer');
    expect(e.message).toBe('Made by a newer Signal');
    expect(() => checkSchema({ schema: 'signal.pm.run/2' }, 'run', 1)).toThrow('Made by a newer Signal');
    expect(() => checkSchema({ schema: 'signal.pm.template/1' }, 'run', 1)).toThrow(/not a run/);
  });

  it('roots follow and the pack default', () => {
    const p = { contentDir: '/data/example/posts' };
    expect(postmakerRoot(p)).toBe('/data/example/postmaker');
    expect(packDirOf(p)).toBe('/data/example/pack');
    expect(packDirOf({ ...p, pack: { dir: '/studio/shared-pack' } })).toBe('/studio/shared-pack');
  });

  it('ids carry the date in the project time zone across the DST change', () => {
    const p = { timeZone: 'Europe/Berlin' };
    expect(newRecipeId(p, Date.parse('2026-10-24T22:30:00Z'))).toMatch(/^rc-20261025-/); // 00:30 CEST
    expect(newRunId(p, Date.parse('2026-10-25T01:30:00Z'))).toMatch(/^run-20261025-023000-[0-9a-f]{4}$/); // 02:30 CET
  });
});

const run = (id: string): Run => ({
  schema: 'signal.pm.run/1',
  id,
  recipeId: RC,
  templateId: null,
  variantId: null,
  trigger: 'make-it',
  scope: { nodes: ['script'] },
  startedAt: '2026-11-06T10:00:00.000Z',
  finishedAt: null,
  by: 'tester@example.test',
  capUsd: 2,
  spentUsd: 0,
  reservedUsd: 0,
  estimate: { usdLow: 0, usdHigh: 1, seconds: 10, nodes: [], unknown: [], token: 'tok' },
  status: 'running',
  pausedFor: null,
  steps: [],
  packageIds: [],
  attended: true,
});

describe('runs and events', () => {
  const ID = 'run-20261106-142210-c01d';
  it('run.json is created once and updated under the lock', async () => {
    await createRun(tmp.root, run(ID));
    await rejects(createRun(tmp.root, run(ID)), 'exists');
    const updated = await updateRun(tmp.root, ID, (r) => ({ ...r, status: 'done', spentUsd: 0.5 }));
    expect(updated.status).toBe('done');
    expect((await readRun(tmp.root, ID))?.spentUsd).toBe(0.5);
    await rejects(updateRun(tmp.root, ID, (r) => ({ ...r, spentUsd: -1 })), 'validation');
  });

  it('events get a monotonic seq, also concurrently and after a restart', async () => {
    const seqs = await Promise.all(Array.from({ length: 25 }, (_, i) => appendEvent(tmp.root, ID, { at: '2026-11-06T10:00:00.000Z', kind: 'step.started', text: `e${i}` })));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    _forgetEventSeqs();
    expect(await appendEvent(tmp.root, ID, { at: '2026-11-06T10:00:01.000Z', kind: 'run.done' })).toBe(26);
    const { events, nextSeq } = await readEvents(tmp.root, ID, 20);
    expect(events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25, 26]);
    expect(nextSeq).toBe(27);
  });

  it('a torn last line (crash mid-append) is skipped and the next event starts on a new line', async () => {
    await appendEvent(tmp.root, ID, { at: '2026-11-06T10:00:00.000Z', kind: 'run.started' });
    const f = path.join(tmp.root, 'runs', ID, 'events.jsonl');
    writeFileSync(f, readFileSync(f, 'utf8') + '{"seq":2,"kin');
    _forgetEventSeqs();
    expect(await appendEvent(tmp.root, ID, { at: '2026-11-06T10:00:01.000Z', kind: 'run.done' })).toBe(2);
    expect((await readEvents(tmp.root, ID)).events.map((e) => e.kind)).toEqual(['run.started', 'run.done']);
  });

  it('runs started within the same second list in start order, not by their random suffix', async () => {
    // a15f sorts after 0d97 as text, but 0d97 started later in the same second: it is the newest run.
    await createRun(tmp.root, { ...run('run-20261106-142210-a15f'), startedAt: '2026-11-06T13:22:10.444Z' });
    await createRun(tmp.root, { ...run('run-20261106-142210-0d97'), startedAt: '2026-11-06T13:22:10.930Z' });
    await createRun(tmp.root, { ...run('run-20261106-142209-ffff'), startedAt: '2026-11-06T13:22:09.990Z' });
    await createRun(tmp.root, { ...run('run-20261106-142211-0000'), startedAt: '2026-11-06T13:22:11.010Z' });
    expect(await listRunIds(tmp.root)).toEqual(['run-20261106-142209-ffff', 'run-20261106-142210-a15f', 'run-20261106-142210-0d97', 'run-20261106-142211-0000']);
  });

  it('run ids are checked before any path is built', async () => {
    await rejects(readRun(tmp.root, '../../etc'), 'not_found');
  });
});

const template = (id: string): Template => ({
  schema: 'signal.pm.template/1',
  id,
  name: 'Story spine',
  status: 'draft',
  recipeId: RC,
  snapshot: { recipeVersion: 1, pipelineVersion: 1, heads: { script: { version: 1, hash: 'c'.repeat(64), locked: false } }, packId: null, packVersion: null },
  provenRunId: null,
  provenAt: null,
  provenBy: null,
  builtIn: false,
  pack: null,
  campaignIds: [],
  inputs: { kind: 'brief', lockedNodes: ['art'] },
  variants: [{ id: 'var-9c1e', label: '30 s', params: { lengthSec: 30 }, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false }],
  repeat: null,
  skipProofForRepeats: false,
  premiumStreak: 0,
  migratedFrom: null,
  revision: 1,
});

describe('templates and pins', () => {
  it('the store owns the revision counter (1 on create, +1 per update, legacy files read as 1)', async () => {
    const created = await createTemplate(tmp.root, { ...template('tpl-20261107-0e4c'), revision: 9 });
    expect(created.revision).toBe(1);
    const a = await updateTemplate(tmp.root, 'tpl-20261107-0e4c', (t) => ({ ...t, name: 'Renamed' }));
    expect(a.revision).toBe(2);
    const b = await updateTemplate(tmp.root, 'tpl-20261107-0e4c', (t) => ({ ...t, revision: 1, status: 'retired' }));
    expect(b.revision).toBe(3); // a caller cannot set it
    expect((await readTemplate(tmp.root, 'tpl-20261107-0e4c'))?.revision).toBe(3);
    // A file written before the counter: reads as revision 1, and its next update is revision 2.
    const { revision: _r, ...legacy } = template('tpl-20261107-0e4d');
    void _r;
    writeFileSync(path.join(tmp.root, 'templates', 'tpl-20261107-0e4d.json'), JSON.stringify(legacy));
    expect((await readTemplate(tmp.root, 'tpl-20261107-0e4d'))?.revision).toBe(1);
    expect((await updateTemplate(tmp.root, 'tpl-20261107-0e4d', (t) => t)).revision).toBe(2);
  });

  it('creates, updates and lists templates', async () => {
    await createTemplate(tmp.root, template('tpl-20261107-0e4a'));
    await createTemplate(tmp.root, template('tpl-20261107-0e4b'));
    await updateTemplate(tmp.root, 'tpl-20261107-0e4a', (t) => ({ ...t, status: 'proven', premiumStreak: 1 }));
    expect((await readTemplate(tmp.root, 'tpl-20261107-0e4a'))?.status).toBe('proven');
    expect((await listTemplates(tmp.root)).map((t) => t.id)).toEqual(['tpl-20261107-0e4a', 'tpl-20261107-0e4b']);
    await rejects(updateTemplate(tmp.root, 'tpl-20261107-0e4a', (t) => ({ ...t, variants: [...t.variants, t.variants[0]!] })), 'validation');
  });

  it('pins are idempotent and record every owner', async () => {
    const a = 'd'.repeat(64);
    await addPins(tmp.root, [a], 'package:12');
    await addPins(tmp.root, [a], 'package:12');
    await addPins(tmp.root, [a], 'package:13');
    expect((await readPins(tmp.root)).objects[a]).toEqual(['package:12', 'package:13']);
    expect(await isPinned(tmp.root, a)).toBe(true);
    expect(await isPinned(tmp.root, 'e'.repeat(64))).toBe(false);
    await expect(addPins(tmp.root, ['nope'], 'package:1')).rejects.toThrow();
  });
});
