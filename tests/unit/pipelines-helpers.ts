// Fixtures for the pipeline tests: a pipeline file in the temp project, a fake post generator and a fake ideas agent.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { root, writePackage, pkgFile, readPkgJson } from './autopilot-helpers';
import { defaultSteps } from '@/lib/studio/pipelines/store';
import type { Pipeline, PipelineState, StepsPatch } from '@/lib/studio/pipelines/types';
import type { RunnerDeps } from '@/lib/studio/autopilot/runner';
import type { Runner } from '@/lib/studio/claude-agent';

export const P1 = 'pl-20261101-aaaa';
export const P2 = 'pl-20261102-bbbb';
export const pipelinesDir = () => path.join(root, 'pipelines');
export const pipelineFile = (id: string) => path.join(pipelinesDir(), `${id}.json`);
export const readPipeline = (id: string) => JSON.parse(readFileSync(pipelineFile(id), 'utf8')) as Pipeline;
export const readPipelineState = (id: string): PipelineState | null => {
  const f = path.join(pipelinesDir(), `${id}.state.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PipelineState) : null;
};

/** Writes a pipeline file with the defaults and the given step overrides (each merged over the default step). */
export function writePipeline(id: string, o: { name?: string; enabled?: boolean; archived?: boolean; steps?: StepsPatch } = {}): Pipeline {
  const d = defaultSteps();
  const s = o.steps ?? {};
  const p: Pipeline = {
    id,
    name: o.name ?? 'Test pipeline',
    enabled: o.enabled ?? true,
    archived: o.archived ?? false,
    steps: {
      source: { ...d.source, ...(s.source ?? {}) },
      make: { ...d.make, ...(s.make ?? {}) },
      review: { ...d.review, ...(s.review ?? {}) },
      approve: { ...d.approve, ...(s.approve ?? {}) },
      schedule: { ...d.schedule, ...(s.schedule ?? {}) },
      budget: { ...d.budget, ...(s.budget ?? {}) },
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
  mkdirSync(pipelinesDir(), { recursive: true });
  writeFileSync(pipelineFile(id), JSON.stringify(p));
  return p;
}

export function writePipelineState(id: string, s: Partial<PipelineState>): void {
  mkdirSync(pipelinesDir(), { recursive: true });
  writeFileSync(path.join(pipelinesDir(), `${id}.state.json`), JSON.stringify({ listNext: 0, ideas: [], lastRunAt: null, lastResult: null, ...s }));
}

export type GenCall = Parameters<NonNullable<RunnerDeps['generatePackage']>>[0];
/** A fake generatePackage: writes a valid package whose source carries the format and the page url as category. */
export function fakeGenerator(o: { fail?: (c: GenCall) => boolean; from?: number } = {}): { generate: NonNullable<RunnerDeps['generatePackage']>; calls: GenCall[] } {
  let n = o.from ?? 10;
  const calls: GenCall[] = [];
  const generate: NonNullable<RunnerDeps['generatePackage']> = async (c) => {
    calls.push(c);
    if (o.fail?.(c)) throw new Error(`Could not make ${c.format}.`);
    const id = String(n++).padStart(2, '0');
    const caption = `${c.captionLead ?? c.brief?.caption ?? c.brief?.prompt ?? c.articleUrl ?? 'post'}\n\nVisuals made with AI.`;
    writePackage(id, { caption, format: c.format === 'higgsfield-reel' ? 'reel' : 'carousel' });
    // the real generator records the format and (for website posts) the page url as source.category
    const f = pkgFile(id, 'package.json');
    const spec = JSON.parse(readFileSync(f, 'utf8')) as { source: { format: string; category: string } };
    spec.source.format = c.format;
    if (c.articleUrl) spec.source.category = c.articleUrl;
    writeFileSync(f, JSON.stringify(spec));
    return { id };
  };
  return { generate, calls };
}

const fence = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
/** A fake Claude runner for the ideas agent. */
export function fakeIdeas(o: { ideas?: (want: number) => unknown[]; fail?: boolean; costUsd?: number } = {}): { runner: Runner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: Runner = async (prompt) => {
    prompts.push(prompt);
    if (o.fail) throw new Error('Claude did not answer.');
    const want = Number(/"count":\s*(\d+)/.exec(prompt)?.[1] ?? 3);
    const ideas = o.ideas?.(want) ?? Array.from({ length: want }, (_, i) => ({ topic: `Idea ${i + 1}`, hook: `Hook ${i + 1}?`, prompt: `Picture ${i + 1}`, headline: `Head ${i + 1}`, caption: `Caption ${i + 1}.` }));
    return { text: fence({ ideas }), seconds: 2, cli: '2.1.0 (Claude Code)', costUsd: o.costUsd ?? 0.2, billing: 'api-key' as const };
  };
  return { runner, prompts };
}

export { readPkgJson };
