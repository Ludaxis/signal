// Accept: turns a proof into normal Posts packages, one per language,
// each with a `postmaker.json` lineage lock, and proves the template.
// Clean Accept needs, all at once: no node out of date, failed, not run or needing you; every required gate signed by
// a named person for the exact version hash (agent and mock records never count); no mock step anywhere in the
// lineage; and a Premium or Standard verdict from the check (or a manual score on an Unscored proof). "Accept as
// draft" waives the sign-offs, the mock rule and the verdict, keeps the template Draft and writes no package.
// Premium sets the template `proven`; Standard writes the package note "below premium", leaves the template Draft
// and resets the streak. Every object in an accepted lineage is pinned (pins.json). Generic core: no project names.
// The streak and skip-proof are per template + variant (template-rules.ts); a hard-gate override (a manual
// score) resets the streak. A fork made by "Make a post" accepts into its template without moving the template's
// snapshot or name; its variant (if any) is proven by a Premium accept. A post made for a campaign slot writes that
// slot's id into campaign.json and its time into the lineage lock's `slotAt`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { featureEnabled } from '@/lib/server/signalConfig';
import { GENERATOR_NOT_ALLOWED, generatorAllowed, PM_GENERATOR, PM_SWITCH_OFF, type PackageFile, type PackageSpec } from '../content';
import { PostmakerError } from './errors';
import { nextPackageIdAfter, PACKAGE_IDS_USED_UP } from '../package-id';
import { acceptBlockers, type GraphState } from './graph/status';
import { recipeMutexKey, type PostmakerEngine } from './runner';
import { inheritedSignOff, isAgentIdentity } from './signoffs';
import { DIR_MODE, FILE_MODE } from './store/fs';
import { withLock } from './store/mutex';
import { getJson, hashJson, sha256OfFile } from './store/objects';
import { newTemplateId, objectPath } from './store/paths';
import { addPins } from './store/pins';
import { readRecipe, readRecipeIndex, readPackLock } from './store/recipes';
import { appendEvent, listRunIds, readRun, updateRun } from './store/runs';
import { createTemplate, listTemplates, readTemplate, updateTemplate } from './store/templates';
import { readVersion } from './store/versions';
import type { Lang, PostmakerMark, Recipe, Run, SignOff, StepVersion, Template } from './types';
import { acceptableVerdict, readVerdict, type Verdict } from './verdict';
import { applyAcceptToTemplate, gateHashesOf, gatesInherited, nextPremiumStreak, SKIP_PROOF_STREAK, streakOf } from './template-rules';
import { runVerdictOf } from './manual-score';
import { TEMPLATE_NAME_MAX } from './template-name';
import type { PostCopyDoc } from './graph/adapters';

export const BELOW_PREMIUM_NOTE = 'below premium';
export const GENERATOR = PM_GENERATOR;

// ---- lineage -----------------------------------------------------------------------------------------

export type LineageEntry = { nodeId: string; n: number; hash: string };

/** The step versions reachable backwards through recorded `inputs` from `roots`, sorted by node id then number. */
export async function lineageOf(root: string, recipeId: string, roots: StepVersion[]): Promise<{ entries: LineageEntry[]; versions: StepVersion[] }> {
  const seen = new Map<string, StepVersion>();
  const stack = [...roots];
  while (stack.length) {
    const v = stack.pop()!;
    const key = `${v.nodeId}@${v.n}`;
    if (seen.has(key)) continue;
    seen.set(key, v);
    for (const i of v.inputs) {
      const up = await readVersion(root, recipeId, i.nodeId, i.version);
      if (!up || up.hash !== i.hash) throw new PostmakerError(409, 'conflict', `The saved history of ${i.nodeId} does not match. Run it again.`);
      stack.push(up);
    }
  }
  const versions = [...seen.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.n - b.n));
  return { entries: versions.map((v) => ({ nodeId: v.nodeId, n: v.n, hash: v.hash })), versions };
}

/** `lineageRoot = sha256(JCS(sorted list of [nodeId, n, hash]))`. */
export const lineageRootOf = (entries: LineageEntry[]): string =>
  hashJson([...entries].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.n - b.n)).map((e) => [e.nodeId, e.n, e.hash]));

/** Recomputes a mark's lineage root from the stored version files (the Posts drawer's on-demand check). */
export async function recomputeLineageRoot(root: string, mark: Pick<PostmakerMark, 'recipeId' | 'lineage'>): Promise<{ ok: boolean; root: string | null; problem: string | null }> {
  const entries: LineageEntry[] = [];
  for (const e of mark.lineage) {
    const v = await readVersion(root, mark.recipeId, e.nodeId, e.n).catch(() => null);
    if (!v) return { ok: false, root: null, problem: `${e.nodeId} v${e.n} is missing.` };
    if (v.hash !== e.hash) return { ok: false, root: null, problem: `${e.nodeId} v${e.n} has changed.` };
    entries.push({ nodeId: v.nodeId, n: v.n, hash: v.hash });
  }
  return { ok: true, root: lineageRootOf(entries), problem: null };
}

// ---- verdict, streak, regenerations ----------------------------------------------------------------

const REGENERATE: Run['trigger'][] = ['regenerate', 'regenerate-from-here'];

/** Regenerations of a recipe since its last accepted run (a run with packages), up to and including `runId`. */
export function countRegenerations(runs: Pick<Run, 'id' | 'recipeId' | 'trigger' | 'startedAt' | 'packageIds'>[], recipeId: string, runId: string): number {
  const mine = runs.filter((r) => r.recipeId === recipeId).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
  const at = mine.findIndex((r) => r.id === runId);
  let n = 0;
  for (let i = (at < 0 ? mine.length : at + 1) - 1; i >= 0; i--) {
    const r = mine[i]!;
    if (r.id !== runId && r.packageIds.length) break;
    if (REGENERATE.includes(r.trigger)) n += 1;
  }
  return n;
}

/** The streak rule (with the hard-gate override) lives in template-rules.ts. */
export { nextPremiumStreak };

// ---- sign-offs -------------------------------------------------------------------------------------

/** The deciding person-made record of a gated version (mock and agent records never count), or null. */
export function personSignOff(v: StepVersion, gate: SignOff['gate'], extra: SignOff[]): SignOff | null {
  const records = [...v.signoffs, ...extra].filter((s) => s.gate === gate && s.nodeId === v.nodeId && s.version === v.n && s.hash === v.hash && !isAgentIdentity(s.by) && !isAgentIdentity(s.name));
  const last = records.at(-1) ?? null;
  return last && last.verdict === 'pass' ? last : null;
}

// ---- the package ------------------------------------------------------------------------------------------

export interface AcceptProject {
  id: string;
  handle: string;
  contentDir: string;
  timeZone?: string;
}

/** The caption text of a post-copy version: the caption, then its hashtags when they are not in it yet. */
async function captionText(root: string, v: StepVersion): Promise<string> {
  const ref = v.outputs.find((o) => o.port === 'caption' && o.kind === 'json');
  if (!ref) throw new PostmakerError(409, 'conflict', `${v.nodeId} has no caption.`);
  const d = await getJson<PostCopyDoc>(root, ref.sha256, { verify: true });
  const caption = typeof d.caption === 'string' ? d.caption.trim() : '';
  if (!caption) throw new PostmakerError(409, 'conflict', `${v.nodeId} has an empty caption.`);
  const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).filter((t) => typeof t === 'string' && t && !caption.includes(t));
  return tags.length ? `${caption}\n\n${tags.join(' ')}\n` : `${caption}\n`;
}

async function nextFreeId(contentDir: string, after: number): Promise<string> {
  const names = await fs.readdir(/* turbopackIgnore: true */ contentDir).catch(() => [] as string[]);
  const next = nextPackageIdAfter(names, after);
  if (!next) throw new PostmakerError(409, 'conflict', PACKAGE_IDS_USED_UP);
  return next;
}

/** The package's campaign.json; `slot` is the campaign slot's id when the post was made for one, else ''. */
export function campaignRecord(recipe: Pick<Recipe, 'campaignId' | 'slot'>, by: string, at: string): { campaign: string; campaign_name?: string; slot: string; made_by: string; made_at: string } {
  const slot = recipe.slot && recipe.slot.campaignId === recipe.campaignId ? recipe.slot : null;
  return { campaign: recipe.campaignId!, ...(slot?.name ? { campaign_name: slot.name } : {}), slot: slot?.slotId ?? '', made_by: by, made_at: at };
}

export interface WrittenPackage {
  id: string;
  mark: PostmakerMark;
}

/**
 * `writePostmakerPackage`: builds the package in a hidden staging folder, then renames it to the next
 * free package id (package-id.ts; a rename onto a folder another writer just made fails and the next number is tried), so Posts never
 * sees a half-written package. Files: `video.mp4` and `cover.png` copied from the render objects (re-hashed after the
 * copy), `caption.txt` from post-copy; `package.json` (format reel, project handle, current experiment, sha256 per
 * file, source.generator 'postmaker'); `postmaker.json`; `campaign.json` when the recipe has a campaign.
 */
export async function writePostmakerPackage(o: {
  root: string;
  project: AcceptProject;
  recipe: Recipe;
  run: Run;
  lang: Lang;
  render: StepVersion;
  postCopy: StepVersion;
  signoffs: SignOff[];
  template: Pick<Template, 'id'> | null;
  /** The variant the proof was made for (a fork's `forkOf.variantId`); null = the default variant. */
  variantId?: string | null;
  templateName: string;
  /** The template revision this accept writes, shown as "v‹revision›" in the Posts origin line. */
  templateRevision: number;
  verdict: 'premium' | 'standard';
  by: string;
  now: number;
  /** The gates this accept took from the template's named sign-offs (skip proof in the daily run). */
  inherited?: PostmakerMark['inherited'];
}): Promise<WrittenPackage> {
  const contentDir = path.resolve(o.project.contentDir);
  await fs.mkdir(/* turbopackIgnore: true */ contentDir, { recursive: true });
  const { entries, versions } = await lineageOf(o.root, o.recipe.id, [o.render, o.postCopy]);
  const modes = { live: versions.filter((v) => v.mode === 'live').length, mock: versions.filter((v) => v.mode === 'mock').length };
  if (modes.mock > 0) throw new PostmakerError(409, 'conflict', 'Made with mock steps. Accept as draft instead.');
  const video = o.render.outputs.find((x) => x.port === 'video' && x.kind === 'video');
  const cover = o.render.outputs.find((x) => x.port === 'cover' && x.kind === 'image');
  if (!video) throw new PostmakerError(409, 'conflict', `${o.render.nodeId} has no video.`);
  const caption = await captionText(o.root, o.postCopy);
  const staging = path.join(contentDir, `.pm-${o.run.id}-${o.lang}-${process.pid}`);
  await fs.rm(/* turbopackIgnore: true */ staging, { recursive: true, force: true });
  await fs.mkdir(/* turbopackIgnore: true */ staging, { mode: DIR_MODE });
  try {
    const files: PackageFile[] = [];
    const markFiles: PostmakerMark['files'] = {};
    const copy = async (name: string, ref: NonNullable<typeof video>, role: PackageFile['role']) => {
      const dest = path.join(staging, name);
      await fs.copyFile(/* turbopackIgnore: true */ objectPath(o.root, ref.sha256), dest);
      await fs.chmod(/* turbopackIgnore: true */ dest, FILE_MODE);
      const sha = await sha256OfFile(dest);
      if (sha !== ref.sha256) throw new PostmakerError(409, 'conflict', 'A saved file has changed on disk.');
      files.push({ name, role, sha256: sha });
      markFiles[name] = { sha256: sha, fromNode: o.render.nodeId, fromVersion: o.render.n, port: ref.port };
    };
    await copy('video.mp4', video, 'video');
    if (cover) await copy('cover.png', cover, 'cover');
    await fs.writeFile(/* turbopackIgnore: true */ path.join(staging, 'caption.txt'), caption, { mode: FILE_MODE, flag: 'wx' });
    const captionSha = await sha256OfFile(path.join(staging, 'caption.txt'));
    files.push({ name: 'caption.txt', role: 'caption', sha256: captionSha });
    markFiles['caption.txt'] = { sha256: captionSha, fromNode: o.postCopy.nodeId, fromVersion: o.postCopy.n, port: 'caption' };

    const at = new Date(o.now).toISOString();
    const packLock = await readPackLock(o.root);
    const mark: PostmakerMark = {
      schema: 'signal.pm.mark/1',
      recipeId: o.recipe.id,
      templateId: o.template?.id ?? null,
      variantId: o.variantId !== undefined ? o.variantId : o.run.variantId,
      runId: o.run.id,
      lang: o.lang,
      lineageRoot: lineageRootOf(entries),
      lineage: entries,
      files: markFiles,
      packId: o.recipe.packId,
      packVersion: packLock && packLock.packId === o.recipe.packId ? packLock.version : null,
      modes,
      signoffs: o.signoffs,
      acceptedBy: o.by,
      acceptedAt: at,
      slotAt: o.recipe.slot && o.recipe.slot.campaignId === o.recipe.campaignId ? o.recipe.slot.at : null,
      pipeline: null,
      // The template revision this accept writes (its snapshot is this proof), not the recipe version.
      template: { name: o.templateName, version: o.templateRevision },
      verdict: o.verdict,
      ...(o.inherited?.length ? { inherited: o.inherited } : {}),
    };

    let after = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = await nextFreeId(contentDir, after);
      const spec: PackageSpec = {
        id,
        title: `${o.templateName} · ${o.lang}`,
        format: 'reel',
        destination: o.project.handle,
        files,
        ...(o.verdict === 'standard' ? { notes: [BELOW_PREMIUM_NOTE] } : {}),
        source: { generator: GENERATOR, format: GENERATOR, category: o.recipe.id, items: [], distractors: [], levels: [], seed: o.run.id },
      };
      await fs.writeFile(/* turbopackIgnore: true */ path.join(staging, 'package.json'), JSON.stringify(spec, null, 2) + '\n', { mode: FILE_MODE });
      await fs.writeFile(/* turbopackIgnore: true */ path.join(staging, 'postmaker.json'), JSON.stringify(mark, null, 2) + '\n', { mode: FILE_MODE });
      if (o.recipe.campaignId) await fs.writeFile(/* turbopackIgnore: true */ path.join(staging, 'campaign.json'), JSON.stringify(campaignRecord(o.recipe, o.by, at), null, 2) + '\n', { mode: FILE_MODE });
      const target = path.join(contentDir, id);
      try {
        // rename(2) fails when another writer has already put a package there (a non-empty folder).
        await fs.rename(/* turbopackIgnore: true */ staging, target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          after = Number(id);
          continue;
        }
        throw e;
      }
      const pins = [...new Set(versions.flatMap((v) => v.outputs.map((x) => x.sha256)))];
      await addPins(o.root, pins, `package:${id}`, o.now);
      return { id, mark };
    }
    throw new PostmakerError(409, 'conflict', 'Could not find a free package number. Try again.');
  } finally {
    await fs.rm(/* turbopackIgnore: true */ staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- proof.accept ------------------------------------------------------------------------------------------------

export interface AcceptResult {
  runId: string;
  asDraft: boolean;
  verdict: Verdict;
  packageIds: string[];
  template: Template;
  note: string | null;
}

async function templateFor(root: string, run: Run): Promise<Template | null> {
  const index = await readRecipeIndex(root, run.recipeId);
  const forkId = index?.forkOf?.templateId ?? run.templateId;
  if (forkId) return readTemplate(root, forkId);
  const mine = (await listTemplates(root)).filter((t) => t.recipeId === run.recipeId && t.status !== 'retired');
  return mine.at(-1) ?? null;
}

const snapshotOf = (s: GraphState, recipe: Recipe, pipelineVersion: number, packVersion: string | null): Template['snapshot'] => ({
  recipeVersion: recipe.version,
  pipelineVersion,
  heads: Object.fromEntries(
    Object.entries(s.current)
      .filter((e): e is [string, StepVersion] => e[1] !== null)
      .map(([id, v]) => [id, { version: v.n, hash: v.hash, locked: s.heads[id]?.locked ?? false }]),
  ),
  packId: recipe.packId,
  packVersion,
});

export const SUPERSEDED_TEXT = 'Steps changed after this proof. Accept the newest proof.';

/**
 * The accepted run must be the proof the heads show: every step this run made or reused is still the current
 * version. A later run or an edit that moved a head makes this run's proof stale (it would package other versions
 * under this run's id).
 */
export function assertRunIsCurrent(run: Pick<Run, 'steps'>, s: Pick<GraphState, 'current'>): void {
  const moved = run.steps.filter((st) => st.version !== null && s.current[st.nodeId]?.n !== st.version).map((st) => st.nodeId);
  if (moved.length) {
    const e = new PostmakerError(409, 'superseded', SUPERSEDED_TEXT);
    (e as PostmakerError & { issues?: unknown[] }).issues = moved.map((nodeId) => ({ nodeId, code: 'superseded', text: `${nodeId} changed after this proof.` }));
    throw e;
  }
}

/** The run is at Proof: finished (or waiting at Proof) with a current check version. */
function assertAtProof(run: Run): void {
  if (run.status === 'running' || run.status === 'queued') throw new PostmakerError(409, 'conflict', 'This run is still going.');
  if (run.packageIds.length) throw new PostmakerError(409, 'conflict', `Already accepted as post ${run.packageIds.join(', ')}.`);
  const atProof = run.status === 'done' || (run.status === 'needs-you' && run.pausedFor === 'check');
  if (!atProof) throw new PostmakerError(409, 'conflict', 'This run has not reached Proof.');
}

export const NOT_INHERITED_TEXT = 'Narration text or voice changed since the template was signed. Check it on Proof.';

/**
 * The gates a skip-proof accept takes from the template, verified here inside the
 * recipe lock whatever the caller decided. All must hold: the run is a fork of a template that is not retired; that
 * template + variant has skip proof on and a streak of at least 3; every current step is live; the check (or a person's
 * score on an Unscored proof) rates it Premium; the narration-text and voice versions are the template's
 * (`gatesInherited`); and every gate the fork's own records leave unsigned has a
 * named person's pass on the exact template version it was forked from. Otherwise 409 and nothing is written.
 * Returns the inherited records by node id (empty when every gate carries its own sign-off).
 */
async function inheritedGates(root: string, recipe: Recipe, s: GraphState, extra: SignOff[], verdict: Verdict): Promise<Map<string, SignOff>> {
  const refuse = (m: string) => new PostmakerError(409, 'accept-blocked', m);
  const fork = (await readRecipeIndex(root, recipe.id))?.forkOf ?? null;
  const t = fork ? await readTemplate(root, fork.templateId) : null;
  if (!fork || !t) throw refuse('Only a post made from a template can skip proof.');
  if (t.status === 'retired') throw refuse('This template is retired.');
  const st = streakOf(t, fork.variantId);
  if (!st || !st.skipProof || st.streak < SKIP_PROOF_STREAK) throw refuse('Skip proof is off for this template.');
  if (Object.values(s.current).some((v) => v && v.mode !== 'live')) throw refuse('Made with mock steps. Accept as draft instead.');
  if (verdict !== 'premium') throw refuse('The check did not rate it Premium.');
  if (!gatesInherited(t, fork.variantId, { current: s.current, languages: recipe.languages })) throw refuse(NOT_INHERITED_TEXT);
  const out = new Map<string, SignOff>();
  for (const n of s.pipeline.nodes) {
    if (!n.gate || n.gate.id === 'proof') continue;
    const v = s.current[n.id];
    if (!v) throw refuse(`${n.id} needs a named sign-off.`);
    if (personSignOff(v, n.gate.id, extra)) continue;
    const so = await inheritedSignOff(root, v, n.gate.id);
    if (!so) throw refuse(NOT_INHERITED_TEXT);
    out.set(n.id, so);
  }
  return out;
}

/**
 * `proof.accept`. Runs under the recipe mutex, so no edit or step commit lands between the checks and the
 * package. 409 for every refusal (lineage out of date, unsigned, mock, verdict, run state).
 */
export async function acceptProof(o: {
  engine: PostmakerEngine;
  root: string;
  project: AcceptProject;
  runId: string;
  asDraft: boolean;
  templateName: string;
  by: string;
  now?: () => number;
  /**
   * The daily run's skip-proof accept. Gates the fork's own records leave unsigned may be taken from the
   * template's named sign-offs, only under the full rule (`inheritedGates`). The API never sets it.
   */
  inheritGates?: boolean;
}): Promise<AcceptResult> {
  const now = o.now ?? Date.now;
  const name = o.templateName.trim().replace(/\s+/g, ' ');
  if (!name || name.length > TEMPLATE_NAME_MAX) throw new PostmakerError(400, 'validation', `Give the template a name (up to ${TEMPLATE_NAME_MAX} characters).`);
  const first = await readRun(o.root, o.runId);
  if (!first) throw new PostmakerError(404, 'not_found', 'Unknown run.');
  return withLock(recipeMutexKey(first.recipeId), async () => {
    const run = (await readRun(o.root, o.runId))!;
    assertAtProof(run);
    const recipe = await readRecipe(o.root, run.recipeId);
    if (!recipe) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
    const s = await o.engine.state(run.recipeId);
    const check = s.current.check ?? null;
    if (!check || !s.pipeline.nodes.some((n) => n.id === 'check')) throw new PostmakerError(409, 'conflict', 'This run has not reached Proof.');
    assertRunIsCurrent(run, s);
    // An Unscored proof the owner scored by hand on this exact check version takes that verdict.
    const verdict = await runVerdictOf(o.root, run.id, check);
    const inherited = o.inheritGates === true && !o.asDraft ? await inheritedGates(o.root, recipe, s, s.signoffs ?? [], verdict) : new Map<string, SignOff>();
    const blockers = acceptBlockers(s, { asDraft: o.asDraft }).filter((b) => !(b.why === 'unsigned' && inherited.has(b.nodeId)));
    if (blockers.length) {
      const e = new PostmakerError(409, 'accept-blocked', blockers.some((b) => b.why === 'out-of-date') ? 'Some steps are out of date.' : blockers[0]!.text);
      (e as PostmakerError & { blockers?: unknown }).blockers = blockers;
      throw e;
    }
    const extra = s.signoffs ?? [];
    const signoffs: SignOff[] = [];
    if (!o.asDraft) {
      // a second guard beside acceptBlockers: every gate needs a person's pass on the exact hash.
      for (const n of s.pipeline.nodes) {
        if (!n.gate || n.gate.id === 'proof') continue;
        const v = s.current[n.id];
        const so = v ? (personSignOff(v, n.gate.id, extra) ?? inherited.get(n.id) ?? null) : null;
        if (!so) throw new PostmakerError(409, 'accept-blocked', `${n.id} needs a named sign-off.`);
        signoffs.push(so);
      }
      if (Object.values(s.current).some((v) => v?.mode === 'mock')) throw new PostmakerError(409, 'accept-blocked', 'Made with mock steps. Accept as draft instead.');
      if (verdict === 'regenerate') throw new PostmakerError(409, 'accept-blocked', 'The check says regenerate. Fix the steps it names first.');
      if (!acceptableVerdict(verdict)) throw new PostmakerError(409, 'accept-blocked', 'Not scored yet. Score it on Proof, or accept as draft.');
      // A clean Accept writes packages: Post maker must be on, and an optional contentGenerators list must name it.
      if (!(await featureEnabled('postmaker'))) throw new PostmakerError(409, 'accept-blocked', `${PM_SWITCH_OFF}.`);
      if (!(await generatorAllowed(GENERATOR))) throw new PostmakerError(409, 'accept-blocked', GENERATOR_NOT_ALLOWED);
    }

    const at = now();
    const iso = new Date(at).toISOString();
    const packLock = await readPackLock(o.root);
    const pipelineVersion = (await readRecipeIndex(o.root, run.recipeId))?.pipeline ?? 1;
    const snapshot = snapshotOf(s, recipe, pipelineVersion, packLock && packLock.packId === recipe.packId ? packLock.version : null);
    // An existing template gets one write per accept (revision + 1); a new one is written once, at revision 1, after
    // the packages, with this accept's outcome already in it.
    const existing = await templateFor(o.root, run);
    if (existing?.status === 'retired') throw new PostmakerError(409, 'conflict', 'This template is retired.');
    // A fork accepts into the template it was made from (never a new one) and never moves its snapshot.
    const fork = (await readRecipeIndex(o.root, run.recipeId))?.forkOf ?? null;
    if (fork && (!existing || existing.id !== fork.templateId)) throw new PostmakerError(409, 'conflict', 'The template this post was made from is gone.');
    const variantId = fork ? fork.variantId : run.variantId;
    const postName = fork && existing ? existing.name : name;
    if (variantId && !existing?.variants.some((v) => v.id === variantId)) throw new PostmakerError(409, 'conflict', 'This variant is no longer on the template.');
    const base: Template = existing ?? {
      schema: 'signal.pm.template/1',
      id: newTemplateId(o.project, at),
      name,
      status: 'draft',
      recipeId: run.recipeId,
      snapshot,
      provenRunId: null,
      provenAt: null,
      provenBy: null,
      builtIn: false,
      pack: recipe.packId,
      campaignIds: recipe.campaignId ? [recipe.campaignId] : [],
      inputs: { kind: 'brief', lockedNodes: [] },
      variants: [],
      repeat: null,
      skipProofForRepeats: false,
      premiumStreak: 0,
      migratedFrom: null,
      revision: 1,
    };
    const write = (change: (t: Template) => Template) => (existing ? updateTemplate(o.root, existing.id, change) : createTemplate(o.root, change(base)));
    let template: Template;

    if (o.asDraft) {
      // A draft accept snapshots the proof but never proves or demotes the template and writes no package.
      // A fork's draft accept leaves its template as it is.
      template = fork && existing ? existing : await write((t) => ({ ...t, name, snapshot }));
      await updateRun(o.root, run.id, (r) => ({ ...r, status: 'done', pausedFor: null, finishedAt: iso }));
      await appendEvent(o.root, run.id, { at: iso, kind: 'run.done', text: 'accepted as draft', data: { templateId: template.id } });
      return { runId: run.id, asDraft: true, verdict, packageIds: [], template, note: null };
    }

    const clean = verdict as 'premium' | 'standard';
    const revision = existing ? existing.revision + 1 : 1;
    const packageIds: string[] = [];
    for (const lang of recipe.languages) {
      const render = s.current[`render:${lang}`];
      const postCopy = s.current[`post-copy:${lang}`];
      if (!render || !postCopy) throw new PostmakerError(409, 'accept-blocked', `The ${lang} version is not made yet.`);
      const langSignoffs = signoffs.filter((x) => x.nodeId.endsWith(`:${lang}`));
      const inheritedHere = [...inherited.entries()].filter(([id]) => id.endsWith(`:${lang}`)).map(([nodeId, so]) => ({ nodeId, fromRecipeId: s.current[nodeId]!.forkedFrom!.recipeId, fromVersion: so.version, fromHash: so.hash }));
      const w = await writePostmakerPackage({ root: o.root, project: o.project, recipe, run, lang, render, postCopy, signoffs: langSignoffs, template: base, variantId, templateName: postName, templateRevision: revision, verdict: clean, by: o.by, now: at, inherited: inheritedHere });
      packageIds.push(w.id);
      await updateRun(o.root, run.id, (r) => ({ ...r, packageIds: [...r.packageIds, w.id] }));
    }
    const runs = [];
    for (const id of await listRunIds(o.root)) {
      const r = await readRun(o.root, id).catch(() => null);
      if (r) runs.push(r);
    }
    const regenerations = countRegenerations(runs.map((r) => (r.id === run.id ? { ...r, packageIds: [] } : r)), run.recipeId, run.id);
    const live = Object.values(s.current).every((v) => !v || v.mode === 'live');
    // A verdict the person gave by hand on an Unscored proof (or a sheet marked manual) is a hard-gate override.
    const read = await readVerdict(o.root, check);
    const override = read.manual || read.verdict === 'unscored';
    // A skip-proof accept is not a proof the person checked: the template (streak, skip proof, proven state)
    // is left as it was; the write only moves the revision the package records.
    template = await write((t) => {
      if (inherited.size || o.inheritGates) return t;
      const next = applyAcceptToTemplate(t, { verdict: clean, live, regenerations, override, variantId, runId: run.id, at: iso, by: o.by, gateHashes: gateHashesOf(s.current), proveTemplate: !fork || t.status !== 'proven' });
      return fork ? next : { ...next, name, snapshot };
    });
    await updateRun(o.root, run.id, (r) => ({ ...r, status: 'done', pausedFor: null, finishedAt: iso }));
    await appendEvent(o.root, run.id, { at: iso, kind: 'run.done', text: 'accepted', data: { packageIds, templateId: template.id, verdict: clean } });
    return { runId: run.id, asDraft: false, verdict: clean, packageIds, template, note: clean === 'standard' ? BELOW_PREMIUM_NOTE : null };
  });
}
