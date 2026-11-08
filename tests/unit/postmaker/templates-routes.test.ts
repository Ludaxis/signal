// @vitest-environment node
// The template actions through POST /api/studio/postmaker: Make a post, variants, Repeat, skip proof, campaigns,
// Duplicate and Retire answer; 401 without a session, 403 cross-origin, 400 for bad bodies, 404 for unknown templates,
// and the Post maker switch (off: every template action is refused 403 feature-off; the API stays read-only). Fakes only.
import './guard';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import * as home from '@/app/api/studio/postmaker/route';
import { acceptProof } from '@/lib/studio/postmaker/accept';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps } from '@/lib/studio/postmaker/service';
import { readRun } from '@/lib/studio/postmaker/store/runs';
import { readTemplate } from '@/lib/studio/postmaker/store/templates';
import { cleanRun, postsProject, withPostsProject, withVerdict, writePostsConfig } from './accept-fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { tmp } from './guard';

withPostsProject();

const ORIGIN = 'http://localhost:3000';
let token = '';
const saved = { secret: process.env.SIGNAL_SESSION_SECRET, renderDir: process.env.SIGNAL_RENDER_SERVICE_DIR };

beforeEach(() => {
  process.env.SIGNAL_RENDER_SERVICE_DIR = `${tmp.dir}/no-render-service`;
  process.env.SIGNAL_SESSION_SECRET = 'postmaker-templates-test-secret-0000';
  token = issueSession();
  _resetEngineState();
  _resetSchedulerState();
  _setServiceDeps({ executors: withVerdict('premium'), allowed: () => true, buildOptions: () => ({}) });
});
afterEach(() => {
  _setServiceDeps({});
  for (const [k, v] of Object.entries(saved)) {
    const key = k === 'secret' ? 'SIGNAL_SESSION_SECRET' : 'SIGNAL_RENDER_SERVICE_DIR';
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

const post = (body: Record<string, unknown>, o: { origin?: string; auth?: boolean } = {}) =>
  home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: o.origin ?? ORIGIN, ...(o.auth === false ? {} : { cookie: `${COOKIE_PLAIN}=${token}` }) }, body: JSON.stringify({ project: TEST_PROJECT.id, ...body }) }));
const body = async <T>(r: Response) => (await r.json()) as T;

async function proven(): Promise<string> {
  const s = await cleanRun({ verdict: 'premium', langs: ['en'] });
  const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: 'owner@example.test' });
  return r.template.id;
}

const actionsFor = (templateId: string) => [
  { action: 'template.make-post', templateId, brief: { topic: 'A rainy evening' } },
  { action: 'template.variant.save', templateId, variant: { label: 'Long', params: { lengthSec: 60 } } },
  { action: 'template.repeat.set', templateId, repeat: { perWeek: 3, days: [1, 3], times: ['18:00'], makeAheadDays: 3, dailyUsd: 3, approve: 'ask' } },
  { action: 'template.skip-proof.set', templateId, variantId: null, on: false },
  { action: 'template.campaign.detach', templateId, campaignId: 'c-20261107-ab12' },
  { action: 'template.duplicate', templateId },
  { action: 'template.retire', templateId },
];

describe('the template actions through the route', () => {
  it('the template actions answer (202 for Make a post, 200 for the settings); Make a post reaches Proof', { timeout: 30_000 }, async () => {
    const id = await proven();
    const [makePost, variant, repeat, ...rest] = actionsFor(id);
    let r = await post(makePost!);
    expect(r.status).toBe(202);
    const started = await body<{ runId: string; recipeId: string; templateId: string }>(r);
    expect(started).toMatchObject({ templateId: id, runId: expect.stringMatching(/^run-/), recipeId: expect.stringMatching(/^rc-/) });
    let run = await readRun(tmp.root, started.runId);
    for (let i = 0; i < 400 && !(run?.status === 'needs-you' && run.pausedFor === 'check'); i++) {
      await new Promise((res) => setTimeout(res, 20));
      run = await readRun(tmp.root, started.runId);
    }
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'check', templateId: id, trigger: 'make-a-post' });
    r = await post(variant!);
    expect(r.status).toBe(200);
    expect((await body<{ variant: { status: string } }>(r)).variant.status).toBe('draft');
    r = await post(repeat!);
    expect(r.status).toBe(200);
    expect((await body<{ template: { repeat: { enabled: boolean } } }>(r)).template.repeat.enabled).toBe(false);
    for (const a of rest) expect((await post(a)).status, a.action).toBe(200);
    expect((await readTemplate(tmp.root, id))!.status).toBe('retired');
  });

  it('401 without a session, 403 cross-origin, 400 for a bad body, 404 for an unknown template', async () => {
    const id = 'tpl-20261107-ffff';
    for (const a of actionsFor(id)) {
      expect((await post(a, { auth: false })).status, a.action).toBe(401);
      expect((await post(a, { origin: 'https://evil.example' })).status, a.action).toBe(403);
      expect((await post({ ...a, extra: 1 })).status, a.action).toBe(400);
      expect((await post(a)).status, a.action).toBe(404);
    }
    const r = await post({ action: 'template.variant.save', templateId: id, variant: { label: 'x', params: { lengthSec: 60 }, status: 'proven' } });
    expect(r.status).toBe(400);
    expect((await body<{ error: { code: string } }>(r)).error.code).toBe('validation');
  });

  it('while the Post maker switch is off every template action is refused 403 and nothing changes', async () => {
    const id = await proven();
    const before = await readTemplate(tmp.root, id);
    writePostsConfig({ postmaker: false });
    for (const a of actionsFor(id)) {
      const r = await post(a);
      expect(r.status, a.action).toBe(403);
      expect((await body<{ error: { details: { reason: string } } }>(r)).error.details.reason).toBe('feature-off');
    }
    expect(await readTemplate(tmp.root, id)).toEqual(before);
  });
});
