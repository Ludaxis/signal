// Server-only: Studio projects (one Instagram account each) and their posting settings.
//
// A project = name + Instagram handle + optional Upload-Post profile + content folder.
// Projects live in <SIGNAL_DATA_DIR>/projects.json (no secrets). Posting settings per account
// (the one-click posting switch, posts per day, total posts, optional end date) live in
// <SIGNAL_DATA_DIR>/accounts.json and are set in the app after typing the handle to confirm.
// The current request's project is carried in AsyncLocalStorage, so content/dispatch/generate code
// works per project without threading a parameter through every call.
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '@/lib/server/signalConfig';

export interface Project {
  id: string;
  name: string;
  handle: string; // e.g. "@yourbrand"
  uploadPostProfile: string; // Upload-Post profile *username* (optional)
  contentDir: string;
  createdAt: string;
}

/** Posting settings for one account. `endsAt` null = no end date; nothing posts automatically unless `posting` is on. */
export interface AccountSettings {
  project: string;
  handle: string;
  profile: string;
  enabled_at: string;
  enabled_by: string;
  ends_at: string | null;
  max_posts: number;
  max_per_day: number;
  posting: boolean; // one-click / scheduled posting through Instagram's API or Upload-Post
  codex_images: boolean; // Codex CLI images when you press Generate
  verified?: { at: string; instagram: string | null };
  posting_changed?: { at: string; by: string }; // last time the posting switch was flipped from Connections
}

export class ProjectError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const home = () => os.homedir();
export const projectsFile = () => process.env.SIGNAL_PROJECTS_FILE || path.join(dataDir(), 'projects.json');
export const accountsFile = () => process.env.SIGNAL_ACCOUNTS_FILE || path.join(dataDir(), 'accounts.json');
/** Optional folder with prompt overrides: agents/_shared.md and agents/<role>/prompt.md. */
export const promptsDir = () => process.env.SIGNAL_PROMPTS_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'agents');

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const HANDLE_RE = /^@[A-Za-z0-9._]{1,30}$/;
const PROFILE_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

/**
 * Single-project mode without the wizard: point SIGNAL_CONTENT_DIR at a posts folder
 * (SIGNAL_PROJECT_ID, SIGNAL_PROJECT_NAME and SIGNAL_PROJECT_HANDLE are optional). Used when projects.json is absent.
 */
export function envProject(): Project | null {
  const contentDir = process.env.SIGNAL_CONTENT_DIR;
  if (!contentDir) return null;
  const id = (process.env.SIGNAL_PROJECT_ID || 'default').trim();
  return {
    id: SLUG_RE.test(id) ? id : 'default',
    name: (process.env.SIGNAL_PROJECT_NAME || 'My brand').trim(),
    handle: normaliseHandle(process.env.SIGNAL_PROJECT_HANDLE || '@mybrand'),
    uploadPostProfile: process.env.UPLOAD_POST_PROFILE || '',
    contentDir: expand(contentDir),
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

async function readProjectsFile(): Promise<Project[] | null> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ projectsFile(), 'utf8')) as { projects?: Project[] };
    return Array.isArray(j.projects) ? j.projects : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProjectError(500, `${path.basename(projectsFile())} is not readable.`);
  }
}

export async function listProjects(): Promise<Project[]> {
  const fromFile = await readProjectsFile();
  if (fromFile) return fromFile;
  const env = envProject();
  return env ? [env] : [];
}

export async function getProject(id: string | null | undefined): Promise<Project> {
  const all = await listProjects();
  const p = id ? all.find((x) => x.id === id) : all[0];
  if (!p) throw new ProjectError(404, all.length ? 'Unknown project.' : 'Create a project first.');
  return p;
}

const expand = (p: string) => (p.startsWith('~/') ? path.join(/* turbopackIgnore: true */ home(), p.slice(2)) : p);

export interface NewProject { name: string; id?: string; handle: string; uploadPostProfile: string; contentDir?: string }

/** Validates the wizard input and returns problems per field (empty when valid). */
export async function checkNewProject(input: NewProject): Promise<Record<string, string>> {
  const errs: Record<string, string> = {};
  const all = await listProjects();
  const id = (input.id || slugify(input.name)).trim();
  if (!input.name?.trim() || input.name.length > 60) errs.name = 'Give the project a name (up to 60 characters).';
  if (!SLUG_RE.test(id)) errs.id = 'Use lowercase letters, numbers and dashes.';
  else if (all.some((p) => p.id === id)) errs.id = 'A project with this id already exists.';
  const handle = normaliseHandle(input.handle);
  if (!HANDLE_RE.test(handle)) errs.handle = 'Enter the Instagram handle, like @yourbrand.';
  else if (all.some((p) => p.handle.toLowerCase() === handle.toLowerCase())) errs.handle = 'This Instagram account is already a project.';
  // Upload-Post is optional: without a profile the project posts through Instagram's API (Meta).
  if (input.uploadPostProfile && !PROFILE_RE.test(input.uploadPostProfile)) errs.uploadPostProfile = 'Enter the profile username from Upload-Post → Manage Users.';
  if (input.contentDir) {
    const c = expand(input.contentDir);
    if (!path.isAbsolute(c)) errs.contentDir = 'Use a full folder path.';
  }
  return errs;
}

export function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
export const normaliseHandle = (h: string) => {
  const t = (h ?? '').trim().replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '');
  return t.startsWith('@') ? t : `@${t}`;
};

/** Default posts folder for a new project: <SIGNAL_DATA_DIR>/projects/<id>/posts. */
export const defaultContentDir = (id: string) => path.join(dataDir(), 'projects', id, 'posts');

export async function createProject(input: NewProject): Promise<Project> {
  const errs = await checkNewProject(input);
  if (Object.keys(errs).length) throw new ProjectError(400, Object.values(errs)[0]!);
  const id = (input.id || slugify(input.name)).trim();
  const contentDir = input.contentDir ? path.resolve(expand(input.contentDir)) : defaultContentDir(id);
  const project: Project = {
    id,
    name: input.name.trim(),
    handle: normaliseHandle(input.handle),
    uploadPostProfile: (input.uploadPostProfile ?? '').trim(),
    contentDir,
    createdAt: new Date().toISOString(),
  };
  const all = await listProjects();
  await fs.mkdir(/* turbopackIgnore: true */ contentDir, { recursive: true });
  await writeJson(projectsFile(), { projects: [...all, project] });
  return project;
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

// ---- account posting settings ----------------------------------------------------------------
interface AccountsFile { accounts: AccountSettings[] }

async function readAccounts(): Promise<AccountsFile> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ accountsFile(), 'utf8')) as Partial<AccountsFile>;
    return { accounts: Array.isArray(j.accounts) ? j.accounts : [] };
  } catch {
    return { accounts: [] };
  }
}

export async function accountSettings(projectId: string): Promise<AccountSettings | null> {
  return (await readAccounts()).accounts.find((a) => a.project === projectId) ?? null;
}

/** Posting is set up and (when an end date is set) not past it. */
export function postingActive(a: AccountSettings | null, now = Date.now()): a is AccountSettings {
  return Boolean(a && (a.ends_at === null || Date.parse(a.ends_at) > now));
}

export const LIMITS = { days: { min: 0, max: 365 }, maxPosts: { min: 1, max: 1000 }, maxPerDay: { min: 1, max: 10 } } as const;

export interface AccountInput { confirmHandle: string; days: number; maxPosts: number; maxPerDay: number; posting: boolean; codexImages: boolean }

/** Sets the posting limits for an account from the app: typed handle confirmation, limits, optional end date (days = 0: none). */
export async function setAccountSettings(project: Project, input: AccountInput, by: string, now = Date.now()): Promise<AccountSettings> {
  if (normaliseHandle(input.confirmHandle).toLowerCase() !== project.handle.toLowerCase()) throw new ProjectError(400, `Type ${project.handle} exactly to confirm.`);
  const days = Math.round(Number(input.days));
  if (!(days >= LIMITS.days.min && days <= LIMITS.days.max)) throw new ProjectError(400, `Days must be ${LIMITS.days.min}–${LIMITS.days.max} (0 = no end date).`);
  if (!(input.maxPosts >= LIMITS.maxPosts.min && input.maxPosts <= LIMITS.maxPosts.max)) throw new ProjectError(400, `Maximum posts must be ${LIMITS.maxPosts.min}–${LIMITS.maxPosts.max}.`);
  if (!(input.maxPerDay >= LIMITS.maxPerDay.min && input.maxPerDay <= LIMITS.maxPerDay.max)) throw new ProjectError(400, `Posts per day must be ${LIMITS.maxPerDay.min}–${LIMITS.maxPerDay.max}.`);
  const stamp = new Date(now).toISOString();
  const settings: AccountSettings = {
    project: project.id,
    handle: project.handle,
    profile: project.uploadPostProfile,
    enabled_at: stamp,
    enabled_by: by,
    ends_at: days > 0 ? new Date(now + days * 86_400_000).toISOString() : null,
    max_posts: Math.round(input.maxPosts),
    max_per_day: Math.round(input.maxPerDay),
    posting: Boolean(input.posting),
    codex_images: Boolean(input.codexImages),
  };
  const file = await readAccounts();
  file.accounts = [...file.accounts.filter((a) => a.project !== project.id), settings];
  await writeJson(accountsFile(), file);
  return settings;
}

/** What the link action needs to know about a profile on your Upload-Post plan (a read-only lookup). */
export type ProfileLookup = (username: string) => Promise<{ username: string; instagram: { handle: string | null } | null } | null>;

/** The same Instagram account, whatever the case and with or without the @. */
export const sameHandle = (a: string, b: string) => a.trim().replace(/^@/, '').toLowerCase() === b.trim().replace(/^@/, '').toLowerCase();

/**
 * Links an Upload-Post profile to a project ('' unlinks it). A non-empty profile must exist on your
 * plan (checked with `lookup`, never created here) and, when its Instagram is connected, that
 * Instagram must be the project's own account (409 otherwise: a profile is never linked to, or marked
 * verified for, a different account). The account's `profile` field in accounts.json follows, its
 * stale verification is dropped, and nothing secret is written. The profile itself is never deleted at Upload-Post.
 */
export async function setUploadPostProfile(projectId: string, profile: string, lookup: ProfileLookup, now = Date.now()): Promise<{ project: Project; instagram: string | null }> {
  const p = (profile ?? '').trim();
  if (p && !PROFILE_RE.test(p)) throw new ProjectError(400, 'Enter the profile username from Upload-Post → Manage Users.');
  const all = await listProjects();
  const i = all.findIndex((x) => x.id === projectId);
  if (i < 0) throw new ProjectError(404, 'Unknown project.');
  let instagram: string | null = null;
  if (p) {
    const found = await lookup(p);
    if (!found) throw new ProjectError(404, `Upload-Post has no profile named “${p}”.`);
    instagram = found.instagram?.handle ?? null;
    if (instagram && !sameHandle(instagram, all[i]!.handle)) throw new ProjectError(409, `“${p}” is connected to ${instagram}, not ${all[i]!.handle}. Pick a profile connected to ${all[i]!.handle}, or connect this one to it first.`);
  }
  const project: Project = { ...all[i]!, uploadPostProfile: p };
  all[i] = project;
  await writeJson(projectsFile(), { projects: all });
  const file = await readAccounts();
  const a = file.accounts.find((x) => x.project === projectId);
  if (a && a.profile !== p) {
    a.profile = p;
    if (p && instagram) a.verified = { at: new Date(now).toISOString(), instagram: instagram.replace(/^@/, '') }; // stored like the verify check: no @
    else delete a.verified;
    await writeJson(accountsFile(), file);
  }
  return { project, instagram };
}

/**
 * The account's one-click posting switch (Instagram's API first, Upload-Post as fallback). Switching
 * it off is always allowed; switching it on needs posting limits that are still active. The change is
 * stamped on the account settings.
 */
export async function setAutomaticPosting(projectId: string, on: boolean, by: string, now = Date.now()): Promise<AccountSettings> {
  const file = await readAccounts();
  const a = file.accounts.find((x) => x.project === projectId);
  if (!a) throw new ProjectError(409, 'Set the posting limits first (Manage projects).');
  if (on && !postingActive(a, now)) throw new ProjectError(409, 'The posting period has ended. Set the posting limits again.');
  a.posting = on;
  a.posting_changed = { at: new Date(now).toISOString(), by };
  await writeJson(accountsFile(), file);
  return a;
}

export async function markVerified(projectId: string, instagram: string | null, now = Date.now()): Promise<void> {
  const file = await readAccounts();
  const a = file.accounts.find((x) => x.project === projectId);
  if (!a) return;
  a.verified = { at: new Date(now).toISOString(), instagram };
  await writeJson(accountsFile(), file);
}

// ---- current project ---------------------------------------------------------------------
const als = new AsyncLocalStorage<Project>();
export function withProject<T>(p: Project, fn: () => Promise<T>): Promise<T> {
  return als.run(p, fn);
}
export function currentProject(): Project {
  const p = als.getStore() ?? envProject();
  if (!p) throw new ProjectError(404, 'No project selected.');
  return p;
}
