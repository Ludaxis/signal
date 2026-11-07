// @vitest-environment node
// zod schemas for PostmakerAction and GraphOp: strict objects, store id patterns, bounded numbers and
// sizes; refusals are 400 and never echo the request.
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { parseAction, parseGraphOps } from '@/lib/studio/postmaker/api/schemas';
import { applyGraphOps } from '@/lib/studio/postmaker/service';
import { buildPipeline } from '@/lib/studio/postmaker/graph/build';
import { validatePipeline } from '@/lib/studio/postmaker/graph/validate';
import { recipeDraft } from './recipe-fixture';
import type { Recipe } from '@/lib/studio/postmaker/types';

const RID = 'rc-20261106-0001';
const RUN = 'run-20261106-100000-abcd';

function bad(body: unknown): string {
  try {
    parseAction(body);
  } catch (e) {
    expect(isPostmakerError(e, 'validation')).toBe(true);
    expect((e as { status: number }).status).toBe(400);
    return (e as Error).message;
  }
  throw new Error(`expected 400 for ${JSON.stringify(body).slice(0, 80)}`);
}

describe('PostmakerAction', () => {
  it('accepts every action shape (project is stripped)', () => {
    const ok = [
      { action: 'make-it', referenceId: 'ref-20261106-0a0a', options: { languages: ['fa', 'en'], lengthSec: 30, shape: '9:16', capUsd: 5 } },
      { action: 'analyse', referenceId: 'ref-20261106-0a0a', options: { languages: ['en'], lengthSec: 15, shape: '1:1' } },
      { action: 'recipe.update', recipeId: RID, baseVersion: 1, patch: { lengthSec: 20, shape: '4:5' } },
      { action: 'pipeline.build', recipeId: RID, recipeVersion: 2 },
      { action: 'pipeline.edit', recipeId: RID, baseVersion: 1, ops: [{ op: 'set-params', nodeId: 'captions:en', params: { maxWords: 4 } }] },
      { action: 'estimate', recipeId: RID, scope: { all: true } },
      { action: 'run', recipeId: RID, scope: { nodes: ['voice:fa'] }, capUsd: 1, estimateToken: 't' },
      { action: 'step.regenerate', recipeId: RID, nodeId: 'voice:fa', mode: 'keep-contracts', estimateToken: 't', beats: ['b01'] },
      { action: 'step.regenerate-from-here', recipeId: RID, nodeId: 'script', capUsd: 1, estimateToken: 't' },
      { action: 'step.edit', recipeId: RID, nodeId: 'script', baseVersion: 1, output: { json: { script: { beats: [] } } } },
      { action: 'step.lock', recipeId: RID, nodeId: 'art' },
      { action: 'step.unskip', recipeId: RID, nodeId: 'lipsync:fa' },
      { action: 'step.use-version', recipeId: RID, nodeId: 'art', version: 2 },
      { action: 'step.choose-candidate', recipeId: RID, nodeId: 'voice:en', version: 3, accept: false },
      { action: 'run.stop', runId: RUN },
      { action: 'run.raise-cap', runId: RUN, capUsd: 3 },
      { action: 'gate.sign-off', recipeId: RID, nodeId: 'narration-text:fa', version: 1, gate: 'fa-native-editor', name: 'Editor A', verdict: 'pass', perLine: [{ lineId: 'l01', ok: true }] },
      { action: 'note.add', runId: RUN, atSec: 3.5, box: [0.1, 0.1, 0.5, 0.2], text: 'Bigger hook' },
      { action: 'proof.accept', runId: RUN, asDraft: true, templateName: 'Story spine' },
      { action: 'template.retire', templateId: 'tpl-20261106-abcd' },
    ];
    for (const a of ok) expect(parseAction({ project: 'p', ...a }).action).toBe(a.action);
  });

  it('refuses unknown actions, unknown keys, path-like ids, bad numbers and oversized values', () => {
    expect(bad({ action: 'rm -rf' })).toBe('Unknown action.');
    expect(bad({})).toBe('Unknown action.');
    expect(bad(null)).toBe('Bad request.');
    expect(bad([])).toBe('Bad request.');
    bad({ action: 'step.lock', recipeId: RID, nodeId: 'art', extra: 1 });
    bad({ action: 'step.lock', recipeId: '../etc', nodeId: 'art' });
    bad({ action: 'step.lock', recipeId: RID, nodeId: '../../x' });
    bad({ action: 'run.stop', runId: 'run-x/..' });
    bad({ action: 'run.raise-cap', runId: RUN, capUsd: -1 });
    bad({ action: 'run.raise-cap', runId: RUN, capUsd: Number.POSITIVE_INFINITY });
    bad({ action: 'step.use-version', recipeId: RID, nodeId: 'art', version: 1.5 });
    bad({ action: 'make-it', referenceId: 'ref-20261106-0a0a', options: { languages: ['de'], lengthSec: 30, shape: '9:16' } });
    bad({ action: 'make-it', referenceId: 'ref-20261106-0a0a', options: { languages: ['en'], lengthSec: 301, shape: '9:16' } });
    bad({ action: 'proof.accept', runId: RUN, asDraft: 'yes', templateName: 'x' });
    bad({ action: 'proof.accept', runId: RUN, asDraft: false, templateName: '   ' });
    bad({ action: 'recipe.update', recipeId: RID, baseVersion: 1, patch: {} });
    bad({ action: 'step.edit', recipeId: RID, nodeId: 'script', baseVersion: 1, output: { json: { big: 'x'.repeat(2_100_000) } } });
    bad({ action: 'gate.sign-off', recipeId: RID, nodeId: 'voice:fa', version: 1, gate: 'nope', name: 'A', verdict: 'pass' });
  });

  it('a refusal names the field, never the value sent', () => {
    const secret = 'sk-live-should-not-echo';
    const msg = bad({ action: 'run.stop', runId: secret });
    expect(msg).toContain('runId');
    expect(msg).not.toContain(secret);
  });
});

describe('GraphOp', () => {
  const recipe = { ...recipeDraft(['en']), schema: 'signal.pm.recipe/1', id: RID, version: 1 } as Recipe;
  const built = buildPipeline(recipe);

  it('parses the six ops and applies them; the result validates', () => {
    const ops = parseGraphOps([
      { op: 'set-params', nodeId: 'captions:en', params: { maxWords: 4 } },
      { op: 'set-instructions', nodeId: 'script', text: 'Shorter hook.' },
      { op: 'set-connector-chain', nodeId: 'script', chain: ['claude-cli', 'mock'] },
      { op: 'move', nodeId: 'music', after: 'art' },
    ]);
    const next = applyGraphOps(built, ops);
    expect(() => validatePipeline(next)).not.toThrow();
    expect(next.nodes.find((n) => n.id === 'captions:en')!.params).toEqual({ maxWords: 4 });
    expect(next.nodes.find((n) => n.id === 'script')!.instructions).toBe('Shorter hook.');
    expect(next.nodes.findIndex((n) => n.id === 'music')).toBe(next.nodes.findIndex((n) => n.id === 'art') + 1);
  });

  it('removing a node others need is caught by validation with the node named', () => {
    const next = applyGraphOps(built, parseGraphOps([{ op: 'remove', nodeId: 'voice:en' }]));
    expect(() => validatePipeline(next)).toThrow(/voice:en/);
  });

  it('refuses unknown ops, bad node ids and an unknown step', () => {
    expect(() => parseGraphOps([{ op: 'drop-table', nodeId: 'art' }])).toThrow();
    expect(() => parseGraphOps([{ op: 'remove', nodeId: 'Art!' }])).toThrow();
    expect(() => parseGraphOps([])).toThrow();
    expect(() => applyGraphOps(built, [{ op: 'remove', nodeId: 'broll' }])).toThrow(/Unknown step broll/);
  });
});
