// The `story-spine@1` builder: a pure function from a recipe (plus what the pack offers and the template's
// options) to a pipeline. Shared nodes: script, art, music, check. Per language: narration-text, voice, motion,
// captions, compose, mix, render, post-copy (it reads the composed timeline for the subtitles). lipsync:<lang> only
// when a beat uses `dialogue` and the pack has a
// character with a face asset; broll only when a beat asks for live-action-like footage and the template allows it.
// Inputs follow, the built-in `expects` rules follow with the tolerances, and the gate table
// follows with the defaults (storyboard and draft-preview off unless the template turns them on).
import type { ExpectRule, HumanGate, Lang, Pipeline, PipelineNode, Recipe, StepKind } from '../types';
import { KINDS } from './kinds';
import { edgesOf } from './validate';

export const BUILDER_ID = 'story-spine@1';

export interface BuildOptions {
  /** Character ids that have a face asset in the pack library (lip-sync needs one). */
  faces?: string[];
  /** The template allows b-roll (vendor policy); off by default. */
  broll?: boolean;
  /** Template gate options: both off in the default template. */
  gates?: { storyboard?: boolean; draftPreview?: boolean };
}

/** Pack library characters tagged `face` (the generic signal that a lip-sync plate exists). */
export function facesOf(library: { id: string; kind: string; tags: string[] }[]): string[] {
  return library.filter((a) => a.kind === 'character' && a.tags.includes('face')).map((a) => a.id);
}

type Input = PipelineNode['inputs'][number];
const inp = (port: string, from: string, fromPort: string, required = true): Input => ({ port, from, fromPort, required });
const id = (kind: StepKind, lang: Lang | null) => (lang ? `${kind}:${lang}` : kind);

const LINE_MS = { pct: 8, ms: 250 };

function rule(ruleId: string, from: string, key: ExpectRule['key'], tolerance: ExpectRule['tolerance'], label: string, adapter: string | null = null): ExpectRule {
  return { id: ruleId, from, key, tolerance, label, adapter };
}

function node(kind: StepKind, lang: Lang | null, inputs: Input[], o: { expects?: ExpectRule[]; gate?: HumanGate | null; role?: string | null } = {}): PipelineNode {
  const spec = KINDS[kind];
  const chain = [...spec.chain];
  return {
    id: id(kind, lang),
    kind,
    lang,
    title: spec.title,
    role: o.role !== undefined ? o.role : spec.role,
    connectorChain: chain,
    params: {},
    instructions: '',
    inputs,
    expects: o.expects ?? [],
    gate: o.gate ?? null,
    attendance: chain.some((c) => c === 'codex' || c.startsWith('browser-agent')) ? 'attended-only' : 'any',
  };
}

const LIVE_ACTION = /\b(live[- ]action|footage|b-roll|broll)\b/i;

export function needsLipsync(recipe: Pick<Recipe, 'beats'>, o: BuildOptions): boolean {
  return (o.faces?.length ?? 0) > 0 && recipe.beats.some((b) => b.techniques.includes('dialogue'));
}

export function needsBroll(recipe: Pick<Recipe, 'beats'>, o: BuildOptions): boolean {
  return o.broll === true && recipe.beats.some((b) => b.techniques.includes('live-action') || LIVE_ACTION.test(b.visual));
}

export function buildPipeline(recipe: Pick<Recipe, 'version' | 'languages' | 'beats'>, o: BuildOptions = {}): Omit<Pipeline, 'schema' | 'recipeId' | 'version'> {
  const langs = [...new Set(recipe.languages)];
  const lip = needsLipsync(recipe, o);
  const broll = needsBroll(recipe, o);
  const nodes: PipelineNode[] = [];

  nodes.push(node('script', null, []));
  nodes.push(node('art', null, [inp('script', 'script', 'script')], { gate: o.gates?.storyboard ? { id: 'storyboard', blocks: 'before-paid-downstream' } : null }));
  if (broll) nodes.push(node('broll', null, [inp('scenes', 'art', 'scenes')]));
  nodes.push(node('music', null, [inp('script', 'script', 'script')]));

  for (const l of langs) {
    const nt = id('narration-text', l);
    const vo = id('voice', l);
    const ls = id('lipsync', l);
    const mo = id('motion', l);
    const ca = id('captions', l);
    const co = id('compose', l);
    const mx = id('mix', l);
    nodes.push(
      node('narration-text', l, [inp('script', 'script', 'script')], {
        role: l === 'fa' ? 'language-editor' : 'copywriter',
        gate: l === 'fa' ? { id: 'fa-native-editor', blocks: 'before-paid-downstream' } : null,
      }),
    );
    nodes.push(
      node('voice', l, [inp('lines', nt, 'lines')], {
        expects: [rule('narration.lineIds.exact', nt, 'lineIds', 'exact', 'Same lines and speakers')],
        gate: l === 'fa' ? { id: 'fa-native-listener', blocks: 'before-paid-downstream' } : null,
      }),
    );
    if (lip) {
      nodes.push(
        node('lipsync', l, [inp('audio', vo, 'audio'), inp('alignment', vo, 'alignment'), inp('scenes', 'art', 'scenes')], {
          expects: [rule('voice.clip.maxMs', vo, 'lineMs', { ms: 20_000 }, 'Dialogue clips ≤ 20 s')],
        }),
      );
    }
    const motionInputs = [inp('scenes', 'art', 'scenes'), inp('alignment', vo, 'alignment'), inp('beatGrid', 'music', 'beatGrid', false)];
    if (lip) motionInputs.push(inp('lipsync', ls, 'clips', false));
    if (broll) motionInputs.push(inp('broll', 'broll', 'clips', false));
    nodes.push(
      node('motion', l, motionInputs, {
        expects: [
          rule('voice.lineMs.within', vo, 'lineMs', LINE_MS, 'Line length ± 8 %', 'motion.retimeHolds'),
          rule('art.anchors.within', 'art', 'anchors', { px: 40 }, 'Placement ± 40 px'),
          rule('music.tempo.within', 'music', 'tempo', { bpm: 1 }, 'Tempo ± 1 BPM'),
        ],
        gate: o.gates?.draftPreview ? { id: 'draft-preview', blocks: 'before-accept' } : null,
      }),
    );
    nodes.push(
      node('captions', l, [inp('lines', nt, 'lines'), inp('alignment', vo, 'alignment'), inp('scenes', 'art', 'scenes')], {
        expects: [rule('voice.wordTimings.recompute', vo, 'wordTimings', 'recompute', 'Word timings', 'captions.recompute')],
      }),
    );
    const composeInputs = [inp('motion', mo, 'motion'), inp('captions', ca, 'captionPages'), inp('scenes', 'art', 'scenes'), inp('audio', vo, 'audio')];
    if (lip) composeInputs.push(inp('lipsync', ls, 'clips', false));
    if (broll) composeInputs.push(inp('broll', 'broll', 'clips', false));
    nodes.push(node('compose', l, composeInputs, { expects: [rule('motion.totalFrames.exact', mo, 'totalFrames', 'exact', 'Same length', 'compose.rebuild')] }));
    nodes.push(
      node('mix', l, [inp('timeline', co, 'timeline'), inp('audio', vo, 'audio'), inp('track', 'music', 'track')], {
        expects: [rule('compose.totalFrames.exact', co, 'totalFrames', 'exact', 'Same length', 'mix.replan')],
      }),
    );
    nodes.push(node('render', l, [inp('timeline', co, 'timeline'), inp('master', mx, 'master')], { expects: [rule('mix.durationFrames.exact', mx, 'totalFrames', { frames: 1 }, 'Audio fits the video')] }));
    // post-copy reads the composed timeline so it writes subtitles.<lang>.srt from the real caption timing.
    nodes.push(node('post-copy', l, [inp('script', 'script', 'script'), inp('timeline', co, 'timeline')], { expects: [rule('script.cta.exact', 'script', 'cta', 'exact', 'Same call to action', 'post-copy.relint')] }));
  }

  const checkInputs: Input[] = [];
  for (const l of langs) {
    checkInputs.push(inp(`video:${l}`, id('render', l), 'video'));
    checkInputs.push(inp(`caption:${l}`, id('post-copy', l), 'caption'));
  }
  nodes.push(node('check', null, checkInputs, { gate: { id: 'proof', blocks: 'before-accept' } }));

  return { builtFrom: { recipeVersion: recipe.version, builder: BUILDER_ID }, nodes, edges: edgesOf(nodes) };
}
