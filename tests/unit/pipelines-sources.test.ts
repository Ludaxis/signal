// Each pipeline source produces ideas and posts: website pages, your own list, the ideas agent, a campaign's slots.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPackage } from '@/lib/studio/content';
import { listEvents } from '@/lib/studio/memory/store';
import { runProject } from '@/lib/studio/autopilot/runner';
import { briefFor, fillTemplate } from '@/lib/studio/pipelines/runner';
import { cleanSteps } from '@/lib/studio/pipelines/store';
import type { AutopilotMark, AutopilotRun } from '@/lib/studio/autopilot/types';
import type { PipelineMark } from '@/lib/studio/pipelines/types';
import { writeTestConfig } from './studio-helpers';
import { A, NOW, campaignWithSlots, fakeMaker, readPlan, root, setupAutopilotProject, teardownAutopilotProject, writePackage, writeSettings } from './autopilot-helpers';
import { P1, fakeGenerator, fakeIdeas, readPipelineState, readPkgJson, writePipeline, writePipelineState } from './pipelines-helpers';

beforeEach(() => setupAutopilotProject({ higgsfield: true }));
afterEach(() => teardownAutopilotProject());

const config = (o: Parameters<typeof writeTestConfig>[1]) => writeTestConfig(path.join(root, 'signal.config.json'), o);
const kinds = (r: AutopilotRun) => r.steps.map((s) => s.kind);
const skips = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'skip').map((s) => (s as { reason: string }).reason);
/** Mon/Wed/Fri 18:00 with 5 days ahead from Thursday 2026-11-05: Fri 06 and Mon 09. */
const SCHED = { schedule: { makeAheadDays: 5 } };
/** A brief format that can run unattended (Higgsfield is switched on in the fixture). */
const IMAGE = { format: 'higgsfield-image' as const };

describe('website', () => {
  it('makes a website post per slot from the next unused page, writes provenance, plans the slot time and records the event', async () => {
    writePipeline(P1, { name: 'Blog', steps: { ...SCHED, review: { enabled: false } } });
    writePackage('05', { caption: 'older' }); // already made from page /a
    const { writeFileSync, readFileSync } = await import('node:fs');
    const f = path.join(root, 'posts', '05', 'package.json');
    const spec = JSON.parse(readFileSync(f, 'utf8')) as { source: { category: string } };
    spec.source.category = 'https://example.test/blog/a';
    writeFileSync(f, JSON.stringify(spec));
    const gen = fakeGenerator();
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate, discoverArticles: async () => ['https://example.test/blog/a', 'https://example.test/blog/b', 'https://example.test/blog/c'] });
    expect(run.status).toBe('done');
    expect(kinds(run)).toEqual(['make', 'make']);
    expect(gen.calls.map((c) => [c.format, c.articleUrl])).toEqual([['website-card', 'https://example.test/blog/b'], ['website-card', 'https://example.test/blog/c']]);
    expect(run.steps[0]).toEqual({ kind: 'make', campaign: null, pipeline: P1, slot: '2026-11-06-18:00', package: '10', format: 'website-card', costUsd: null });
    expect(readPkgJson<PipelineMark>('10', 'pipeline.json')).toEqual({ pipeline: P1, name: 'Blog', slotAt: '2026-11-06T17:00:00.000Z', idea: { topic: 'https://example.test/blog/b', articleUrl: 'https://example.test/blog/b' }, madeAt: new Date(NOW).toISOString(), run: run.id });
    expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')).toEqual({ run: run.id, campaign: null, slot: '2026-11-06-18:00', pipeline: P1, madeAt: new Date(NOW).toISOString(), autoApproved: null });
    const pkg = await loadPackage('10');
    expect(pkg.status).toBe('ready'); // stops in Review
    expect(pkg.plannedFor).toBe('2026-11-06T17:00:00.000Z');
    expect(pkg.pipeline).toEqual({ id: P1, name: 'Blog', slotAt: '2026-11-06T17:00:00.000Z', article: 'https://example.test/blog/b' });
    expect(pkg.autopilot?.pipeline).toBe(P1);
    expect((await loadPackage('11')).plannedFor).toBe('2026-11-09T17:00:00.000Z');
    const ev = await listEvents({ types: ['post.made'] });
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ by: 'signal-autopilot', campaign: null, refs: { package: '10', slot: '2026-11-06-18:00', run: run.id }, data: { pipeline: P1, format: 'website-card', autopilot: true } });
    expect(readPipelineState(P1)).toMatchObject({ lastRunAt: new Date(NOW).toISOString(), lastResult: 'Made 2 posts.' });
    // the next run finds both slots filled
    const again = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate, discoverArticles: async () => ['https://example.test/blog/d'] });
    expect(again.steps).toEqual([]);
    expect(again.note).toMatch(/Nothing to do/);
    expect(readPipelineState(P1)?.lastResult).toBe('Up to date: every upcoming slot has a post.');
  });
  it('stops with a plain reason when the website has no unused page or cannot be read', async () => {
    writePipeline(P1, { steps: { ...SCHED, review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate, discoverArticles: async () => [] });
    expect(skips(run)).toEqual(['no pages were found on the website (no sitemap or feed).']);
    run = await runProject('manual', { now: NOW, generatePackage: gen.generate, discoverArticles: async () => { throw new Error('Import the website on the Brand screen first.'); } });
    expect(skips(run)).toEqual(['the website gave no pages: Import the website on the Brand screen first.']);
    expect(gen.calls).toHaveLength(0);
  });
  it('with another post type, the page becomes the topic (title and summary) for the brief', async () => {
    writePipeline(P1, { steps: { ...SCHED, make: { format: 'codex-post', template: 'Poster about {topic} for {brand}' }, review: { enabled: false } } });
    const gen = fakeGenerator();
    // Codex: only in a run you started for this pipeline
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate, discoverArticles: async () => ['https://example.test/blog/b'], readArticle: async (url) => ({ url, title: 'Cold mornings', summary: 'Five frames.', image: null }) }, undefined, { pipeline: P1 });
    expect(kinds(run)).toEqual(['make', 'skip']); // one page only: the second slot has nothing
    expect(gen.calls[0]).toMatchObject({ format: 'codex-post', brief: { prompt: 'Poster about Cold mornings for Demo', caption: 'Five frames.' } });
    expect(skips(run)).toEqual(['every page on the website has a post already.']);
  });
});

describe('list', () => {
  it('uses the topics in order, remembers where it is, and says when the list is used up', async () => {
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'list', list: ['Sunrise', 'Rain', 'Night'] }, make: IMAGE, review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(kinds(run)).toEqual(['make', 'make']);
    expect(gen.calls.map((c) => c.brief?.prompt)).toEqual(['Sunrise', 'Rain']);
    expect(readPkgJson<PipelineMark>('10', 'pipeline.json')?.idea).toEqual({ topic: 'Sunrise' });
    expect(readPipelineState(P1)?.listNext).toBe(2);
    // a failed make keeps the topic for next time
    const gen2 = fakeGenerator({ from: 20, fail: (c) => c.brief?.prompt === 'Night' });
    run = await runProject('manual', { now: Date.parse('2026-11-10T08:30:00+01:00'), generatePackage: gen2.generate });
    expect(run.steps[0]).toMatchObject({ kind: 'make', package: null, error: /Could not make/ });
    expect(readPipelineState(P1)?.listNext).toBe(2);
    run = await runProject('manual', { now: Date.parse('2026-11-10T08:31:00+01:00'), generatePackage: fakeGenerator({ from: 30 }).generate });
    expect(kinds(run)).toEqual(['make', 'skip']);
    expect(skips(run)).toEqual(['the list is used up (3 of 3 used). Add topics to keep going.']);
    expect(readPipelineState(P1)?.lastResult).toMatch(/list is used up/);
  });
  it('a brief format gets the template filled with {topic} {brand} {tone}; the empty list is a plain problem', async () => {
    expect(fillTemplate('', { topic: 'Rain', brand: 'B', tone: 'warm' })).toBe('Rain');
    expect(fillTemplate(' A {Topic} poster for {brand}, {tone}  ', { topic: 'Rain', brand: 'B', tone: 'warm, short' })).toBe('A Rain poster for B, warm, short');
    const p = { steps: cleanSteps({ make: { format: 'codex-post', template: '{topic} in {brand} colours' } }) } as never;
    expect(briefFor(p, { topic: 'Rain', hook: 'Wet?', headline: 'Rain day', caption: 'Body.' }, { brand: 'B', tone: '' })).toEqual({ format: 'codex-post', brief: { prompt: 'Rain in B colours', headline: 'Rain day', caption: 'Wet?\n\nBody.' } });
    expect(briefFor({ steps: cleanSteps({ make: { format: 'higgsfield-reel' } }) } as never, { topic: 'Rain', prompt: 'Drops on glass' }, { brand: 'B', tone: '' })).toEqual({ format: 'higgsfield-reel', brief: { prompt: 'Drops on glass', headline: undefined, caption: undefined } });
    expect(briefFor({ steps: cleanSteps({ make: { format: 'website-card' } }) } as never, { topic: 'Rain', articleUrl: 'https://example.test/rain' }, { brand: 'B', tone: '' })).toEqual({ format: 'website-card', articleUrl: 'https://example.test/rain' });
    writePipeline(P1, { steps: { source: { kind: 'list', list: [] }, make: IMAGE } });
    const run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator().generate });
    expect(skips(run)).toEqual(['The list is empty. Add a topic.']);
  });
});

describe('ideas (agent)', () => {
  beforeEach(() => config({ memoryTeam: true, autopilot: true, claudeAgents: true, higgsfield: true }));
  it('asks the planner once for as many ideas as open slots, queues them, uses one per post and counts the cost', async () => {
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'ideas' }, make: { ...IMAGE, captionStyle: 'short, warm' }, review: { enabled: false } } });
    const gen = fakeGenerator();
    const ideas = fakeIdeas({ costUsd: 0.3 });
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate, agentRunner: ideas.runner });
    expect(kinds(run)).toEqual(['ideas', 'make', 'make']);
    expect(run.steps[0]).toEqual({ kind: 'ideas', pipeline: P1, ideas: 2, costUsd: 0.3 });
    expect(ideas.prompts).toHaveLength(1);
    expect(ideas.prompts[0]).toContain('"count": 2');
    expect(ideas.prompts[0]).toContain('"captionStyle": "short, warm"');
    expect(gen.calls.map((c) => c.brief?.prompt)).toEqual(['Picture 1', 'Picture 2']);
    expect(gen.calls[0]?.brief?.caption).toBe('Hook 1?\n\nCaption 1.');
    expect(readPkgJson<PipelineMark>('10', 'pipeline.json')?.idea).toEqual({ topic: 'Idea 1', hook: 'Hook 1?', prompt: 'Picture 1', headline: 'Head 1', caption: 'Caption 1.' });
    expect(run.costUsd).toBe(0.3064); // the agent call plus two image estimates
    expect(readPipelineState(P1)?.ideas).toEqual([]);
    expect((await listEvents({ types: ['plan.made'] }))[0]).toMatchObject({ by: 'agent:planner', data: { pipeline: P1, ideas: 2 } });
  });
  it('uses queued ideas first (no agent call), and a failing agent is one step, not a crash', async () => {
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'ideas' }, make: IMAGE, review: { enabled: false } } });
    writePipelineState(P1, { ideas: [{ topic: 'Queued', hook: 'From the queue' }] });
    const gen = fakeGenerator();
    const ideas = fakeIdeas({ fail: true });
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate, agentRunner: ideas.runner });
    expect(kinds(run)).toEqual(['make', 'ideas']);
    expect(gen.calls.map((c) => c.brief?.prompt)).toEqual(['Queued']);
    expect(run.steps[1]).toMatchObject({ kind: 'ideas', pipeline: P1, ideas: 0, costUsd: null, error: /Claude did not answer/ });
    expect(run.status).toBe('done');
    expect(readPipelineState(P1)?.lastResult).toMatch(/Ideas failed/);
  });
  it('an answer without usable ideas is a failed step that still counts what the call cost', async () => {
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'ideas' }, make: IMAGE, review: { enabled: false } } });
    const run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator().generate, agentRunner: fakeIdeas({ ideas: () => [], costUsd: 0.25 }).runner });
    expect(run.steps).toEqual([{ kind: 'ideas', pipeline: P1, ideas: 0, costUsd: 0.25, error: 'The agent returned no ideas.' }]);
    expect(run.costUsd).toBe(0.25);
  });
  it('does not call the agent when its cap would pass the daily budget, or when agents are switched off', async () => {
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'ideas' }, make: IMAGE, review: { enabled: false }, budget: { dailyUsd: 0.5 } } });
    const ideas = fakeIdeas();
    let run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator().generate, agentRunner: ideas.runner });
    expect(ideas.prompts).toHaveLength(0);
    expect(skips(run)).toEqual([expect.stringMatching(/Daily budget of \$0\.50 reached/)]);
    config({ memoryTeam: true, autopilot: true, higgsfield: true });
    writePipeline(P1, { steps: { ...SCHED, source: { kind: 'ideas' }, make: IMAGE, review: { enabled: false } } });
    run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator().generate, agentRunner: ideas.runner });
    expect(run.steps[0]).toMatchObject({ kind: 'ideas', ideas: 0, error: /Turn on "agents"/ });
  });
});

describe('campaign', () => {
  it('makes the linked campaign’s planned slots inside make-ahead with its own briefs, through makeSlotPost', async () => {
    campaignWithSlots(['2026-11-04', '2026-11-06', '2026-11-07', '2026-11-12']);
    writeSettings(A, { enabled: true }); // the campaign's own autopilot must be on
    writePipeline(P1, { name: 'Run campaign', steps: { source: { kind: 'campaign', campaign: A }, schedule: { makeAheadDays: 3 }, review: { enabled: false } } });
    const maker = fakeMaker();
    // Run now on the pipeline: in the daily run the campaign's own autopilot would make these slots first
    const run = await runProject('manual', { now: NOW, makeSlotPost: maker.make }, undefined, { pipeline: P1 });
    expect(kinds(run)).toEqual(['make', 'make']);
    expect(maker.calls.map((c) => c.slot)).toEqual(['2026-11-06-website-card', '2026-11-07-website-card']);
    expect(run.steps[0]).toMatchObject({ kind: 'make', campaign: A, pipeline: P1, slot: '2026-11-06-website-card', package: '10', format: 'website-card' });
    expect(readPkgJson<PipelineMark>('10', 'pipeline.json')).toMatchObject({ pipeline: P1, slotAt: '2026-11-06T17:00:00.000Z', idea: { topic: 'Hook 2 for 2026-11-06' } });
    expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')).toMatchObject({ campaign: A, pipeline: P1, slot: '2026-11-06-website-card' });
    expect(readPlan(A).slots.filter((s) => s.status === 'made')).toHaveLength(2);
    expect(readPipelineState(P1)?.lastResult).toBe('Made 2 posts from "Grow saves".');
  });
  it('waits while the campaign is not running or its autopilot is off, and says when it is gone', async () => {
    campaignWithSlots(['2026-11-06'], { status: 'paused' });
    writeSettings(A, { enabled: true });
    writePipeline(P1, { steps: { source: { kind: 'campaign', campaign: A } } });
    const maker = fakeMaker();
    let run = await runProject('manual', { now: NOW, makeSlotPost: maker.make });
    expect(skips(run)).toEqual(['campaign "Grow saves" is not running (paused).']);
    // running, but its own autopilot is off: the pipeline never bypasses that switch
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: false });
    run = await runProject('manual', { now: NOW, makeSlotPost: maker.make }, undefined, { pipeline: P1 });
    expect(skips(run)).toEqual(['campaign "Grow saves" is off: its autopilot is switched off, so nothing is made from its plan.']);
    expect(readPipelineState(P1)?.lastResult).toBe('Campaign "Grow saves" is off.');
    expect(maker.calls).toHaveLength(0);
    writePipeline(P1, { steps: { source: { kind: 'campaign', campaign: 'c-20261101-zzzz' } } });
    run = await runProject('manual', { now: NOW, makeSlotPost: fakeMaker().make });
    expect(skips(run)).toEqual(['the linked campaign no longer exists.']);
  });
});
