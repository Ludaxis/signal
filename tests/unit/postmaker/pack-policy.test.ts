// @vitest-environment node
// the pack's claims policy and template tempo reach the script and post-copy executors
// through wiring.ts; a pack that declares claims never runs with a null policy, even when the rest of it is broken.
import './guard';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScriptDoc } from '@/lib/studio/postmaker/graph/adapters';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { loadProjectPack } from '@/lib/studio/postmaker/pack/load';
import { NO_PACK_POLICY, packPolicy } from '@/lib/studio/postmaker/pack/policy';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { getJson } from '@/lib/studio/postmaker/store/objects';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { serviceExecutors } from '@/lib/studio/postmaker/wiring';
import { mockScriptProposal } from '@/lib/studio/postmaker/executors/script';
import { runAll, setup } from './engine-fixtures';
import { writeFixturePack } from './fixtures';
import { tmp } from './guard';

const project = () => ({ contentDir: path.join(tmp.dir, 'content'), pack: { dir: path.join(tmp.dir, 'pack') } });
const template = (id: string, o: Record<string, unknown> = {}) => JSON.stringify({ schema: 'signal.pack-template/1', id, version: 1, builder: 'story-spine@1', tempo: { bpmRange: [100, 110], chantBeatsPerCard: 4, beatsPerBar: 4 }, ...o });

describe('packPolicy', () => {
  it('no pack: no policy; a pack: its claims and the first story-spine template tempo', async () => {
    expect(await packPolicy({ contentDir: path.join(tmp.dir, 'content') }, tmp.root)).toEqual(NO_PACK_POLICY);
    const p = writeFixturePack(project().pack.dir);
    // the fixture's own template has no builder or tempo: no tempo
    expect(await packPolicy(project(), tmp.root)).toEqual({ claims: { allowed: [], denied: ['free'] }, tempo: null, tempoFrom: null });
    p.write('templates/a-other.json', template('a-other', { builder: 'other@1' }));
    p.write('templates/b-bad.json', template('b-bad', { tempo: { bpmRange: [80, 140], chantBeatsPerCard: 3 } }));
    p.write('templates/c-spine.json', template('c-spine'));
    p.write('templates/d-spine.json', template('d-spine', { tempo: { bpmRange: [120, 120], chantBeatsPerCard: 2 } }));
    p.manifest.templates = ['templates/story-basic.json', 'templates/a-other.json', 'templates/b-bad.json', 'templates/c-spine.json', 'templates/d-spine.json'];
    p.manifest.claims = { allowed: ['level-count'], denied: ['Mega Pack'] };
    p.writeManifest();
    expect(await packPolicy(project(), tmp.root)).toEqual({ claims: { allowed: ['level-count'], denied: ['Mega Pack'] }, tempo: { bpmRange: [100, 110], chantBeatsPerCard: 4 }, tempoFrom: 'c-spine' });
  });

  it('a pack that does not load still gives its declared claims (never a null policy); no tempo', async () => {
    const p = writeFixturePack(project().pack.dir);
    p.manifest.claims = { allowed: [], denied: ['Mega Pack'] };
    p.writeManifest();
    rmSync(path.join(p.dir, 'glossary.json'));
    await expect(loadProjectPack(project(), tmp.root)).rejects.toThrow(); // the full load now fails
    expect(await packPolicy(project(), tmp.root)).toEqual({ claims: { allowed: [], denied: ['Mega Pack'] }, tempo: null, tempoFrom: null });
    p.write('pack.json', '{ not json');
    expect((await packPolicy(project(), tmp.root)).claims).toBeNull();
  });
});

describe('serviceExecutors passes the pack policy (wiring.ts)', () => {
  const pack = { claims: { allowed: [], denied: ['loud tonight'] }, tempo: { bpmRange: [100, 110] as [number, number], chantBeatsPerCard: 4 as const }, tempoFrom: 'c-spine' };
  const script: ScriptDoc = { beats: [{ id: 'b01', segment: 'hook', targetMs: 6000, onScreen: { en: "Grandma's house is loud tonight." } }], lines: [], tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 }, cta: { en: 'Your turn tonight.' } };
  const input = { recipe: {} as never, node: { id: 'post-copy:en', kind: 'post-copy', lang: 'en', params: {} } as never, lang: 'en', inputs: [], byPort: { script }, params: {}, seed: 1, mode: 'mock', connector: 'mock', note: null, beats: null, pinnedBeats: [], previous: null, violations: [], take: 1, context: null, runId: 'run-20261106-101500-ab12', now: () => 0, signal: new AbortController().signal } as unknown as ExecInput;

  it('post-copy lints against the pack claims; without a pack the same caption passes', async () => {
    const none = serviceExecutors({ root: tmp.root, render: null, claudeCli: null });
    expect((await none['post-copy'].run(input)).status).toBe('ok');
    const withPack = serviceExecutors({ root: tmp.root, render: null, claudeCli: null, pack });
    await expect(withPack['post-copy'].run(input)).rejects.toThrow(/claim/);
  });

  it('script uses the template tempo: the mock keeps the recipe BPM inside the range and the chant beats per card', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], deps: { executors: serviceExecutors({ root: tmp.root, render: null, claudeCli: null, pack: { ...pack, claims: { allowed: [], denied: [] } } }) } });
    await runAll(engine, recipeId);
    const h = await readHead(tmp.root, recipeId, 'script');
    const v = (await readVersion(tmp.root, recipeId, 'script', h.current!))!;
    const doc = await getJson<ScriptDoc>(tmp.root, v.outputs.find((o) => o.port === 'script')!.sha256);
    expect(doc.tempo).toMatchObject({ bpm: 100, chantBeatsPerCard: 4 });
  });

  it('a recipe BPM outside the template range: the mock picks the middle of the range', () => {
    const recipe = { beats: [], languages: ['en'] as const, tempo: { bpm: 96, downbeatMs: 0 } };
    expect(mockScriptProposal({ ...recipe, languages: ['en'] }, pack.tempo).tempo.bpm).toBe(105);
    expect(mockScriptProposal({ ...recipe, languages: ['en'], tempo: { bpm: 108, downbeatMs: 0 } }, pack.tempo).tempo.bpm).toBe(108);
    expect(mockScriptProposal({ ...recipe, languages: ['en'], tempo: null }, pack.tempo).tempo.bpm).toBe(105);
  });
});
