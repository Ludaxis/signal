// @vitest-environment node
// Server additions for the Post maker screens: the RecipeView extras (reference, person-made sign-offs, notes, the
// Proof projection, version outputs), `?only=recipe` for a recipe without a pipeline, the camelCase expect ids in
// `step.regenerate`, and manual scoring on an Unscored live proof (`proof.score`) with Accept honouring it only on the
// exact check version it was made on. Signed owner session; network guard on; fakes only.
import './guard';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from '@/lib/server/auth';
import { COOKIE_PLAIN } from '@/lib/server/session';
import * as home from '@/app/api/studio/postmaker/route';
import * as recipes from '@/app/api/studio/postmaker/recipes/[id]/route';
import { acceptProof } from '@/lib/studio/postmaker/accept';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { runDeterministic } from '@/lib/studio/postmaker/checks/deterministic';
import { draftSheet } from '@/lib/studio/postmaker/checks/sheet';
import { CRITERIA_IDS, isHardGate, type ReviewerAnswer } from '@/lib/studio/postmaker/checks/rubric';
import { proofProjections } from '@/lib/studio/postmaker/checks/proof';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { mockPostCopy, validatePostCopy } from '@/lib/studio/postmaker/executors/post-copy';
import { DEFAULT_TEMPO, mockScriptProposal } from '@/lib/studio/postmaker/executors/script';
import type { ExecutorRegistry } from '@/lib/studio/postmaker/executors/types';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { manualScoreFile, readManualScore, runVerdict, scoreProof } from '@/lib/studio/postmaker/manual-score';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, proofOf } from '@/lib/studio/postmaker/service';
import { signoffsDep } from '@/lib/studio/postmaker/signoffs';
import { createRecipe } from '@/lib/studio/postmaker/store/recipes';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { readRun } from '@/lib/studio/postmaker/store/runs';
import type { CheckResult, RecipeOnlyView, RecipeView, RubricSheet } from '@/lib/studio/postmaker/types';
import { existsSync } from 'node:fs';
import { acceptState } from '@/app/studio/postmaker/model';
import { readVerdict, verdictOf } from '@/lib/studio/postmaker/verdict';
import { cleanRun, postsProject, withPostsProject } from './accept-fixtures';
import { answer, baseSubject } from './check-fixtures';
import { runAll, setup } from './engine-fixtures';
import { TEST_PROJECT } from '../studio-helpers';
import { tmp } from './guard';
import { recipeDraft } from './recipe-fixture';

withPostsProject();

const ORIGIN = 'http://localhost:3000';
const P = TEST_PROJECT.id;
let token = '';
const saved = { secret: process.env.SIGNAL_SESSION_SECRET, renderDir: process.env.SIGNAL_RENDER_SERVICE_DIR, origin: process.env.SIGNAL_WEB_ORIGIN };

beforeEach(() => {
  process.env.SIGNAL_RENDER_SERVICE_DIR = `${tmp.dir}/no-render-service`;
  delete process.env.SIGNAL_WEB_ORIGIN;
  process.env.SIGNAL_SESSION_SECRET = 'postmaker-screens-test-secret-00000';
  token = issueSession();
  _resetEngineState();
  _resetSchedulerState();
});
afterEach(() => {
  _setServiceDeps({});
  for (const [k, v] of Object.entries({ SIGNAL_SESSION_SECRET: saved.secret, SIGNAL_RENDER_SERVICE_DIR: saved.renderDir, SIGNAL_WEB_ORIGIN: saved.origin })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const cookie = () => ({ cookie: `${COOKIE_PLAIN}=${token}` });
const getRecipe = (id: string, extra = '') => recipes.GET(new NextRequest(`${ORIGIN}/api/studio/postmaker/recipes/${id}?project=${P}${extra}`, { headers: cookie() }), { params: Promise.resolve({ id }) });

/** The real check output shape (a CheckResult with one Unscored sheet per language), written by a stub check. */
function unscoredCheck(): ExecutorRegistry {
  const ex = defaultExecutors({});
  return {
    ...ex,
    check: {
      ...ex.check,
      run: async (i) => {
        const r = await ex.check.run(i);
        const sheets: RubricSheet[] = (['en'] as const).map((lang) => draftSheet({ lang, medium: 'video', animated: true, report: runDeterministic(baseSubject({ lang })), answer: null, scoredBy: 'deterministic-only', unscoredReason: null }));
        const doc: CheckResult = { schema: 'signal.pm.score/1', runId: i.runId, reviewer: 'deterministic-only', sheets, costUsd: 0 };
        return { ...r, outputs: r.outputs.map((o) => (o.port === 'score' ? { ...o, data: doc } : o)) };
      },
    },
  };
}

/** The real check output with a reviewer's scores on every language (no top-level `verdict`). */
function scoredCheck(score: 1 | 2 | 3 | 4 | 5): ExecutorRegistry {
  const ex = defaultExecutors({});
  return {
    ...ex,
    check: {
      ...ex.check,
      run: async (i) => {
        const r = await ex.check.run(i);
        const sheets: RubricSheet[] = (['fa', 'en'] as const).map((lang) => {
          const sheet = draftSheet({ lang, medium: 'video', animated: true, report: runDeterministic(baseSubject({ lang })), answer: answer(score), scoredBy: 'agent-sdk', unscoredReason: null });
          // The Persian C8 confirmation is the signed reader's (the run's sign-offs stand in for it in this fixture).
          return { ...sheet, scores: sheet.scores.map((x) => (x.criterion === 'C8' ? { ...x, confirmedBy: 'Editor A' } : x)) };
        });
        const doc: CheckResult = { schema: 'signal.pm.score/1', runId: i.runId, reviewer: 'agent-sdk', sheets, costUsd: 0 };
        return { ...r, outputs: r.outputs.map((o) => (o.port === 'score' ? { ...o, data: doc } : o)) };
      },
    },
  };
}

/** A reviewer answer with every hard gate (C3, C8, C11) at `hard`, every other criterion at `rest`, and C1 at `c1`. */
const answerMix = (hard: 1 | 2 | 3 | 4 | 5, rest: 1 | 2 | 3 | 4 | 5, c1: 1 | 2 | 3 | 4 | 5 = rest): ReviewerAnswer => {
  const a = answer(rest);
  return { ...a, scores: a.scores.map((x) => ({ ...x, score: isHardGate(x.criterion) ? hard : x.criterion === 'C1' ? c1 : rest })) };
};
const PREMIUM = answerMix(5, 5);
const STANDARD = answerMix(5, 4, 3); // hard gates 5, the rest 4 with C1 at 3: Standard, never Premium
const REGENERATE = answerMix(4, 4); // a hard gate below 5

/** A real `CheckResult` (signal.pm.score/1, one draftSheet per language, no top-level verdict). */
function realCheckResult(runId: string, per: Partial<Record<'fa' | 'en', ReviewerAnswer>>): CheckResult {
  const sheets: RubricSheet[] = (Object.entries(per) as ['fa' | 'en', ReviewerAnswer][]).map(([lang, ans]) => {
    const sheet = draftSheet({ lang, medium: 'video', animated: true, report: runDeterministic(baseSubject({ lang })), answer: ans, scoredBy: 'agent-sdk', unscoredReason: null });
    return { ...sheet, scores: sheet.scores.map((x) => (x.criterion === 'C8' ? { ...x, confirmedBy: 'Editor A' } : x)) };
  });
  return { schema: 'signal.pm.score/1', runId, reviewer: 'agent-sdk', sheets, costUsd: 0 };
}

/** The check writes a real CheckResult with the given answer per language. */
function checkWith(per: Partial<Record<'fa' | 'en', ReviewerAnswer>>): ExecutorRegistry {
  const ex = defaultExecutors({});
  return {
    ...ex,
    check: {
      ...ex.check,
      run: async (i) => {
        const r = await ex.check.run(i);
        return { ...r, outputs: r.outputs.map((o) => (o.port === 'score' ? { ...o, data: realCheckResult(i.runId, per) } : o)) };
      },
    },
  };
}

describe('the screen and Accept read the same verdict (review fix)', () => {
  it('verdictOf: a top-level verdict wins; a CheckResult without one takes its weakest language', () => {
    expect(verdictOf({ verdict: 'Premium' }).verdict).toBe('premium');
    expect(verdictOf({ schema: 'signal.pm.score/1', sheets: [{ lang: 'fa', verdict: 'premium' }, { lang: 'en', verdict: 'standard' }] }).verdict).toBe('standard');
    expect(verdictOf({ sheets: [{ verdict: 'premium' }, { verdict: 'unscored' }] }).verdict).toBe('unscored');
    expect(verdictOf({ sheets: [] }).verdict).toBe('unscored');
    expect(verdictOf({ sheets: [{ verdict: 'bogus' }] }).verdict).toBe('unscored');
  });

  it('a live, signed run whose check scored every language Premium: the screen offers Accept and the server accepts it cleanly', { timeout: 30_000 }, async () => {
    const ex = scoredCheck(5);
    const s = await cleanRun({ executors: ex, id: 'rc-20261106-00bb' });
    _setServiceDeps({ executors: ex, allowed: () => true }); // the view reads the same registry and liveness as the run
    const head = await readHead(tmp.root, s.recipeId, 'check');
    const check = (await readVersion(tmp.root, s.recipeId, 'check', head.current!))!;
    const proof = await proofOf(tmp.root, check, s.run.id);
    const server = (await readVerdict(tmp.root, check)).verdict;
    expect(proof.map((p) => p.verdict)).toEqual([server, server]);
    expect(server).toBe('premium');
    const v = (await (await getRecipe(s.recipeId)).json()) as RecipeView;
    expect(acceptState(v)).toMatchObject({ asDraft: false, disabled: false, reason: null });
    const a = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Scored by the reviewer', by: 'owner@example.test' });
    expect(a).toMatchObject({ asDraft: false, verdict: 'premium' });
    expect(a.packageIds).toHaveLength(2);
  });

  it('a real CheckResult reads as its weakest language (fa Premium + en Standard = Standard; fa Regenerate = Regenerate)', () => {
    const mixed = realCheckResult('fixture', { fa: PREMIUM, en: STANDARD });
    expect(mixed.sheets.map((x) => [x.lang, x.verdict])).toEqual([['fa', 'premium'], ['en', 'standard']]);
    expect('verdict' in mixed).toBe(false);
    expect(verdictOf(mixed)).toEqual({ verdict: 'standard', manual: false });
    expect(runVerdict(mixed.sheets)).toBe('standard');
    const regen = realCheckResult('fixture', { fa: REGENERATE, en: PREMIUM });
    expect(regen.sheets.map((x) => x.verdict)).toEqual(['regenerate', 'premium']);
    expect(verdictOf(regen).verdict).toBe('regenerate');
    // The Proof screen's fallback applies the same rule to the projections.
    const view = { recipe: { languages: ['fa', 'en'] }, nodes: [], signoffs: [], run: null, proof: proofProjections(mixed, null) } as unknown as Parameters<typeof acceptState>[0];
    expect(runVerdict(view.proof)).toBe('standard');
    expect(verdictOf({ ...mixed, verdict: null }).verdict).toBe('standard'); // a null top-level verdict is no verdict
  });

  it('through the API: the view and Accept read Standard from fa Premium + en Standard; fa Regenerate blocks a clean Accept', { timeout: 60_000 }, async () => {
    const ex = checkWith({ fa: PREMIUM, en: STANDARD });
    const s = await cleanRun({ executors: ex, id: 'rc-20261107-00cc' });
    _setServiceDeps({ executors: ex, allowed: () => true });
    const v = (await (await getRecipe(s.recipeId)).json()) as RecipeView;
    expect(v.proof.map((p) => [p.lang, p.verdict])).toEqual([['fa', 'premium'], ['en', 'standard']]);
    expect(v.verdict).toBe('standard');
    expect(acceptState(v)).toMatchObject({ asDraft: false, disabled: false, reason: null });
    const post = (body: Record<string, unknown>) => home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...cookie() }, body: JSON.stringify({ project: P, ...body }) }));
    const ok = await post({ action: 'proof.accept', runId: s.run.id, asDraft: false, templateName: 'Weakest language decides' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ asDraft: false, verdict: 'standard' });

    const ex2 = checkWith({ fa: REGENERATE, en: PREMIUM });
    const s2 = await cleanRun({ executors: ex2, id: 'rc-20261107-00dd' });
    _setServiceDeps({ executors: ex2, allowed: () => true });
    const v2 = (await (await getRecipe(s2.recipeId)).json()) as RecipeView;
    expect(v2.verdict).toBe('regenerate');
    expect(acceptState(v2)).toMatchObject({ disabled: true, reason: 'regenerate' });
    const blocked = await post({ action: 'proof.accept', runId: s2.run.id, asDraft: false, templateName: 'Weakest language decides' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'accept-blocked' }, message: 'The check says regenerate. Fix the steps it names first.' } });
  });
});

describe('RecipeView extras and ?only=recipe', () => {
  it('a recipe without a pipeline answers 404 on the full view and the recipe on ?only=recipe; bad `only` is 400', async () => {
    const { recipe } = await createRecipe(tmp.root, { id: P, timeZone: 'Europe/Berlin' }, { ...recipeDraft(['en']), projectId: P }, { now: Date.parse('2026-11-06T10:00:00Z') });
    expect((await getRecipe(recipe.id)).status).toBe(404);
    const r = await getRecipe(recipe.id, '&only=recipe');
    expect(r.status).toBe(200);
    const b = (await r.json()) as RecipeOnlyView;
    expect(b.recipe.id).toBe(recipe.id);
    expect(b.pipeline).toBeNull();
    expect((await getRecipe(recipe.id, '&only=nodes')).status).toBe(400);
  });

  it('the full view carries reference, sign-offs, notes, proof and version outputs after a mock run', { timeout: 30_000 }, async () => {
    const s = await setup({ langs: ['en'], build: {}, id: 'rc-20261106-00aa' });
    const run = await runAll(s.engine, s.recipeId);
    expect(run.status).toBe('done');
    const post = await home.POST(new NextRequest(`${ORIGIN}/api/studio/postmaker`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...cookie() }, body: JSON.stringify({ project: P, action: 'note.add', runId: run.id, atSec: 3.5, text: 'Hook too small', nodeId: 'captions:en' }) }));
    expect(post.status).toBe(200);
    const r = await getRecipe(s.recipeId);
    expect(r.status).toBe(200);
    const v = (await r.json()) as RecipeView;
    expect(v.reference).toBeNull(); // the fixture recipe names a reference that was never stored
    expect(v.signoffs).toEqual([]);
    expect(v.notes).toMatchObject([{ runId: run.id, atSec: 3.5, text: 'Hook too small', nodeId: 'captions:en' }]);
    expect(Array.isArray(v.proof)).toBe(true);
    const script = v.nodes.find((n) => n.id === 'script')!;
    expect(script.versions[0]!.outputs.length).toBeGreaterThan(0);
    expect(script.versions[0]!.outputs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('step.regenerate accepts the builder rule ids (camelCase segments)', () => {
  it('parses narration.lineIds.exact and voice.lineMs.within; still refuses separators', () => {
    const base = { project: 'p', action: 'step.regenerate', recipeId: 'rc-20261106-0001', nodeId: 'voice:fa', mode: 'allow-breaks', estimateToken: 'a'.repeat(64) };
    expect(() => parseAction({ ...base, uncheckedExpects: ['narration.lineIds.exact', 'voice.lineMs.within'] })).not.toThrow();
    expect(() => parseAction({ ...base, uncheckedExpects: ['../x'] })).toThrow();
  });
});

describe('proof.score: manual scoring on an Unscored live proof', () => {
  const allScores = (score: 1 | 2 | 3 | 4 | 5, hard: 1 | 2 | 3 | 4 | 5 = 5) => CRITERIA_IDS.map((c) => ({ criterion: c, score: ['C3', 'C8', 'C11'].includes(c) ? hard : score, note: `Checked ${c} on the phone.` }));

  it('scores the sheet, the projection and Accept read it; a new check version drops it; mock runs are refused', { timeout: 30_000 }, async () => {
    const s = await setup({ langs: ['en'], build: {}, deps: { allowed: () => true, signoffs: signoffsDep(tmp.root), executors: unscoredCheck() } });
    const run = await runAll(s.engine, s.recipeId, { capUsd: 5 });
    expect(run.status).toBe('done');
    const head = await readHead(tmp.root, s.recipeId, 'check');
    const check = (await readVersion(tmp.root, s.recipeId, 'check', head.current!))!;
    expect((await proofOf(tmp.root, check, run.id)).map((p) => p.verdict)).toEqual(['unscored']);

    // A missing note is refused by the scoring rule; then a full set scores the sheet.
    await expect(scoreProof({ engine: s.engine, root: tmp.root, runId: run.id, lang: 'en', scores: [{ criterion: 'C1', score: 4, note: ' ' }], by: 'owner@example.test' })).rejects.toMatchObject({ status: 400 });
    const r = await scoreProof({ engine: s.engine, root: tmp.root, runId: run.id, lang: 'en', scores: allScores(5), by: 'owner@example.test' });
    expect(r.sheet).toMatchObject({ verdict: 'premium', scoredBy: 'manual' });
    expect(existsSync(manualScoreFile(tmp.root, run.id))).toBe(true);
    const proj = await proofOf(tmp.root, check, run.id);
    expect(proj[0]).toMatchObject({ verdict: 'premium', scoredBy: 'manual' });
    // Bound to the exact check version: a different hash reads as no record.
    expect(await readManualScore(tmp.root, run.id, { n: check.n, hash: 'f'.repeat(64) })).toBeNull();

    // Accept takes the manual verdict (the run is live; the template is proven by a Premium accept).
    const a = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: run.id, asDraft: false, templateName: 'Scored by hand', by: 'owner@example.test' });
    expect(a).toMatchObject({ asDraft: false, verdict: 'premium' });
    expect(a.packageIds).toHaveLength(1);
  });

  it('refuses a mock run (Accept as draft only) and a language the run does not have', { timeout: 30_000 }, async () => {
    const s = await setup({ langs: ['en'], build: {}, deps: { signoffs: signoffsDep(tmp.root), executors: unscoredCheck() } });
    const run = await runAll(s.engine, s.recipeId);
    await expect(scoreProof({ engine: s.engine, root: tmp.root, runId: run.id, lang: 'en', scores: allScores(4), by: 'owner@example.test' })).rejects.toMatchObject({ status: 409, code: 'mock' });
  });

  it('runVerdict: the weakest language decides', () => {
    expect(runVerdict([])).toBe('unscored');
    expect(runVerdict([{ verdict: 'premium' }, { verdict: 'standard' }])).toBe('standard');
    expect(runVerdict([{ verdict: 'premium' }, { verdict: 'unscored' }])).toBe('unscored');
    expect(runVerdict([{ verdict: 'standard' }, { verdict: 'regenerate' }])).toBe('regenerate');
  });

  it('the schema takes 1-5 scores with a note and refuses an unknown criterion', () => {
    const base = { project: 'p', action: 'proof.score', runId: 'run-20261106-100000-abcd', lang: 'en' };
    expect(() => parseAction({ ...base, scores: [{ criterion: 'C1', score: 4, note: 'ok' }] })).not.toThrow();
    expect(() => parseAction({ ...base, scores: [{ criterion: 'C13', score: 4, note: 'ok' }] })).toThrow();
    expect(() => parseAction({ ...base, scores: [{ criterion: 'C1', score: 6, note: 'ok' }] })).toThrow();
    expect(() => parseAction({ ...base, scores: [{ criterion: 'C1', score: 4, note: '' }] })).toThrow();
  });
});

describe('mock Make it with Persian and a reference read without words', () => {
  it('the mock CTA passes each language lint, so mock post-copy does not fail and the run reaches Proof', () => {
    const beats = recipeDraft(['fa', 'en']).beats.map((b) => ({ ...b, onScreenText: { fa: '', en: '' } }));
    const script = mockScriptProposal({ beats, languages: ['fa', 'en'] }, DEFAULT_TEMPO);
    for (const lang of ['fa', 'en'] as const) {
      const doc = { beats: script.beats.map((b) => ({ id: b.id, onScreen: { fa: b.onScreen.fa?.text ?? '', en: b.onScreen.en?.text ?? '' } })), cta: script.cta } as unknown as Parameters<typeof mockPostCopy>[0];
      expect(() => validatePostCopy(mockPostCopy(doc, lang), { lang, cta: script.cta[lang]!, claims: null })).not.toThrow();
    }
  });
});

describe('estimate tokens for Regenerate', () => {
  it("an estimate `for: 'regenerate'` gives the token step.regenerate checks; the run estimate of a current node does not", { timeout: 30_000 }, async () => {
    const { handleAction } = await import('@/lib/studio/postmaker/service');
    const s = await setup({ langs: ['en'], build: {} });
    const run = await runAll(s.engine, s.recipeId);
    expect(run.status).toBe('done');
    const project = { id: 'example-project', handle: '@x', contentDir: tmp.contentDir, timeZone: 'Asia/Tehran' };
    _setServiceDeps({ executors: defaultExecutors({}), buildOptions: () => ({}) });
    const plain = await handleAction(project, { email: 'owner@example.test' }, { action: 'estimate', recipeId: s.recipeId, scope: { nodes: ['voice:en'] } });
    expect((plain.body.plan as string[]).length).toBe(0);
    const exact = await handleAction(project, { email: 'owner@example.test' }, { action: 'estimate', recipeId: s.recipeId, scope: { nodes: ['voice:en'] }, for: 'regenerate' });
    expect(exact.body.plan).toEqual(['voice:en']);
    const token = (exact.body.estimate as { token: string }).token;
    const r = await handleAction(project, { email: 'owner@example.test' }, { action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'voice:en', mode: 'keep-contracts', estimateToken: token });
    expect(r.status).toBe(202);
    const here = await handleAction(project, { email: 'owner@example.test' }, { action: 'estimate', recipeId: s.recipeId, scope: { from: 'music' }, for: 'regenerate-from-here' });
    expect((here.body.plan as string[])[0]).toBe('music');
  });

  it('the estimate takes the regenerate options (nodeId + exact / fromHere), so confirm is one step; a changed estimate still answers 409', { timeout: 30_000 }, async () => {
    const { handleAction, estimateOptions } = await import('@/lib/studio/postmaker/service');
    const s = await setup({ langs: ['en'], build: {} });
    expect((await runAll(s.engine, s.recipeId)).status).toBe('done');
    const project = { id: 'example-project', handle: '@x', contentDir: tmp.contentDir, timeZone: 'Asia/Tehran' };
    const actor = { email: 'owner@example.test' };
    _setServiceDeps({ executors: defaultExecutors({}), buildOptions: () => ({}) });
    // Parsing: the same options step.regenerate / regenerate-from-here use.
    expect(parseAction({ project: 'p', action: 'estimate', recipeId: s.recipeId, nodeId: 'voice:en', exact: true })).toMatchObject({ nodeId: 'voice:en', exact: true });
    expect(estimateOptions({ action: 'estimate', recipeId: s.recipeId, nodeId: 'voice:en' })).toEqual({ scope: { nodes: ['voice:en'] }, exact: true, fromHere: false });
    expect(estimateOptions({ action: 'estimate', recipeId: s.recipeId, nodeId: 'music', fromHere: true })).toEqual({ scope: { from: 'music' }, exact: false, fromHere: true });
    expect(() => estimateOptions({ action: 'estimate', recipeId: s.recipeId, nodeId: 'music', exact: true, fromHere: true })).toThrow(/not both/);
    expect(() => estimateOptions({ action: 'estimate', recipeId: s.recipeId, scope: { all: true }, exact: true })).toThrow(/exact/i);
    expect(() => estimateOptions({ action: 'estimate', recipeId: s.recipeId, scope: { all: true }, nodeId: 'music' })).toThrow(/disagree/);
    expect(() => estimateOptions({ action: 'estimate', recipeId: s.recipeId })).toThrow(/scope or a step/);

    // One step: the estimate with the regenerate's options gives the token the action accepts.
    const exact = await handleAction(project, actor, { action: 'estimate', recipeId: s.recipeId, nodeId: 'voice:en', exact: true });
    expect(exact.body.plan).toEqual(['voice:en']);
    const r = await handleAction(project, actor, { action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'voice:en', mode: 'keep-contracts', estimateToken: (exact.body.estimate as { token: string }).token });
    expect(r.status).toBe(202);
    const runId = (r.body as { runId: string }).runId;
    for (let i = 0; i < 500; i++) {
      const x = await readRun(tmp.root, runId);
      if (x && x.status !== 'running' && x.status !== 'queued') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const here = await handleAction(project, actor, { action: 'estimate', recipeId: s.recipeId, nodeId: 'music', fromHere: true });
    expect((here.body.plan as string[])[0]).toBe('music');

    // A genuinely changed estimate (the step's head moved since the estimate) still answers 409 estimate-changed.
    const stale = (exact.body.estimate as { token: string }).token;
    await expect(handleAction(project, actor, { action: 'step.regenerate', recipeId: s.recipeId, nodeId: 'voice:en', mode: 'keep-contracts', estimateToken: stale })).rejects.toMatchObject({ status: 409, code: 'estimate-changed' });
  });
});
