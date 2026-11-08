// Server-only: Instagram post packages.
// Packages live on your machine in <content dir>/<id>/ with package.json (ids: package-id.ts).
// The app approves a package (after re-verifying every file's SHA-256). Posting is either manual
// (you record the link) or, when posting is switched on for the account, a single dispatch through
// Instagram's API (./publish-meta.ts) or Upload-Post (./dispatch.ts). State files are written once ('wx').
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TIMEZONE } from '@/lib/time';
import { GENERATOR_NOT_ALLOWED, contentGeneratorAllowed, featureEnabled } from '@/lib/server/signalConfig';
import { accountSettings, postingActive, currentProject } from './projects';
import { getAccount, getMedia, instagramApiAllowed, listMedia, shortcode, type IgMedia } from './meta';
import type { AutopilotMark } from './autopilot/types';
import { comparePackageIds, packageIdOk } from './package-id';

/** Posting limits for the current project's Instagram account, from its posting settings (accounts.json). */
export interface Limits { open: boolean; reason: string; expiresAt: number; maxPosts: number; maxPerDay: number; dispatch: boolean; codex: boolean }
export async function currentLimits(now = Date.now()): Promise<Limits> {
  const p = currentProject();
  const a = await accountSettings(p.id);
  const ended = a?.ends_at ? Date.parse(a.ends_at) : 0;
  if (!postingActive(a, now))
    return { open: false, reason: ended ? `The posting period for ${p.handle} has ended. Set the account limits again.` : `Set the posting limits for ${p.handle} first (Projects → account settings).`, expiresAt: ended, maxPosts: 0, maxPerDay: 0, dispatch: false, codex: false };
  return { open: true, reason: '', expiresAt: a.ends_at ? Date.parse(a.ends_at) : Number.POSITIVE_INFINITY, maxPosts: a.max_posts, maxPerDay: a.max_per_day, dispatch: a.posting, codex: a.codex_images };
}

const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpg|jpeg|mp4|txt)$/i;
const POST_URL_RE = /^https:\/\/(www\.)?instagram\.com\/(p|reel)\/[A-Za-z0-9_-]{5,40}\/?(\?[^\s]*)?$/;

export type FileRole = 'slide' | 'video' | 'cover' | 'caption';
export interface PackageFile { name: string; role: FileRole; sha256: string }
export interface PackageSpec {
  id: string;
  title: string;
  format: 'carousel' | 'image' | 'reel';
  destination: string;
  /** Free label kept for older packages; not checked. */
  experiment?: string;
  files: PackageFile[];
  notes?: string[];
  source?: {
    generator: string;
    format: string;
    category: string;
    items: string[];
    distractors: { category: string; itemId: string }[];
    levels: number[];
    seed: string;
    codex?: { cli: string; seconds: number; prompt: string };
    /** Set by the Higgsfield formats: models, request ids, wall time and the estimated spend. */
    higgsfield?: HiggsfieldSource;
  };
}
export interface HiggsfieldSource {
  imageModel: string;
  videoModel: string | null;
  imageRequestId: string;
  videoRequestId: string | null;
  prompt: string;
  videoPrompt: string | null;
  videoSeconds: number | null;
  seconds: number;
  estimatedCostUsd: number;
}
export interface Approval { approved_by: string; approved_at: string; hashes: Record<string, string> }
export interface Posted {
  url: string | null;
  posted_at: string;
  ai_label_confirmed: boolean;
  recorded_by: string;
  via?: 'manual' | 'upload-post' | 'meta';
  request_id?: string;
  media_id?: string;
}
export interface Dispatch { request_id: string; idempotency_key: string; claimed_at: string; claimed_by: string; provider: 'upload-post' | 'meta'; hashes: Record<string, string> }
export interface Outcome { state: 'submitted' | 'uncertain' | 'failed' | 'scheduled'; at: string; message?: string; resolved_by?: string }
export interface LabelCheck { confirmed_by: string; confirmed_at: string }
export type PackageStatus = 'ready' | 'changed' | 'approved' | 'scheduled' | 'sending' | 'submitted' | 'uncertain' | 'failed' | 'posted' | 'discarded' | 'invalid';
/** Statuses that hold a post slot: something may be (or may become) live on Instagram. */
export const IN_FLIGHT: PackageStatus[] = ['sending', 'submitted', 'uncertain'];
/** Statuses that will (or may) become a post: they count toward the per-day and total limits. */
export const COMMITTED: PackageStatus[] = ['scheduled', 'sending', 'submitted', 'uncertain'];
export interface PackageView {
  id: string;
  title: string;
  format: PackageSpec['format'];
  destination: string;
  status: PackageStatus;
  problems: string[];
  caption: string;
  files: (PackageFile & { ok: boolean })[];
  approval: Approval | null;
  posted: Posted | null;
  dispatch: Dispatch | null;
  outcome: Outcome | null;
  labelConfirmed: boolean;
  source: PackageSpec['source'] | null;
  plannedFor: string | null;
  metrics: { fetched_at: string; metrics: { views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null } | null; error?: string } | null;
  /** provider 'signal': Signal sends it itself at the time; otherwise Upload-Post holds it. */
  scheduled: { job_id: string; scheduled_for: string; provider?: 'upload-post' | 'signal' } | null;
  /** Set when a Signal schedule passed while the app was off; you decide what to do. */
  missedAt: string | null;
  missedReason: string | null;
  /** Set when the post was made from a campaign plan. */
  campaign: { id: string; name: string; slot: string } | null;
  /** Set when autopilot made the post: <package>/autopilot.json. */
  autopilot: AutopilotMark | null;
  /** Set when a pipeline made the post: <package>/pipeline.json. */
  pipeline: { id: string; name: string; slotAt: string; article: string | null } | null;
  /** Set when Post maker made the post: <package>/postmaker.json, for the origin line. */
  postmaker?: { template: string; version: number; recipeId: string; runId: string; lang: string; verdict: string | null } | null;
  /** State files in the folder that are not valid JSON (the package is then 'invalid' and names them in `problems`). */
  unreadable?: string[];
}

export function contentDir(): string {
  return currentProject().contentDir;
}

/** A package folder name: 00-99, then 100-99999 (see package-id.ts). */
export function isPackageId(id: string): boolean {
  return packageIdOk(id);
}

function pkgDir(id: string): string {
  if (!isPackageId(id)) throw new ContentError(400, 'Unknown package.');
  return path.join(contentDir(), id);
}

export class ContentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ContentError(500, `Could not read ${path.basename(file)}.`);
  }
}

/**
 * State files that say whether something was (or may be) sent. When one of them cannot be read,
 * Signal cannot tell what happened, so the package is 'invalid' and cannot be discarded either.
 */
const SENDING_STATE = ['posted.json', 'dispatch.json', 'outcome.json', 'scheduled.json', 'discarded.json'];

/** Like readJson, but a file that is not valid JSON is noted in `unreadable` (and read as absent) instead of failing the whole package. */
async function readState<T>(dir: string, name: string, unreadable: string[]): Promise<T | null> {
  try {
    return await readJson<T>(path.join(dir, name));
  } catch (e) {
    if (e instanceof ContentError) {
      unreadable.push(name);
      return null;
    }
    throw e;
  }
}

export function pkgPath(id: string, name: string): string {
  return path.join(pkgDir(id), name);
}

export async function writeJsonReplace(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function writeJsonExclusive(file: string, data: unknown): Promise<void> {
  // 'wx' fails if the file exists: an approval or post record can be written once only.
  try {
    await fs.writeFile(/* turbopackIgnore: true */ file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ContentError(409, 'This has already been recorded.');
    throw e;
  }
}

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(/* turbopackIgnore: true */ file)).digest('hex');
}

function validSpec(spec: PackageSpec | null, id: string): string[] {
  if (!spec) return ['package.json is missing.'];
  const p: string[] = [];
  if (spec.id !== id) p.push('package.json id does not match its folder.');
  const dest = currentProject().handle;
  if (spec.destination !== dest) p.push(`Destination must be ${dest}.`);
  if (!Array.isArray(spec.files) || spec.files.length === 0) p.push('No files listed.');
  else {
    for (const f of spec.files) if (!FILE_RE.test(f?.name ?? '') || !/^[0-9a-f]{64}$/.test(f?.sha256 ?? '')) p.push(`Bad file entry: ${String(f?.name)}`);
    if (spec.files.filter((f) => f.role === 'caption').length !== 1) p.push('Exactly one caption file is required.');
  }
  return p;
}

export async function loadPackage(id: string): Promise<PackageView> {
  const dir = pkgDir(id);
  // One broken JSON file makes this package 'invalid' (named in problems); it never fails the whole list.
  const unreadable: string[] = [];
  const spec = await readState<PackageSpec>(dir, 'package.json', unreadable);
  const problems = unreadable.length ? ['package.json could not be read (damaged or not valid JSON).'] : validSpec(spec, id);
  const files: PackageView['files'] = [];
  const actual = new Map<string, string | null>();
  let caption = '';
  const specOk = Boolean(spec) && problems.length === 0;
  if (spec && specOk) {
    for (const f of spec.files) {
      let ok = false;
      try {
        const h = await sha256File(path.join(dir, f.name));
        actual.set(f.name, h);
        ok = h === f.sha256;
      } catch {
        actual.set(f.name, null);
        ok = false;
      }
      if (!ok) problems.push(`${f.name} changed or is missing since the package was made.`);
      files.push({ ...f, ok });
      if (f.role === 'caption') caption = await fs.readFile(/* turbopackIgnore: true */ path.join(dir, f.name), 'utf8').catch(() => '');
    }
  }
  const approval = await readState<Approval>(dir, 'approval.json', unreadable);
  const posted = await readState<Posted>(dir, 'posted.json', unreadable);
  const dispatch = await readState<Dispatch>(dir, 'dispatch.json', unreadable);
  const outcome = await readState<Outcome>(dir, 'outcome.json', unreadable);
  const label = await readState<LabelCheck>(dir, 'label.json', unreadable);
  const discarded = await readState<{ discarded_by: string; discarded_at: string }>(dir, 'discarded.json', unreadable);
  const plan = await readState<{ planned_for: string | null; missed_at?: string; missed_reason?: string }>(dir, 'plan.json', unreadable);
  const metrics = await readState<PackageView['metrics']>(dir, 'metrics.json', unreadable);
  const camp = await readState<{ campaign: string; campaign_name?: string; slot: string }>(dir, 'campaign.json', unreadable);
  const scheduled = await readState<{ job_id: string; scheduled_for: string; provider?: 'upload-post' | 'signal' }>(dir, 'scheduled.json', unreadable);
  const autopilot = await readJson<AutopilotMark>(path.join(dir, 'autopilot.json')).catch(() => null);
  const pipe = await readJson<{ pipeline: string; name?: string; slotAt: string; idea?: { articleUrl?: string } }>(path.join(dir, 'pipeline.json')).catch(() => null);
  const mark = await readState<PostmakerMarkFile>(dir, 'postmaker.json', unreadable);
  if (mark && spec && specOk) problems.push(...postmakerProblems(mark, spec, actual));
  // A Post maker package can be approved and sent only while the postmaker switch is on.
  if ((mark || spec?.source?.generator === PM_GENERATOR) && !(await featureEnabled('postmaker'))) problems.push(`${PM_SWITCH_OFF}.`);
  if (approval && spec) {
    for (const f of spec.files) if (approval.hashes?.[f.name] !== f.sha256) problems.push(`Approval does not cover the current ${f.name}.`);
  }
  for (const name of unreadable) if (name !== 'package.json') problems.push(`${name} could not be read (damaged or not valid JSON).`);
  const unsure = unreadable.some((n) => SENDING_STATE.includes(n));
  // A discard wins over a broken package.json and over a definite failure (nothing was posted), never over a post.
  const failed = outcome?.state === 'failed';
  let status: PackageStatus;
  if (unsure) status = 'invalid';
  else if (discarded && !posted && (!dispatch || failed)) status = 'discarded';
  else if (!spec || validSpec(spec, id).length) status = 'invalid';
  else if (posted) status = 'posted';
  else if (unreadable.length) status = 'invalid';
  else if (outcome) status = outcome.state;
  else if (dispatch) status = 'sending';
  else if (problems.length) status = 'changed';
  else if (approval && scheduled?.provider === 'signal') status = 'scheduled';
  else if (approval) status = 'approved';
  else status = 'ready';
  return {
    id,
    title: spec?.title ?? `Post ${id}`,
    format: spec?.format ?? 'image',
    destination: spec?.destination ?? '',
    status,
    problems,
    caption,
    files,
    approval,
    posted,
    dispatch,
    outcome,
    labelConfirmed: Boolean(label) || posted?.ai_label_confirmed === true,
    source: spec?.source ?? null,
    plannedFor: plan?.planned_for ?? null,
    metrics: metrics ?? null,
    scheduled: scheduled ?? null,
    missedAt: plan?.missed_at ?? null,
    missedReason: plan?.missed_reason ?? null,
    campaign: camp ? { id: camp.campaign, name: camp.campaign_name ?? camp.campaign, slot: camp.slot } : null,
    autopilot: autopilot && typeof autopilot === 'object' && typeof autopilot.run === 'string' ? autopilot : null,
    postmaker: postmakerOrigin(mark),
    pipeline: pipe && typeof pipe === 'object' && typeof pipe.pipeline === 'string' && typeof pipe.slotAt === 'string' ? { id: pipe.pipeline, name: typeof pipe.name === 'string' ? pipe.name : pipe.pipeline, slotAt: pipe.slotAt, article: typeof pipe.idea?.articleUrl === 'string' ? pipe.idea.articleUrl : null } : null,
    ...(unreadable.length ? { unreadable } : {}),
  };
}

// ---- Post maker lineage lock ---------------------------------------------------------------------------------------

export const PM_RECORD_MISMATCH = 'Post maker record does not match this video';
export const PM_MOCK_STEPS = 'Made with mock steps';
export const PM_SWITCH_OFF = 'Post maker is off in Connections';
/** `source.generator` of a Post maker package (the name an optional contentGenerators list uses). */
export const PM_GENERATOR = 'postmaker';
/** Why autopilot leaves a Post maker post in Review: only you approve one. */
export const PM_OWNER_APPROVES = 'A Post maker post is approved by you, never by autopilot.';

/** The fields of postmaker.json this module reads (the full shape is PostmakerMark in postmaker/types.ts). */
interface PostmakerMarkFile {
  schema?: unknown;
  recipeId?: unknown;
  runId?: unknown;
  lang?: unknown;
  files?: Record<string, { sha256?: unknown }>;
  modes?: { live?: unknown; mock?: unknown };
  template?: { name?: unknown; version?: unknown } | null;
  verdict?: unknown;
}

/**
 * A Post maker package must match its record: every package file is listed with the same sha256 the file has now,
 * and no step was a mock. Either problem makes the package `changed`, so approval is refused.
 */
function postmakerProblems(mark: PostmakerMarkFile, spec: PackageSpec, actual: Map<string, string | null>): string[] {
  const out: string[] = [];
  const files = mark.files && typeof mark.files === 'object' ? mark.files : {};
  const names = new Set(spec.files.map((f) => f.name));
  const mismatch =
    mark.schema !== 'signal.pm.mark/1' ||
    spec.files.some((f) => typeof files[f.name]?.sha256 !== 'string' || files[f.name]!.sha256 !== actual.get(f.name) || files[f.name]!.sha256 !== f.sha256) ||
    Object.keys(files).some((n) => !names.has(n));
  if (mismatch) out.push(`${PM_RECORD_MISMATCH}.`);
  const mock = mark.modes?.mock;
  if (typeof mock !== 'number' || mock > 0) out.push(`${PM_MOCK_STEPS}.`);
  return out;
}

function postmakerOrigin(mark: PostmakerMarkFile | null): PackageView['postmaker'] {
  if (!mark || typeof mark !== 'object') return null;
  const t = mark.template && typeof mark.template === 'object' ? mark.template : null;
  return {
    template: typeof t?.name === 'string' ? t.name : 'Post maker',
    version: typeof t?.version === 'number' ? t.version : 1,
    recipeId: typeof mark.recipeId === 'string' ? mark.recipeId : '',
    runId: typeof mark.runId === 'string' ? mark.runId : '',
    lang: typeof mark.lang === 'string' ? mark.lang : '',
    verdict: typeof mark.verdict === 'string' ? mark.verdict : null,
  };
}

export { GENERATOR_NOT_ALLOWED };

/** True when a package of this generator may be approved (signal.config.json "contentGenerators"; absent = all). */
export async function generatorAllowed(generator: string | null | undefined): Promise<boolean> {
  return contentGeneratorAllowed(generator);
}

export async function listPackages(): Promise<PackageView[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/* turbopackIgnore: true */ contentDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && isPackageId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  // One package that cannot be read at all never hides the others: it is listed as 'invalid'.
  return Promise.all(names.sort(comparePackageIds).map((id) => loadPackage(id).catch((e: unknown) => unreadableView(id, e))));
}

function unreadableView(id: string, e: unknown): PackageView {
  return {
    id,
    title: `Post ${id}`,
    format: 'image',
    destination: '',
    status: 'invalid',
    problems: [e instanceof ContentError ? e.message : `Post ${id} could not be read.`],
    caption: '',
    files: [],
    approval: null,
    posted: null,
    dispatch: null,
    outcome: null,
    labelConfirmed: false,
    source: null,
    plannedFor: null,
    metrics: null,
    scheduled: null,
    missedAt: null,
    missedReason: null,
    campaign: null,
    autopilot: null,
    pipeline: null,
    // Signal cannot tell what this package's state is, so it is not discardable either.
    unreadable: ['package folder'],
  };
}

function dayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** Checks the account limits before an approval. Throws ContentError when blocked. */
export function assertCanApprove(all: PackageView[], now: number, lim: Limits): void {
  if (!lim.open) throw new ContentError(403, lim.reason);
  const committed = all.filter((p) => p.posted || COMMITTED.includes(p.status));
  if (committed.length >= lim.maxPosts) throw new ContentError(403, `The limit of ${lim.maxPosts} posts for this account is reached (posted and scheduled).`);
  const unclear = all.filter((p) => p.status === 'uncertain');
  if (unclear.length) throw new ContentError(409, `Post ${unclear[0]!.id} has an unclear result. Resolve it first.`);
  const unlabelled = all.filter((p) => p.posted && !p.labelConfirmed);
  if (unlabelled.length) throw new ContentError(409, `Check that post ${unlabelled[0]!.id} shows Instagram's AI label, then confirm it.`);
}

/** The AI-label canary: nothing more is sent or scheduled while a posted package's AI label is unconfirmed. */
export function assertNoUnlabelled(all: PackageView[], exceptId?: string): void {
  const u = all.find((p) => p.id !== exceptId && p.posted && !p.labelConfirmed);
  if (u) throw new ContentError(409, `Check that post ${u.id} shows Instagram's AI label, then confirm it. Nothing more goes out until then.`);
}

/**
 * When a committed package goes (or went) out: the posted time; the scheduled time while it is
 * scheduled or in flight from a schedule (an Upload-Post schedule that is processing still belongs to
 * its scheduled day); otherwise the time it was sent. Null when it is not committed.
 */
export function goesOutAt(p: PackageView): string | null {
  if (p.posted) return p.posted.posted_at;
  if (p.scheduled && (p.status === 'scheduled' || IN_FLIGHT.includes(p.status))) return p.scheduled.scheduled_for;
  if (IN_FLIGHT.includes(p.status) && p.dispatch) return p.dispatch.claimed_at;
  return null;
}

/** The calendar day a package goes (or went) out on, if it is committed. */
function goesOutOn(p: PackageView): string | null {
  const at = goesOutAt(p);
  return at ? dayKey(Date.parse(at)) : null;
}

/** Posts per calendar day (Studio time zone) on the target day, counting posted, scheduled and in-flight packages. */
export function assertDayCapacity(all: PackageView[], targetMs: number, lim: Limits, excludeId?: string): void {
  const day = dayKey(targetMs);
  const used = all.filter((p) => p.id !== excludeId && goesOutOn(p) === day).length;
  if (used >= lim.maxPerDay)
    throw new ContentError(403, lim.maxPerDay === 1 ? `There is already a post on ${day}. The limit is one post per day.` : `${day} already has ${lim.maxPerDay} posts.`);
  const total = all.filter((p) => p.id !== excludeId && (p.posted || COMMITTED.includes(p.status))).length;
  if (total >= lim.maxPosts) throw new ContentError(403, `The limit of ${lim.maxPosts} posts for this account is reached.`);
  if (targetMs > lim.expiresAt) throw new ContentError(403, 'That day is after this account’s posting period ends. Extend it in the account settings first.');
}

export async function approvePackage(id: string, approver: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (pkg.status === 'approved' || pkg.status === 'posted') throw new ContentError(409, `Post ${id} is already ${pkg.status}.`);
  if (pkg.status !== 'ready') throw new ContentError(409, pkg.problems[0] ?? `Post ${id} is ${pkg.status}, not ready to approve.`);
  assertCanApprove(await listPackages(), now, await currentLimits(now));
  if (!(await generatorAllowed(pkg.source?.generator))) throw new ContentError(409, GENERATOR_NOT_ALLOWED);
  const hashes = Object.fromEntries(pkg.files.map((f) => [f.name, f.sha256]));
  await writeJsonExclusive(path.join(pkgDir(id), 'approval.json'), { approved_by: approver, approved_at: new Date(now).toISOString(), hashes } satisfies Approval);
  return loadPackage(id);
}

export function isInstagramPostUrl(url: string): boolean {
  return POST_URL_RE.test(url.trim());
}

export async function recordPosted(id: string, url: string, aiLabel: boolean, by: string, now = Date.now()): Promise<PackageView> {
  if (!isInstagramPostUrl(url)) throw new ContentError(400, 'Paste the Instagram post link, like https://www.instagram.com/p/…');
  if (!aiLabel) throw new ContentError(400, 'Confirm the Instagram AI label is on before recording the post.');
  const pkg = await loadPackage(id);
  if (pkg.status === 'posted') throw new ContentError(409, `Post ${id} is already recorded as posted.`);
  if (pkg.status !== 'approved') throw new ContentError(409, pkg.problems[0] ?? `Post ${id} must be approved first.`);
  await writeJsonExclusive(path.join(pkgDir(id), 'posted.json'), { url: url.trim(), posted_at: new Date(now).toISOString(), ai_label_confirmed: true, recorded_by: by, via: 'manual' } satisfies Posted);
  return loadPackage(id);
}

/** What was known when you confirmed the AI label, stored in label.json. */
export interface LabelEvidence {
  permalink: string | null;
  media_id: string | null;
  /** Instagram's is_ai_generated flag as read from its API; null when it was not read. */
  ai_label: boolean | null;
  ai_label_source: 'instagram-api' | null;
  read_at: string | null;
  read_error?: string;
  /** SHA-256 of the posted slides, video and cover. */
  hashes: Record<string, string>;
}

/** Reads the post from Instagram's API when it is set up for this account; never fails the confirmation. */
async function labelEvidence(pkg: PackageView, now: number, f: typeof fetch): Promise<LabelEvidence> {
  const posted = pkg.posted!;
  const ev: LabelEvidence = {
    permalink: posted.url ?? null,
    media_id: posted.media_id ?? null,
    ai_label: null,
    ai_label_source: null,
    read_at: null,
    hashes: Object.fromEntries(pkg.files.filter((x) => x.role !== 'caption').map((x) => [x.name, x.sha256])),
  };
  if (!(ev.media_id || shortcode(ev.permalink)) || !(await instagramApiAllowed().catch(() => ({ enabled: false }))).enabled) return ev;
  try {
    let media: IgMedia | null = null;
    if (ev.media_id) media = await getMedia(ev.media_id, f);
    else {
      const code = shortcode(ev.permalink);
      media = (await listMedia((await getAccount(f)).userId, 50, f)).find((m) => shortcode(m.permalink) === code) ?? null;
    }
    ev.read_at = new Date(now).toISOString();
    if (!media) ev.read_error = 'Not found among the latest 50 Instagram posts.';
    else Object.assign(ev, { media_id: media.id || ev.media_id, permalink: media.permalink ?? ev.permalink, ai_label: media.aiLabel, ai_label_source: media.aiLabel === null ? null : 'instagram-api' });
  } catch (e) {
    ev.read_at = new Date(now).toISOString();
    ev.read_error = (e as Error).message.slice(0, 160);
  }
  return ev;
}

/** You confirm Instagram's AI label is visible on an automatically posted package. */
export async function confirmLabel(id: string, by: string, now = Date.now(), deps: { fetch?: typeof fetch } = {}): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (pkg.status !== 'posted') throw new ContentError(409, `Post ${id} is not posted.`);
  if (pkg.labelConfirmed) throw new ContentError(409, 'Already confirmed.');
  const evidence = await labelEvidence(pkg, now, deps.fetch ?? fetch);
  await writeJsonExclusive(path.join(pkgDir(id), 'label.json'), { confirmed_by: by, confirmed_at: new Date(now).toISOString(), evidence } satisfies LabelCheck & { evidence: LabelEvidence });
  return loadPackage(id);
}

/** "<project id>-post-<package id>-<file>": names the account the file belongs to, never a fixed prefix. */
export function downloadName(projectId: string, id: string, name: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'signal';
  return `${slug}-post-${id}-${name}`;
}

export async function readPackageFile(id: string, name: string): Promise<{ body: Buffer; type: string }> {
  const pkg = await loadPackage(id);
  const f = pkg.files.find((x) => x.name === name);
  if (!f) throw new ContentError(404, 'Not found.');
  const ext = name.split('.').pop()!.toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'mp4' ? 'video/mp4' : ext === 'txt' ? 'text/plain; charset=utf-8' : 'image/jpeg';
  return { body: await fs.readFile(/* turbopackIgnore: true */ path.join(pkgDir(id), name)), type };
}

/** Whether a package may be rejected: nothing posted, nothing on its way and nothing scheduled. */
export function discardBlock(pkg: PackageView): string | null {
  const id = pkg.id;
  if (pkg.posted) return `Post ${id} is posted and cannot be discarded.`;
  if (pkg.status === 'invalid') {
    const unsure = (pkg.unreadable ?? []).filter((n) => SENDING_STATE.includes(n) || n === 'package folder');
    if (unsure.length) return `Post ${id} has a file Signal cannot read (${unsure.join(', ')}), so it cannot tell whether the post was sent. Fix the file first.`;
    if (pkg.scheduled) return `Post ${id} is scheduled. Cancel the schedule first.`;
    if (pkg.dispatch && pkg.outcome?.state !== 'failed') return `Post ${id} was sent and its result is not known. Check its status first.`;
    return null;
  }
  // A definite failure (Upload-Post or Instagram refused it, or you checked: not posted) may be rejected.
  if (['ready', 'changed', 'approved', 'failed'].includes(pkg.status)) return null;
  return `Post ${id} is ${pkg.status} and cannot be discarded.`;
}

/** Hides a package that will not be posted. Nothing is deleted; discarded.json records the decision. */
export async function discardPackage(id: string, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  const block = discardBlock(pkg);
  if (block) throw new ContentError(409, block);
  await writeJsonExclusive(path.join(pkgDir(id), 'discarded.json'), { discarded_by: by, discarded_at: new Date(now).toISOString() });
  return loadPackage(id);
}

/** Plans (or clears) the day and time a package should go out. Planning never posts anything. */
export async function setPlan(id: string, plannedFor: string | null, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (['posted', 'discarded', 'sending', 'submitted', 'uncertain', 'scheduled'].includes(pkg.status))
    throw new ContentError(409, pkg.status === 'scheduled' ? `Post ${id} is scheduled on Upload-Post; move it from the Calendar or cancel the schedule.` : `Post ${id} is ${pkg.status}; its date can't be changed.`);
  if (plannedFor !== null) {
    const t = Date.parse(plannedFor);
    if (!Number.isFinite(t)) throw new ContentError(400, 'Pick a valid date and time.');
    if (t < now - 5 * 60_000) throw new ContentError(400, 'Pick a time in the future.');
  }
  await writeJsonReplace(path.join(pkgDir(id), 'plan.json'), { planned_for: plannedFor ? new Date(plannedFor).toISOString() : null, planned_by: by, planned_at: new Date(now).toISOString() });
  return loadPackage(id);
}

