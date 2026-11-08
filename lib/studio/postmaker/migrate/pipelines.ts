// The one-time move of `pipelines/*.json` into templates with Repeat (no data is deleted).
// - Started only by a person (`postmaker.migrate`), never by a run or a timer; refused (409) while a daily run is in
//   progress, and it holds the run lock so no run starts while it works.
// - Backup first: every file of `pipelines/` is copied byte for byte into `pipelines/.backup-<ISO time>/`, each copy
//   checked against the original's SHA-256 (the hash list is kept in the migration record).
// - Each live pipeline becomes a template (`createTemplate`: write-once, exclusive) with `migratedFrom: 'pl-…'`, Repeat
//   equal to the pipeline's schedule, budget, approval and on/off switch, `inputs.kind` from its source, and its format
//   as a one-node `legacy-format` pipeline (migrate/legacy.ts). `<id>.state.json` is copied unchanged to
//   `templates/<tid>.state.json`. The source file then gets `archived: true` and nothing else changes in it.
// - Not moved: a pipeline that already makes posts from a template, and a pipeline whose format needs Codex at the
//   desk (Codex only runs while you watch); both stay in Pipelines with a reason line, so the Pipelines tab stays.
// - Idempotent: a pipeline whose template already exists (same `migratedFrom`) is never moved twice; a move that
//   stopped half-way is finished (archive, state copy) by the next one. Nothing to move = no backup, no record.
// - Undo (`postmaker.migrate.undo`) never deletes: the moved templates (and their state) go to
//   `templates/.undone-<ISO time>/`, the moved pipelines' current files go to `pipelines/.undone-<ISO time>/`, and their
//   backed-up files are copied back byte for byte. Deleting anything stays behind the data-deletion gate.
// - Every move and undo writes a record under `postmaker/migrations/` and a memory event.
// Runs only on the project it is given; tests use temp folders. Generic core: no project names.
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FORMATS } from '../../formats';
import { recordEvent } from '../../memory/store';
import { cleanSteps, defaultName, defaultSteps, ID_RE } from '../../pipelines/store';
import type { Pipeline, SourceKind } from '../../pipelines/types';
import { PostmakerError } from '../errors';
import { templateStateFile } from '../repeat-state';
import { DIR_MODE, ensureDir, exists, listDir, pretty, readJsonFile, readText, writeOnce, writeReplace } from '../store/fs';
import { contentParent, newTemplateId, postmakerRoot, templateFile } from '../store/paths';
import { createTemplate, listTemplates } from '../store/templates';
import type { ProjectLike, Template } from '../types';
import { LEGACY_ATTENDED_FORMATS, LEGACY_RECIPE_ID, legacyPipelineOf } from './legacy';

export type MigrateProject = Pick<ProjectLike, 'id' | 'contentDir' | 'timeZone'>;

export interface MigrationRecord {
  schema: 'signal.pm.migration/1';
  id: string;
  at: string;
  by: string;
  /** The backup folder inside `pipelines/` (`.backup-<ISO time>`). */
  backup: string;
  /** Every file copied into the backup, with the SHA-256 of the original (the hash list). */
  files: { name: string; sha256: string; bytes: number }[];
  moved: { pipeline: string; template: string; name: string; state: boolean }[];
  skipped: { pipeline: string; reason: string }[];
}

export interface UndoRecord {
  schema: 'signal.pm.migration-undo/1';
  id: string;
  at: string;
  by: string;
  /** Where the moved templates went, inside `postmaker/templates/`. */
  templatesFolder: string;
  /** Where the moved pipelines' current (archived) files went, inside `pipelines/`. */
  pipelinesFolder: string;
  templates: string[];
  restored: string[];
}

export interface MigrateResult {
  /** Null when there was nothing to move (no backup and no record were written). */
  migrationId: string | null;
  backup: string | null;
  moved: MigrationRecord['moved'];
  skipped: MigrationRecord['skipped'];
}

export interface UndoResult {
  migrationId: string;
  templatesFolder: string;
  pipelinesFolder: string;
  templates: string[];
  restored: string[];
}

export const RUN_GOING_TEXT = 'A run is going. Try again when it ends.';
export const NOTHING_TO_UNDO_TEXT = 'There is no move to undo.';
export const BACKUP_CHANGED_TEXT = 'The backup changed since the move. Nothing was undone.';
export const SKIP_TEXT = {
  removed: 'It was removed.',
  fromTemplate: 'It already makes posts from a template. Turn on Repeat on that template instead.',
  codex: 'Its images come from Codex, which only runs while you watch. It stays in Pipelines.',
  unreadable: 'Its file could not be read.',
} as const;

const PIPELINE_FILE_RE = /^pl-\d{8}-[a-z0-9]{4}\.json$/;
const MIGRATION_ID_RE = /^mig-\d{8}T\d{6}\d{3}Z-[0-9a-f]{4}$/;

// ---- paths ---------------------------------------------------------------------------------------------------------

export const pipelinesFolder = (p: Pick<ProjectLike, 'contentDir'>) => path.join(contentParent(p), 'pipelines');
const migrationsDir = (root: string) => path.join(root, 'migrations');
const recordFile = (root: string, id: string) => path.join(migrationsDir(root), `${id}.json`);
const undoFile = (root: string, id: string) => path.join(migrationsDir(root), `${id}.undo.json`);
/** `2026-11-07T10:15:30.123Z` → `20261107T101530123Z`: sortable and safe in every file system. */
const stampOf = (now: number) => new Date(now).toISOString().replace(/[-:.]/g, '');

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- the run lock --------------------------------------------------------------------------------------------------

/** Refused while a run is in progress; holds the run lock while `fn` works (the autopilot runner loads lazily). */
async function underRunLock<T>(project: MigrateProject, fn: () => Promise<T>): Promise<T> {
  const ap = await import('../../autopilot/runner');
  if (ap.runInProgress(project.id)) throw new PostmakerError(409, 'conflict', RUN_GOING_TEXT);
  return ap.withRunLock(fn, project.id, RUN_GOING_TEXT);
}

// ---- reading the pipelines -----------------------------------------------------------------------------------------

interface Source {
  name: string; // file name
  raw: string;
  pipeline: Pipeline;
  fromTemplate: boolean;
}

/** A pipeline whose format needs Codex at the desk stays where it is (Codex only runs while you watch). */
const needsCodex = (s: Source): boolean => !s.fromTemplate && LEGACY_ATTENDED_FORMATS.includes(s.pipeline.steps.make.format);
/** Live pipelines a move leaves where they are: they make posts from a template, or their format needs Codex. */
const staysInPipelines = (s: Source): boolean => s.fromTemplate || needsCodex(s);

/** A stored pipeline as the runner reads it (the store's own cleaning; every format kept, whatever the project). */
function parsePipeline(raw: string): { pipeline: Pipeline; fromTemplate: boolean } | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const steps = cleanSteps(o.steps, defaultSteps(), [...FORMATS]);
  const name = typeof o.name === 'string' && o.name.replace(/\s+/g, ' ').trim() ? o.name.replace(/\s+/g, ' ').trim().slice(0, 60) : defaultName(steps);
  const at = typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString();
  return {
    pipeline: { id: o.id, name, enabled: o.enabled === true, archived: o.archived === true, steps, createdAt: at, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : at },
    fromTemplate: !!steps.make.fromTemplate,
  };
}

async function readSources(dir: string): Promise<{ sources: Source[]; unreadable: string[] }> {
  const sources: Source[] = [];
  const unreadable: string[] = [];
  for (const name of (await listDir(dir)).filter((n) => PIPELINE_FILE_RE.test(n)).sort()) {
    const raw = await readText(path.join(dir, name));
    const parsed = raw === null ? null : parsePipeline(raw);
    if (!parsed || `${parsed.pipeline.id}.json` !== name) unreadable.push(name.replace(/\.json$/, ''));
    else sources.push({ name, raw: raw!, ...parsed });
  }
  return { sources, unreadable };
}

// ---- the template of one pipeline (field table) --------------------------------------------------------------

const INPUT_KIND: Record<SourceKind, Template['inputs']['kind']> = { ideas: 'ideas', list: 'topic-list', website: 'website-page', campaign: 'campaign-slot' };

/** The template a pipeline becomes. Pure; `id` and the time come from the caller. */
export function templateOfPipeline(p: Pipeline, o: { id: string; at: string; by: string }): Omit<Template, 'revision'> {
  const s = p.steps;
  return {
    schema: 'signal.pm.template/1',
    id: o.id,
    name: p.name,
    // A moved pipeline already made posts on its schedule: it lands on Proven with Repeats. It has no Post
    // maker proof (`provenRunId: null`) and no streak, so skip proof stays locked.
    status: 'proven',
    recipeId: LEGACY_RECIPE_ID,
    snapshot: { recipeVersion: 1, pipelineVersion: 1, heads: {}, packId: null, packVersion: null },
    provenRunId: null,
    provenAt: o.at,
    provenBy: o.by,
    builtIn: false,
    pack: null,
    campaignIds: s.source.kind === 'campaign' && s.source.campaign ? [s.source.campaign] : [],
    inputs: { kind: INPUT_KIND[s.source.kind], lockedNodes: [], ...(s.source.kind === 'list' ? { list: [...s.source.list] } : {}) },
    variants: [],
    repeat: { enabled: p.enabled, perWeek: s.schedule.perWeek, days: [...s.schedule.days], times: [...s.schedule.times], makeAheadDays: s.schedule.makeAheadDays, dailyUsd: s.budget.dailyUsd, approve: s.approve.mode },
    skipProofForRepeats: false,
    premiumStreak: 0,
    migratedFrom: p.id,
    legacy: legacyPipelineOf(s.make.format, { template: s.make.template, captionStyle: s.make.captionStyle, review: s.review.enabled }),
  };
}

/**
 * The source file with `archived: true` and every other byte as it was: one textual change when the file has exactly
 * one `"archived": false`, else the store's own formatting. The result is checked by parsing it back.
 */
export function archivedText(raw: string): string {
  const before = JSON.parse(raw) as Record<string, unknown>;
  const want = { ...before, archived: true };
  const re = /("archived"\s*:\s*)false\b/g;
  const hits = raw.match(re)?.length ?? 0;
  const next = hits === 1 ? raw.replace(re, '$1true') : pretty(want);
  if (!isDeepStrictEqual(JSON.parse(next), want)) return pretty(want);
  return next;
}

// ---- move ----------------------------------------------------------------------------------------------------------

/**
 * Pipelines a move would take (`pending`: live, readable, not making posts from a template, not moved yet), the live
 * pipelines a move leaves where they are (`kept`: they make posts from a template; the Pipelines tab stays
 * while any is left), and the move Undo would revert.
 */
export async function pendingPipelines(project: Pick<ProjectLike, 'contentDir'>): Promise<{ pending: string[]; kept: string[]; undo: string | null }> {
  const root = postmakerRoot(project);
  const { sources } = await readSources(pipelinesFolder(project));
  const moved = new Set((await listTemplates(root).catch(() => [] as Template[])).map((t) => t.migratedFrom).filter(Boolean));
  const live = sources.filter((s) => !s.pipeline.archived && !moved.has(s.pipeline.id));
  const pending = live.filter((s) => !staysInPipelines(s)).map((s) => s.pipeline.id);
  const kept = live.filter(staysInPipelines).map((s) => s.pipeline.id);
  return { pending, kept, undo: (await undoable(root))?.id ?? null };
}

/** Copies every top-level file of `dir` into a new `.backup-<stamp>` folder, checking each copy's SHA-256. */
async function backUp(dir: string, stamp: string): Promise<{ folder: string; files: MigrationRecord['files'] }> {
  let folder = `.backup-${stamp}`;
  for (let i = 2; ; i++) {
    try {
      await fs.mkdir(/* turbopackIgnore: true */ path.join(dir, folder), { mode: DIR_MODE });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 9) throw e;
      folder = `.backup-${stamp}-${i}`;
    }
  }
  const files: MigrationRecord['files'] = [];
  for (const name of (await listDir(dir)).sort()) {
    if (name.startsWith('.')) continue; // earlier backups, undo folders and temp files
    const from = path.join(dir, name);
    if (!(await fs.lstat(/* turbopackIgnore: true */ from)).isFile()) continue;
    const bytes = await fs.readFile(/* turbopackIgnore: true */ from);
    const to = path.join(dir, folder, name);
    await fs.writeFile(/* turbopackIgnore: true */ to, bytes, { flag: 'wx', mode: 0o600 });
    const copy = await fs.readFile(/* turbopackIgnore: true */ to);
    if (sha256(copy) !== sha256(bytes)) throw new PostmakerError(500, 'internal', 'The backup copy does not match.');
    files.push({ name, sha256: sha256(bytes), bytes: bytes.length });
  }
  return { folder, files };
}

/** Copies a pipeline's run state to its template unchanged; true when there was one. */
async function copyState(dir: string, pipelineId: string, root: string, templateId: string): Promise<boolean> {
  const from = path.join(dir, `${pipelineId}.state.json`);
  if (!(await exists(from))) return false;
  const to = templateStateFile(root, templateId);
  if (await exists(to)) return true;
  await ensureDir(path.dirname(to));
  await fs.copyFile(/* turbopackIgnore: true */ from, to, fsConstants.COPYFILE_EXCL);
  return true;
}

/**
 * `postmaker.migrate`: moves every live pipeline into a template with Repeat (see the file header). Started by a
 * person only; refused while a run is in progress.
 */
export async function migratePipelines(project: MigrateProject, o: { by: string; now?: number }): Promise<MigrateResult> {
  return underRunLock(project, async () => {
    const now = o.now ?? Date.now();
    const at = new Date(now).toISOString();
    const dir = pipelinesFolder(project);
    const root = postmakerRoot(project);
    const { sources, unreadable } = await readSources(dir);
    const existing = new Map<string, Template>();
    for (const t of await listTemplates(root)) if (t.migratedFrom) existing.set(t.migratedFrom, t);

    const skipped: MigrationRecord['skipped'] = unreadable.map((pipeline) => ({ pipeline, reason: SKIP_TEXT.unreadable }));
    const create: Source[] = [];
    const finish: { source: Source; template: Template }[] = [];
    for (const s of sources) {
      const done = existing.get(s.pipeline.id);
      if (s.pipeline.archived) {
        if (!done) skipped.push({ pipeline: s.pipeline.id, reason: SKIP_TEXT.removed });
        continue; // moved earlier (its template exists) or removed by the person: nothing to do
      }
      if (done) finish.push({ source: s, template: done });
      else if (s.fromTemplate) skipped.push({ pipeline: s.pipeline.id, reason: SKIP_TEXT.fromTemplate });
      else if (needsCodex(s)) skipped.push({ pipeline: s.pipeline.id, reason: SKIP_TEXT.codex });
      else create.push(s);
    }
    if (!create.length && !finish.length) return { migrationId: null, backup: null, moved: [], skipped };

    const stamp = stampOf(now);
    const { folder, files } = await backUp(dir, stamp);
    const moved: MigrationRecord['moved'] = [];
    for (const s of create) {
      let template: Template | null = null;
      for (let attempt = 0; attempt < 5 && !template; attempt++) {
        try {
          template = await createTemplate(root, templateOfPipeline(s.pipeline, { id: newTemplateId(project, now), at, by: o.by }));
        } catch (e) {
          if (!(e instanceof PostmakerError && e.code === 'exists')) throw e;
        }
      }
      if (!template) throw new PostmakerError(409, 'conflict', 'Could not find a free template id. Try again.');
      const state = await copyState(dir, s.pipeline.id, root, template.id);
      await writeReplace(path.join(dir, s.name), archivedText(s.raw));
      moved.push({ pipeline: s.pipeline.id, template: template.id, name: template.name, state });
    }
    for (const { source: s, template } of finish) {
      // A move that stopped after the template was written: copy the state and archive the source now.
      const state = await copyState(dir, s.pipeline.id, root, template.id);
      await writeReplace(path.join(dir, s.name), archivedText(s.raw));
      moved.push({ pipeline: s.pipeline.id, template: template.id, name: template.name, state });
    }
    const id = `mig-${stamp}-${randomBytes(2).toString('hex')}`;
    const record: MigrationRecord = { schema: 'signal.pm.migration/1', id, at, by: o.by, backup: folder, files, moved, skipped };
    await writeOnce(recordFile(root, id), pretty(record));
    const n = moved.length;
    await recordEvent({
      type: 'decision.made',
      by: o.by,
      at,
      data: { decision: 'pipelines-moved', migration: id, pipelines: moved.map((m) => m.pipeline), templates: moved.map((m) => m.template), backup: folder, text: `Moved ${n} ${n === 1 ? 'pipeline' : 'pipelines'} into templates with Repeat. Backup kept.` },
    });
    return { migrationId: id, backup: folder, moved, skipped };
  });
}

// ---- undo ----------------------------------------------------------------------------------------------------------

async function listRecords(root: string): Promise<MigrationRecord[]> {
  const out: MigrationRecord[] = [];
  for (const f of (await listDir(migrationsDir(root))).sort()) {
    const m = /^(mig-.+)\.json$/.exec(f);
    if (!m || !MIGRATION_ID_RE.test(m[1]!)) continue;
    const r = await readJsonFile<MigrationRecord>(path.join(migrationsDir(root), f)).catch(() => null);
    if (r?.schema === 'signal.pm.migration/1' && r.id === m[1]) out.push(r);
  }
  return out;
}

/** The newest move that was not undone yet. */
async function undoable(root: string): Promise<MigrationRecord | null> {
  const all = await listRecords(root);
  for (const r of all.reverse()) if (!(await exists(undoFile(root, r.id)))) return r;
  return null;
}

/** Moves `from` into `folder` (created on first use); never overwrites and never deletes. */
async function moveInto(from: string, folder: string): Promise<void> {
  await ensureDir(folder);
  const to = path.join(folder, path.basename(from));
  if (await exists(to)) throw new PostmakerError(409, 'conflict', 'The undo folder already has this file.');
  await fs.rename(/* turbopackIgnore: true */ from, to);
}

/**
 * `postmaker.migrate.undo`: undoes the newest move (or `migrationId`) without deleting anything (see the file header).
 * Refused while a run is in progress, when there is nothing to undo, and when the backup's files no longer match the
 * hash list.
 */
export async function undoMigration(project: MigrateProject, o: { by: string; migrationId?: string; now?: number }): Promise<UndoResult> {
  return underRunLock(project, async () => {
    const now = o.now ?? Date.now();
    const dir = pipelinesFolder(project);
    const root = postmakerRoot(project);
    if (o.migrationId !== undefined && !MIGRATION_ID_RE.test(o.migrationId)) throw new PostmakerError(404, 'not_found', NOTHING_TO_UNDO_TEXT);
    const record = o.migrationId ? ((await listRecords(root)).find((r) => r.id === o.migrationId) ?? null) : await undoable(root);
    if (!record || (await exists(undoFile(root, record.id)))) throw new PostmakerError(409, 'conflict', NOTHING_TO_UNDO_TEXT);
    if (!/^\.backup-[0-9TZ-]+$/.test(record.backup)) throw new PostmakerError(409, 'conflict', BACKUP_CHANGED_TEXT);

    // The backup must still be what the move copied (the hash list), or nothing is touched.
    const backupDir = path.join(dir, record.backup);
    const backed = new Map<string, Buffer>();
    for (const f of record.files) {
      if (!PIPELINE_FILE_RE.test(f.name) && !/^pl-\d{8}-[a-z0-9]{4}\.state\.json$/.test(f.name)) continue;
      const b = await fs.readFile(/* turbopackIgnore: true */ path.join(backupDir, f.name)).catch(() => null);
      if (!b || sha256(b) !== f.sha256) throw new PostmakerError(409, 'conflict', BACKUP_CHANGED_TEXT);
      backed.set(f.name, b);
    }

    const stamp = stampOf(now);
    const templatesFolder = `.undone-${stamp}`;
    const pipelinesFolderName = `.undone-${stamp}`;
    const tplUndone = path.join(root, 'templates', templatesFolder);
    const plUndone = path.join(dir, pipelinesFolderName);
    const templates: string[] = [];
    const restored: string[] = [];
    for (const m of record.moved) {
      if (!ID_RE.test(m.pipeline)) continue; // a hand-edited record never names a path outside the two folders
      // The template (only while it is still the one this move wrote) and its run state go to the dated folder.
      const tf = templateFile(root, m.template);
      const t = await readJsonFile<Template>(tf).catch(() => null);
      if (t && t.migratedFrom === m.pipeline) {
        await moveInto(tf, tplUndone);
        const sf = templateStateFile(root, m.template);
        if (await exists(sf)) await moveInto(sf, tplUndone);
        templates.push(m.template);
      }
      // The pipeline's files come back from the backup; whatever is there now is kept in the dated folder.
      for (const name of [`${m.pipeline}.json`, `${m.pipeline}.state.json`]) {
        const b = backed.get(name);
        if (!b) continue;
        const target = path.join(dir, name);
        const cur = await fs.readFile(/* turbopackIgnore: true */ target).catch(() => null);
        if (cur && cur.equals(b)) continue;
        if (cur) await moveInto(target, plUndone);
        await fs.writeFile(/* turbopackIgnore: true */ target, b, { flag: 'wx', mode: 0o600 });
        restored.push(name);
      }
    }
    const at = new Date(now).toISOString();
    const undo: UndoRecord = { schema: 'signal.pm.migration-undo/1', id: record.id, at, by: o.by, templatesFolder, pipelinesFolder: pipelinesFolderName, templates, restored };
    await writeOnce(undoFile(root, record.id), pretty(undo));
    const n = record.moved.length;
    await recordEvent({
      type: 'decision.made',
      by: o.by,
      at,
      data: { decision: 'pipelines-move-undone', migration: record.id, templates, restored, text: `Undid the move of ${n} ${n === 1 ? 'pipeline' : 'pipelines'}. Templates kept aside.` },
    });
    return { migrationId: record.id, templatesFolder, pipelinesFolder: pipelinesFolderName, templates, restored };
  });
}
