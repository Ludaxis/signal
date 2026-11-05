// ClaudeJudge over a fake fetch: request shape, parsing and renormalisation, cost, redaction, gating.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, ClaudeJudge, FakeJudge, JudgeError, buildJudgePrompt, claudeJudgeAvailable, estimateCostUsd, matchAnswers, normaliseAnswer, parseJudgeJson, stripIdentifiers, type JudgeQuestion } from '@/lib/studio/memory/judge';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
let root = '';
const Q = {
  pred: { name: 'answer-unambiguous#0', kind: 'predicate', instructions: 'Is the answer unambiguous?' } satisfies JudgeQuestion,
  choice: { name: 'comment-kind#1', kind: 'choice', instructions: 'Kind of comment?', choices: [{ value: 'question', description: 'Asks' }, { value: 'praise', description: 'Likes' }, { value: 'other', description: 'Else' }] } satisfies JudgeQuestion,
  score: { name: 'brief-match#2', kind: 'score', instructions: 'Match?', levels: ['1', '2', '3', '4', '5'].map((label) => ({ label, description: `Level ${label}` })) } satisfies JudgeQuestion,
};

interface Captured { url: string; init: RequestInit }
/** A fetch double that records the request and replies with a Messages API body. */
function fakeFetch(reply: (c: Captured, n: number) => { status?: number; body: unknown }): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    const r = reply(c, calls.length);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const messages = (text: string, usage = { input_tokens: 1000, output_tokens: 100 }, model = 'claude-haiku-5-5-20260101') => ({ content: [{ type: 'text', text }], usage, model });
const bodyOf = (c: Captured) => JSON.parse(String(c.init.body)) as { model: string; max_tokens: number; temperature: number; system: string; messages: { role: string; content: string }[] };
const headersOf = (c: Captured) => c.init.headers as Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-judge-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_PROMPTS_DIR = root;
  process.env.SIGNAL_ANTHROPIC_API_KEY = KEY;
  mkdirSync(path.join(root, 'posts'));
  writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, claudeAgents: true, claudeApiKey: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_PROMPTS_DIR', 'SIGNAL_ANTHROPIC_API_KEY', 'SIGNAL_JUDGE_MODEL']) delete process.env[k];
});

describe('ClaudeJudge request', () => {
  it('posts to the Messages API with the key header, version, model, temperature 0 and a small token budget', async () => {
    const ff = fakeFetch(() => ({ body: messages('```json\n{"answers":[{"name":"answer-unambiguous#0","p_yes":0.93}]}\n```') }));
    const judge = new ClaudeJudge({ fetch: ff.fetch });
    const res = await judge.ask({ evidence: 'Slides: A B C. Answer: B.', questions: [Q.pred] });
    expect(ff.calls).toHaveLength(1);
    const c = ff.calls[0]!;
    expect(c.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(c.init.method).toBe('POST');
    expect(headersOf(c)['x-api-key']).toBe(KEY);
    expect(headersOf(c)['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headersOf(c).authorization).toBeUndefined();
    const b = bodyOf(c);
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.temperature).toBe(0);
    expect(b.max_tokens).toBeLessThanOrEqual(400);
    expect(b.system).toContain('strict JSON');
    expect(b.messages[0]!.content).toContain('Slides: A B C. Answer: B.');
    expect(b.messages[0]!.content).toContain('name="answer-unambiguous#0" kind=predicate');
    expect(res.answers[0]).toEqual({ name: 'answer-unambiguous#0', answer: true, probabilities: { yes: 0.93, no: 0.07 }, confidence: 0.93 });
    expect(res.model).toBe('claude-haiku-5-5-20260101');
    expect(res.costUsd).toBe(0.0015); // 1000 in × $1/MTok + 100 out × $5/MTok (estimate)
  });
  it('takes the model from SIGNAL_JUDGE_MODEL and strips odd characters', async () => {
    process.env.SIGNAL_JUDGE_MODEL = 'claude-sonnet-5-5; rm';
    const ff = fakeFetch(() => ({ body: messages('{"answers":[{"name":"answer-unambiguous#0","p_yes":0.1}]}') }));
    await new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'x', questions: [Q.pred] });
    expect(bodyOf(ff.calls[0]!).model).toBe('claude-sonnet-5-5rm');
  });
  it('strips @handles and e-mails from the evidence and wraps untrusted text', async () => {
    const ff = fakeFetch(() => ({ body: messages('{"answers":[{"name":"comment-kind#1","probabilities":{"question":1}}]}') }));
    await new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'Hey @puzzle.fan, mail me at someone@example.com — how do I win?', untrusted: true, questions: [Q.choice] });
    const content = bodyOf(ff.calls[0]!).messages[0]!.content;
    expect(content).not.toContain('@puzzle.fan');
    expect(content).not.toContain('someone@example.com');
    expect(content).toContain('Hey [handle], mail me at [email] — how do I win?');
    expect(content).toMatch(/<untrusted_data>\n[\s\S]*how do I win\?\n<\/untrusted_data>/);
    expect(content).toContain('- "question": Asks');
    const trusted = buildJudgePrompt({ evidence: 'plain', questions: [Q.pred] });
    expect(trusted).not.toContain('<untrusted_data>');
    expect(trusted).toContain('Answer with p_yes.');
  });
  it('batches more than 20 questions into several calls and sums the cost', async () => {
    const ff = fakeFetch((c) => {
      const names = [...bodyOf(c).messages[0]!.content.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
      return { body: messages(JSON.stringify({ answers: names.map((name) => ({ name, p_yes: 0.6 })) })) };
    });
    const questions = Array.from({ length: 23 }, (_, i) => ({ ...Q.pred, name: `q${i}` }));
    const res = await new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions });
    expect(ff.calls).toHaveLength(2);
    expect(bodyOf(ff.calls[0]!).messages[0]!.content.match(/name="/g)).toHaveLength(20);
    expect(res.answers).toHaveLength(23);
    expect(res.answers.map((a) => a.name)).toEqual(questions.map((q) => q.name));
    expect(res.costUsd).toBe(0.003);
  });
  it('rejects duplicate question names before calling out', async () => {
    const ff = fakeFetch(() => ({ body: {} }));
    await expect(new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions: [Q.pred, Q.pred] })).rejects.toThrow(/Duplicate question name/);
    expect(ff.calls).toHaveLength(0);
  });
});

describe('ClaudeJudge parsing', () => {
  it('reads fenced JSON, drops unknown options, clamps and renormalises', async () => {
    const text = 'Sure:\n```json\n{"answers":[{"name":"comment-kind#1","probabilities":{"question":2,"praise":1,"bogus":5,"other":-1}},{"name":"brief-match#2","probabilities":{"3":0.5,"4":0.5}},{"name":"answer-unambiguous#0","p_yes":1.7}]}\n```';
    const ff = fakeFetch(() => ({ body: messages(text) }));
    const res = await new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions: [Q.choice, Q.score, Q.pred] });
    expect(res.answers[0]).toEqual({ name: 'comment-kind#1', answer: 'question', probabilities: { question: 0.6667, praise: 0.3333, other: 0 }, confidence: 0.6667 });
    expect(res.answers[1]).toEqual({ name: 'brief-match#2', answer: 3.5, probabilities: { '1': 0, '2': 0, '3': 0.5, '4': 0.5, '5': 0 }, confidence: 0.5 });
    expect(res.answers[2]).toEqual({ name: 'answer-unambiguous#0', answer: true, probabilities: { yes: 1, no: 0 }, confidence: 1 });
  });
  it('falls back to uniform probabilities when nothing usable is given', () => {
    expect(normaliseAnswer(Q.choice, { name: Q.choice.name, probabilities: { bogus: 1 } }).probabilities).toEqual({ question: 0.3333, praise: 0.3333, other: 0.3333 });
    expect(normaliseAnswer(Q.pred, { name: Q.pred.name, probabilities: { yes: 0.25 } }).probabilities).toEqual({ yes: 0.25, no: 0.75 });
    expect(normaliseAnswer(Q.pred, { name: Q.pred.name })).toMatchObject({ probabilities: { yes: 0.5, no: 0.5 }, answer: true, confidence: 0.5 });
  });
  it('throws clear errors for invalid JSON, missing answers and bad responses', async () => {
    expect(() => parseJudgeJson('no json here')).toThrow(JudgeError);
    expect(parseJudgeJson('prefix {"answers":[]} suffix')).toEqual({ answers: [] });
    expect(() => matchAnswers([Q.pred, Q.choice], { answers: [{ name: Q.pred.name, p_yes: 0.5 }] })).toThrow(/did not answer: comment-kind#1/);
    const bad = fakeFetch(() => ({ body: 'not json' }));
    await expect(new ClaudeJudge({ fetch: bad.fetch }).ask({ evidence: 'e', questions: [Q.pred] })).rejects.toThrow(/unreadable response/);
    const prose = fakeFetch(() => ({ body: messages('I cannot decide.') }));
    await expect(new ClaudeJudge({ fetch: prose.fetch }).ask({ evidence: 'e', questions: [Q.pred] })).rejects.toThrow(/valid JSON/);
  });
  it('estimates cost from usage with per-model prices and returns null without usage', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { input_tokens: 2_000_000, output_tokens: 0 })).toBe(2);
    expect(estimateCostUsd('claude-sonnet-5-5-20260101', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(18);
    expect(estimateCostUsd('unknown-model', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(1);
    expect(estimateCostUsd('claude-haiku-5-5', undefined)).toBeNull();
    expect(estimateCostUsd('x', { input_tokens: 10, output_tokens: 10 }, { x: { inputPerMTok: 0.1, outputPerMTok: 0 } })).toBe(0.000001);
  });
});

describe('ClaudeJudge safety and gating', () => {
  it('never puts the key into thrown errors (HTTP error bodies, network failures)', async () => {
    const http = fakeFetch(() => ({ status: 401, body: { error: { message: `invalid x-api-key ${KEY}` } } }));
    const e1 = await new ClaudeJudge({ fetch: http.fetch }).ask({ evidence: 'e', questions: [Q.pred] }).catch((e: unknown) => e as JudgeError);
    expect(e1).toBeInstanceOf(JudgeError);
    expect((e1 as JudgeError).status).toBe(401);
    expect((e1 as JudgeError).message).toContain('HTTP 401');
    expect((e1 as JudgeError).message).toContain('[key]');
    expect((e1 as JudgeError).message).not.toContain(KEY);
    const net = { fetch: (async () => { throw new Error(`ECONNRESET while sending ${KEY}`); }) as typeof fetch };
    const e2 = await new ClaudeJudge({ fetch: net.fetch }).ask({ evidence: 'e', questions: [Q.pred] }).catch((e: unknown) => e as Error);
    expect((e2 as Error).message).toContain('[key]');
    expect((e2 as Error).message).not.toContain(KEY);
    expect(stripIdentifiers('a@b.co and @me.too')).toBe('[email] and [handle]');
  });
  it('refuses without the memory switch, without the API-key switch, and without the key — before any request', async () => {
    const ff = fakeFetch(() => ({ body: messages('{"answers":[]}') }));
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: false, claudeAgents: true, claudeApiKey: true });
    await expect(new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions: [Q.pred] })).rejects.toThrow(/"memory"/);
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, claudeAgents: true, claudeApiKey: false });
    await expect(new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions: [Q.pred] })).rejects.toThrow(/agentsApiKey/);
    expect((await claudeJudgeAvailable()).ok).toBe(false);
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, claudeAgents: true, claudeApiKey: true });
    delete process.env.SIGNAL_ANTHROPIC_API_KEY;
    await expect(new ClaudeJudge({ fetch: ff.fetch }).ask({ evidence: 'e', questions: [Q.pred] })).rejects.toThrow(/SIGNAL_ANTHROPIC_API_KEY|agentsApiKey/);
    expect(ff.calls).toHaveLength(0);
    process.env.SIGNAL_ANTHROPIC_API_KEY = KEY;
    expect(await claudeJudgeAvailable()).toEqual({ ok: true, reason: '' });
  });
});

describe('FakeJudge', () => {
  it('answers deterministically by question name or decision id', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'praise', 'brief-match#2': { '5': 1 }, 'answer-unambiguous#0': 0.2 }, { costUsd: null, model: 'fake-1' });
    const a = await judge.ask({ evidence: 'e', questions: [Q.choice, Q.score, Q.pred, { ...Q.pred, name: 'unknown#9' }] });
    const b = await judge.ask({ evidence: 'e', questions: [Q.choice, Q.score, Q.pred, { ...Q.pred, name: 'unknown#9' }] });
    expect(a).toEqual(b);
    expect(a.answers[0]).toMatchObject({ answer: 'praise', confidence: 0.9 });
    expect(a.answers[1]).toMatchObject({ answer: 5, confidence: 1 });
    expect(a.answers[2]).toMatchObject({ answer: false, probabilities: { yes: 0.2, no: 0.8 } });
    expect(a.answers[3]).toMatchObject({ probabilities: { yes: 0.5, no: 0.5 } });
    expect(a).toMatchObject({ costUsd: null, model: 'fake-1' });
    expect(judge.calls).toHaveLength(2);
  });
});
