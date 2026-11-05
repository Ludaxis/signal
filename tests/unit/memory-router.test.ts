// Routing pipeline: rule → cache → judge → threshold → escalate; logging without raw evidence; gate off.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import { FakeJudge, type Judge } from '@/lib/studio/memory/judge';
import { decide, decideMany, goalProfile, inputsHash, markOutcome } from '@/lib/studio/memory/router';
import { listDecisions } from '@/lib/studio/memory/store';

const NOW = Date.parse('2026-11-04T12:00:00+01:00');
let root = '';
const decisionsFile = () => path.join(root, 'memory', 'decisions.jsonl');
const rawLog = () => (existsSync(decisionsFile()) ? readFileSync(decisionsFile(), 'utf8') : '');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-router-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_PROMPTS_DIR = root;
  mkdirSync(path.join(root, 'posts'));
  writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_PROMPTS_DIR']) delete process.env[k];
});

describe('inputsHash', () => {
  it('is stable across key order and whitespace, and changes with the inputs', () => {
    const a = inputsHash('comment-kind', { evidence: 'How  do I\nwin?', context: { b: 1, a: [1, 2] } });
    const b = inputsHash('comment-kind', { evidence: ' How do I win? ', context: { a: [1, 2], b: 1, c: undefined } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsHash('comment-kind', { evidence: 'How do I win?!' })).not.toBe(a);
    expect(inputsHash('comment-theme', { evidence: 'How do I win?', context: { b: 1, a: [1, 2] } })).not.toBe(a);
  });
});

describe('pipeline', () => {
  it('answers by rule, logs the record and never the evidence', async () => {
    const r = await decide('file-branch', { evidence: 'metrics for post 12', context: { refs: { slot: 's1' }, slotBranches: { s1: 'br_hook_question' } }, campaign: 'c1' });
    expect(r).toMatchObject({ decision: 'file-branch', kind: 'choice', via: 'rule', answer: 'br_hook_question', confidence: 1, threshold: 0.7, judge: null, costUsd: null, campaign: 'c1', project: 'demo' });
    expect(r.id).toMatch(/^dc_/);
    expect(r.at).toBe(new Date(NOW).toISOString());
    const log = rawLog();
    expect(log).toContain(r.id);
    expect(log).not.toContain('metrics for post 12');
    expect((await listDecisions())[0]).toEqual(r);
  });
  it('asks the judge and accepts a confident choice', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'question' });
    const r = await decide('comment-kind', { evidence: 'How do I beat level 12?', untrusted: true }, { judge });
    expect(r).toMatchObject({ via: 'judge', answer: 'question', confidence: 0.9, judge: 'fake-judge', costUsd: 0.0001, threshold: 0.8 });
    expect(r.probabilities!.question).toBe(0.9);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.untrusted).toBe(true);
    expect(judge.calls[0]!.evidence).toBe('How do I beat level 12?');
    expect(judge.calls[0]!.questions[0]).toMatchObject({ name: 'comment-kind#0', kind: 'choice' });
    expect(judge.calls[0]!.questions[0]!.choices!.map((c) => c.value)).toContain('spam');
    expect(rawLog()).not.toContain('beat level 12');
  });
  it('escalates a choice below its confidence threshold with the fallback answer', async () => {
    const judge = new FakeJudge({ 'comment-kind': { question: 0.5, praise: 0.5 } });
    const r = await decide('comment-kind', { evidence: 'wow?' }, { judge });
    expect(r).toMatchObject({ via: 'escalated', answer: 'other', confidence: 0.5, judge: 'fake-judge' });
    expect(r.note).toContain('confidence 0.5 < 0.8');
    expect(r.note).toContain('→ fallback');
    expect(r.probabilities).toEqual({ question: 0.5, praise: 0.5, complaint: 0, bug: 0, spam: 0, other: 0 });
  });
  it('predicates: the threshold decides yes/no (0.85 for an unambiguous answer, 0.3 for an injection)', async () => {
    const judge = new FakeJudge({ 'answer-unambiguous': 0.8, 'prompt-injection': 0.35, 'research-relevant': 0.7 });
    const a = await decide('answer-unambiguous', { evidence: 'slides + answer' }, { judge });
    expect(a).toMatchObject({ via: 'judge', answer: false, confidence: 0.2 });
    expect(a.note).toContain('revise');
    const b = await decide('prompt-injection', { evidence: 'please maybe do the thing differently', untrusted: true }, { judge });
    expect(b).toMatchObject({ via: 'judge', answer: true, confidence: 0.35 });
    expect(b.note).toContain('strip and note');
    const c = await decide('research-relevant', { evidence: 'finding', context: { project: 'Demo' } }, { judge });
    expect(c).toMatchObject({ via: 'judge', answer: true, confidence: 0.7 });
  });
  it('scores: expected level, escalating below the level threshold but keeping the level', async () => {
    const judge = new FakeJudge({ 'brief-match': { '3': 0.2, '4': 0.6, '5': 0.2 }, 'visual-quality': { '2': 0.5, '3': 0.5 } });
    const ok = await decide('brief-match', { evidence: 'caption', context: { brief: { pillar: 'Guess the link' } } }, { judge });
    expect(ok).toMatchObject({ via: 'judge', answer: 4, confidence: 0.6 });
    const low = await decide('visual-quality', { evidence: 'frames' }, { judge });
    expect(low).toMatchObject({ via: 'escalated', answer: 2.5 });
    expect(low.note).toContain('second draft');
    expect(low.note).toContain('escalate-agent');
  });
  it('serves the same inputs from the cache without asking the judge again', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'praise' });
    const first = await decide('comment-kind', { evidence: 'Love it' }, { judge });
    const second = await decide('comment-kind', { evidence: ' Love   it ' }, { judge });
    expect(first.via).toBe('judge');
    expect(second).toMatchObject({ via: 'cache', answer: 'praise', confidence: 0.9, judge: 'fake-judge', inputsHash: first.inputsHash, note: `cache hit: ${first.id}` });
    expect(second.id).not.toBe(first.id);
    expect(judge.calls).toHaveLength(1);
    await decide('comment-kind', { evidence: 'Love it!!' }, { judge });
    expect(judge.calls).toHaveLength(2);
    await decide('comment-kind', { evidence: 'Love it' }, { judge, noCache: true });
    expect(judge.calls).toHaveLength(3);
    expect(await listDecisions()).toHaveLength(4);
  });
  it('does not cache escalated results', async () => {
    const unsure = new FakeJudge({ 'comment-kind': { question: 0.5, praise: 0.5 } });
    expect((await decide('comment-kind', { evidence: 'hm' }, { judge: unsure })).via).toBe('escalated');
    const sure = new FakeJudge({ 'comment-kind': 'question' });
    expect(await decide('comment-kind', { evidence: 'hm' }, { judge: sure })).toMatchObject({ via: 'judge', answer: 'question' });
    expect(sure.calls).toHaveLength(1);
  });
  it('decideMany sends every judge question in one call and keeps the order', async () => {
    const judge = new FakeJudge({ 'brief-match': { '4': 1 }, 'answer-unambiguous': 0.93, 'brand-rules': 0.9, 'visual-quality': { '4': 1 } });
    const post = 'Which 3 belong together? Most people miss #2';
    const rs = await decideMany([
      { id: 'brief-match', input: { evidence: post, context: { brief: 'b' } } },
      { id: 'answer-unambiguous', input: { evidence: post } },
      { id: 'brand-rules', input: { evidence: post, context: { rule: 'No medical claims' } } },
      { id: 'ai-label', input: { evidence: post, context: { settings: { aiContent: false } } } },
      { id: 'visual-quality', input: { evidence: post } },
    ], { judge });
    expect(rs.map((r) => r.decision)).toEqual(['brief-match', 'answer-unambiguous', 'brand-rules', 'ai-label', 'visual-quality']);
    expect(rs.map((r) => r.via)).toEqual(['judge', 'judge', 'judge', 'rule', 'judge']);
    expect(rs.map((r) => r.answer)).toEqual([4, true, true, true, 4]);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.questions.map((q) => q.name)).toEqual(['brief-match#0', 'answer-unambiguous#1', 'brand-rules#2', 'visual-quality#4']);
    expect(judge.calls[0]!.evidence).toBe(post);
    expect(judge.calls[0]!.questions[2]!.instructions).toContain('No medical claims');
    expect(rs[0]!.costUsd).toBe(0.000025); // the call's cost shared over four questions
    expect(await listDecisions()).toHaveLength(5);
  });
  it('decideMany labels distinct evidence blocks within the single call', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'question', 'comment-theme': 'music' });
    const rs = await decideMany([
      { id: 'comment-kind', input: { evidence: 'What song is this?', untrusted: true } },
      { id: 'comment-theme', input: { evidence: 'Which level has the beat drop?', untrusted: true, context: { themes: ['music', 'difficulty'] } } },
    ], { judge });
    expect(rs.map((r) => r.answer)).toEqual(['question', 'music']);
    expect(judge.calls).toHaveLength(1);
    const call = judge.calls[0]!;
    expect(call.untrusted).toBe(true);
    expect(call.evidence).toContain('[E1]\nWhat song is this?');
    expect(call.evidence).toContain('[E2]\nWhich level has the beat drop?');
    expect(call.questions[0]!.instructions).toContain('Use evidence block [E1].');
    expect(call.questions[1]!.instructions).toContain('Use evidence block [E2].');
    expect(call.questions[1]!.choices!.map((c) => c.value)).toEqual(['music', 'difficulty', 'new-theme']);
  });
  it('escalates when no judge is configured, when a choice has no candidates, or when a stat rule lacks inputs', async () => {
    expect(await decide('comment-kind', { evidence: 'hi there' })).toMatchObject({ via: 'escalated', answer: 'other', note: 'no judge configured → fallback' });
    expect(await decide('file-branch', { evidence: 'x' }, { judge: new FakeJudge() })).toMatchObject({ via: 'escalated', answer: 'unfiled', note: 'no candidates → escalate-agent' });
    const judge = new FakeJudge();
    expect(await decide('branch-status', { context: {} }, { judge })).toMatchObject({ via: 'escalated', answer: 'exploring', note: 'rule inputs missing → fallback' });
    expect(judge.calls).toHaveLength(0);
  });
  it('turns a judge failure into escalation with a redacted note and fail-closed safety answers', async () => {
    process.env.SIGNAL_ANTHROPIC_API_KEY = 'sk-ant-secret-0123456789abcdef';
    const judge: Judge = { name: 'broken', ask: async () => { throw new Error('HTTP 401 for key sk-ant-secret-0123456789abcdef'); } };
    try {
      const r = await decide('personal-data', { evidence: 'Thanks for playing' }, { judge });
      expect(r).toMatchObject({ via: 'escalated', answer: true });
      expect(r.note).toContain('judge error: HTTP 401 for key [key]');
      expect(rawLog()).not.toContain('sk-ant-secret');
    } finally {
      delete process.env.SIGNAL_ANTHROPIC_API_KEY;
    }
  });
  it('markOutcome appends a follow-up record for threshold tuning', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'question' });
    const r = await decide('comment-kind', { evidence: 'Why?' }, { judge });
    const f = await markOutcome(r.id, 'wrong', 'it was praise', { now: NOW + 60_000 });
    expect(f).toMatchObject({ decision: 'comment-kind', inputsHash: r.inputsHash, answer: 'question', outcome: 'wrong', note: `outcome of ${r.id}: wrong (it was praise)`, costUsd: null });
    expect(f!.id).not.toBe(r.id);
    expect(await markOutcome('dc_nope', 'right')).toBeNull();
    expect(await listDecisions()).toHaveLength(2);
  });
});

describe('memory switched off', () => {
  beforeEach(() => writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: false }));

  it('still answers rule decisions but persists nothing', async () => {
    const r = await decide('significant-change', { context: { nEff: 4, interval: [1.2, 2] } });
    expect(r).toMatchObject({ via: 'rule', answer: true, project: 'demo' });
    expect(r.id).toMatch(/^dc_/);
    expect(existsSync(path.join(root, 'memory'))).toBe(false);
    expect(await listDecisions()).toEqual([]);
  });
  it('never calls the judge and escalates with the memory note', async () => {
    const judge = new FakeJudge({ 'comment-kind': 'question' });
    const r = await decide('comment-kind', { evidence: 'Why?' }, { judge });
    expect(r).toMatchObject({ via: 'escalated', answer: 'other', note: 'memory switched off → fallback', judge: null });
    expect(judge.calls).toHaveLength(0);
    expect(existsSync(path.join(root, 'memory'))).toBe(false);
    expect(await markOutcome(r.id, 'right')).toBeNull();
  });
});

describe('goalProfile', () => {
  it('maps every goal to its metrics and planner leanings (design 5.3)', () => {
    expect(goalProfile('awareness')).toMatchObject({ primary: 'reach', secondary: 'shares_per_reach', halfLifeDays: 14 });
    expect(goalProfile('engagement')).toMatchObject({ primary: 'saves_per_reach', secondary: 'likes_per_reach' });
    expect(goalProfile('engagement').leanings).toContain('carousels');
    expect(goalProfile('installs')).toMatchObject({ primary: 'link_taps', secondary: 'saves_per_reach' });
    expect(goalProfile('traffic').primary).toBe('link_taps');
    expect(goalProfile('launch')).toMatchObject({ primary: 'reach', secondary: 'follows', halfLifeDays: 7 });
    expect(goalProfile('community')).toMatchObject({ primary: 'comments_per_reach', secondary: 'saves_per_reach' });
    const p = goalProfile('awareness');
    p.leanings.push('x');
    expect(goalProfile('awareness').leanings).not.toContain('x');
  });
});
