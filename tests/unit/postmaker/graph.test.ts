// @vitest-environment node
// graph: (validation names the node), (story-spine@1 builds 22 nodes for fa+en and 13 for en),
// the edges, the gate table with the defaults, and the expects rules.
import './guard';
import { describe, expect, it } from 'vitest';
import { buildPipeline, facesOf } from '@/lib/studio/postmaker/graph/build';
import { branchWidth, edgesOf, MAX_NODES, pipelineIssues, topoOrder, validatePipeline } from '@/lib/studio/postmaker/graph/validate';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import type { PipelineNode } from '@/lib/studio/postmaker/types';
import { FACES, recipeDraft } from './recipe-fixture';

const recipe = (langs: ('fa' | 'en')[]) => ({ ...recipeDraft(langs), version: 1 });
const ids = (p: { nodes: PipelineNode[] }) => p.nodes.map((n) => n.id);
const msgOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(isPostmakerError(e, 'pipeline-invalid')).toBe(true);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('story-spine@1 builder', () => {
  it('fa + en with a dialogue beat and a face asset: 22 nodes (4 shared + 2 × 8 + 2 lip-sync)', () => {
    const p = buildPipeline(recipe(['fa', 'en']), FACES);
    expect(p.nodes).toHaveLength(22);
    expect(p.builtFrom).toEqual({ recipeVersion: 1, builder: 'story-spine@1' });
    const per = ['narration-text', 'voice', 'lipsync', 'motion', 'captions', 'compose', 'mix', 'render', 'post-copy'];
    expect(ids(p).sort()).toEqual(['art', 'check', 'music', 'script', ...per.flatMap((k) => [`${k}:fa`, `${k}:en`])].sort());
    expect(() => validatePipeline(p)).not.toThrow();
  });

  it('en only: 13 nodes (4 shared + 8 per language + 1 lip-sync)', () => {
    const p = buildPipeline(recipe(['en']), FACES);
    expect(p.nodes).toHaveLength(13);
    expect(ids(p).filter((i) => i.endsWith(':fa'))).toEqual([]);
    expect(() => validatePipeline(p)).not.toThrow();
  });

  it('no face asset or no dialogue beat: no lip-sync (20 nodes, the slice graph)', () => {
    expect(buildPipeline(recipe(['fa', 'en']), {}).nodes).toHaveLength(20);
    const noDialogue = { ...recipe(['fa', 'en']), beats: recipe(['fa', 'en']).beats.map((b) => ({ ...b, techniques: b.techniques.filter((t) => t !== 'dialogue') })) };
    expect(buildPipeline(noDialogue, FACES).nodes).toHaveLength(20);
    expect(facesOf([{ id: 'char-a', kind: 'character', tags: ['face'] }, { id: 'bg', kind: 'background', tags: ['face'] }])).toEqual(['char-a']);
  });

  it('b-roll only when a beat asks for footage and the template allows it', () => {
    const footage = { ...recipe(['en']), beats: recipe(['en']).beats.map((b, i) => (i === 1 ? { ...b, visual: 'live-action footage of a kitchen' } : b)) };
    expect(ids(buildPipeline(footage, FACES))).not.toContain('broll');
    const p = buildPipeline(footage, { ...FACES, broll: true });
    expect(ids(p)).toContain('broll');
    expect(p.nodes.find((n) => n.id === 'motion:en')!.inputs.find((i) => i.from === 'broll')).toMatchObject({ required: false });
    expect(() => validatePipeline(p)).not.toThrow();
  });

  it('edges follow and are derived from the node inputs', () => {
    const p = buildPipeline(recipe(['fa', 'en']), FACES);
    const e = (to: string) => p.edges.filter((x) => x.to === to).map((x) => `${x.from}.${x.fromPort}${x.soft ? '?' : ''}`);
    expect(e('script')).toEqual([]);
    expect(e('art')).toEqual(['script.script']);
    expect(e('music')).toEqual(['script.script']);
    expect(e('narration-text:fa')).toEqual(['script.script']);
    expect(e('voice:fa')).toEqual(['narration-text:fa.lines']);
    expect(e('lipsync:fa')).toEqual(['voice:fa.audio', 'voice:fa.alignment', 'art.scenes']);
    expect(e('motion:fa')).toEqual(['art.scenes', 'voice:fa.alignment', 'music.beatGrid?', 'lipsync:fa.clips?']);
    expect(e('captions:fa')).toEqual(['narration-text:fa.lines', 'voice:fa.alignment', 'art.scenes']);
    expect(e('compose:fa')).toEqual(['motion:fa.motion', 'captions:fa.captionPages', 'art.scenes', 'voice:fa.audio', 'lipsync:fa.clips?']);
    expect(e('mix:fa')).toEqual(['compose:fa.timeline', 'voice:fa.audio', 'music.track']);
    expect(e('render:fa')).toEqual(['compose:fa.timeline', 'mix:fa.master']);
    expect(e('post-copy:fa')).toEqual(['script.script', 'compose:fa.timeline']); // subtitles from the composed timeline
    expect(e('check')).toEqual(['render:fa.video', 'post-copy:fa.caption', 'render:en.video', 'post-copy:en.caption']);
    expect(p.edges).toEqual(edgesOf(p.nodes));
    expect(topoOrder(p.nodes).order[0]).toBe('script');
    expect(topoOrder(p.nodes).order.at(-1)).toBe('check');
    expect(branchWidth(p.nodes).width).toBeLessThanOrEqual(8);
  });

  it('gate table with the defaults; the template can turn storyboard and draft-preview on', () => {
    const p = buildPipeline(recipe(['fa', 'en']), FACES);
    const g = Object.fromEntries(p.nodes.filter((n) => n.gate).map((n) => [n.id, n.gate]));
    expect(g).toEqual({
      'narration-text:fa': { id: 'fa-native-editor', blocks: 'before-paid-downstream' },
      'voice:fa': { id: 'fa-native-listener', blocks: 'before-paid-downstream' },
      check: { id: 'proof', blocks: 'before-accept' },
    });
    const on = buildPipeline(recipe(['fa', 'en']), { ...FACES, gates: { storyboard: true, draftPreview: true } });
    expect(on.nodes.find((n) => n.id === 'art')!.gate).toEqual({ id: 'storyboard', blocks: 'before-paid-downstream' });
    expect(on.nodes.find((n) => n.id === 'motion:en')!.gate).toEqual({ id: 'draft-preview', blocks: 'before-accept' });
  });

  it('expects rules with the tolerances and the free adapters', () => {
    const p = buildPipeline(recipe(['fa']), FACES);
    const rules = Object.fromEntries(p.nodes.flatMap((n) => n.expects.map((r) => [`${n.id} ${r.id}`, [r.from, r.key, r.tolerance, r.adapter]])));
    expect(rules).toEqual({
      'voice:fa narration.lineIds.exact': ['narration-text:fa', 'lineIds', 'exact', null],
      'lipsync:fa voice.clip.maxMs': ['voice:fa', 'lineMs', { ms: 20000 }, null],
      'motion:fa voice.lineMs.within': ['voice:fa', 'lineMs', { pct: 8, ms: 250 }, 'motion.retimeHolds'],
      'motion:fa art.anchors.within': ['art', 'anchors', { px: 40 }, null],
      'motion:fa music.tempo.within': ['music', 'tempo', { bpm: 1 }, null],
      'captions:fa voice.wordTimings.recompute': ['voice:fa', 'wordTimings', 'recompute', 'captions.recompute'],
      'compose:fa motion.totalFrames.exact': ['motion:fa', 'totalFrames', 'exact', 'compose.rebuild'],
      'mix:fa compose.totalFrames.exact': ['compose:fa', 'totalFrames', 'exact', 'mix.replan'],
      'render:fa mix.durationFrames.exact': ['mix:fa', 'totalFrames', { frames: 1 }, null],
      'post-copy:fa script.cta.exact': ['script', 'cta', 'exact', 'post-copy.relint'],
    });
  });
});

describe('validatePipeline', () => {
  const base = () => buildPipeline(recipe(['fa', 'en']), FACES);

  it('refuses a cycle, naming a node on it', () => {
    const p = base();
    const script = p.nodes.find((n) => n.id === 'script')!;
    script.inputs.push({ port: 'loop', from: 'art', fromPort: 'scenes', required: true });
    p.edges = edgesOf(p.nodes);
    const msg = msgOf(() => validatePipeline(p));
    expect(msg).toMatch(/loop at (script|art)/);
    expect(pipelineIssues(p).find((i) => i.code === 'cycle')!.nodeId).toMatch(/^(script|art)$/);
  });

  it('refuses a dangling required port, naming the node and the missing step', () => {
    const p = base();
    p.nodes = p.nodes.filter((n) => n.id !== 'narration-text:en');
    p.edges = edgesOf(p.nodes);
    expect(msgOf(() => validatePipeline(p))).toBe('voice:en needs lines from narration-text:en, which is not in the pipeline.');
    const q = base();
    q.nodes.find((n) => n.id === 'render:fa')!.inputs[1]!.fromPort = 'nothing';
    q.edges = edgesOf(q.nodes);
    expect(msgOf(() => validatePipeline(q))).toBe('render:fa needs nothing from mix:fa, which does not make it.');
  });

  it('a soft input to a missing step is allowed', () => {
    const p = base();
    p.nodes = p.nodes.filter((n) => !n.id.startsWith('lipsync:'));
    p.edges = edgesOf(p.nodes);
    expect(() => validatePipeline(p)).not.toThrow();
  });

  it('refuses 41 nodes, naming the node over the limit', () => {
    const p = base();
    const extra = (i: number): PipelineNode => ({ ...p.nodes.find((n) => n.id === 'art')!, id: `broll#${i}`, kind: 'broll', title: 'B-roll', connectorChain: ['higgsfield-video'], inputs: [{ port: 'scenes', from: 'art', fromPort: 'scenes', required: true }], expects: [], gate: null });
    for (let i = 1; p.nodes.length < MAX_NODES + 1; i++) p.nodes.push(extra(i));
    p.edges = edgesOf(p.nodes);
    expect(p.nodes).toHaveLength(41);
    expect(msgOf(() => validatePipeline(p))).toBe(`Too many steps: 41 (at most 40). ${p.nodes[40]!.id} is over the limit.`);
  });

  it('refuses more than 8 parallel branches, a duplicate id, an unregistered connector and stale stored edges', () => {
    const p = base();
    for (let i = 1; i <= 9; i++) p.nodes.push({ ...p.nodes.find((n) => n.id === 'art')!, id: `broll#${i}`, kind: 'broll', title: 'B-roll', connectorChain: ['higgsfield-video'], inputs: [{ port: 'script', from: 'script', fromPort: 'script', required: true }], expects: [], gate: null });
    p.edges = edgesOf(p.nodes);
    expect(pipelineIssues(p).map((i) => i.code)).toContain('too-many-branches');
    const q = base();
    q.nodes.push({ ...q.nodes[0]! });
    q.edges = edgesOf(q.nodes);
    expect(msgOf(() => validatePipeline(q))).toBe('script appears twice.');
    const r = base();
    r.nodes.find((n) => n.id === 'voice:fa')!.connectorChain = ['elevenlabs', 'codex'];
    expect(msgOf(() => validatePipeline(r))).toBe('voice:fa cannot use codex.');
    const s = base();
    s.edges = s.edges.slice(1);
    expect(msgOf(() => validatePipeline(s))).toMatch(/^The stored links of .+ do not match its inputs\.$/);
    const t = base();
    t.nodes.find((n) => n.id === 'voice:en')!.lang = 'fa';
    expect(msgOf(() => validatePipeline(t))).toBe('voice:en does not match its kind and language.');
  });
});
