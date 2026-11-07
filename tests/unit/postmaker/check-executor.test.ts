// @vitest-environment node
// `check` executor: the fallback chain (Agent SDK reviewer with get_run_frames → CLI reviewer → deterministic
// only → Unscored), the Post maker reviewer envelope (opus, $1.00, 12 turns) through runRole with a
// fake queryFn (no live SDK call), a rejected answer with an applicable score and no evidence, mock mode, and score.json
// / routes.json written through the store as the check node's outputs in a full mock run.
import './guard';
import { rmSync } from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { proofProjection } from '@/lib/studio/postmaker/checks/proof';
import { checkExecutor, defaultSdkReviewer, runFramesTool, type CliReviewer, type SdkReviewer } from '@/lib/studio/postmaker/executors/check';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { getJson, putBytes } from '@/lib/studio/postmaker/store/objects';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import type { CheckResult, PipelineNode, PreviewStrip, Recipe, RoutesDoc } from '@/lib/studio/postmaker/types';
import { POSTMAKER_ROLES, POSTMAKER_TOOL_NAMES, ROLES } from '@/lib/studio/team/roles';
import { reviewerEnvelope } from '@/lib/studio/postmaker/executors/check';
import type { CheckSubject } from '@/lib/studio/postmaker/checks/deterministic';
import { answer, baseSubject } from './check-fixtures';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';
import { cleanupTeamEnv, fakeQuery, setupTeamRoot } from '../team-helpers';

let teamRoot = '';
afterEach(() => {
  cleanupTeamEnv();
  if (teamRoot) rmSync(teamRoot, { recursive: true, force: true });
  teamRoot = '';
});

const NODE: PipelineNode = { id: 'check', kind: 'check', lang: null, title: 'Check', role: 'reviewer', connectorChain: ['agent-sdk', 'claude-cli', 'deterministic-only'], params: {}, instructions: '', inputs: [], expects: [], gate: { id: 'proof', blocks: 'before-accept' }, attendance: 'any' };

function input(o: Partial<ExecInput> = {}): ExecInput {
  return {
    recipe: { id: 'rc-20261106-0001', languages: ['en'] } as unknown as Recipe,
    node: NODE,
    lang: null,
    inputs: [],
    byPort: {},
    params: {},
    seed: 1,
    mode: 'live',
    connector: 'agent-sdk',
    note: null,
    beats: null,
    pinnedBeats: [],
    previous: null,
    violations: [],
    take: 1,
    context: null,
    runId: 'run-test',
    now: () => Date.parse('2026-11-06T10:00:00.000Z'),
    signal: new AbortController().signal,
    ...o,
  };
}

async function fixtureStrip(): Promise<PreviewStrip> {
  const frames: PreviewStrip['frames'] = [];
  for (const [frame, c] of [[0, 30], [60, 120], [450, 220]] as const) {
    const png = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: c, g: 40, b: 90 } } }).png().toBuffer();
    frames.push({ frame, sha256: (await putBytes(tmp.root, png)).sha256, mime: 'image/png' });
  }
  return { lang: 'en', fps: 30, width: 1080, height: 1920, frames };
}

const run = async (deps: Parameters<typeof checkExecutor>[0], i: Partial<ExecInput> = {}, subject: CheckSubject = baseSubject()) => {
  const ex = checkExecutor({ gather: async () => [subject], ...deps });
  const r = await ex.run(input(i));
  return { r, score: r.outputs.find((o) => o.port === 'score')!.data as CheckResult, routes: r.outputs.find((o) => o.port === 'routes')!.data as RoutesDoc };
};

describe('Post maker reviewer envelope', () => {
  it('reviewer: opus, $1.00, 12 turns, only get_run_frames; the memory-team reviewer keeps its own envelope', () => {
    expect(reviewerEnvelope()).toEqual({ title: 'Check', model: 'opus', maxBudgetUsd: 1, maxTurns: 12, tools: ['get_run_frames'] });
    expect(POSTMAKER_ROLES.reviewer).toMatchObject({ id: 'reviewer', runner: 'sdk', steps: { check: { model: 'opus', budgetUsd: 1, maxTurns: 12 } } });
    expect(POSTMAKER_ROLES['motion-designer'].steps.captions).toEqual({ model: 'sonnet', budgetUsd: 0.6, maxTurns: 15 });
    expect(POSTMAKER_TOOL_NAMES).toEqual(['get_run_frames']);
    expect(ROLES.reviewer).toMatchObject({ model: 'sonnet', maxBudgetUsd: 0.3 });
  });

  it('runs through runRole with the fake queryFn: caps, tools and prompt from the envelope, no memory pack', async () => {
    teamRoot = setupTeamRoot();
    const { queryFn, calls } = fakeQuery({ structured_output: answer(5), total_cost_usd: 0.42 }, 'claude-opus-test');
    const strip = await fixtureStrip();
    const { score, r } = await run({ sdk: defaultSdkReviewer(queryFn), root: tmp.root }, {}, baseSubject({ strip }));
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o.maxBudgetUsd).toBe(1);
    expect(o.maxTurns).toBe(12);
    expect(o.model).toBe('opus');
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(['mcp__signal__get_run_frames']);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'WebFetch', 'WebSearch']));
    expect(String(o.systemPrompt)).toContain('# Check (Post maker reviewer)');
    expect(calls[0]!.prompt).not.toContain('<context_pack');
    expect(calls[0]!.prompt).toContain('Call get_run_frames first');
    expect(calls[0]!.prompt).toMatch(/<untrusted_data>[\s\S]*Five letters make one word[\s\S]*<\/untrusted_data>/);
    // The guard hook allows the envelope tool only; memory-team tools and built-ins are denied.
    const hook = o.hooks!.PreToolUse![0]!.hooks[0]!;
    const pre = (tool_name: string) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: {}, tool_use_id: 'tu', session_id: 's', transcript_path: '/dev/null', cwd: '/' } as never, 'tu', { signal: new AbortController().signal });
    expect(await pre('mcp__signal__get_run_frames')).toEqual({ continue: true });
    expect(await pre('mcp__signal__read_pack')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await pre('Bash')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(score.reviewer).toBe('agent-sdk');
    expect(score.sheets[0]).toMatchObject({ lang: 'en', verdict: 'premium', scoredBy: 'agent-sdk' });
    expect(score.costUsd).toBe(0.42);
    expect(r.costUsd).toBe(0.42);
    expect(r.status).toBe('ok');
  });
});

describe('get_run_frames over the preview strip (fixture strip until)', () => {
  it('returns the nearest sampled frames at phone size (360 px wide), at most 8', async () => {
    const strip = await fixtureStrip();
    const t = runFramesTool({ strips: [strip], load: async (sha) => (await import('@/lib/studio/postmaker/store/objects')).getBytes(tmp.root, sha) });
    expect(t.name).toBe('get_run_frames');
    const out = await t.handler({ frames: [2, 59, 400] }, {});
    const head = JSON.parse((out.content[0] as { text: string }).text) as { served: { asked: number; frame: number }[] };
    expect(head.served).toEqual([
      { asked: 2, frame: 0 },
      { asked: 59, frame: 60 },
      { asked: 400, frame: 450 },
    ]);
    const images = out.content.filter((c) => c.type === 'image') as { data: string; mimeType: string }[];
    expect(images).toHaveLength(3);
    const meta = await sharp(Buffer.from(images[0]!.data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([360, 640]);
    const none = await runFramesTool({ strips: [], load: async () => new Uint8Array() }).handler({ frames: [0] }, {});
    expect(none.isError).toBe(true);
  });
});

describe('fallback chain', () => {
  it('with the SDK unavailable (no approvals, no key) the verdict is Unscored and the Proof projection says so', async () => {
    const { queryFn, calls } = fakeQuery({ structured_output: answer(5) });
    const { score, routes } = await run({ sdk: defaultSdkReviewer(queryFn) });
    expect(calls).toHaveLength(0); // teamAllowed() refused before any SDK call
    expect(score.reviewer).toBe('deterministic-only');
    const sheet = score.sheets[0]!;
    expect(sheet.verdict).toBe('unscored');
    expect(sheet.scores.every((s) => s.score === null)).toBe(true);
    expect(routes.routes).toEqual([]);
    const p = proofProjection(sheet, routes);
    expect(p).toMatchObject({ verdict: 'unscored', manualScoring: true, verdictAllowsAccept: false, unscored: { reason: 'No reviewer was available. Score it yourself, or accept as draft.' } });
    expect(p.checks.map((c) => c.id)).toEqual(['loudness', 'safe-zones', 'caption-match', 'ai-label', 'fonts', 'frame-count']);
    expect(p.hardGates.map((g) => g.criterion)).toEqual(['C3', 'C8', 'C11']);
  });

  it('a fake reviewer answer with an applicable score and empty evidence is rejected; no CLI → Unscored', async () => {
    teamRoot = setupTeamRoot();
    const bad = answer(5);
    bad.scores = bad.scores.map((s) => (s.criterion === 'C4' ? { ...s, evidence: [] } : s));
    const { queryFn, calls } = fakeQuery({ structured_output: bad });
    const { score } = await run({ sdk: defaultSdkReviewer(queryFn) });
    expect(calls).toHaveLength(1);
    expect(score.sheets[0]).toMatchObject({ verdict: 'unscored', unscoredReason: "The reviewer's answer was incomplete. Score it yourself, or accept as draft." });
  });

  it('falls back to the CLI reviewer when the SDK fails; a CLI answer without evidence is rejected too', async () => {
    const sdkCalls: number[] = [];
    const sdk: SdkReviewer = async () => {
      sdkCalls.push(1);
      throw new Error('The Check failed (error_during_execution)');
    };
    const prompts: string[] = [];
    const cli: CliReviewer = async (req) => {
      prompts.push(req.prompt);
      return { text: '```json\n' + JSON.stringify(answer(4)) + '\n```', costUsd: 0, model: 'claude-cli-test' };
    };
    const { score } = await run({ sdk, cli });
    expect(sdkCalls).toHaveLength(1);
    expect(score.reviewer).toBe('claude-cli');
    expect(score.sheets[0]!.verdict).toBe('regenerate'); // all 4s: the hard gates are below 5
    expect(prompts[0]).toContain('You cannot see frames in this mode');
    expect(prompts[0]).toMatch(/<untrusted_data>[\s\S]*<\/untrusted_data>/);
    const empty = answer(5);
    empty.scores[0] = { ...empty.scores[0]!, evidence: [] };
    const r2 = await run({ sdk, cli: async () => ({ text: JSON.stringify(empty), costUsd: 0, model: null }) });
    expect(r2.score.sheets[0]!.verdict).toBe('unscored');
  });

  it('a claude-cli connector skips the SDK; deterministic-only and mock mode call no reviewer and spend nothing', async () => {
    let sdkCalls = 0;
    const sdk: SdkReviewer = async () => {
      sdkCalls++;
      return { value: answer(5), costUsd: 1, model: 'x' };
    };
    const viaCli = await run({ sdk, cli: async () => ({ text: JSON.stringify(answer(5)), costUsd: 0.2, model: null }) }, { connector: 'claude-cli' });
    expect(viaCli.score.reviewer).toBe('claude-cli');
    expect(sdkCalls).toBe(0);
    const det = await run({ sdk }, { connector: 'deterministic-only' });
    expect(det.score.sheets[0]!.verdict).toBe('unscored');
    const mock = await run({ sdk }, { mode: 'mock' });
    expect(sdkCalls).toBe(0);
    expect(mock.score.sheets[0]).toMatchObject({ verdict: 'unscored', unscoredReason: 'Mock run, so not scored. Accept as draft only.' });
    expect(mock.r.costUsd).toBe(0);
  });

  it('routes failing criteria and records each Proof row as a step check', async () => {
    const a = answer(5);
    a.scores = a.scores.map((s) => (s.criterion === 'C9' ? { ...s, score: 2, note: 'Music masks the narration.' } : s.criterion === 'C8' ? { ...s, score: 3, evidence: [{ kind: 'text', ref: 'pronunciation:l01' }] } : s));
    const { score, routes, r } = await run({ sdk: async () => ({ value: a, costUsd: 0.5, model: 'opus' }) });
    expect(score.sheets[0]!.verdict).toBe('regenerate');
    expect(routes.routes.map((x) => [x.criterion, x.nodeId])).toEqual([
      ['C8', 'voice:en'],
      ['C9', 'music'],
    ]);
    expect(r.checks!.map((c) => c.id)).toEqual(['check:en:loudness', 'check:en:safe-zones', 'check:en:caption-match', 'check:en:ai-label', 'check:en:fonts', 'check:en:frame-count']);
  });

  it('estimates the reviewer cap per language on the SDK, $0 in mock and deterministic-only', () => {
    const ex = checkExecutor({ gather: async () => [] });
    const recipe = { languages: ['fa', 'en'] } as unknown as Recipe;
    expect(ex.estimate({ recipe, node: NODE, connector: 'agent-sdk', mode: 'live', byPort: {} }).usdHigh).toBe(2);
    expect(ex.estimate({ recipe, node: NODE, connector: 'agent-sdk', mode: 'mock', byPort: {} }).usdHigh).toBe(0);
    expect(ex.estimate({ recipe, node: NODE, connector: 'deterministic-only', mode: 'live', byPort: {} }).usdHigh).toBe(0);
  });
});

describe('score.json and routes.json through the store', () => {
  it('a full mock run stores the check outputs: one sheet per language, Unscored, measured rows from the lineage', async () => {
    const s = await setup();
    const engine = new (s.engine.constructor as typeof import('@/lib/studio/postmaker/runner').PostmakerEngine)({ root: tmp.root, project: { id: 'example-project', timeZone: 'Asia/Tehran' }, executors: defaultExecutors({ fakes: s.fakes, check: { root: tmp.root } }), packLock: null, now: () => (s.now.t += 1000) });
    const done = await runAll(engine, s.recipeId);
    expect(done.status).toBe('done');
    const head = await readHead(tmp.root, s.recipeId, 'check');
    const v = (await readVersion(tmp.root, s.recipeId, 'check', head.current!))!;
    expect(v.implVersion).toBe('check@2');
    expect(v.outputs.map((o) => [o.port, o.name])).toEqual([
      ['score', 'score.json'],
      ['routes', 'routes.json'],
    ]);
    const score = await getJson<CheckResult>(tmp.root, v.outputs[0]!.sha256, { verify: true });
    const routes = await getJson<RoutesDoc>(tmp.root, v.outputs[1]!.sha256, { verify: true });
    expect(score).toMatchObject({ schema: 'signal.pm.score/1', runId: done.id, reviewer: 'deterministic-only', costUsd: 0 });
    expect(routes).toEqual({ schema: 'signal.pm.routes/1', runId: done.id, routes: [] });
    expect(score.sheets.map((x) => [x.lang, x.verdict])).toEqual([
      ['fa', 'unscored'],
      ['en', 'unscored'],
    ]);
    const fa = score.sheets[0]!;
    const row = (id: string) => fa.checks.find((c) => c.id === id)!;
    expect(row('frame-count')).toMatchObject({ ok: true, measured: true });
    expect(row('caption-match').measured).toBe(true);
    expect(row('safe-zones')).toMatchObject({ ok: false, measured: false, reason: 'Not measured yet.' });
    expect(fa.unscoredReason).toBe('Mock run, so not scored. Accept as draft only.');
    expect(fa.findings.some((f) => f.id.startsWith('pacing.'))).toBe(true); // the fake timeline is linted with frame numbers
  });
});
