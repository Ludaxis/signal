// @vitest-environment node
// Server side of the Proven screen: a stub-Premium proof accepted clean makes a Proven
// template that Home lists with its card (steps, the proof's cost and time, languages, length, shape); Run proof on a
// variant (template.make-post with the variant id) makes a run carrying that variantId; Make a post's trigger is
// "make-a-post". Network guard on; stub connectors are flagged live inside this test only; nothing is posted.
import './guard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptProof } from '@/lib/studio/postmaker/accept';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, handleAction, home, type ServiceProject } from '@/lib/studio/postmaker/service';
import { readRun } from '@/lib/studio/postmaker/store/runs';
import { readTemplate } from '@/lib/studio/postmaker/store/templates';
import { templateCard } from '@/lib/studio/postmaker/template-actions';
import type { PostmakerAction, Run } from '@/lib/studio/postmaker/types';
import { cleanRun, postsProject, withPostsProject, withVerdict } from './accept-fixtures';
import { tmp } from './guard';

withPostsProject();

const ACTOR = { email: 'owner@example.test' };
const project = (): ServiceProject => postsProject();
const act = (a: PostmakerAction) => handleAction(project(), ACTOR, a);

beforeEach(() => {
  _resetEngineState();
  _resetSchedulerState();
  _setServiceDeps({ executors: withVerdict('premium'), allowed: () => true, buildOptions: () => ({}) });
});
afterEach(() => _setServiceDeps({}));

async function untilAtProof(runId: string): Promise<Run> {
  for (let i = 0; i < 400; i++) {
    const r = await readRun(tmp.root, runId);
    if (r && r.status === 'needs-you' && r.pausedFor === 'check') return r;
    if (r && (r.status === 'failed' || r.status === 'stopped')) throw new Error(`run stopped: ${r.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the run did not reach Proof');
}

describe('Proven on the server: an accepted stub-Premium proof is a Proven template card on Home', () => {
  it('Home lists it Proven with its card: steps of the snapshot, the proof run cost and time, languages, length, shape', { timeout: 30_000 }, async () => {
    const s = await cleanRun({ verdict: 'premium', langs: ['en'] });
    const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: ACTOR.email });
    expect(r.template).toMatchObject({ status: 'proven', provenRunId: s.run.id });
    const h = await home(project());
    expect(h.templates).toEqual([expect.objectContaining({ id: r.template.id, status: 'proven', name: 'Story spine' })]);
    const card = h.templateCards?.[r.template.id];
    expect(card).toBeDefined();
    expect(card!.steps).toBe(Object.keys(r.template.snapshot.heads).length);
    expect(card!.steps).toBeGreaterThan(3);
    expect(card!.usd).toBe(s.run.spentUsd);
    expect(card!.languages).toEqual(['en']);
    expect(card!.lengthSec).toBeGreaterThan(0);
    expect(card!.shape).toBe('9:16');
    expect(card!.lastRunAt).toBe(s.run.startedAt);
  });

  it('a template whose proof run and recipe are gone still gives a card (counts only, nulls elsewhere)', async () => {
    const s = await cleanRun({ verdict: 'premium', langs: ['en'] });
    const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: ACTOR.email });
    const t = (await readTemplate(tmp.root, r.template.id))!;
    const card = await templateCard(tmp.root, { ...t, provenRunId: 'run-20200101-000000-0000', recipeId: 'rc-20200101-0000' }, []);
    expect(card).toEqual({ steps: Object.keys(t.snapshot.heads).length, usd: null, seconds: null, lastRunAt: null, languages: [], lengthSec: null, shape: null, cover: null });
  });
});

describe('Proven on the server: Make a post and Run proof on a variant', () => {
  it('Make a post runs with trigger "make-a-post"; Run proof on a variant makes a run with that variantId', { timeout: 60_000 }, async () => {
    const s = await cleanRun({ verdict: 'premium', langs: ['en'] });
    const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: ACTOR.email });
    const post = await act({ action: 'template.make-post', templateId: r.template.id, brief: { topic: 'A rainy evening' } });
    expect(post.status).toBe(202);
    const postRun = await untilAtProof((post.body as { runId: string }).runId);
    expect(postRun).toMatchObject({ trigger: 'make-a-post', templateId: r.template.id, variantId: null });

    // Add variant refuses a length the template cannot make, with its reason (the chip shows the same reason).
    const bad = await act({ action: 'template.variant.save', templateId: r.template.id, variant: { label: 'Short', params: { lengthSec: 15 } } }).catch((e: unknown) => e as { status: number; message: string });
    expect(bad).toMatchObject({ status: 400, message: 'This template makes 30-90 s videos.' });
    const saved = await act({ action: 'template.variant.save', templateId: r.template.id, variant: { label: 'Thirty', params: { lengthSec: 30 } } });
    const variantId = (saved.body as { variant: { id: string } }).variant.id;
    const proof = await act({ action: 'template.make-post', templateId: r.template.id, variantId, brief: { topic: 'A rainy evening' } });
    expect(proof.body).toMatchObject({ variantId });
    const proofRun = await untilAtProof((proof.body as { runId: string }).runId);
    expect(proofRun).toMatchObject({ templateId: r.template.id, variantId, trigger: 'make-a-post' });
    const h = await home(project());
    expect(h.runs.find((x) => x.id === proofRun.id)).toMatchObject({ trigger: 'make-a-post', templateId: r.template.id });
  });
});
