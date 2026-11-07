// The `music.upload` route (pattern): 401 without a session, 403 cross-origin and with the Post maker
// switch off, 400 without a BPM (before anything is written), and a draft music asset with a complete licence record
// with BPM, downbeat, plan and date. Offline: the network guard is on.
import './guard';
import { existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import * as music from '@/app/api/studio/postmaker/music/route';
import { POSTMAKER_OFF_TEXT } from '@/lib/studio/postmaker/api/http';
import { clickTrackWav } from '@/lib/studio/postmaker/connectors/mock/audio';
import { trackLicenceOk } from '@/lib/studio/postmaker/executors/music';
import { rootOf } from '@/lib/studio/postmaker/service';
import { projectLibraryFile } from '@/lib/studio/postmaker/store/paths';
import type { Asset } from '@/lib/studio/postmaker/types';
import { postsProject, withPostsProject, writePostsConfig } from './accept-fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { networkGuardLog } from './guard';

withPostsProject();

const ORIGIN = 'http://localhost:3000';
let token = '';
const saved = { secret: process.env.SIGNAL_SESSION_SECRET };
beforeEach(() => {
  process.env.SIGNAL_SESSION_SECRET = 'postmaker-music-test-secret-0000000';
  token = issueSession();
});
afterEach(() => {
  if (saved.secret === undefined) delete process.env.SIGNAL_SESSION_SECRET;
  else process.env.SIGNAL_SESSION_SECRET = saved.secret;
  expect(networkGuardLog()).toEqual([]);
});

const FIELDS = 'bpm=100&downbeatMs=0&plan=Pro&downloadedAt=2026-11-06';
const post = (query: string, body: Uint8Array | string, o: { auth?: boolean; origin?: string } = {}) =>
  music.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker/music?project=${TEST_PROJECT.id}&${query}`, { method: 'POST', headers: { origin: o.origin ?? ORIGIN, 'content-type': 'audio/wav', ...(o.auth === false ? {} : { cookie: `${COOKIE_PLAIN}=${token}` }) }, body: body as BodyInit }));
const wav = () => new Uint8Array(clickTrackWav({ bpm: 100, ms: 4000 }));
const libraryFile = () => projectLibraryFile(rootOf(postsProject() as never));

describe('music.upload route', () => {
  it('401 without a session; 403 cross-origin; 403 with the Post maker switch off', async () => {
    expect((await post(FIELDS, wav(), { auth: false })).status).toBe(401);
    expect((await post(FIELDS, wav(), { origin: 'https://evil.example' })).status).toBe(403);
    writePostsConfig({ postmaker: false });
    const off = await post(FIELDS, wav());
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: { message: string } }).error.message).toBe(POSTMAKER_OFF_TEXT);
    expect(existsSync(libraryFile())).toBe(false);
  });

  it('400 without a BPM, before anything is written', async () => {
    const r = await post('downbeatMs=0&plan=Pro&downloadedAt=2026-11-06', wav());
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string; message: string } }).error).toEqual({ code: 'validation', message: 'Type the track’s BPM (60 to 200).', details: {} });
    expect(existsSync(libraryFile())).toBe(false);
  });

  it('with BPM, downbeat, plan and date: a draft music asset with a complete licence record', async () => {
    const r = await post(FIELDS, wav());
    expect(r.status).toBe(200);
    const { asset } = (await r.json()) as { asset: Asset };
    expect(asset).toMatchObject({ kind: 'music', status: 'draft', approvedBy: null, music: { bpm: 100, firstDownbeatMs: 0, declaredBy: 'user' }, licence: { plan: 'Pro', acquiredAt: '2026-11-06', allowedUses: ['organic'] } });
    expect(trackLicenceOk({ asset, origin: 'project', file: '' })).toBe(true);
    expect(existsSync(libraryFile())).toBe(true);
    expect((await post(FIELDS, '<html>not audio</html>')).status).toBe(400);
  });
});
