import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { approvePackage, loadPackage, confirmLabel } from '@/lib/studio/content';
import { checkDispatch, dispatchPackage, liveState, redact, resolveUncertain } from '@/lib/studio/dispatch';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const KEY = 'test-key-abcdefghijklmnopqrstuvwxyz0123456789';
const NOW = Date.parse('2026-11-04T12:00:00+01:00');
let root = '';

function writeGate(authorized: boolean) {
  writeTestConfig(path.join(root, 'signal.config.json'), { dispatch: authorized });
}
function makePackage(id: string) {
  const d = path.join(root, 'posts', id);
  mkdirSync(d, { recursive: true });
  const s1 = Buffer.from(`slide-1-${id}`), s2 = Buffer.from(`slide-2-${id}`), cap = `Caption ${id} #DemoBrand`;
  writeFileSync(path.join(d, 'slide-1.png'), s1);
  writeFileSync(path.join(d, 'slide-2.png'), s2);
  writeFileSync(path.join(d, 'caption.txt'), cap);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ id, title: 't', format: 'carousel', destination: '@signal.demo', 
    files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(s1) }, { name: 'slide-2.png', role: 'slide', sha256: sha(s2) }, { name: 'caption.txt', role: 'caption', sha256: sha(cap) }] }));
  return d;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-dispatch-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.UPLOAD_POST_API_KEY = KEY;
  process.env.UPLOAD_POST_PROFILE = 'demo-profile';
  writeGate(true);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'UPLOAD_POST_API_KEY', 'UPLOAD_POST_PROFILE']) delete process.env[k];
});

describe('Upload-Post dispatch', () => {
  it('is off unless the gate authorizes it and the key/profile exist', async () => {
    writeGate(false);
    expect((await liveState(NOW)).enabled).toBe(false);
    writeGate(true);
    delete process.env.UPLOAD_POST_API_KEY;
    expect((await liveState(NOW)).reason).toMatch(/Upload-Post API key/);
    process.env.UPLOAD_POST_API_KEY = KEY;
    expect((await liveState(NOW)).enabled).toBe(true);
    expect((await liveState(Date.parse('2026-11-18T01:00:00+01:00'))).enabled).toBe(false);
  });

  it('refuses unapproved or changed packages and sends nothing', async () => {
    const d = makePackage('01');
    const f = vi.fn();
    await expect(dispatchPackage('01', 'owner', { fetch: f as never, now: NOW })).rejects.toThrow(/approved/);
    await approvePackage('01', 'owner', NOW);
    writeFileSync(path.join(d, 'slide-2.png'), 'edited');
    await expect(dispatchPackage('01', 'owner', { fetch: f as never, now: NOW })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it('sends the approved files once with the AI label, idempotency key and profile', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const f = vi.fn(async () => json(200, { success: true, request_id: 'x' }));
    const p = await dispatchPackage('01', 'owner', { fetch: f as never, now: NOW });
    expect(p.status).toBe('submitted');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.upload-post.com/api/upload_photos');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Apikey ${KEY}`);
    expect(h['Idempotency-Key']).toBe(p.dispatch!.request_id);
    const form = init.body as FormData;
    expect(form.get('user')).toBe('demo-profile');
    expect(form.getAll('platform[]')).toEqual(['instagram']);
    expect(form.get('is_ai_generated')).toBe('true');
    expect(form.get('title')).toBe('Caption 01 #DemoBrand');
    expect(form.getAll('photos[]')).toHaveLength(2);
    // A second click cannot send again.
    await expect(dispatchPackage('01', 'owner', { fetch: f as never, now: NOW })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('concurrent sends produce exactly one provider call', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const f = vi.fn(async () => json(200, { success: true }));
    const r = await Promise.allSettled([1, 2, 3].map(() => dispatchPackage('01', 'owner', { fetch: f as never, now: NOW })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('marks timeouts and 5xx uncertain, never retries, and blocks the next approval', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    const f = vi.fn(async () => {
      throw new Error('timeout');
    });
    const p = await dispatchPackage('01', 'owner', { fetch: f as never, now: NOW });
    expect(p.status).toBe('uncertain');
    expect(f).toHaveBeenCalledTimes(1);
    const tomorrow = Date.parse('2026-11-05T12:00:00+01:00');
    await expect(approvePackage('02', 'owner', tomorrow)).rejects.toThrow(/unclear result/);
    // Survives a "restart": state comes from disk.
    expect((await loadPackage('01')).status).toBe('uncertain');
    // Status unknown at provider keeps it paused.
    const st = vi.fn(async () => json(404, { status: 'not_found' }));
    expect((await checkDispatch('01', 'owner', { fetch: st as never })).status).toBe('uncertain');
    // owner checked Instagram: not there.
    expect((await resolveUncertain('01', 'owner', { posted: false }, NOW)).status).toBe('failed');
    expect((await approvePackage('02', 'owner', tomorrow)).status).toBe('approved');
  });

  it('records the post from provider status, then requires the AI label check', async () => {
    makePackage('01');
    makePackage('02');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(200, { success: true })) as never, now: NOW });
    const st = vi.fn(async () => json(200, { status: 'completed', results: [{ platform: 'instagram', success: true, url: 'https://www.instagram.com/p/DAbc123xyz/' }] }));
    const p = await checkDispatch('01', 'owner', { fetch: st as never, now: NOW });
    expect(p.status).toBe('posted');
    expect(p.posted!.url).toBe('https://www.instagram.com/p/DAbc123xyz/');
    const tomorrow = Date.parse('2026-11-05T12:00:00+01:00');
    await expect(approvePackage('02', 'owner', tomorrow)).rejects.toThrow(/AI label/);
    await confirmLabel('01', 'owner', NOW);
    expect((await approvePackage('02', 'owner', tomorrow)).status).toBe('approved');
  });

  it('records a definite rejection as failed with the key redacted', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    const f = async () => json(401, { message: `Invalid or expired token Apikey ${KEY}` });
    const p = await dispatchPackage('01', 'owner', { fetch: f as never, now: NOW });
    expect(p.status).toBe('failed');
    expect(p.outcome!.message).not.toContain(KEY);
    const files = ['dispatch.json', 'outcome.json'].map((n) => readFileSync(path.join(root, 'posts', '01', n), 'utf8')).join('');
    expect(files).not.toContain(KEY);
    expect(redact(`Bearer abc.def ${KEY}`)).not.toMatch(/abc\.def|test-key/);
    expect(existsSync(path.join(root, 'posts', '01', 'posted.json'))).toBe(false);
  });

  it('does not treat success:false while processing as a failure, and a real link resolves a failed check', async () => {
    makePackage('01');
    await approvePackage('01', 'owner', NOW);
    await dispatchPackage('01', 'owner', { fetch: (async () => json(200, { success: true })) as never, now: NOW });
    const processing = async () => json(200, { status: 'in_progress', results: [{ platform: 'instagram', success: false, status: 'processing' }] });
    expect((await checkDispatch('01', 'owner', { fetch: processing as never })).status).toBe('submitted');
    const failed = async () => json(200, { status: 'failed', results: [{ platform: 'instagram', success: false, status: 'failed', message: 'x' }] });
    expect((await checkDispatch('01', 'owner', { fetch: failed as never })).status).toBe('failed');
    const later = async () => json(200, { status: 'completed', results: [{ platform: 'instagram', success: true, url: 'https://www.instagram.com/p/DAbc123xyz/' }] });
    expect((await checkDispatch('01', 'owner', { fetch: later as never, now: NOW })).status).toBe('posted');
  });
});
