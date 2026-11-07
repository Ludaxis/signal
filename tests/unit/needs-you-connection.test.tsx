// Today › Needs you shows a row when a connection blocks a post planned within 24 h: a fixture post planned in 23 h
// with Upload-Post disconnected shows it, one planned in 25 h does not, and the list still has at most 5 rows. The server field comes from GET /api/studio/content; nothing here calls a provider.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/server/studioAuth', () => ({ requireStudioUser: async () => ({ email: 'owner@test' }) }));

import { Today } from '@/app/studio/Studio';
import type { Payload, RealPackage } from '@/app/studio/RealPosts';
import { BLOCK_WINDOW_MS, connectionBlocks, postingPath } from '@/lib/studio/posting-blocks';
import { TEST_PROJECT, clearTestEnv, writeTestConfig } from './studio-helpers';

const NOW = Date.parse('2026-11-06T10:00:00Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const DOWN = { service: 'upload-post', ready: false };

const post = (id: string, status: string, plannedFor: string | null, extra: Record<string, unknown> = {}) => ({ id, status, plannedFor, scheduled: null, posted: null, dispatch: null, ...extra });

describe('connectionBlocks (pure)', () => {
  it('blocks a post planned in 23 h while Upload-Post is disconnected, not one in 25 h', () => {
    expect(connectionBlocks([post('07', 'approved', iso(NOW + 23 * H))], DOWN, NOW)).toEqual([{ service: 'upload-post', postId: '07', plannedFor: iso(NOW + 23 * H), count: 1 }]);
    expect(connectionBlocks([post('07', 'approved', iso(NOW + 25 * H))], DOWN, NOW)).toEqual([]);
    expect(BLOCK_WINDOW_MS).toBe(24 * H);
  });

  it('one row per connection, naming the first post and the count', () => {
    const r = connectionBlocks([post('09', 'ready', iso(NOW + 20 * H)), post('08', 'approved', iso(NOW + 2 * H)), post('10', 'approved', iso(NOW + 30 * H))], DOWN, NOW);
    expect(r).toEqual([{ service: 'upload-post', postId: '08', plannedFor: iso(NOW + 2 * H), count: 2 }]);
  });

  it('nothing is blocked when the connection is ready, nothing posts automatically, or the post is past, scheduled, sent, posted or rejected', () => {
    const soon = iso(NOW + 3 * H);
    expect(connectionBlocks([post('07', 'approved', soon)], { service: 'upload-post', ready: true }, NOW)).toEqual([]);
    expect(connectionBlocks([post('07', 'approved', soon)], null, NOW)).toEqual([]);
    for (const p of [post('07', 'approved', iso(NOW - H)), post('07', 'scheduled', soon, { scheduled: { scheduled_for: soon } }), post('07', 'sending', soon, { dispatch: { request_id: 'r' } }), post('07', 'posted', soon, { posted: { posted_at: soon } }), post('07', 'discarded', soon), post('07', 'approved', null)])
      expect(connectionBlocks([p], DOWN, NOW)).toEqual([]);
  });

  it('postingPath: Instagram live or no automatic posting means no Upload-Post block', () => {
    expect(postingPath({ metaLive: true, automatic: true, uploadPostKey: false, uploadPostProfile: false })).toBeNull();
    expect(postingPath({ metaLive: false, automatic: false, uploadPostKey: false, uploadPostProfile: false })).toBeNull();
    expect(postingPath({ metaLive: false, automatic: true, uploadPostKey: true, uploadPostProfile: false })).toEqual({ service: 'upload-post', ready: false });
    expect(postingPath({ metaLive: false, automatic: true, uploadPostKey: true, uploadPostProfile: true })).toEqual({ service: 'upload-post', ready: true });
  });
});

// ---- Today ----------------------------------------------------------------------------------------------------
function pkg(id: string, status: RealPackage['status'], extra: Partial<RealPackage> = {}): RealPackage {
  return { id, title: `Example post ${id}`, format: 'image', destination: '@example.account', status, problems: [], caption: 'Caption.', files: [], approval: null, posted: null, outcome: null, labelConfirmed: false, plannedFor: null, scheduled: null, metrics: null, dispatch: null, ...extra } as RealPackage;
}
function payload(packages: RealPackage[], extra: Partial<Payload> = {}): Payload {
  return {
    account: { destination: '@example.account', maxPosts: 14, posted: 0, open: true, expiresAt: NOW + 10 * 24 * H, maxPerDay: 1 },
    folder: '/tmp/example',
    packages,
    live: { enabled: false, reason: '' },
    scheduling: { enabled: false, reason: '' },
    project: { id: 'example', name: 'Example', handle: '@example.account' },
    ...extra,
  };
}

describe('Today › Needs you connection row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const at23 = iso(NOW + 23 * H);
  const block = { service: 'upload-post', postId: '07', plannedFor: at23, count: 1 };

  it('shows the row first, with the dictionary text, and opens the service in Connections', () => {
    const go = vi.fn();
    render(<Today data={payload([pkg('07', 'approved', { plannedFor: at23 })], { connectionBlocks: [block] })} go={go} onMake={() => undefined} />);
    const list = screen.getByRole('region', { name: /^Needs you/ });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Connect Upload-Post');
    expect(rows[0]!.textContent).toContain('Post 07 is planned for Sat 7 Nov, 10:00.');
    expect(within(rows[0]!).getByText('Needs you')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Open Upload-Post in Connections' }));
    expect(go).toHaveBeenCalledWith('connections', { service: 'upload-post' });
  });

  it('no row without a block (the 25 h case gets no field entry)', () => {
    render(<Today data={payload([pkg('07', 'approved', { plannedFor: iso(NOW + 25 * H) })], { connectionBlocks: [] })} go={vi.fn()} onMake={() => undefined} />);
    expect(screen.queryByText(/Connect Upload-Post/)).toBeNull();
    expect(screen.getByText('Nothing needs you.')).toBeTruthy();
  });

  it('still at most 5 rows: the block takes one, posts fill the rest, then "See all in Posts"', () => {
    const many = Array.from({ length: 7 }, (_, i) => pkg(String(10 + i), 'ready'));
    render(<Today data={payload(many, { connectionBlocks: [block] })} go={vi.fn()} onMake={() => undefined} />);
    const list = screen.getByRole('region', { name: /^Needs you/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain('Connect Upload-Post');
    expect(within(list).getByRole('button', { name: 'See all in Posts' })).toBeTruthy();
  });
});

// ---- GET /api/studio/content ----------------------------------------------------------------------------------
describe('GET /api/studio/content › connectionBlocks', () => {
  const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
  let root = '';
  /** The test project's handle (single-project mode through the environment). */
  const HANDLE = TEST_PROJECT.handle;
  function makePackage(id: string, plannedFor: string) {
    const d = path.join(root, 'posts', id);
    mkdirSync(d, { recursive: true });
    const slide = Buffer.from(`png-${id}`);
    const caption = `Caption ${id}`;
    writeFileSync(path.join(d, 'slide-1.png'), slide);
    writeFileSync(path.join(d, 'caption.txt'), caption);
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination: HANDLE, files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(slide) }, { name: 'caption.txt', role: 'caption', sha256: sha(caption) }] }));
    writeFileSync(path.join(d, 'plan.json'), JSON.stringify({ planned_for: plannedFor, planned_by: 'owner@test', planned_at: iso(Date.now() - H) }));
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'signal-blocks-'));
    mkdirSync(path.join(root, 'posts'));
    process.env.SIGNAL_CONTENT_DIR = path.join(root, 'posts');
    process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
    vi.stubEnv('UPLOAD_POST_API_KEY', '');
    vi.stubEnv('UPLOAD_POST_PROFILE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
    clearTestEnv();
  });

  async function blocks() {
    const route = await import('@/app/api/studio/content/route');
    const r = await route.GET(new NextRequest('http://localhost/api/studio/content'));
    expect(r.status).toBe(200);
    return ((await r.json()) as { connectionBlocks: unknown[] }).connectionBlocks;
  }

  it('lists the post planned in 23 h while automatic posting is on and Upload-Post has no key', async () => {
    writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: true, expires: '2099-01-01T00:00:00Z' });
    makePackage('07', iso(Date.now() + 23 * H));
    makePackage('08', iso(Date.now() + 25 * H));
    expect(await blocks()).toEqual([expect.objectContaining({ service: 'upload-post', postId: '07', count: 1 })]);
  });

  it('lists nothing while posting is by hand (automatic posting off)', async () => {
    writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: false, expires: '2099-01-01T00:00:00Z' });
    makePackage('07', iso(Date.now() + 23 * H));
    expect(await blocks()).toEqual([]);
  });
});
