// @vitest-environment node
// Connections routes for Post maker: GET lists the Making rows (all off on a fresh config), connector.switch asks once
// for a paid service's terms (409 'terms-needed', then acceptTerms), and the settings feature action keeps that same
// terms step for the paid-service switches while other switches stay plain. Signed owner session; no network.
import '../guard';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import './env';
import { readConfig } from '@/lib/server/signalConfig';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import { GET as connectionsGET, POST as connectionsPOST } from '@/app/api/studio/connections/route';
import { POST as settingsPOST } from '@/app/api/studio/settings/route';
import { tmp } from '../guard';

const ORIGIN = 'http://localhost:3000';
function signedIn() {
  process.env.SIGNAL_SESSION_SECRET = 'connections-route-test-secret-0000';
  process.env.SIGNAL_PROJECTS_FILE = path.join(tmp.dir, 'no-projects.json');
  process.env.SIGNAL_CONTENT_DIR = tmp.contentDir;
  return issueSession();
}
const get = (token: string, url: string) => new NextRequest(`${ORIGIN}${url}`, { headers: { cookie: `${COOKIE_PLAIN}=${token}` } });
const post = (token: string, url: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${url}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie: `${COOKIE_PLAIN}=${token}`, origin: ORIGIN, 'content-type': 'application/json' } });

describe('GET /api/studio/connections › making', () => {
  it('lists every Making connector with its switch off and no key value', async () => {
    const token = signedIn();
    const r = await connectionsGET(get(token, '/api/studio/connections'));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { making: { id: string; switchOn: boolean; status: { state: string; line: string } }[]; postmaker: { paused: boolean } };
    expect(j.making.length).toBe(16);
    for (const row of j.making) expect(row.switchOn, row.id).toBe(false);
    expect(j.postmaker).toEqual({ paused: false });
    expect(JSON.stringify(j)).not.toMatch(/sk-|xi-api-key|SIGNAL_TOKEN_KEY/);
  });
});

describe('POST connector.switch', () => {
  it('asks once for the terms of a paid service, then turns it on with acceptTerms', async () => {
    const token = signedIn();
    const first = await connectionsPOST(post(token, '/api/studio/connections', { action: 'connector.switch', id: 'sync', on: true }));
    expect(first.status).toBe(409);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe('terms-needed');
    expect((await readConfig()).features.postmakerSync).toBeUndefined();
    const second = await connectionsPOST(post(token, '/api/studio/connections', { action: 'connector.switch', id: 'sync', on: true, acceptTerms: true }));
    expect(second.status).toBe(200);
    const row = ((await second.json()) as { row: { id: string; switchOn: boolean } }).row;
    expect(row).toMatchObject({ id: 'sync', switchOn: true });
    expect(Object.keys((await readConfig()).postmaker.acceptedTerms)).toEqual(['vendor:sync']);
  });

  it('refuses a blocked binding, an unknown id and a bad switch value', async () => {
    const token = signedIn();
    expect((await connectionsPOST(post(token, '/api/studio/connections', { action: 'connector.switch', id: 'browser-agent:suno', on: true, acceptTerms: true }))).status).toBe(403);
    expect((await connectionsPOST(post(token, '/api/studio/connections', { action: 'connector.switch', id: 'nope', on: true }))).status).toBe(404);
    expect((await connectionsPOST(post(token, '/api/studio/connections', { action: 'connector.switch', id: 'sync', on: 'yes' }))).status).toBe(400);
  });
});

describe('POST /api/studio/settings › feature', () => {
  it('keeps the terms step for a paid Post maker service', async () => {
    const token = signedIn();
    const first = await settingsPOST(post(token, '/api/studio/settings', { action: 'feature', id: 'postmakerHedra', on: true }));
    expect(first.status).toBe(409);
    expect((await readConfig()).features.postmakerHedra).toBeUndefined();
    const second = await settingsPOST(post(token, '/api/studio/settings', { action: 'feature', id: 'postmakerHedra', on: true, acceptTerms: true }));
    expect(second.status).toBe(200);
    expect((await readConfig()).features.postmakerHedra).toBe(true);
  });

  it('turns the Post maker switch and other switches on without a terms step', async () => {
    const token = signedIn();
    for (const id of ['postmaker', 'scheduler']) {
      const r = await settingsPOST(post(token, '/api/studio/settings', { action: 'feature', id, on: true }));
      expect(r.status, id).toBe(200);
    }
    const f = (await readConfig()).features;
    expect(f.postmaker).toBe(true);
    expect(f.scheduler).toBe(true);
  });
});
