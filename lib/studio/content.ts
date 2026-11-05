// Server-only: Instagram post packages.
// Packages live on your machine in <content dir>/<NN>/ with package.json.
// The app approves a package (after re-verifying every file's SHA-256). Posting is either manual
// (you record the link) or, when posting is switched on for the account, a single dispatch through
// Instagram's API (./publish-meta.ts) or Upload-Post (./dispatch.ts). State files are written once ('wx').
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TIMEZONE } from '@/lib/time';
import { accountSettings, postingActive, currentProject } from './projects';
import type { AutopilotMark } from './autopilot/types';

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

const ID_RE = /^\d{2}$/;
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
}

export function contentDir(): string {
  return currentProject().contentDir;
}

export function isPackageId(id: string): boolean {
  return ID_RE.test(id);
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
  const spec = await readJson<PackageSpec>(path.join(dir, 'package.json'));
  const problems = validSpec(spec, id);
  const files: PackageView['files'] = [];
  let caption = '';
  if (spec && problems.length === 0) {
    for (const f of spec.files) {
      let ok = false;
      try {
        ok = (await sha256File(path.join(dir, f.name))) === f.sha256;
      } catch {
        ok = false;
      }
      if (!ok) problems.push(`${f.name} changed or is missing since the package was made.`);
      files.push({ ...f, ok });
      if (f.role === 'caption') caption = await fs.readFile(/* turbopackIgnore: true */ path.join(dir, f.name), 'utf8').catch(() => '');
    }
  }
  const approval = await readJson<Approval>(path.join(dir, 'approval.json'));
  const posted = await readJson<Posted>(path.join(dir, 'posted.json'));
  const dispatch = await readJson<Dispatch>(path.join(dir, 'dispatch.json'));
  const outcome = await readJson<Outcome>(path.join(dir, 'outcome.json'));
  const label = await readJson<LabelCheck>(path.join(dir, 'label.json'));
  const discarded = await readJson<{ discarded_by: string; discarded_at: string }>(path.join(dir, 'discarded.json'));
  const plan = await readJson<{ planned_for: string | null; missed_at?: string; missed_reason?: string }>(path.join(dir, 'plan.json'));
  const metrics = await readJson<PackageView['metrics']>(path.join(dir, 'metrics.json'));
  const camp = await readJson<{ campaign: string; campaign_name?: string; slot: string }>(path.join(dir, 'campaign.json'));
  const scheduled = await readJson<{ job_id: string; scheduled_for: string; provider?: 'upload-post' | 'signal' }>(path.join(dir, 'scheduled.json'));
  const autopilot = await readJson<AutopilotMark>(path.join(dir, 'autopilot.json')).catch(() => null);
  if (approval && spec) {
    for (const f of spec.files) if (approval.hashes?.[f.name] !== f.sha256) problems.push(`Approval does not cover the current ${f.name}.`);
  }
  let status: PackageStatus;
  if (!spec || validSpec(spec, id).length) status = 'invalid';
  else if (posted) status = 'posted';
  else if (discarded && !dispatch) status = 'discarded';
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
  };
}

export async function listPackages(): Promise<PackageView[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/* turbopackIgnore: true */ contentDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && isPackageId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  return Promise.all(names.sort().map(loadPackage));
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

/** The calendar day a package goes (or went) out on, if it is committed. */
function goesOutOn(p: PackageView): string | null {
  if (p.posted) return dayKey(Date.parse(p.posted.posted_at));
  if (p.status === 'scheduled' && p.scheduled) return dayKey(Date.parse(p.scheduled.scheduled_for));
  if (IN_FLIGHT.includes(p.status) && p.dispatch) return dayKey(Date.parse(p.dispatch.claimed_at));
  return null;
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

/** You confirm Instagram's AI label is visible on an automatically posted package. */
export async function confirmLabel(id: string, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (pkg.status !== 'posted') throw new ContentError(409, `Post ${id} is not posted.`);
  if (pkg.labelConfirmed) throw new ContentError(409, 'Already confirmed.');
  await writeJsonExclusive(path.join(pkgDir(id), 'label.json'), { confirmed_by: by, confirmed_at: new Date(now).toISOString() } satisfies LabelCheck);
  return loadPackage(id);
}

export async function readPackageFile(id: string, name: string): Promise<{ body: Buffer; type: string }> {
  const pkg = await loadPackage(id);
  const f = pkg.files.find((x) => x.name === name);
  if (!f) throw new ContentError(404, 'Not found.');
  const ext = name.split('.').pop()!.toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'mp4' ? 'video/mp4' : ext === 'txt' ? 'text/plain; charset=utf-8' : 'image/jpeg';
  return { body: await fs.readFile(/* turbopackIgnore: true */ path.join(pkgDir(id), name)), type };
}

/** Hides an unapproved package from Review. Nothing is deleted; discarded.json records the decision. */
export async function discardPackage(id: string, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (!['ready', 'changed', 'invalid', 'approved'].includes(pkg.status)) throw new ContentError(409, `Post ${id} is ${pkg.status} and cannot be discarded.`);
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

