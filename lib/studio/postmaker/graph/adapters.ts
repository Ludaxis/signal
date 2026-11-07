// Free local adapters: pure functions that absorb an upstream change inside a dependent without calling any
// executor, written as version `source: 'adapt'` at $0. `captions.recompute`, `motion.retimeHolds`,
// `compose.rebuild`, `mix.replan`, `post-copy.relint`. `render` is never an adapter (minutes of CPU).
// Also the document shapes these functions read and write (the JSON outputs of the steps involved), so the fake
// executors and later the real ones agree on them. Adapters rewrite JSON ports only; media ports of the dependent are
// carried over from its current version by the engine.
// Ruling 8: when the engine gives the bundled faces (`AdapterArgs.fonts`, set when the real render
// chain runs), `captions.recompute` calls `buildCaptions` and `compose.rebuild` calls `composeTimeline`, with
// the recipe beats and techniques, the line lengths, the node params, the seed and the mock flag, so an adapted version
// is what the executor itself would write (carries its checks). `motion.retimeHolds` on a document (a
// compiled MotionSpec) refits the spec, checks it again and recompiles its tracks. Without fonts (the fakes), the simple
// document functions below are used. compose.rebuild rewrites `timeline` only: the preview strip is left as it was.
import { buildCaptions, captionMeasure } from '../executors/captions';
import { composeTimeline, faceMeasure, timelineChecks, type ComposeParams } from '../executors/compose';
import { timelineFonts } from '../executors/render-chain';
import { isMotionStepDoc, retimeMotionDoc } from '../executors/motion';
import { carryCreativeArt } from '../executors/compose-art';
import type { FontFile } from '../render/fonts';
import type { Contract, Lang, PipelineNode, Recipe, StepCheck, StepKind } from '../types';

export const FPS = 30;

// ---- documents -------------------------------------------------------------------------------------------------

export interface ScriptBeatDoc {
  id: string;
  segment: string;
  targetMs: number;
  onScreen: Partial<Record<Lang, string>>;
  take?: number; // the seed of a regenerated beat (pinned beats keep theirs)
}
export interface ScriptLineDoc {
  id: string;
  beatId: string;
  speaker: string;
  langs: Lang[];
  fa?: { display: string } | null;
  en?: { display: string } | null;
}
export interface ScriptDoc {
  beats: ScriptBeatDoc[];
  lines: ScriptLineDoc[];
  tempo: { bpm: number; downbeatMs: number; chantBeatsPerCard: 2 | 4 };
  cta: Partial<Record<Lang, string>>;
}

export interface WordTiming {
  token: string;
  startMs: number;
  endMs: number;
}
export interface AlignmentDoc {
  lang: Lang;
  lines: { id: string; beatId: string; ms: number; words: WordTiming[] }[];
}

export interface MotionBeat {
  id: string;
  startFrame: number;
  endFrame: number;
  holdFrames: number;
  lines: string[];
}
export interface MotionDoc {
  fps: number;
  beats: MotionBeat[];
  totalFrames: number;
  cutFrames: number[];
}

export interface CaptionPage {
  lineId: string;
  beatId: string;
  text: string;
  beatOffsetMs: number; // from the start of the line's beat
  durationMs: number;
}
export interface CaptionsDoc {
  lang: Lang;
  pages: CaptionPage[];
}

export interface TimelineDoc {
  fps: number;
  durationInFrames: number;
  layers: { beatId: string; from: number; to: number }[];
  captions: { lineId: string; text: string; from: number; to: number }[];
  coverFrame: number;
}

export interface MixPlanDoc {
  durationFrames: number;
  cues: { beatId: string; atFrame: number }[];
}

export interface PostCopyDoc {
  lang: Lang;
  caption: string;
  cta: string;
  hashtags: string[];
  lint: string[];
}

// ---- pure layout functions (shared with the executors) -----------------------------------------------------------

const framesOf = (ms: number) => Math.ceil((ms * FPS) / 1000);

/** Beat lengths from speech: a beat with lines lasts its lines plus its hold; a beat without lines keeps its target. */
export function layoutMotion(beats: { id: string; targetMs: number; holdFrames?: number }[], alignment: AlignmentDoc, holdFrames: number): MotionDoc {
  let frame = 0;
  const out: MotionBeat[] = [];
  for (const b of beats) {
    const lines = alignment.lines.filter((l) => l.beatId === b.id);
    const hold = b.holdFrames ?? holdFrames;
    const len = lines.length ? framesOf(lines.reduce((s, l) => s + l.ms, 0)) + hold : Math.max(1, Math.round((b.targetMs * FPS) / 1000));
    out.push({ id: b.id, startFrame: frame, endFrame: frame + len, holdFrames: hold, lines: lines.map((l) => l.id) });
    frame += len;
  }
  return { fps: FPS, beats: out, totalFrames: frame, cutFrames: out.slice(1).map((b) => b.startFrame) };
}

export const motionContract = (m: MotionDoc): Contract => ({
  beatIds: m.beats.map((b) => b.id),
  beatFrames: Object.fromEntries(m.beats.map((b) => [b.id, [b.startFrame, b.endFrame] as [number, number]])),
  cutFrames: m.cutFrames,
  totalFrames: m.totalFrames,
});

/** `motion.retimeHolds`: keeps the beats, their order and their holds; refits each spoken beat to its new lines. */
export function retimeHolds(current: MotionDoc, alignment: AlignmentDoc): MotionDoc {
  return layoutMotion(
    current.beats.map((b) => ({ id: b.id, targetMs: ((b.endFrame - b.startFrame) * 1000) / FPS, holdFrames: b.holdFrames })),
    alignment,
    0,
  );
}

const WORDS_PER_PAGE = 4; //: 3-5 words per page; the bundled-font width test is authoritative

/** `captions.recompute`: caption pages from the word timings, at most 4 words per page, timed by the words. */
export function recomputeCaptions(alignment: AlignmentDoc): CaptionsDoc {
  const pages: CaptionPage[] = [];
  const offset = new Map<string, number>();
  for (const l of alignment.lines) {
    const base = offset.get(l.beatId) ?? 0;
    for (let i = 0; i < l.words.length; i += WORDS_PER_PAGE) {
      const ws = l.words.slice(i, i + WORDS_PER_PAGE);
      pages.push({ lineId: l.id, beatId: l.beatId, text: ws.map((w) => w.token).join(' '), beatOffsetMs: base + ws[0]!.startMs, durationMs: ws.at(-1)!.endMs - ws[0]!.startMs });
    }
    offset.set(l.beatId, base + l.ms);
  }
  return { lang: alignment.lang, pages };
}

/** `compose.rebuild`: the timeline is a pure function of motion and captions. */
export function rebuildTimeline(motion: MotionDoc, captions: CaptionsDoc): TimelineDoc {
  const start = new Map(motion.beats.map((b) => [b.id, b.startFrame]));
  return {
    fps: motion.fps,
    durationInFrames: motion.totalFrames,
    layers: motion.beats.map((b) => ({ beatId: b.id, from: b.startFrame, to: b.endFrame })),
    captions: captions.pages.map((p) => {
      const from = (start.get(p.beatId) ?? 0) + Math.floor((p.beatOffsetMs * FPS) / 1000);
      return { lineId: p.lineId, text: p.text, from, to: from + Math.max(1, framesOf(p.durationMs)) };
    }),
    coverFrame: Math.max(0, Math.min(motion.totalFrames - 1, FPS)),
  };
}

export const timelineContract = (t: TimelineDoc): Contract => ({ totalFrames: t.durationInFrames, coverFrame: t.coverFrame });

/** `mix.replan`: the mix plan follows the timeline's length and beat starts. */
export function replanMix(timeline: TimelineDoc): MixPlanDoc {
  return { durationFrames: timeline.durationInFrames, cues: timeline.layers.map((l) => ({ beatId: l.beatId, atFrame: l.from })) };
}

/** `post-copy.relint`: keeps the caption text, re-checks it against the script's CTA. */
export function relintPostCopy(current: PostCopyDoc, script: ScriptDoc): PostCopyDoc {
  const cta = script.cta[current.lang] ?? '';
  const lint: string[] = [];
  if (cta && !current.caption.includes(cta)) lint.push('The caption does not carry the call to action.');
  if (current.hashtags.length > 5) lint.push('At most 5 hashtags.');
  return { ...current, cta, lint };
}

// ---- registry ----------------------------------------------------------------------------------------------------

export interface AdapterArgs {
  node: PipelineNode;
  /** The dependent's current JSON outputs, by port. */
  current: Record<string, unknown>;
  /** The current upstream JSON outputs, by the dependent's input port (null for media or absent inputs). */
  inputs: Record<string, unknown>;
  /** Ruling 8: the recipe (beats with their techniques, on-screen text, tempo) the real builders read. */
  recipe?: Pick<Recipe, 'beats' | 'tempo'>;
  /** Ruling 8: the bundled faces the measures come from; absent = the simple document functions (fakes). */
  fonts?: FontFile[];
  /** Line lengths (ms) from the voice `audio` refs, by line id (compose places the voice clips with them). */
  lineMs?: Record<string, number>;
  /** The node's params (compose: brand, AI label, palette, …). Default: `node.params`. */
  params?: Record<string, unknown>;
  /** The seed of the version being adapted. */
  seed?: number;
  /** A mock anywhere in the lineage (MOCK on every frame). */
  mock?: boolean;
}

export interface Adapter {
  kind: StepKind;
  /**
   * `follows`: the dependent mirrors the upstream key (an exact rule is absorbed by rebuilding); otherwise the rule
   * must pass within tolerance before the adapter may run.
   */
  follows: boolean;
  /**
   * The input ports whose changes this adapter can absorb. A change on any other input port leaves the dependent
   * out of date (it needs its executor). Omitted = every input (the earlier rule).
   */
  absorbs?: string[];
  /** `checks`, when given, replace the dependent's checks on the adapted version (the real builders' checks). */
  run(a: AdapterArgs): { data: Record<string, unknown>; provides: Contract; checks?: StepCheck[] };
}

const beatsWith = (a: AdapterArgs, technique: string) => new Set((a.recipe?.beats ?? []).filter((b) => b.techniques.includes(technique)).map((b) => b.id));

export const ADAPTERS: Record<string, Adapter> = {
  'captions.recompute': {
    kind: 'captions',
    follows: true,
    run: (a) => {
      const alignment = a.inputs.alignment as AlignmentDoc;
      if (!a.fonts?.length) return { data: { captionPages: recomputeCaptions(alignment) }, provides: {} };
      const lang = a.node.lang ?? alignment.lang;
      const { measure, font } = captionMeasure(lang, a.fonts);
      const { doc, checks } = buildCaptions({ lang, alignment, measure, highlightBeats: beatsWith(a, 'highlight-marker'), emphasisBeats: beatsWith(a, 'emphasis-punch'), font: { family: font.family, sha256: font.sha256 } });
      return { data: { captionPages: doc }, provides: {}, checks };
    },
  },
  'motion.retimeHolds': {
    kind: 'motion',
    follows: false,
    run: ({ node, current, inputs }) => {
      // A compiled MotionSpec refits the same way, then is checked and compiled again with its own rigs
      if (isMotionStepDoc(current.motion)) {
        const r = retimeMotionDoc(current.motion, inputs.alignment as AlignmentDoc, node.id);
        return { data: { motion: r.doc }, provides: motionContract(r.doc), checks: r.checks };
      }
      const m = retimeHolds(current.motion as MotionDoc, inputs.alignment as AlignmentDoc);
      return { data: { motion: m }, provides: motionContract(m) };
    },
  },
  'compose.rebuild': {
    kind: 'compose',
    follows: true,
    run: (a) => {
      const lang = a.node.lang;
      if (!a.fonts?.length || !a.recipe || !lang) {
        const t = rebuildTimeline(a.inputs.motion as MotionDoc, a.inputs.captions as CaptionsDoc);
        return { data: { timeline: t }, provides: timelineContract(t) };
      }
      const t = composeTimeline({
        lang,
        recipe: a.recipe as Recipe,
        motion: a.inputs.motion as MotionDoc,
        captions: a.inputs.captions as CaptionsDoc,
        lineMs: a.lineMs,
        params: (a.params ?? a.node.params) as ComposeParams,
        mock: a.mock ?? false,
        seed: a.seed ?? 1,
        fonts: timelineFonts(a.fonts),
      });
      // The compiled motion of the retimed version, the cast art and the backgrounds carry over.
      const full = carryCreativeArt(a.current.timeline, t, a.inputs.motion);
      return { data: { timeline: full }, provides: { totalFrames: full.durationInFrames, coverFrame: full.coverFrame }, checks: timelineChecks(full, `compose:${lang}`, { measure: faceMeasure(a.fonts) }) };
    },
  },
  'mix.replan': {
    kind: 'mix',
    follows: true,
    // The mix reads the voice stems (and the music track) directly: a new voice take is new audio, so mix:<lang> is
    // out of date on any voice change, keep-contracts included (quality as ruled); the replan only
    // absorbs a new timeline.
    absorbs: ['timeline'],
    run: ({ inputs }) => {
      const p = replanMix(inputs.timeline as TimelineDoc);
      return { data: { mixPlan: p }, provides: { totalFrames: p.durationFrames } };
    },
  },
  'post-copy.relint': {
    kind: 'post-copy',
    follows: false,
    run: ({ current, inputs }) => {
      const d = relintPostCopy(current.caption as PostCopyDoc, inputs.script as ScriptDoc);
      return { data: { caption: d }, provides: { cta: { [d.lang]: d.cta } } };
    },
  },
};
