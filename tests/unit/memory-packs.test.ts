// context packs per role — budgets, privacy (no usernames, no raw comments), caching by hash.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A, DAY, T0, root, seedProject, setupMemoryProject, teardownMemoryProject } from './memory-helpers';
import { rebuildMemory } from '@/lib/studio/memory/graph';
import { PACK_BUDGET, buildPack, fitToBudget, scrub } from '@/lib/studio/memory/packs';
import { appendEvent, readPack } from '@/lib/studio/memory/store';
import type { Role } from '@/lib/studio/memory/types';

beforeEach(setupMemoryProject);
afterEach(teardownMemoryProject);

const ROLES: Role[] = ['lead', 'researcher', 'strategist', 'planner', 'creative-producer', 'motion-designer', 'reviewer', 'analyst', 'community-manager'];

async function seedEvents(): Promise<void> {
  await appendEvent({ type: 'post.rejected', by: 'owner', campaign: A, refs: { package: '05' }, data: { reason: 'First frame too dark; the answer is ambiguous.' }, at: '2026-11-01T18:00:00.000Z' });
  await appendEvent({ type: 'post.rejected', by: 'owner', campaign: A, refs: { package: '06' }, data: { reason: 'Hook repeats last week. Ask @someone_else for the file.' }, at: '2026-11-02T18:00:00.000Z' });
  await appendEvent({ type: 'comments.theme', by: 'agent:analyst', campaign: A, refs: { package: '01' }, data: { theme: 'asks for the answer', count: 7 }, at: '2026-11-02T19:00:00.000Z' });
  await appendEvent({ type: 'comment.question', by: 'agent:analyst', campaign: A, refs: { package: '01' }, data: { question: 'Is there an Android version?', theme: 'availability' }, at: '2026-11-02T19:05:00.000Z' });
  // A sloppy event that carries a username and raw comment text must never reach a pack.
  await appendEvent({ type: 'comment.question', by: 'agent:analyst', campaign: A, refs: { package: '02' }, data: { question: 'When is level 40 out?', username: 'puzzle_fan_88', raw: '@signal.demo when is level 40 out?? @puzzle_fan_88' }, at: '2026-11-03T09:00:00.000Z' });
}

describe('buildPack', () => {
  it('respects every role budget and keeps the most important sections first', async () => {
    seedProject();
    await seedEvents();
    await rebuildMemory(T0);
    const padding = { title: 'Brief', text: Array.from({ length: 400 }, (_, i) => `Line ${i}: show the fruit bowl, then the reveal.`).join('\n') };
    for (const role of ROLES) {
      const pack = await buildPack(role, { campaign: A, now: T0, extra: [padding] });
      expect(pack.role).toBe(role);
      expect(pack.budgetTokens).toBe(PACK_BUDGET[role]);
      expect(pack.tokensApprox).toBeLessThanOrEqual(pack.budgetTokens);
      expect(pack.tokensApprox).toBe(Math.ceil(pack.sections.reduce((a, s) => a + s.title.length + s.text.length, 0) / 4));
      expect(pack.sections.length).toBeGreaterThan(0);
      expect(pack.project).toBe('demo');
      expect(pack.campaign).toBe(A);
    }
    const strategist = await buildPack('strategist', { campaign: A, now: T0 });
    expect(strategist.sections.map((s) => s.title).slice(0, 3)).toEqual(['Goal and campaigns', 'Current strategy', 'Top 10 learnings']);
    expect(strategist.sections.find((s) => s.title === 'Top 10 learnings')!.text).toMatch(/Question hooks .*more saves per reach/);
    expect(strategist.sections.find((s) => s.title === 'Branches')!.text).toContain('Question hooks in Guess the link [hypothesis; promising');
    const creative = await buildPack('creative-producer', { campaign: A, now: T0, extra: [{ title: 'Brief', text: 'Three fruits, one impostor.' }] });
    expect(creative.sections[0]).toEqual({ title: 'Brief', text: 'Three fruits, one impostor.' });
    const planner = await buildPack('planner', { campaign: A, now: T0 });
    expect(planner.sections.find((s) => s.title.startsWith('Recent hooks'))!.text).toContain('"Which 3 belong together?"');
    expect(planner.sections.find((s) => s.title.startsWith('Branch weights'))!.text).toMatch(/Question hooks in Guess the link: promising; expected next \d+\.\d+% saves per reach; exploit/);
  });

  it('gives the reviewer and the creative producer past rejection reasons, never usernames or raw comments', async () => {
    seedProject();
    await seedEvents();
    await rebuildMemory(T0);
    for (const role of ROLES) {
      const pack = await buildPack(role, { campaign: A, now: T0 });
      const text = JSON.stringify(pack.sections);
      expect(text).not.toContain('puzzle_fan_88');
      expect(text).not.toContain('someone_else');
      expect(text).not.toContain('level 40 out??');
    }
    const reviewer = await buildPack('reviewer', { campaign: A, now: T0 });
    const rej = reviewer.sections.find((s) => s.title.startsWith('Past rejections'))!.text;
    expect(rej).toContain('2026-11-02 post 06: Hook repeats last week. Ask @… for the file.');
    expect(rej).toContain('2026-11-01 post 05: First frame too dark');
    expect(rej.indexOf('post 06')).toBeLessThan(rej.indexOf('post 05')); // most recent first
    expect(reviewer.sections[0]!.title).toBe('Brand rules and claims policy');
    expect(reviewer.sections[0]!.text).toContain("reel: don't No real brands");
    const creative = await buildPack('creative-producer', { campaign: A, now: T0 });
    expect(creative.sections.find((s) => s.title.startsWith('Past rejections'))!.text).toContain('First frame too dark');
    const cm = await buildPack('community-manager', { campaign: A, now: T0 });
    const comments = cm.sections.find((s) => s.title.startsWith('Comment themes'))!.text;
    expect(comments).toContain('asks for the answer (7)');
    expect(comments).toContain('Is there an Android version?');
    expect(comments).toContain('When is level 40 out?');
    expect(comments).not.toContain('@');
  });

  it('caches by inputs hash and rebuilds when the inputs change', async () => {
    seedProject();
    await rebuildMemory(T0);
    const first = await buildPack('analyst', { campaign: null, now: T0 });
    expect(existsSync(path.join(root, 'memory', 'packs', 'analyst.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(path.join(root, 'memory', 'packs', 'analyst.json'), 'utf8')) as { inputsHash: string; builtAt: string };
    expect(onDisk.inputsHash).toBe(first.inputsHash);
    expect(first.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs later: the cached pack comes back untouched (builtAt proves it).
    const again = await buildPack('analyst', { campaign: null, now: T0 + 3_600_000 });
    expect(again).toEqual(first);
    expect(again.builtAt).toBe(new Date(T0).toISOString());
    // A new event changes the inputs: a fresh pack replaces the cached one.
    await appendEvent({ type: 'post.rejected', by: 'owner', campaign: A, refs: { package: '03' }, data: { reason: 'Wrong category' }, at: new Date(T0).toISOString() });
    await rebuildMemory(T0 + DAY);
    const third = await buildPack('reviewer', { campaign: null, now: T0 + DAY });
    expect(third.inputsHash).not.toBe(first.inputsHash);
    expect((await readPack('reviewer', null))!.builtAt).toBe(new Date(T0 + DAY).toISOString());
    // Packs are per campaign: a different campaign scope has its own file and hash.
    const scoped = await buildPack('reviewer', { campaign: A, now: T0 + DAY });
    expect(scoped.inputsHash).not.toBe(third.inputsHash);
    expect(existsSync(path.join(root, 'memory', 'packs', `reviewer@${A}.json`))).toBe(true);
  });

  it('works for an empty project', async () => {
    await rebuildMemory(T0);
    const pack = await buildPack('lead', { now: T0 });
    expect(pack.tokensApprox).toBeLessThanOrEqual(PACK_BUDGET.lead);
    expect(pack.sections.some((s) => s.title === 'Baselines')).toBe(false);
    expect(JSON.stringify(pack)).not.toContain('undefined');
  });
});

describe('helpers', () => {
  it('cuts sections at a line break to fit the budget', () => {
    const long = { title: 'Long', text: Array.from({ length: 50 }, (_, i) => `line ${i} of a long section`).join('\n') };
    const out = fitToBudget([{ title: 'Short', text: 'ok' }, long, { title: 'Never', text: 'dropped' }], 100);
    expect(out).toHaveLength(2);
    expect(out[1]!.text.endsWith('\n… (cut)')).toBe(true);
    expect(out[1]!.text.length + out[0]!.text.length + 'Short'.length + 'Long'.length).toBeLessThanOrEqual(400);
    expect(fitToBudget([{ title: 'Empty', text: '  ' }], 100)).toEqual([]);
  });
  it('scrubs handles and e-mail addresses but keeps the project handle', () => {
    expect(scrub('Ask @someone and mail a@b.co; @signal.demo stays', '@signal.demo')).toBe('Ask @… and mail [email]; @signal.demo stays');
  });
});
