// The list routes answer with a JSON error (never a bare 500), and downloads are named after the project.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import { TEST_PROJECT, clearTestEnv, setTestProjectEnv, writeTestConfig } from './studio-helpers';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'http://localhost:3000';
let root = '';
let token = '';

const req = (url: string) => new NextRequest(`${ORIGIN}${url}`, { headers: { cookie: `${COOKIE_PLAIN}=${token}` } });

function makePackage(dir: string, id: string, destination: string = TEST_PROJECT.handle) {
  const d = path.join(dir, id);
  mkdirSync(d, { recursive: true });
  const slide = Buffer.from(`png-${id}`);
  const caption = `Caption ${id}`;
  writeFileSync(path.join(d, 'slide-1.png'), slide);
  writeFileSync(path.join(d, 'caption.txt'), caption);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination, files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(slide) }, { name: 'caption.txt', role: 'caption', sha256: sha(caption) }] }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-routes-errors-'));
  mkdirSync(path.join(root, 'posts'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  writeTestConfig(path.join(root, 'signal.config.json'));
  process.env.SIGNAL_SESSION_SECRET = 'routes-errors-test-secret-0000';
  token = issueSession();
});
afterEach(() => {
  vi.doUnmock('@/lib/studio/content');
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
  delete process.env.SIGNAL_SESSION_SECRET;
  clearTestEnv();
});

describe('list routes fail with a JSON error', () => {
  it('GET /api/studio/content and /api/studio/calendar return jsonError when listing fails', async () => {
    vi.doMock('@/lib/studio/content', async (orig) => ({
      ...(await orig<typeof import('@/lib/studio/content')>()),
      listPackages: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    }));
    const content = await import('@/app/api/studio/content/route');
    const r = await content.GET(req(`/api/studio/content?project=${TEST_PROJECT.id}`));
    expect(r.status).toBe(500);
    expect(r.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(((await r.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'internal', message: 'Could not load the posts. Try again.' });

    const cal = await import('@/app/api/studio/calendar/route');
    const c = await cal.GET(req('/api/studio/calendar?from=2026-11-02&to=2026-11-08'));
    expect(c.status).toBe(500);
    expect(((await c.json()) as { error: { message: string } }).error.message).toBe('Could not load the calendar. Try again.');
  });

  it('a broken plan.json no longer breaks the calendar: the other packages are still listed', async () => {
    makePackage(path.join(root, 'posts'), '01');
    makePackage(path.join(root, 'posts'), '02');
    writeFileSync(path.join(root, 'posts', '01', 'plan.json'), '{ not json');
    const cal = await import('@/app/api/studio/calendar/route');
    const c = await cal.GET(req('/api/studio/calendar?from=2026-11-02&to=2026-11-08'));
    expect(c.status).toBe(200);
    const j = (await c.json()) as { unplanned: { id: string }[] };
    expect(j.unplanned.map((x) => x.id)).toEqual(['02']); // 01 is invalid and hidden, as before
  });
});

describe('download filenames', () => {
  it('names the file after the project, not a fixed prefix', async () => {
    makePackage(path.join(root, 'posts'), '01');
    const file = await import('@/app/api/studio/content/[id]/file/[name]/route');
    const r = await file.GET(req(`/api/studio/content/01/file/slide-1.png?project=${TEST_PROJECT.id}&download=1`), { params: Promise.resolve({ id: '01', name: 'slide-1.png' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Disposition')).toBe('attachment; filename="demo-post-01-slide-1.png"');

    // Another project: its own id.
    const other = path.join(root, 'other');
    makePackage(other, '01', '@other.brand');
    writeFileSync(process.env.SIGNAL_PROJECTS_FILE!, JSON.stringify({ projects: [{ id: 'other', name: 'Other', handle: '@other.brand', uploadPostProfile: '', contentDir: other, createdAt: '2026-11-03T00:00:00.000Z' }] }));
    const k = await file.GET(req('/api/studio/content/01/file/slide-1.png?project=other&download=1'), { params: Promise.resolve({ id: '01', name: 'slide-1.png' }) });
    expect(k.status).toBe(200);
    expect(k.headers.get('Content-Disposition')).toBe('attachment; filename="other-post-01-slide-1.png"');
  });

  it('falls back to a safe name when the id has nothing usable', async () => {
    const { downloadName } = await import('@/app/api/studio/content/[id]/file/[name]/route');
    expect(downloadName('My Brand!', '07', 'cover.png')).toBe('my-brand-post-07-cover.png');
    expect(downloadName('---', '07', 'cover.png')).toBe('signal-post-07-cover.png');
  });
});
