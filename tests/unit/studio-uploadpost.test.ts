import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UP_PROFILES_PATH, connectLink, createUpProfile, listUpProfiles, profileManagementAllowed } from '@/lib/studio/uploadpost';
import { writeTestConfig } from './studio-helpers';

let root = '';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function gate(on: boolean) {
  writeTestConfig(path.join(root, 'signal.config.json'), { uploadPostProfiles: on });
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-up-'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.UPLOAD_POST_API_KEY = 'k-test';
  gate(true);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SIGNAL_CONFIG_FILE;
  delete process.env.UPLOAD_POST_API_KEY;
});

describe('Upload-Post profile setup', () => {
  it('is off until the switch is on, and never calls Upload-Post then', async () => {
    gate(false);
    expect((await profileManagementAllowed()).enabled).toBe(false);
    const f = vi.fn();
    await expect(listUpProfiles(f as never)).rejects.toThrow(/uploadPostProfiles/);
    expect(f).not.toHaveBeenCalled();
  });

  it('lists profiles with their connected Instagram account', async () => {
    const f = vi.fn(async () =>
      json(200, { plan: 'free', limit: 2, profiles: [
        { username: 'default', display_name: 'Demo', social_accounts: { instagram: { username: '1789', handle: 'signal.demo', display_name: 'Demo' }, tiktok: '' } },
        { username: 'idonly', social_accounts: { instagram: { username: '29341287095480770', display_name: 'Example' } } },
        { username: 'second-profile', social_accounts: { instagram: null } },
      ] }),
    );
    const l = await listUpProfiles(f as never);
    expect(l).toMatchObject({ plan: 'free', limit: 2 });
    expect(l.profiles[0]).toMatchObject({ username: 'default', instagram: { handle: '@signal.demo' } });
    // The opaque Instagram id is never shown as a handle.
    expect(l.profiles[1]!.instagram).toMatchObject({ handle: null, name: 'Example' });
    expect(l.profiles[2]!.instagram).toBeNull();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.upload-post.com${UP_PROFILES_PATH}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Apikey k-test');
  });

  it('creates a profile and explains plan limits and duplicates', async () => {
    await expect(createUpProfile('bad name!', 'x', vi.fn() as never)).rejects.toThrow(/letters/);
    await expect(createUpProfile('second-profile', 'Second', (async () => json(403, { error_code: 'PROFILE_LIMIT_REACHED' })) as never)).rejects.toThrow(/Free allows 2/);
    await expect(createUpProfile('second-profile', 'Second', (async () => json(409, {})) as never)).rejects.toThrow(/already exists/);
    const f = vi.fn(async () => json(201, { success: true, profile: { username: 'second-profile', display_name: 'Second', social_accounts: {} } }));
    expect((await createUpProfile('second-profile', 'Second', f as never)).username).toBe('second-profile');
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ username: 'second-profile', display_name: 'Second' });
  });

  it('opens the hosted connect page, or falls back to the Upload-Post dashboard', async () => {
    const ok = await connectLink('second-profile', 'http://localhost:3000/studio', (async () => json(200, { access_url: 'https://app.upload-post.com/connect?token=t', duration: '48h', success: true })) as never);
    expect(ok).toMatchObject({ hosted: true, url: 'https://app.upload-post.com/connect?token=t' });
    const no = await connectLink('second-profile', null, (async () => json(403, { error_code: 'PROFILE_BLOCKED' })) as never);
    expect(no.hosted).toBe(false);
    expect(no.note).toMatch(/Manage Users/);
  });
});
