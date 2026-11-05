import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { clearTestEnv, setTestProjectEnv } from './studio-helpers';
import { approvePackage, listPackages, loadPackage } from '@/lib/studio/content';
import { dispatchPackage } from '@/lib/studio/dispatch';
import { accountSettings, checkNewProject, createProject, defaultContentDir, getProject, listProjects, setAccountSettings, withProject } from '@/lib/studio/projects';

let root = '';
const NOW = Date.parse('2026-11-05T12:00:00+01:00');
const sha = (b: string) => createHash('sha256').update(b).digest('hex');

function pkg(dir: string, id: string, destination: string) {
  const d = path.join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'slide-1.png'), 'img');
  writeFileSync(path.join(d, 'caption.txt'), 'cap');
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: 't', format: 'image', destination, files: [{ name: 'slide-1.png', role: 'slide', sha256: sha('img') }, { name: 'caption.txt', role: 'caption', sha256: sha('cap') }] }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-projects-'));
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  process.env.SIGNAL_PROMPTS_DIR = root;
  setTestProjectEnv(path.join(root, 'demo-posts'));
  process.env.UPLOAD_POST_API_KEY = 'k-test-1234567890';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearTestEnv();
  delete process.env.UPLOAD_POST_API_KEY;
});

describe('projects', () => {
  it('starts with the env project and validates the wizard input', async () => {
    expect((await listProjects()).map((p) => p.id)).toEqual(['demo']);
    const errs = await checkNewProject({ name: '', handle: 'not a handle!', uploadPostProfile: 'not a profile!', contentDir: 'relative/folder' });
    expect(Object.keys(errs).sort()).toEqual(['contentDir', 'handle', 'id', 'name', 'uploadPostProfile']);
    expect((await checkNewProject({ name: 'Dup', handle: '@signal.demo', uploadPostProfile: 'x' })).handle).toMatch(/already/);
    // Upload-Post is optional: a project can post through Instagram's API (Meta) instead.
    expect(await checkNewProject({ name: 'Another Studio', handle: '@anotherstudio', uploadPostProfile: '' })).toEqual({});
  });

  it('has no projects at all without a projects file or SIGNAL_CONTENT_DIR', async () => {
    delete process.env.SIGNAL_CONTENT_DIR;
    expect(await listProjects()).toEqual([]);
    await expect(getProject(null)).rejects.toThrow(/Create a project first/);
  });

  it('creates a project with its own content folder (default inside the data folder) and keeps packages separate', async () => {
    const d = await createProject({ name: 'Default Folder', handle: '@default.folder', uploadPostProfile: '' });
    expect(d.contentDir).toBe(defaultContentDir('default-folder'));
    expect(d.contentDir.startsWith(path.join(root, 'data'))).toBe(true);
    const p = await createProject({ name: 'Second', handle: 'instagram.com/second.brand', uploadPostProfile: 'second-profile', contentDir: path.join(root, 'second-posts') });
    expect(p).toMatchObject({ id: 'second', handle: '@second.brand' });
    expect(existsSync(p.contentDir)).toBe(true);
    // projects.json replaces the env project once it exists.
    expect((await listProjects()).map((x) => x.id)).toEqual(['demo', 'default-folder', 'second']);
    expect(JSON.parse(readFileSync(path.join(root, 'data', 'projects.json'), 'utf8')).projects).toHaveLength(3);
    pkg(p.contentDir, '01', '@second.brand');
    pkg(process.env.SIGNAL_CONTENT_DIR!, '01', '@signal.demo');
    const second = await withProject(p, () => listPackages());
    expect(second.map((x) => [x.id, x.status])).toEqual([['01', 'ready']]);
    // A package aimed at another account is invalid in this project.
    pkg(p.contentDir, '02', '@signal.demo');
    expect(await withProject(p, () => loadPackage('02').then((x) => x.status))).toBe('invalid');
  });

  it('needs typed-handle account settings per project, stores them in accounts.json, and enforces the limits', async () => {
    const p = await createProject({ name: 'Second', handle: '@second.brand', uploadPostProfile: 'second-profile', contentDir: path.join(root, 'second-posts') });
    pkg(p.contentDir, '01', '@second.brand');
    await expect(withProject(p, () => approvePackage('01', 'owner', NOW))).rejects.toThrow(/Set the posting limits/);
    await expect(setAccountSettings(p, { confirmHandle: '@wrong', days: 14, maxPosts: 14, maxPerDay: 1, posting: true, codexImages: false }, 'owner', NOW)).rejects.toThrow(/Type @second.brand/);
    await expect(setAccountSettings(p, { confirmHandle: '@second.brand', days: 400, maxPosts: 14, maxPerDay: 1, posting: true, codexImages: false }, 'owner', NOW)).rejects.toThrow(/Days/);
    const a = await setAccountSettings(p, { confirmHandle: '@second.brand', days: 7, maxPosts: 5, maxPerDay: 1, posting: true, codexImages: false }, 'owner', NOW);
    expect(a).toMatchObject({ project: 'second', profile: 'second-profile', max_posts: 5, posting: true, ends_at: new Date(NOW + 7 * 86_400_000).toISOString() });
    expect(JSON.parse(readFileSync(path.join(root, 'data', 'accounts.json'), 'utf8')).accounts).toHaveLength(1);
    expect((await accountSettings('second'))?.handle).toBe('@second.brand');
    // The env project has no settings: they are per account.
    expect(await accountSettings('demo')).toBeNull();
    // Approving and sending uses this project's Upload-Post profile.
    await withProject(p, () => approvePackage('01', 'owner', NOW));
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const sent = await withProject(p, () => dispatchPackage('01', 'owner', { fetch: f as never, now: NOW }));
    expect(sent.status).toBe('submitted');
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('user')).toBe('second-profile');
    // Saving again replaces the settings; days 0 means no end date.
    const again = await setAccountSettings(p, { confirmHandle: '@second.brand', days: 0, maxPosts: 9, maxPerDay: 2, posting: true, codexImages: true }, 'owner', NOW + 1);
    expect(again.ends_at).toBeNull();
    expect(await accountSettings('second')).toMatchObject({ max_posts: 9, max_per_day: 2, codex_images: true, ends_at: null });
  });

  it('rejects unknown projects', async () => {
    await expect(getProject('nope')).rejects.toThrow(/Unknown project/);
  });
});
