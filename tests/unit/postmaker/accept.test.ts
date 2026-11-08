// @vitest-environment node
// Accept: server parts, the
// Standard / Premium template rule and premiumStreak, every clean-accept refusal, and Posts approval unchanged.
import './guard';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvePackage, GENERATOR_NOT_ALLOWED, loadPackage, PM_MOCK_STEPS, PM_RECORD_MISMATCH, PM_SWITCH_OFF, type PackageSpec } from '@/lib/studio/content';
import { acceptProof, BELOW_PREMIUM_NOTE, countRegenerations, nextPremiumStreak, personSignOff, recomputeLineageRoot, SUPERSEDED_TEXT } from '@/lib/studio/postmaker/accept';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { PACKAGE_IDS_USED_UP } from '@/lib/studio/package-id';
import { signoffsDep } from '@/lib/studio/postmaker/signoffs';
import { readPins } from '@/lib/studio/postmaker/store/pins';
import { readRecipe, writePipelineVersion, writeRecipeVersion } from '@/lib/studio/postmaker/store/recipes';
import { readRun } from '@/lib/studio/postmaker/store/runs';
import { listTemplates, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { PostmakerMark, Run } from '@/lib/studio/postmaker/types';
import { cleanRun, postsProject, withPostsProject, writePostsConfig } from './accept-fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';

withPostsProject();

const accept = (s: { engine: Parameters<typeof acceptProof>[0]['engine'] }, runId: string, asDraft = false, templateName = 'Story spine') =>
  acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId, asDraft, templateName, by: 'owner@example.test', now: () => Date.parse('2026-11-06T12:00:00Z') });

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(isPostmakerError(e), String(e)).toBe(true);
    const x = e as { status: number; code: string; message: string };
    return { status: x.status, code: x.code, message: x.message };
  }
  throw new Error('expected a refusal');
}

const pkgJson = <T>(id: string, name: string) => JSON.parse(readFileSync(path.join(tmp.contentDir, id, name), 'utf8')) as T;
const packageDirs = () => (existsSync(tmp.contentDir) ? readdirSync(tmp.contentDir).filter((n) => /^\d{2}$/.test(n)) : []);

describe('clean accept', () => {
  it('a Premium clean stub run makes one ready package per language with a lineage lock; the template becomes Proven', async () => {
    const s = await cleanRun({ verdict: 'premium' });
    const r = await accept(s, s.run.id);
    expect(r).toMatchObject({ asDraft: false, verdict: 'premium', note: null });
    expect(r.packageIds).toEqual(['01', '02']);
    expect(packageDirs()).toEqual(['01', '02']);
    expect(readdirSync(tmp.contentDir).filter((n) => n.startsWith('.'))).toEqual([]); // no staging folder left
    for (const [i, lang] of (['fa', 'en'] as const).entries()) {
      const id = r.packageIds[i]!;
      const spec = pkgJson<PackageSpec>(id, 'package.json');
      expect(spec).toMatchObject({ id, format: 'reel', destination: TEST_PROJECT.handle, source: { generator: 'postmaker' } });
      expect(spec.notes).toBeUndefined();
      expect(spec.files.map((f) => [f.name, f.role])).toEqual([['video.mp4', 'video'], ['cover.png', 'cover'], ['caption.txt', 'caption']]);
      const mark = pkgJson<PostmakerMark>(id, 'postmaker.json');
      expect(mark).toMatchObject({ schema: 'signal.pm.mark/1', recipeId: s.recipeId, runId: s.run.id, lang, modes: { mock: 0 }, acceptedBy: 'owner@example.test', template: { name: 'Story spine', version: 1 }, verdict: 'premium' });
      // files[*].sha256 equal package.json hashes; the lineage root recomputes from the stored manifests.
      for (const f of spec.files) expect(mark.files[f.name]!.sha256).toBe(f.sha256);
      expect(Object.keys(mark.files).sort()).toEqual(spec.files.map((f) => f.name).sort());
      expect(mark.files['video.mp4']).toMatchObject({ fromNode: `render:${lang}`, port: 'video' });
      expect(mark.files['caption.txt']).toMatchObject({ fromNode: `post-copy:${lang}`, port: 'caption' });
      expect(await recomputeLineageRoot(tmp.root, mark)).toEqual({ ok: true, root: mark.lineageRoot, problem: null });
      expect(mark.lineage.map((e) => e.nodeId)).toEqual(expect.arrayContaining([`render:${lang}`, `voice:${lang}`, 'script', 'art', 'music']));
      expect(mark.lineage.some((e) => e.nodeId.endsWith(lang === 'fa' ? ':en' : ':fa'))).toBe(false);
      expect(mark.signoffs.map((x) => x.gate).sort()).toEqual(lang === 'fa' ? ['fa-native-editor', 'fa-native-listener'] : []);
      // Posts sees it as a normal ready package with the Post maker origin line.
      const view = await loadPackage(id);
      expect(view.status).toBe('ready');
      expect(view.problems).toEqual([]);
      expect(view.postmaker).toMatchObject({ template: 'Story spine', version: 1, lang, verdict: 'premium' });
      // Pins: every object of the lineage is pinned by this package.
      const pins = await readPins(tmp.root);
      const render = (await readVersion(tmp.root, s.recipeId, `render:${lang}`, mark.lineage.find((e) => e.nodeId === `render:${lang}`)!.n))!;
      for (const o of render.outputs) expect(pins.objects[o.sha256]).toContain(`package:${id}`);
    }
    const [t] = await listTemplates(tmp.root);
    expect(t).toMatchObject({ name: 'Story spine', status: 'proven', provenRunId: s.run.id, provenBy: 'owner@example.test', premiumStreak: 1, recipeId: s.recipeId });
    expect(Object.keys(t!.snapshot.heads)).toHaveLength(s.pipeline.nodes.length);
    expect(await readRun(tmp.root, s.run.id)).toMatchObject({ status: 'done', packageIds: ['01', '02'], pausedFor: null });
    // Approving through the existing approvePackage() works unchanged.
    const approved = await approvePackage('01', 'owner@example.test');
    expect(approved.status).toBe('approved');
    expect(approved.approval!.hashes).toEqual(Object.fromEntries(pkgJson<PackageSpec>('01', 'package.json').files.map((f) => [f.name, f.sha256])));
  });

  it('a Standard accept writes the package with the "below premium" note and leaves the template Draft with streak 0', async () => {
    const s = await cleanRun({ verdict: 'standard', langs: ['en'] });
    const r = await accept(s, s.run.id);
    expect(r).toMatchObject({ verdict: 'standard', note: BELOW_PREMIUM_NOTE, packageIds: ['01'] });
    expect(pkgJson<PackageSpec>('01', 'package.json').notes).toEqual([BELOW_PREMIUM_NOTE]);
    expect((await loadPackage('01')).status).toBe('ready');
    const [t] = await listTemplates(tmp.root);
    expect(t).toMatchObject({ status: 'draft', provenRunId: null, premiumStreak: 0 });
  });

  it('accepting the same run twice is refused', async () => {
    const s = await cleanRun({ langs: ['en'] });
    await accept(s, s.run.id);
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, message: 'Already accepted as post 01.' });
  });

  it('after folder 99 the next packages are 100 and 101 (no 0100)', async () => {
    const s = await cleanRun({ verdict: 'premium' });
    mkdirSync(path.join(tmp.contentDir, '98'), { recursive: true });
    mkdirSync(path.join(tmp.contentDir, '99'));
    const r = await accept(s, s.run.id);
    expect(r.packageIds).toEqual(['100', '101']);
    expect(pkgJson<PackageSpec>('100', 'package.json').id).toBe('100');
    expect((await loadPackage('101')).status).toBe('ready');
  });

  it('past 99999 a clean accept is refused with a plain reason and nothing is written', async () => {
    const t = await cleanRun({ langs: ['en'] });
    mkdirSync(path.join(tmp.contentDir, '99999'));
    expect(await refusal(accept(t, t.run.id))).toMatchObject({ status: 409, message: PACKAGE_IDS_USED_UP });
    expect(readdirSync(tmp.contentDir).filter((n) => n.startsWith('.'))).toEqual([]); // no staging folder left
  });
});

describe('and the lineage problems in loadPackage', () => {
  it('one changed byte in video.mp4 makes the package changed with the Post maker problem line; approval is refused', async () => {
    const s = await cleanRun({ langs: ['en'] });
    await accept(s, s.run.id);
    const file = path.join(tmp.contentDir, '01', 'video.mp4');
    const buf = readFileSync(file);
    buf[0] = buf[0]! ^ 0x01;
    writeFileSync(file, buf);
    const view = await loadPackage('01');
    expect(view.status).toBe('changed');
    expect(view.problems).toContain(`${PM_RECORD_MISMATCH}.`);
    await expect(approvePackage('01', 'owner@example.test')).rejects.toMatchObject({ status: 409 });
  });

  it('a record with mock steps, or one that does not list a file, makes the package changed', async () => {
    const s = await cleanRun({ langs: ['en'] });
    await accept(s, s.run.id);
    const markFile = path.join(tmp.contentDir, '01', 'postmaker.json');
    const mark = JSON.parse(readFileSync(markFile, 'utf8')) as PostmakerMark;
    writeFileSync(markFile, JSON.stringify({ ...mark, modes: { live: 1, mock: 2 } }));
    let view = await loadPackage('01');
    expect(view.status).toBe('changed');
    expect(view.problems).toEqual([`${PM_MOCK_STEPS}.`]);
    const { 'cover.png': _cover, ...rest } = mark.files;
    void _cover;
    writeFileSync(markFile, JSON.stringify({ ...mark, files: rest }));
    view = await loadPackage('01');
    expect(view.problems).toEqual([`${PM_RECORD_MISMATCH}.`]);
    writeFileSync(markFile, '{ not json');
    expect((await loadPackage('01')).status).toBe('invalid');
  });
});

describe('Post maker must be on, and an optional contentGenerators list must name it', () => {
  it('a clean Accept is refused before any package is written while the postmaker switch is off', async () => {
    const s = await cleanRun({ langs: ['en'] });
    writePostsConfig({ postmaker: false });
    const r = await refusal(accept(s, s.run.id));
    expect(r).toMatchObject({ status: 409, code: 'accept-blocked', message: `${PM_SWITCH_OFF}.` });
    expect(existsSync(path.join(postsProject().contentDir, '01'))).toBe(false);
    expect((await listTemplates(tmp.root)).length).toBe(0);
    writePostsConfig();
    await accept(s, s.run.id);
    expect((await loadPackage('01')).status).toBe('ready');
  });

  it('a contentGenerators list without postmaker refuses a clean Accept; without the list every generator is allowed', async () => {
    const s = await cleanRun({ langs: ['en'] });
    writePostsConfig({ contentGenerators: ['signal-template-v1'] });
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, code: 'accept-blocked', message: GENERATOR_NOT_ALLOWED });
    expect(existsSync(path.join(postsProject().contentDir, '01'))).toBe(false);
    writePostsConfig({ contentGenerators: ['signal-template-v1', 'postmaker'] });
    await accept(s, s.run.id);
    expect((await loadPackage('01')).status).toBe('ready');
  });

  it('turning Post maker off makes an accepted package changed and its approval refused; on again, it approves', async () => {
    const s = await cleanRun({ langs: ['en'] });
    await accept(s, s.run.id);
    expect((await loadPackage('01')).status).toBe('ready');
    writePostsConfig({ postmaker: false });
    let view = await loadPackage('01');
    expect(view.status).toBe('changed');
    expect(view.problems).toEqual([`${PM_SWITCH_OFF}.`]);
    await expect(approvePackage('01', 'owner@example.test')).rejects.toMatchObject({ status: 409, message: `${PM_SWITCH_OFF}.` });
    writePostsConfig({ contentGenerators: ['signal-template-v1'] });
    await expect(approvePackage('01', 'owner@example.test')).rejects.toMatchObject({ status: 409, message: GENERATOR_NOT_ALLOWED });
    writePostsConfig();
    view = await loadPackage('01');
    expect(view.status).toBe('ready');
    expect((await approvePackage('01', 'owner@example.test')).status).toBe('approved');
    // An approved package loses its approval standing the moment the switch goes off.
    writePostsConfig({ postmaker: false });
    expect((await loadPackage('01')).status).toBe('changed');
  });
});

describe('refusals', () => {
  it('a mock run: clean accept answers 409; Accept as draft keeps the template Draft and writes no package', async () => {
    const s = await setup({ deps: { signoffs: signoffsDep(tmp.root) } });
    const run = await runAll(s.engine, s.recipeId);
    const e = await refusal(accept(s, run.id));
    expect(e).toMatchObject({ status: 409, code: 'accept-blocked' });
    const r = await accept(s, run.id, true, 'Draft spine');
    expect(r).toMatchObject({ asDraft: true, packageIds: [], verdict: 'unscored' });
    expect(packageDirs()).toEqual([]);
    const [t] = await listTemplates(tmp.root);
    expect(t).toMatchObject({ name: 'Draft spine', status: 'draft', premiumStreak: 0 });
    expect(await readRun(tmp.root, run.id)).toMatchObject({ status: 'done', packageIds: [] });
  });

  it('an unsigned listening gate blocks a clean accept with the node named', async () => {
    const s = await cleanRun({ signListener: false });
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, message: 'voice:fa needs a named sign-off.' });
    expect(packageDirs()).toEqual([]);
  });

  it('Regenerate and Unscored verdicts block a clean accept (draft still works)', async () => {
    let s = await cleanRun({ verdict: 'regenerate', langs: ['en'] });
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, message: 'The check says regenerate. Fix the steps it names first.' });
    s = await cleanRun({ verdict: 'Unscored', langs: ['en'], id: 'rc-20261106-0002' });
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, message: 'Not scored yet. Score it on Proof, or accept as draft.' });
    expect((await accept(s, s.run.id, true)).packageIds).toEqual([]);
  });

  it('an out-of-date lineage answers 409 (a setting changed after the proof)', async () => {
    const s = await cleanRun({ langs: ['en'] });
    const nodes = s.pipeline.nodes.map((n) => (n.id === 'captions:en' ? { ...n, params: { maxWords: 4 } } : n));
    await writePipelineVersion(tmp.root, s.recipeId, { builtFrom: s.pipeline.builtFrom, nodes, edges: s.pipeline.edges });
    expect(await refusal(accept(s, s.run.id))).toMatchObject({ status: 409, message: 'Some steps are out of date.' });
    expect(await refusal(accept(s, s.run.id, true))).toMatchObject({ status: 409 });
  });

  it('a proof replaced by a later run is refused (no package under the wrong run id); the newest proof is accepted', async () => {
    const s = await cleanRun({ langs: ['en'] });
    const later = await (await s.engine.regenerateFromHere({ recipeId: s.recipeId, nodeId: 'post-copy:en', note: 'shorter' })).done;
    expect(later.status).toBe('done');
    const e = await refusal(accept(s, s.run.id));
    expect(e).toMatchObject({ status: 409, code: 'superseded', message: SUPERSEDED_TEXT });
    expect(await refusal(accept(s, s.run.id, true))).toMatchObject({ status: 409, code: 'superseded' });
    expect(packageDirs()).toEqual([]);
    expect(await readRun(tmp.root, s.run.id)).toMatchObject({ status: 'done', packageIds: [] });
    const r = await accept(s, later.id);
    expect(r.packageIds).toEqual(['01']);
    expect(pkgJson<PostmakerMark>('01', 'postmaker.json').runId).toBe(later.id);
  });

  it('the origin version is the template revision this accept writes, not the recipe version', async () => {
    const s = await cleanRun({ langs: ['en'] });
    const draft = await accept(s, s.run.id, true, 'Story spine'); // a new template: written once, revision 1
    expect(draft.template.revision).toBe(1);
    // Every later template change bumps the revision; the next clean accept writes revision 3 and records it.
    await updateTemplate(tmp.root, draft.template.id, (t) => ({ ...t, name: 'Story spine' }));
    const run2 = await runAll(s.engine, s.recipeId, { capUsd: 5 });
    const r = await accept(s, run2.id);
    expect(r.template.revision).toBe(3);
    expect(r.template.snapshot.recipeVersion).toBe(1);
    expect(pkgJson<PostmakerMark>(r.packageIds[0]!, 'postmaker.json').template).toEqual({ name: 'Story spine', version: 3 });
    expect((await loadPackage(r.packageIds[0]!)).postmaker).toMatchObject({ version: 3 });
  });

  it('the template snapshot follows this proof\'s recipe version, not the previous snapshot\'s', async () => {
    const s = await cleanRun({ langs: ['en'] });
    await accept(s, s.run.id, true, 'Story spine'); // the template snapshot now holds recipe v1
    const v1 = (await readRecipe(tmp.root, s.recipeId))!;
    const { schema: _schema, id: _id, version: _version, ...draft } = v1;
    void _schema;
    void _id;
    void _version;
    const v2 = await writeRecipeVersion(tmp.root, s.recipeId, draft, { baseVersion: 1 });
    expect(v2.version).toBe(2);
    const run2 = await runAll(s.engine, s.recipeId, { capUsd: 5 });
    const r = await accept(s, run2.id);
    expect(r.packageIds).toEqual(['01']);
    expect(pkgJson<PostmakerMark>('01', 'postmaker.json').template).toEqual({ name: 'Story spine', version: 2 });
    expect(r.template.snapshot.recipeVersion).toBe(2);
    expect((await loadPackage('01')).postmaker).toMatchObject({ version: 2 });
  });

  it('an unknown run is 404; an empty template name is 400', async () => {
    const s = await setup();
    expect((await refusal(accept(s, 'run-20261106-100000-ffff'))).status).toBe(404);
    expect((await refusal(accept(s, 'run-20261106-100000-ffff', false, '  '))).status).toBe(400);
  });
});

describe('personSignOff (second guard)', () => {
  it('only a pass by a person on the exact hash counts; agent, mock and stale-hash records never do', async () => {
    const s = await cleanRun({ langs: ['fa'] });
    const v = (await readVersion(tmp.root, s.recipeId, 'narration-text:fa', 1))!;
    const rec = (o: Record<string, unknown>) => ({ gate: 'fa-native-editor' as const, nodeId: v.nodeId, version: v.n, hash: v.hash, by: 'editor@example.test', name: 'Editor A', at: 'x', verdict: 'pass' as const, ...o });
    expect(personSignOff(v, 'fa-native-editor', [rec({})])).not.toBeNull();
    expect(personSignOff(v, 'fa-native-editor', [rec({ by: 'agent:language-editor' })])).toBeNull();
    expect(personSignOff(v, 'fa-native-editor', [rec({ name: 'reviewer' })])).toBeNull();
    expect(personSignOff(v, 'fa-native-editor', [rec({ by: 'mock', name: 'mock' })])).toBeNull();
    expect(personSignOff(v, 'fa-native-editor', [rec({ hash: 'f'.repeat(64) })])).toBeNull();
    expect(personSignOff(v, 'fa-native-editor', [rec({}), rec({ verdict: 'fail' })])).toBeNull();
  });
});

describe('premiumStreak', () => {
  const run = (id: string, at: string, trigger: Run['trigger'], packageIds: string[] = []) => ({ id, recipeId: 'rc-1', trigger, startedAt: at, packageIds });
  it('counts regenerations since the last accepted run', () => {
    const runs = [run('a', '1', 'make-it', ['01']), run('b', '2', 'regenerate'), run('c', '3', 'regenerate-from-here'), run('d', '4', 'run'), run('e', '5', 'regenerate')];
    expect(countRegenerations(runs, 'rc-1', 'd')).toBe(2);
    expect(countRegenerations(runs, 'rc-1', 'e')).toBe(3);
    expect(countRegenerations(runs, 'rc-1', 'a')).toBe(0);
  });
  it('Premium, live, ≤ 2 regenerations adds one; anything else resets', () => {
    expect(nextPremiumStreak(2, { verdict: 'premium', live: true, regenerations: 2 })).toBe(3);
    expect(nextPremiumStreak(2, { verdict: 'premium', live: true, regenerations: 3 })).toBe(0);
    expect(nextPremiumStreak(2, { verdict: 'premium', live: false, regenerations: 0 })).toBe(0);
    expect(nextPremiumStreak(2, { verdict: 'standard', live: true, regenerations: 0 })).toBe(0);
  });
});
