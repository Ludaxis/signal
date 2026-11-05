// Linking, changing and removing a project's Upload-Post profile from the Connections screen,
// and the account's one-click posting switch in accounts.json (POST /api/studio/projects/:pid actions).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestEnv, setTestProjectEnv } from './studio-helpers';
import { accountSettings, createProject, getProject, listProjects, setAccountSettings, setAutomaticPosting, setUploadPostProfile } from '@/lib/studio/projects';

let root = '';
const NOW = Date.parse('2026-11-05T12:00:00+01:00');
const lookup = vi.fn(async (u: string) =>
  u === 'studio' ? { username: 'studio', instagram: { handle: '@example.studio' } } : u === 'caps' ? { username: 'caps', instagram: { handle: 'Example.Studio' } } : u === 'other' ? { username: 'other', instagram: { handle: '@someone.else' } } : u === 'bare' ? { username: 'bare', instagram: null } : null,
);
const LIMITS = { confirmHandle: '@example.studio', days: 7, maxPosts: 5, maxPerDay: 1, codexImages: false } as const;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-uplink-'));
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  setTestProjectEnv(path.join(root, 'demo-posts'));
  lookup.mockClear();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearTestEnv();
});

const newProject = (profile = '') => createProject({ name: 'Example Studio', handle: '@example.studio', uploadPostProfile: profile, contentDir: path.join(root, 'studio-posts') });

describe('Upload-Post profile link', () => {
  it('links only a profile that exists on the plan, and reports its Instagram', async () => {
    const p = await newProject();
    await expect(setUploadPostProfile(p.id, 'nope', lookup)).rejects.toThrow(/no profile named “nope”/);
    await expect(setUploadPostProfile(p.id, 'bad name!', lookup)).rejects.toThrow(/Manage Users/);
    await expect(setUploadPostProfile('ghost', 'studio', lookup)).rejects.toThrow(/Unknown project/);
    const r = await setUploadPostProfile(p.id, 'studio', lookup);
    expect(r).toMatchObject({ instagram: '@example.studio', project: { id: 'example-studio', uploadPostProfile: 'studio' } });
    expect((await getProject('example-studio')).uploadPostProfile).toBe('studio');
    // The projects file holds no secrets: just the profile username.
    expect(readFileSync(path.join(root, 'data', 'projects.json'), 'utf8')).not.toMatch(/Apikey|key/i);
  });

  it('refuses a profile whose Instagram is another account (409) and never marks the account verified with it', async () => {
    const p = await newProject('old');
    await setAccountSettings(p, { ...LIMITS, posting: true }, 'owner', NOW);
    await expect(setUploadPostProfile(p.id, 'other', lookup, NOW)).rejects.toMatchObject({ status: 409, message: /“other” is connected to @someone\.else, not @example\.studio/ });
    expect((await getProject('example-studio')).uploadPostProfile).toBe('old');
    const a = await accountSettings('example-studio');
    expect(a?.profile).toBe('old');
    expect(a?.verified).toBeUndefined();
    // the same account in another case or without the @ is fine
    expect((await setUploadPostProfile(p.id, 'caps', lookup, NOW)).instagram).toBe('Example.Studio');
    expect(await accountSettings('example-studio')).toMatchObject({ profile: 'caps', verified: { instagram: 'Example.Studio' } });
  });

  it('keeps accounts.json in step: profile field and verified handle', async () => {
    const p = await newProject('old');
    await setAccountSettings(p, { ...LIMITS, posting: true }, 'owner', NOW);
    expect((await accountSettings('example-studio'))?.profile).toBe('old');
    await setUploadPostProfile(p.id, 'studio', lookup, NOW);
    expect(await accountSettings('example-studio')).toMatchObject({ profile: 'studio', posting: true, verified: { instagram: 'example.studio' } });
    // A profile without Instagram drops the stale verification.
    await setUploadPostProfile(p.id, 'bare', lookup, NOW);
    const a = await accountSettings('example-studio');
    expect(a?.profile).toBe('bare');
    expect(a?.verified).toBeUndefined();
  });

  it('removes the profile without touching the posting limits or the plan', async () => {
    const p = await newProject('studio');
    await setAccountSettings(p, { ...LIMITS, posting: true }, 'owner', NOW);
    const r = await setUploadPostProfile(p.id, '', lookup);
    expect(lookup).not.toHaveBeenCalled(); // nothing is looked up or deleted at Upload-Post
    expect(r.project.uploadPostProfile).toBe('');
    expect((await listProjects()).find((x) => x.id === 'example-studio')?.uploadPostProfile).toBe('');
    const a = await accountSettings('example-studio');
    expect(a).toMatchObject({ profile: '', posting: true, max_posts: 5 }); // the limits are kept
  });

  it('works for the env project before a projects file exists', async () => {
    await expect(setUploadPostProfile('demo', 'studio', lookup)).rejects.toMatchObject({ status: 409 }); // another account's profile
    await setUploadPostProfile('demo', 'bare', lookup);
    expect((await getProject('demo')).uploadPostProfile).toBe('bare');
  });
});

describe('one-click posting switch', () => {
  it('needs posting limits, flips the switch and stamps who did it', async () => {
    const p = await newProject('studio');
    await expect(setAutomaticPosting(p.id, true, 'owner', NOW)).rejects.toThrow(/Set the posting limits first/);
    await setAccountSettings(p, { ...LIMITS, posting: false }, 'owner', NOW);
    expect((await setAutomaticPosting(p.id, true, 'owner', NOW + 1000)).posting).toBe(true);
    expect(await accountSettings('example-studio')).toMatchObject({ posting: true, posting_changed: { by: 'owner' } });
    expect((await setAutomaticPosting(p.id, false, 'owner', NOW + 2000)).posting).toBe(false);
    // Off is always allowed; on needs limits that are still active.
    const late = NOW + 8 * 86_400_000;
    expect((await setAutomaticPosting(p.id, false, 'owner', late)).posting).toBe(false);
    await expect(setAutomaticPosting(p.id, true, 'owner', late)).rejects.toThrow(/has ended/);
  });
});
