// The one-time move of pipelines/*.json into templates with Repeat: 3 fixture pipelines → 3 templates with Repeat
// equal field by field, sources kept with `archived: true`, a second move creates nothing, `madeBy()` finds a post
// made after the move under the old `pl-…` id; the files stay and the daily run reads only the templates; refused
// (409) while a run is in progress; the backup is byte-equal to the originals (hash list); undo restores the pipeline
// files byte for byte and moves (never deletes) the templates; a slot the pipeline made is not made again by its
// template the same day; a pipeline whose format needs Codex at the desk is not moved (reason line, it stays in
// Pipelines); the nav has no Pipelines item after the move. Temp folders only; the daily run is called directly
// (runProject), never through a scheduler; the post generator and the ideas agent are fakes; no network.
import './guard';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPackages } from '@/lib/studio/content';
import { FORMATS } from '@/lib/studio/formats';
import { runProject, withRunLock } from '@/lib/studio/autopilot/runner';
import { ATTENDED_ONLY } from '@/lib/studio/autopilot/steps';
import type { AutopilotRun } from '@/lib/studio/autopilot/types';
import { listEvents } from '@/lib/studio/memory/store';
import { DAILY_USD, MAKE_AHEAD, PER_WEEK } from '@/lib/studio/pipelines/store';
import { madeBy } from '@/lib/studio/pipelines/runner';
import { currentProject } from '@/lib/studio/projects';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { pmFail } from '@/lib/studio/postmaker/api/http';
import { BUILT_IN_FORMAT_TEMPLATES, LEGACY_ATTENDED_FORMATS, LEGACY_ONLY_REPEAT, LEGACY_REPEAT_LIMITS } from '@/lib/studio/postmaker/migrate/legacy';
import { archivedText, BACKUP_CHANGED_TEXT, migratePipelines, NOTHING_TO_UNDO_TEXT, pendingPipelines, RECORD_DAMAGED_TEXT, RUN_GOING_TEXT, SKIP_TEXT, templateOfPipeline, undoMigration } from '@/lib/studio/postmaker/migrate/pipelines';
import { REPEAT_ENV } from '@/lib/studio/postmaker/repeat-state';
import { setRepeatAction, makePostFork } from '@/lib/studio/postmaker/template-actions';
import { handleAction, home, PIPELINES_UNREADABLE_TEXT } from '@/lib/studio/postmaker/service';
import { listTemplates, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import type { Template } from '@/lib/studio/postmaker/types';
import { navGroups, pipelinesInNav } from '@/app/studio/postmaker/model';
import { NOW, root, setupAutopilotProject, teardownAutopilotProject } from '../autopilot-helpers';
import { P1, P2, fakeGenerator, pipelineFile, pipelinesDir, writePipeline, writePipelineState } from '../pipelines-helpers';

const P3 = 'pl-20261103-cccc';
const GONE = 'pl-20261104-dddd';
const ACTOR = 'owner@example.test';
const pmRoot = () => path.join(root, 'postmaker');
const project = () => currentProject();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hashes = (dir: string) => Object.fromEntries(readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(path.join(dir, n)).isFile()).sort().map((n) => [n, sha(readFileSync(path.join(dir, n)))]));
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}
const skips = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'skip').map((s) => (s as { reason: string }).reason);
const made = (r: AutopilotRun, p: string) => r.steps.filter((s) => s.kind === 'make' && s.pipeline === p && s.package).map((s) => (s as { slot: string }).slot);

beforeEach(() => {
  setupAutopilotProject({ higgsfield: true });
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  process.env.SIGNAL_SECRETS_DIR = path.join(root, 'secrets');
  delete process.env[REPEAT_ENV];
});
afterEach(() => {
  delete process.env.SIGNAL_FEATURE_POSTMAKER;
  delete process.env[REPEAT_ENV];
  delete process.env.SIGNAL_DATA_DIR;
  delete process.env.SIGNAL_SECRETS_DIR;
  teardownAutopilotProject();
});

/** Three live pipelines with different settings (one under the $0.50 Repeat minimum) and one removed earlier. */
const P4 = 'pl-20261105-eeee';
function threePipelines(o: { codexOn?: boolean } = {}) {
  const a = writePipeline(P1, { name: 'Topics', steps: { source: { kind: 'list', list: ['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4'] }, make: { format: 'website-card' }, review: { enabled: false }, schedule: { makeAheadDays: 5 } } });
  const b = writePipeline(P2, { name: 'Pictures', enabled: o.codexOn ?? false, steps: { source: { kind: 'list', list: ['A rainy evening'] }, make: { format: 'higgsfield-image', template: 'A calm picture of {topic}', captionStyle: 'short' }, approve: { mode: 'trusted' }, schedule: { perWeek: 4, days: [1, 3], times: ['09:00', '17:30'], makeAheadDays: 2 }, budget: { dailyUsd: 0.2 } } });
  const c = writePipeline(P3, { name: 'Website', steps: { schedule: { perWeek: 1, days: [6], times: ['12:00'], makeAheadDays: 7 }, budget: { dailyUsd: 20 } } });
  writePipeline(GONE, { archived: true, enabled: false });
  writePipelineState(P2, { listNext: 0, ideas: [{ topic: 'Queued idea' }], lastRunAt: '2026-11-04T08:00:00.000Z', lastResult: 'Made 1 post.' });
  return [a, b, c];
}

describe('built-in format templates', () => {
  it('one one-node legacy-format pipeline per format; Codex is attended-only; the pipeline ranges match the pipeline store', () => {
    expect(BUILT_IN_FORMAT_TEMPLATES.map((t) => t.format)).toEqual([...FORMATS]);
    for (const t of BUILT_IN_FORMAT_TEMPLATES) {
      expect(t.pipeline.nodes).toHaveLength(1);
      expect(t.pipeline.nodes[0]).toMatchObject({ id: 'legacy-format', kind: 'legacy-format', params: { format: t.format } });
    }
    const codex = BUILT_IN_FORMAT_TEMPLATES.find((t) => t.format === 'codex-post')!.pipeline.nodes[0];
    expect(codex).toMatchObject({ connectorChain: ['codex'], attendance: 'attended-only' });
    expect(BUILT_IN_FORMAT_TEMPLATES.find((t) => t.format === 'higgsfield-reel')!.pipeline.nodes[0].connectorChain).toEqual(['higgsfield-image', 'higgsfield-video']);
    expect([...LEGACY_ATTENDED_FORMATS].sort()).toEqual([...ATTENDED_ONLY].sort());
    expect(LEGACY_REPEAT_LIMITS).toMatchObject({ perWeek: { min: PER_WEEK.min, max: PER_WEEK.max }, makeAheadDays: { min: MAKE_AHEAD.min, max: MAKE_AHEAD.max }, dailyUsd: { min: DAILY_USD.min, max: DAILY_USD.max }, times: 4 });
  });

  it('the campaign source maps to campaign-slot with the campaign attached', () => {
    const p = writePipeline(P1, { steps: { source: { kind: 'campaign', campaign: 'c-20261101-aaaa' }, make: { format: 'website-card' } } });
    const t = templateOfPipeline(p, { id: 'tpl-20261105-00aa', at: '2026-11-05T07:30:00.000Z', by: ACTOR });
    expect(t).toMatchObject({ inputs: { kind: 'campaign-slot', lockedNodes: [] }, campaignIds: ['c-20261101-aaaa'], migratedFrom: P1, status: 'proven', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false });
  });
});

describe('archivedText: archived true, every other byte unchanged', () => {
  it('one textual change for a store-written or compact file; re-formatted only when the key is missing or ambiguous', () => {
    const pretty = JSON.stringify({ id: P1, name: 'x', enabled: true, archived: false, steps: {} }, null, 2) + '\n';
    expect(archivedText(pretty)).toBe(pretty.replace('"archived": false', '"archived": true'));
    const compact = JSON.stringify({ id: P1, archived: false, steps: { source: { list: ['"archived": false'] } } });
    expect(JSON.parse(archivedText(compact))).toEqual({ ...JSON.parse(compact), archived: true });
    const missing = JSON.stringify({ id: P1 });
    expect(JSON.parse(archivedText(missing))).toEqual({ id: P1, archived: true });
  });
});

describe('three pipelines become three templates with Repeat', () => {
  it('Repeat equal field by field, sources archived with nothing else changed, state copied, a second move creates nothing', async () => {
    const pipes = threePipelines();
    const before = Object.fromEntries([P1, P2, P3].map((id) => [id, readFileSync(pipelineFile(id), 'utf8')]));
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    expect(r.moved.map((m) => m.pipeline).sort()).toEqual([P1, P2, P3]);
    expect(r.skipped).toEqual([{ pipeline: GONE, reason: SKIP_TEXT.removed }]);
    const templates = await listTemplates(pmRoot());
    expect(templates).toHaveLength(3);
    for (const p of pipes) {
      const t = templates.find((x) => x.migratedFrom === p.id)!;
      expect(t).toBeDefined();
      // Field by field (perWeek, days, times, makeAheadDays, dailyUsd, approve) plus the switch.
      expect(t.repeat).toEqual({ enabled: p.enabled, perWeek: p.steps.schedule.perWeek, days: p.steps.schedule.days, times: p.steps.schedule.times, makeAheadDays: p.steps.schedule.makeAheadDays, dailyUsd: p.steps.budget.dailyUsd, approve: p.steps.approve.mode });
      expect(t).toMatchObject({ name: p.name, status: 'proven', provenBy: ACTOR, revision: 1, variants: [], premiumStreak: 0, skipProofForRepeats: false });
      expect(t.legacy).toEqual({ schema: 'signal.pm.legacy-pipeline/1', builtIn: `format:${p.steps.make.format}`, review: p.steps.review.enabled, nodes: [expect.objectContaining({ kind: 'legacy-format', params: { format: p.steps.make.format, template: p.steps.make.template, captionStyle: p.steps.make.captionStyle } })] });
      // The source stays on disk, archived, and otherwise byte for byte as it was.
      const now = readFileSync(pipelineFile(p.id), 'utf8');
      expect(now).toBe(before[p.id]!.replace('"archived":false', '"archived":true'));
      expect(JSON.parse(now)).toEqual({ ...JSON.parse(before[p.id]!), archived: true });
    }
    expect(templates.find((t) => t.migratedFrom === P1)!.inputs).toEqual({ kind: 'topic-list', lockedNodes: [], list: ['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4'] });
    expect(templates.find((t) => t.migratedFrom === P3)!.inputs).toEqual({ kind: 'website-page', lockedNodes: [] });
    // <id>.state.json copied unchanged to templates/<tid>.state.json.
    const t2 = templates.find((t) => t.migratedFrom === P2)!;
    expect(readFileSync(path.join(pmRoot(), 'templates', `${t2.id}.state.json`))).toEqual(readFileSync(path.join(pipelinesDir(), `${P2}.state.json`)));
    // The memory timeline records the move.
    expect((await listEvents({ types: ['decision.made'] })).map((e) => e.data.migration)).toContain(r.migrationId);
    expect(await pendingPipelines(project())).toEqual({ pending: [], kept: [], undo: r.migrationId });

    // A second move creates nothing: no template, no backup, no record.
    const backups = readdirSync(pipelinesDir()).filter((n) => n.startsWith('.backup-'));
    const again = await migratePipelines(project(), { by: ACTOR, now: NOW + 60_000 });
    expect(again).toMatchObject({ migrationId: null, backup: null, moved: [] });
    expect(await listTemplates(pmRoot())).toHaveLength(3);
    expect(readdirSync(pipelinesDir()).filter((n) => n.startsWith('.backup-'))).toEqual(backups);
  });

  it('a move that stopped after the template was written is finished, never doubled', async () => {
    threePipelines();
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    // As if the archive write of P1 had not happened.
    writePipeline(P1, { name: 'Topics', steps: { source: { kind: 'list', list: ['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4'] }, make: { format: 'website-card' }, review: { enabled: false }, schedule: { makeAheadDays: 5 } } });
    const again = await migratePipelines(project(), { by: ACTOR, now: NOW + 60_000 });
    expect(again.moved).toEqual([expect.objectContaining({ pipeline: P1, template: r.moved.find((m) => m.pipeline === P1)!.template })]);
    expect(await listTemplates(pmRoot())).toHaveLength(3);
    expect(JSON.parse(readFileSync(pipelineFile(P1), 'utf8')).archived).toBe(true);
  });

  it('a pipeline that already makes posts from a template is left as it is', async () => {
    writePipeline(P1, { steps: { source: { kind: 'list', list: ['x'] }, make: { format: 'website-card', fromTemplate: { id: 'tpl-20261101-00aa', variant: null } } } });
    const raw = readFileSync(pipelineFile(P1));
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    expect(r).toEqual({ migrationId: null, backup: null, moved: [], skipped: [{ pipeline: P1, reason: SKIP_TEXT.fromTemplate }] });
    expect(readFileSync(pipelineFile(P1))).toEqual(raw);
    // It is counted as kept, so the Pipelines tab stays.
    expect(await pendingPipelines(project())).toEqual({ pending: [], kept: [P1], undo: null });
  });
});

describe('the backup', () => {
  it('copies every pipelines file byte for byte into .backup-<time>; the record keeps the hash list', async () => {
    threePipelines();
    const originals = hashes(pipelinesDir());
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    expect(r.backup).toMatch(/^\.backup-20261105T073000000Z$/);
    expect(hashes(path.join(pipelinesDir(), r.backup!))).toEqual(originals);
    const record = JSON.parse(readFileSync(path.join(pmRoot(), 'migrations', `${r.migrationId}.json`), 'utf8')) as { files: { name: string; sha256: string }[] };
    expect(Object.fromEntries(record.files.map((f) => [f.name, f.sha256]))).toEqual(originals);
  });
});

describe('refused while a run is in progress', () => {
  it('409 from the move and its undo while the run lock is held; nothing is written', async () => {
    threePipelines();
    const before = hashes(pipelinesDir());
    await withRunLock(async () => {
      const e = await migratePipelines(project(), { by: ACTOR, now: NOW }).catch((x: unknown) => x);
      expect(e).toMatchObject({ status: 409, message: RUN_GOING_TEXT });
      expect(pmFail(e, 'test').status).toBe(409);
      await expect(undoMigration(project(), { by: ACTOR, now: NOW })).rejects.toMatchObject({ status: 409 });
    });
    expect(hashes(pipelinesDir())).toEqual(before);
    expect(readdirSync(pipelinesDir()).some((n) => n.startsWith('.'))).toBe(false);
    expect(await listTemplates(pmRoot())).toEqual([]);
    // The lock the move holds while it works keeps the daily run from starting.
    await withRunLock(async () => {
      await expect(runProject('manual', { now: NOW })).rejects.toMatchObject({ status: 409 });
    });
  });

  it('the API actions parse (and nothing else rides along)', () => {
    expect(parseAction({ project: 'x', action: 'postmaker.migrate' })).toEqual({ action: 'postmaker.migrate' });
    expect(parseAction({ action: 'postmaker.migrate.undo', migrationId: 'mig-20261105T073000000Z-ab12' })).toEqual({ action: 'postmaker.migrate.undo', migrationId: 'mig-20261105T073000000Z-ab12' });
    expect(() => parseAction({ action: 'postmaker.migrate', dir: '/tmp' })).toThrow();
    expect(() => parseAction({ action: 'postmaker.migrate.undo', migrationId: '../x' })).toThrow();
  });
});

describe('postmaker.migrate and postmaker.migrate.undo through the service', () => {
  it('Home counts the pipelines to move; the actions move them and undo the move', async () => {
    threePipelines();
    expect((await home(project())).migration).toEqual({ pending: 3, kept: 0, undo: null });
    const moved = await handleAction(project(), { email: ACTOR }, { action: 'postmaker.migrate' });
    expect(moved.status).toBe(200);
    expect((moved.body as { moved: unknown[] }).moved).toHaveLength(3);
    const h = await home(project());
    expect(h.migration).toEqual({ pending: 0, kept: 0, undo: (moved.body as { migrationId: string }).migrationId });
    expect(h.templates.filter((t) => t.migratedFrom).map((t) => t.migratedFrom).sort()).toEqual([P1, P2, P3]);
    const undone = await handleAction(project(), { email: ACTOR }, { action: 'postmaker.migrate.undo' });
    expect(undone.body).toMatchObject({ migrationId: (moved.body as { migrationId: string }).migrationId });
    expect((await home(project())).migration).toEqual({ pending: 3, kept: 0, undo: null });
  });
});

describe('undo moves, never deletes', () => {
  it('restores the pipeline files byte-equal to the backup and moves the templates aside; no file is lost', async () => {
    threePipelines();
    const originals = hashes(pipelinesDir());
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    const templateIds = r.moved.map((m) => m.template).sort();
    const countBefore = countFiles(pipelinesDir()) + countFiles(path.join(pmRoot(), 'templates'));
    const u = await undoMigration(project(), { by: ACTOR, now: NOW + 60_000 });
    expect(u.migrationId).toBe(r.migrationId);
    expect(u.templates.sort()).toEqual(templateIds);
    // The pipeline files are the backup's, byte for byte.
    expect(hashes(pipelinesDir())).toEqual(originals);
    expect(hashes(pipelinesDir())).toEqual(hashes(path.join(pipelinesDir(), r.backup!)));
    // The templates (and the copied state) sit in templates/.undone-<time>/; the archived pipeline files in pipelines/.undone-<time>/.
    const tplAside = path.join(pmRoot(), 'templates', u.templatesFolder);
    expect(readdirSync(tplAside).sort()).toEqual([...templateIds.map((id) => `${id}.json`), `${r.moved.find((m) => m.pipeline === P2)!.template}.state.json`].sort());
    expect(readdirSync(path.join(pipelinesDir(), u.pipelinesFolder)).sort()).toEqual([P1, P2, P3].map((id) => `${id}.json`).sort());
    expect(await listTemplates(pmRoot())).toEqual([]);
    // No deletion: every file before is still there (moved), plus the restored copies.
    const countAfter = countFiles(pipelinesDir()) + countFiles(path.join(pmRoot(), 'templates'));
    expect(countAfter).toBe(countBefore + u.restored.length);
    expect(u.restored.sort()).toEqual([P1, P2, P3].map((id) => `${id}.json`).sort());
    // Undo once only; the pipelines are pending again and can be moved again.
    await expect(undoMigration(project(), { by: ACTOR, now: NOW + 120_000 })).rejects.toMatchObject({ status: 409, message: NOTHING_TO_UNDO_TEXT });
    expect((await pendingPipelines(project())).pending.sort()).toEqual([P1, P2, P3]);
    const again = await migratePipelines(project(), { by: ACTOR, now: NOW + 180_000 });
    expect(again.moved).toHaveLength(3);
  });

  it('refuses when the backup no longer matches its hash list, and changes nothing', async () => {
    threePipelines();
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    writeFileSync(path.join(pipelinesDir(), r.backup!, `${P1}.json`), '{}');
    const before = hashes(pipelinesDir());
    await expect(undoMigration(project(), { by: ACTOR, now: NOW + 60_000 })).rejects.toMatchObject({ status: 409, message: BACKUP_CHANGED_TEXT });
    expect(hashes(pipelinesDir())).toEqual(before);
    expect(await listTemplates(pmRoot())).toHaveLength(3);
  });

  it('refuses the whole undo when one entry of the record has a malformed template id, and nothing has moved', async () => {
    threePipelines();
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    const file = path.join(pmRoot(), 'migrations', `${r.migrationId}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')) as { moved: { template: string }[] };
    record.moved[record.moved.length - 1]!.template = '../outside';
    writeFileSync(file, JSON.stringify(record));
    const before = hashes(pipelinesDir());
    const templatesBefore = readdirSync(path.join(pmRoot(), 'templates')).sort();
    await expect(undoMigration(project(), { by: ACTOR, now: NOW + 60_000 })).rejects.toMatchObject({ status: 409, message: RECORD_DAMAGED_TEXT });
    expect(hashes(pipelinesDir())).toEqual(before);
    expect(readdirSync(path.join(pmRoot(), 'templates')).sort()).toEqual(templatesBefore);
    expect(readdirSync(pipelinesDir()).some((n) => n.startsWith('.undone-'))).toBe(false);
    expect(existsSync(path.join(pmRoot(), 'migrations', `${r.migrationId}.undo.json`))).toBe(false);
    expect(await listTemplates(pmRoot())).toHaveLength(3);
  });
});

describe('madeBy: the daily run after the move', () => {
  it('reads only the templates, never makes a slot twice, and marks new posts with the old pl-… id', async () => {
    writePipeline(P1, { name: 'Topics', steps: { source: { kind: 'list', list: ['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4'] }, make: { format: 'higgsfield-image' }, review: { enabled: false }, schedule: { makeAheadDays: 5 } } });
    const gen = fakeGenerator();
    // Before the move the pipeline makes its two due slots (Fri 06 and Mon 09).
    const first = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(made(first, P1)).toEqual(['2026-11-06-18:00', '2026-11-09-18:00']);
    await migratePipelines(project(), { by: ACTOR, now: NOW + 1000 });
    expect(existsSync(pipelineFile(P1))).toBe(true); // The file stays

    // Repeat switch off (the default): the archived pipeline does not run and the template makes nothing.
    const off = await runProject('manual', { now: NOW + 2000, generatePackage: gen.generate });
    expect(skips(off)).toEqual(['A template repeats, but nothing is made: Post maker is off.']);
    expect(gen.calls).toHaveLength(2);

    // Repeat on: the same day, the slots the pipeline made are not made again by its template.
    process.env.SIGNAL_FEATURE_POSTMAKER = '1';
    process.env[REPEAT_ENV] = '1';
    const same = await runProject('manual', { now: NOW + 3000, generatePackage: gen.generate });
    expect(made(same, P1)).toEqual([]);
    expect(gen.calls).toHaveLength(2);
    const t = (await listTemplates(pmRoot()))[0]!;
    expect(JSON.parse(readFileSync(path.join(pmRoot(), 'templates', `${t.id}.state.json`), 'utf8'))).toMatchObject({ listNext: 2, lastResult: 'Up to date: every upcoming slot has a post.' });

    // A longer make-ahead opens Wed 11: the template makes it with the pipeline's format and its next topic.
    await updateTemplate(pmRoot(), t.id, (x) => ({ ...x, repeat: { ...x.repeat!, makeAheadDays: 7 } }));
    const more = await runProject('manual', { now: NOW + 4000, generatePackage: gen.generate });
    expect(made(more, P1)).toEqual(['2026-11-11-18:00']);
    expect(gen.calls[2]).toMatchObject({ format: 'higgsfield-image' });
    expect(JSON.stringify(gen.calls[2])).toContain('Topic 3');
    const pkgId = more.steps.find((s) => s.kind === 'make' && s.package)!;
    expect(madeBy(await listPackages(), P1).get('2026-11-11T17:00:00.000Z')).toBe((pkgId as { package: string }).package);
  });

  it('a pipeline whose format needs Codex at the desk is not moved: it stays in Pipelines with a reason line', async () => {
    threePipelines();
    const before = readFileSync(pipelineFile(writePipeline(P4, { name: 'Codex pictures', enabled: true, steps: { source: { kind: 'list', list: ['A rainy evening'] }, make: { format: 'codex-post' } } }).id), 'utf8');
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    expect(r.moved.map((m) => m.pipeline).sort()).toEqual([P1, P2, P3]);
    expect(r.skipped).toContainEqual({ pipeline: P4, reason: SKIP_TEXT.codex });
    expect((await listTemplates(pmRoot())).some((t) => t.migratedFrom === P4)).toBe(false);
    expect(readFileSync(pipelineFile(P4), 'utf8')).toBe(before); // untouched, not archived
    // It counts as kept, so the nav keeps Pipelines for it.
    expect(await pendingPipelines(project())).toEqual({ pending: [], kept: [P4], undo: r.migrationId });
    expect((await home(project())).migration).toMatchObject({ pending: 0, kept: 1 });
    // The daily run still treats it as a pipeline: Codex only when you press Run now.
    process.env.SIGNAL_FEATURE_POSTMAKER = '1';
    process.env[REPEAT_ENV] = '1';
    const gen = fakeGenerator();
    const run = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate });
    expect(made(run, P4)).toEqual([]);
    expect(gen.calls.filter((c) => c.format === 'codex-post')).toEqual([]);
  });
});

describe('a moved pipeline’s template', () => {
  it('keeps the pipeline ranges on Repeat edits and refuses Make a post', async () => {
    threePipelines();
    await migratePipelines(project(), { by: ACTOR, now: NOW });
    const t = (await listTemplates(pmRoot())).find((x) => x.migratedFrom === P2) as Template;
    const saved = await setRepeatAction(pmRoot(), t.id, { ...t.repeat!, dailyUsd: 0.3 });
    expect(saved.repeat).toMatchObject({ dailyUsd: 0.3, enabled: false });
    await expect(makePostFork({ root: pmRoot(), project: project(), templateId: t.id, brief: { topic: 'x' }, by: ACTOR, now: NOW })).rejects.toMatchObject({ status: 409, message: LEGACY_ONLY_REPEAT });
  });
});


describe('the nav after a fixture move', () => {
  const navOf = async () => {
    const shown = pipelinesInNav((await home(project())).migration);
    return navGroups({ postmaker: true, pipelines: shown }).flatMap((g) => g.items);
  };
  it('has no Pipelines item once every pipeline moved, gets it back on Undo, and keeps it for a pipeline that stays', async () => {
    threePipelines();
    expect(await navOf()).toContain('pipelines');
    const r = await migratePipelines(project(), { by: ACTOR, now: NOW });
    const after = await navOf();
    expect(after).not.toContain('pipelines');
    expect(after).toHaveLength(10);
    await undoMigration(project(), { by: ACTOR, now: NOW + 60_000, migrationId: r.migrationId! });
    expect(await navOf()).toContain('pipelines');
    // A Codex pipeline is not moved, so Pipelines stays for it after the next move.
    writePipeline(P4, { name: 'Codex pictures', steps: { source: { kind: 'list', list: ['x'] }, make: { format: 'codex-post' } } });
    await migratePipelines(project(), { by: ACTOR, now: NOW + 120_000 });
    expect(await navOf()).toContain('pipelines');
  });

  it('keeps the Pipelines item and records the error when the pipelines folder cannot be read', async () => {
    rmSync(pipelinesDir(), { recursive: true, force: true });
    writeFileSync(pipelinesDir(), 'not a folder');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await home(project())).migration).toEqual({ pending: 0, kept: 0, undo: null, error: PIPELINES_UNREADABLE_TEXT });
      expect(await navOf()).toContain('pipelines');
      expect(log).toHaveBeenCalledWith('[postmaker] pipelines', expect.any(String));
    } finally {
      log.mockRestore();
    }
  });
});
