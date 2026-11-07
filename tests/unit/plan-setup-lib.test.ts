// Plan and Learn server pieces: Results by template, the pack's Persian pronunciation list (Brand) and the brand's
// Persian register. Temp folders only; nothing outside them is read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byTemplate, groupOf, templateNames } from '@/lib/studio/results-templates';
import { MAX_ROWS, packLexiconFa } from '@/lib/studio/pack-lexicon';
import { FORMAT_LABEL } from '@/lib/studio/formats';
import type { PackageView } from '@/lib/studio/content';
import type { Project } from '@/lib/studio/projects';

let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-plan-setup-'));
  mkdirSync(path.join(root, 'posts'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const project = (extra: Partial<Project> = {}) => ({ id: 'fixture', name: 'Fixture project', handle: '@fixture.account', contentDir: path.join(root, 'posts'), ...extra }) as unknown as Project;
const write = (rel: string, v: unknown) => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
};
const template = (id: string, name: string) => ({
  schema: 'signal.pm.template/1',
  id,
  name,
  status: 'proven',
  recipeId: 'rc-20261101-abcd',
  snapshot: { recipeVersion: 1, pipelineVersion: 1, heads: {}, packId: null, packVersion: null },
  provenRunId: null,
  provenAt: null,
  provenBy: null,
  builtIn: false,
  pack: null,
  campaignIds: [],
  inputs: { kind: 'brief', lockedNodes: [] },
  variants: [],
  repeat: null,
  skipProofForRepeats: false,
  premiumStreak: 0,
  migratedFrom: null,
});
const pkg = (id: string, format: string, views: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    title: `Post ${id}`,
    status: 'posted',
    posted: { posted_at: '2026-11-02T18:00:00.000Z' },
    metrics: { metrics: { views, reach: views, likes: 10, comments: 1, saves: 2, shares: 0 } },
    source: { generator: 'x', format, category: '', items: [], distractors: [], levels: [], seed: '', ...extra },
  }) as unknown as PackageView;

describe('Results by template', () => {
  it('a project with no pack shows only template names; core format labels never appear', async () => {
    write('postmaker/templates/tpl-20261101-abcd.json', template('tpl-20261101-abcd', 'Question card'));
    const names = await templateNames(project());
    expect(names).toEqual({ templates: { 'tpl-20261101-abcd': 'Question card' }, formats: {} });
    const rows = byTemplate([pkg('01', 'codex-post', 100, { templateId: 'tpl-20261101-abcd' }), pkg('02', 'codex-post', 300), pkg('03', 'website-card', 200), { ...pkg('04', 'higgsfield-image', 50), metrics: null } as unknown as PackageView], names);
    expect(rows.map((r) => [r.key, r.name, r.posts])).toEqual([
      ['template:tpl-20261101-abcd', 'Question card', 1],
      ['none', null, 2],
    ]);
    for (const r of rows) for (const label of Object.values(FORMAT_LABEL)) expect(r.name ?? '').not.toBe(label);
  });

  it('a pack that names a format shows its own label; labels the pack leaves alone stay hidden', async () => {
    write('pack/formats.json', { schema: 'signal.formats/1', labels: { 'codex-post': 'Idea card', 'website-card': FORMAT_LABEL['website-card'] } });
    const p = project({ pack: { dir: path.join(root, 'pack') } });
    const names = await templateNames(p);
    expect(names.formats).toEqual({ 'codex-post': 'Idea card' });
    expect(groupOf(pkg('01', 'codex-post', 1), names)).toEqual({ key: 'format:codex-post', name: 'Idea card' });
    expect(groupOf(pkg('02', 'website-card', 1), names)).toEqual({ key: 'none', name: null });
  });

  it('a missing or broken store gives no names and never throws', async () => {
    write('postmaker/templates/tpl-20261101-ffff.json', '{ not json');
    await expect(templateNames(project())).resolves.toEqual({ templates: {}, formats: {} });
  });
});

describe('pack pronunciation list (Brand)', () => {
  it('reads the Persian list the pack names, keeps unsigned forms proposed and skips retired ones', async () => {
    write('pack/pack.json', { schema: 'signal.pack/1', lexicon: { fa: 'lexicon/fa.json' } });
    write('pack/lexicon/fa.json', {
      schema: 'signal.fa-lexicon/1',
      scope: 'pack',
      version: 1,
      entries: [
        { id: 'e1', kind: 'character', match: { display: ['هرفینو'], mode: 'word', inflects: false }, pron: null, roman: 'harfino', source: 'editor', status: 'approved', approvedBy: null, approvedAt: null },
        { id: 'e2', kind: 'place', match: { display: ['کوچه'], mode: 'word', inflects: true }, pron: null, roman: 'kuche', source: 'editor', status: 'approved', approvedBy: 'Named Editor', approvedAt: '2026-11-05' },
        { id: 'e3', kind: 'loanword', match: { display: ['پلی'], mode: 'word', inflects: false }, pron: null, roman: 'pley', source: 'core', status: 'retired', approvedBy: null, approvedAt: null },
      ],
    });
    const lex = await packLexiconFa(project());
    expect(lex?.count).toBe(2);
    expect(lex?.rows).toEqual([
      { id: 'e1', display: 'هرفینو', roman: 'harfino', status: 'proposed' },
      { id: 'e2', display: 'کوچه', roman: 'kuche', status: 'approved' },
    ]);
    expect(MAX_ROWS).toBe(200);
  });

  it('has no list without a pack, without a Persian entry, or with a path that leaves the pack', async () => {
    expect(await packLexiconFa(project())).toBeNull();
    write('pack/pack.json', { schema: 'signal.pack/1', lexicon: { en: 'lexicon/en.json' } });
    expect(await packLexiconFa(project())).toBeNull();
    write('secret.json', { entries: [] });
    write('pack/pack.json', { schema: 'signal.pack/1', lexicon: { fa: '../secret.json' } });
    expect(await packLexiconFa(project())).toBeNull();
  });
});

describe('Persian register (Brand voice)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_PROJECTS_FILE']) saved[k] = process.env[k];
    process.env.SIGNAL_CONTENT_DIR = path.join(root, 'posts');
    process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('stores the Persian register with the brand and ignores unknown values', async () => {
    const { loadBrand, updateBrand } = await import('@/lib/studio/brand');
    await updateBrand({ name: 'Fixture brand', faRegister: 'formal' });
    expect((await loadBrand())?.faRegister).toBe('formal');
    await updateBrand({ faRegister: 'shouty' as never });
    expect((await loadBrand())?.faRegister).toBe('formal');
  });
});
