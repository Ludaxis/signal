// Fake executors for every kind except `narration-text` ("fake = a test double injected through deps"). They
// are deterministic from the seed, never touch the network or a child process, and make the document shapes of
// graph/adapters.ts so the engine, the adapters and the tests share one vocabulary. Real executors replace them
// kind by kind; until then the engine uses these with mock providers only.
// Knobs: per-node delays, scripted voice line durations per take, per-node costs and estimates, scripted failures,
// start/end instrumentation (concurrency tests) and counted vendor-job submits (crash-recovery tests).
import { PostmakerError } from '../errors';
import { layoutMotion, motionContract, rebuildTimeline, recomputeCaptions, relintPostCopy, replanMix, timelineContract } from '../graph/adapters';
import type { AlignmentDoc, CaptionsDoc, MotionDoc, PostCopyDoc, ScriptDoc, TimelineDoc } from '../graph/adapters';
import { KINDS, ROLE_CAP_USD } from '../graph/kinds';
import type { Contract, Lang, PipelineNode, StepKind } from '../types';
import type { ExecEstimate, ExecInput, ExecOutput, ExecResult, Executor, EstimateInput } from './types';

export interface FakeConfig {
  /** Delay per node id or kind, in ms (default 0). */
  delayMs?: Record<string, number>;
  /** Holds a node until the returned promise settles (deterministic "while X is running" tests). */
  holdUntil?: (nodeId: string) => Promise<void> | undefined;
  /** Scripted voice line duration (ms) for a line and take; undefined = the mock rate (60 ms/char fa, 55 ms/char en). */
  voiceMs?: (lineId: string, lang: Lang, take: number, seed: number) => number | undefined;
  /** Estimate and actual cost per node id or kind (live mode only; mock is always $0). */
  costs?: Record<string, { usdHigh: number; usdLow?: number; actual?: number | null }>;
  /**
   * How live agent steps (claude-cli, agent-sdk) are billed. 'subscription' (default): $0, "Your Claude plan".
   * 'api-key':, the role's per-call cap (ROLE_CAP_USD) as `usdHigh`, $0 as `usdLow` (no past runs yet).
   */
  agentBilling?: 'subscription' | 'api-key';
  /** A scripted failure message per node id. */
  fail?: Record<string, string>;
  onStart?: (nodeId: string, connector: string) => void;
  onEnd?: (nodeId: string, connector: string) => void;
  /** Called after a vendor job was submitted (before collecting). */
  onSubmitted?: (nodeId: string, requestId: string) => void;
  counters?: FakeCounters;
}

export interface FakeCounters {
  submits: Record<string, number>;
  collects: Record<string, number>;
  runs: Record<string, number>;
}

export const newCounters = (): FakeCounters => ({ submits: {}, collects: {}, runs: {} });

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

const json = (port: string, name: string, data: unknown, lang?: Lang | null): ExecOutput => ({ port, name, kind: 'json', mime: 'application/json', data, ...(lang ? { lang } : {}) });
const bytes = (port: string, name: string, kind: ExecOutput['kind'], mime: string, text: string, lang?: Lang | null, meta?: ExecOutput['meta']): ExecOutput => ({
  port,
  name,
  kind,
  mime,
  data: null,
  bytes: Buffer.from(text, 'utf8'),
  ...(lang ? { lang } : {}),
  ...(meta ? { meta } : {}),
});

const pick = <T,>(m: Record<string, T> | undefined, node: PipelineNode): T | undefined => m?.[node.id] ?? m?.[node.kind];

// ---- document makers -------------------------------------------------------------------------------------------

/** A script from the recipe: one line per beat that has on-screen text in a language; pinned beats are kept as they were. */
export function fakeScript(input: Pick<ExecInput, 'recipe' | 'seed' | 'previous' | 'pinnedBeats' | 'beats'>): ScriptDoc {
  const { recipe, seed } = input;
  const prev = input.previous?.data.script as ScriptDoc | undefined;
  const only = input.beats && input.beats.length ? new Set(input.beats) : null;
  const beats: ScriptDoc['beats'] = [];
  const lines: ScriptDoc['lines'] = [];
  let n = 0;
  for (const b of recipe.beats) {
    const keep = prev && (input.pinnedBeats.includes(b.id) || (only && !only.has(b.id)));
    if (keep) {
      const pb = prev.beats.find((x) => x.id === b.id);
      if (pb) beats.push(pb);
      for (const l of prev.lines.filter((x) => x.beatId === b.id)) {
        lines.push(l);
        n = Math.max(n, Number(l.id.slice(1)));
      }
      continue;
    }
    beats.push({ id: b.id, segment: b.segment, targetMs: Math.round((b.end - b.start) * 1000), onScreen: { ...b.onScreenText }, ...(seed > 1 ? { take: seed } : {}) });
    // One line per text line of the beat's on-screen text ("\n" separates lines; languages pair up by position).
    const texts = Object.fromEntries(recipe.languages.map((l) => [l, (b.onScreenText[l] ?? '').split('\n').map((t) => t.trim()).filter(Boolean)])) as Partial<Record<Lang, string[]>>;
    const count = Math.max(0, ...recipe.languages.map((l) => texts[l]?.length ?? 0));
    for (let k = 0; k < count; k++) {
      n += 1;
      const fa = texts.fa?.[k];
      const en = texts.en?.[k];
      lines.push({
        id: `l${String(n).padStart(2, '0')}`,
        beatId: b.id,
        speaker: b.techniques.includes('dialogue') ? 'char-host' : 'narrator',
        langs: recipe.languages.filter((l) => texts[l]?.[k]),
        ...(fa ? { fa: { display: fa } } : {}),
        ...(en ? { en: { display: en } } : {}),
      });
    }
  }
  const endcard = recipe.beats.find((b) => b.segment === 'endcard') ?? recipe.beats.at(-1);
  const cta: ScriptDoc['cta'] = {};
  for (const l of recipe.languages) cta[l] = (endcard?.onScreenText[l] ?? '').split('\n').at(-1)!.trim();
  return { beats, lines, tempo: { bpm: recipe.tempo?.bpm ?? 100, downbeatMs: recipe.tempo?.downbeatMs ?? 0, chantBeatsPerCard: 2 }, cta };
}

export const scriptContract = (s: ScriptDoc): Contract => ({ beatIds: s.beats.map((b) => b.id), lineIds: s.lines.map((l) => l.id), tempo: s.tempo, cta: s.cta });

interface NarrLine {
  id: string;
  beatId: string;
  display: string;
}

/** Mock speech: ms per character of the line (the mock rate), unless scripted; synthetic word timings. */
export function fakeAlignment(lang: Lang, lines: NarrLine[], msOf: (l: NarrLine) => number): AlignmentDoc {
  return {
    lang,
    lines: lines.map((l) => {
      const ms = Math.max(1, Math.round(msOf(l)));
      const words = l.display.split(/\s+/).filter(Boolean);
      const chars = words.reduce((s, w) => s + w.length, 0) || 1;
      let at = 0;
      const timings = words.map((w) => {
        const d = (ms * w.length) / chars;
        const t = { token: w, startMs: Math.round(at), endMs: Math.round(at + d) };
        at += d;
        return t;
      });
      return { id: l.id, beatId: l.beatId, ms, words: timings };
    }),
  };
}

export const alignmentContract = (a: AlignmentDoc): Contract => ({
  lineIds: a.lines.map((l) => l.id),
  lineMs: Object.fromEntries(a.lines.map((l) => [l.id, l.ms])),
  wordTimings: Object.fromEntries(a.lines.map((l) => [l.id, l.words])),
});

// ---- the fakes -------------------------------------------------------------------------------------------------

type Maker = (i: ExecInput, cfg: FakeConfig) => ExecResult | Promise<ExecResult>;

function narrLines(i: ExecInput): NarrLine[] {
  const doc = i.byPort.lines as { lines?: { id: string; beatId: string; display: string }[] } | null;
  return (doc?.lines ?? []).map((l) => ({ id: l.id, beatId: l.beatId, display: l.display }));
}

const MAKERS: Record<Exclude<StepKind, 'narration-text'>, Maker> = {
  analyse: (i) => ({ outputs: [json('recipe', 'recipe.json', { beats: i.recipe.beats.map((b) => b.id) })], provides: { beatIds: i.recipe.beats.map((b) => b.id) }, costUsd: 0 }),
  script: (i) => {
    const s = fakeScript(i);
    return { outputs: [json('script', 'script.json', s)], provides: scriptContract(s), costUsd: 0 };
  },
  voice: (i, cfg) => {
    const lang = i.lang!;
    const rate = lang === 'fa' ? 60 : 55;
    const a = fakeAlignment(lang, narrLines(i), (l) => cfg.voiceMs?.(l.id, lang, i.take, i.seed) ?? Math.max(800, l.display.replace(/\s+/g, '').length * rate));
    const audio = a.lines.map((l) => bytes('audio', `voice.${lang}.${l.id}.wav`, 'audio', 'audio/wav', `FAKE-WAV ${lang} ${l.id} ${l.ms} ms seed ${i.seed}`, lang, { durationMs: l.ms, sampleRate: 48_000 }));
    return { outputs: [json('alignment', `alignment.${lang}.json`, a, lang), ...audio], provides: alignmentContract(a), costUsd: null };
  },
  art: (i) => {
    const beats = i.recipe.beats.map((b, n) => ({ id: b.id, background: `bg-${n % 3}`, anchors: { x: 540, y: 1200, h: 900 }, textZone: (n % 2 ? 'lower' : 'headline') as 'lower' | 'headline' }));
    return {
      outputs: [json('scenes', 'scenes.json', { beats })],
      provides: { assetIds: [...new Set(beats.map((b) => b.background))], anchors: Object.fromEntries(beats.map((b) => [b.id, b.anchors])), textZones: Object.fromEntries(beats.map((b) => [b.id, b.textZone])) },
      costUsd: 0,
    };
  },
  broll: (i) => ({ outputs: [json('clips', 'broll.json', { clips: [], seed: i.seed })], provides: {}, costUsd: 0 }),
  lipsync: (i) => {
    const a = i.byPort.alignment as AlignmentDoc | null;
    const clips = (a?.lines ?? []).map((l) => ({ lineId: l.id, ms: l.ms }));
    return { outputs: [json('clips', `lipsync.${i.lang}.json`, { clips, seed: i.seed }, i.lang)], provides: { lineMs: Object.fromEntries(clips.map((c) => [c.lineId, c.ms])) }, costUsd: null };
  },
  music: (i) => {
    const bpm = (i.byPort.script as ScriptDoc | null)?.tempo.bpm ?? 100;
    return {
      outputs: [bytes('track', 'music.wav', 'audio', 'audio/wav', `FAKE-TRACK ${bpm} bpm seed ${i.seed}`), json('beatGrid', 'beat-grid.json', { bpm, downbeatMs: 0 })],
      provides: { tempo: { bpm, downbeatMs: 0, chantBeatsPerCard: 2 } },
      costUsd: 0,
    };
  },
  motion: (i) => {
    const script = i.recipe.beats.map((b) => ({ id: b.id, targetMs: Math.round((b.end - b.start) * 1000) }));
    const hold = typeof i.params.holdFrames === 'number' ? i.params.holdFrames : 12 + (i.seed % 3);
    const m = layoutMotion(script, i.byPort.alignment as AlignmentDoc, hold);
    return { outputs: [json('motion', `motion.${i.lang}.json`, m, i.lang)], provides: motionContract(m), costUsd: 0 };
  },
  captions: (i) => {
    const c = recomputeCaptions(i.byPort.alignment as AlignmentDoc);
    return { outputs: [json('captionPages', `captions.${i.lang}.json`, c, i.lang)], provides: {}, costUsd: 0 };
  },
  compose: (i) => {
    const t = rebuildTimeline(i.byPort.motion as MotionDoc, i.byPort.captions as CaptionsDoc);
    return { outputs: [json('timeline', `timeline.${i.lang}.json`, t, i.lang)], provides: timelineContract(t), costUsd: 0 };
  },
  mix: (i) => {
    const p = replanMix(i.byPort.timeline as TimelineDoc);
    return {
      outputs: [json('mixPlan', `mix.${i.lang}.json`, p, i.lang), bytes('master', `master.${i.lang}.wav`, 'audio', 'audio/wav', `FAKE-MASTER ${i.lang} ${p.durationFrames} frames`, i.lang, { frames: p.durationFrames })],
      provides: { totalFrames: p.durationFrames },
      costUsd: 0,
    };
  },
  render: (i) => {
    const t = i.byPort.timeline as TimelineDoc;
    return {
      outputs: [
        bytes('video', `video.${i.lang}.mp4`, 'video', 'video/mp4', `FAKE-MP4 ${i.lang} ${t.durationInFrames} frames MOCK`, i.lang, { width: 1080, height: 1920, frames: t.durationInFrames }),
        bytes('cover', `cover.${i.lang}.png`, 'image', 'image/png', `FAKE-PNG ${i.lang} frame ${t.coverFrame}`, i.lang, { width: 1080, height: 1920 }),
      ],
      provides: { totalFrames: t.durationInFrames, coverFrame: t.coverFrame },
      costUsd: 0,
    };
  },
  'post-copy': (i) => {
    const s = i.byPort.script as ScriptDoc;
    const lang = i.lang!;
    const cta = s.cta[lang] ?? '';
    const d = relintPostCopy({ lang, caption: `${s.beats[0]?.onScreen[lang] ?? ''}\n\n${cta}`.trim(), cta, hashtags: [], lint: [] }, s);
    return { outputs: [json('caption', `caption.${lang}.json`, d, lang), json('meta', `meta.${lang}.json`, { aiGenerated: true, lang }, lang)], provides: { cta: { [lang]: cta } }, costUsd: 0 };
  },
  check: (i) => {
    const renders = i.inputs.filter((u) => u.port.startsWith('video:')).map((u) => u.nodeId);
    return {
      outputs: [json('score', 'score.json', { verdict: 'Unscored', criteria: [], renders }), json('routes', 'routes.json', { routes: [] })],
      provides: {},
      checks: [{ id: 'check.unscored', ok: true, required: false, text: 'No reviewer: unscored' }],
      costUsd: 0,
    };
  },
};

function fakeEstimate(cfg: FakeConfig, e: EstimateInput): ExecEstimate {
  if (e.mode === 'mock') return { usdLow: 0, usdHigh: 0, seconds: 1, basis: 'mock', verified: true };
  const c = pick(cfg.costs, e.node);
  if (c) return { usdLow: c.usdLow ?? c.usdHigh, usdHigh: c.usdHigh, seconds: 1, basis: 'fake estimate', verified: true };
  if (e.node.kind === 'voice') {
    const lines = ((e.byPort.lines as { lines?: { display: string }[] } | null)?.lines ?? []).reduce((s, l) => s + l.display.length, 0);
    const usd = Math.round(lines * 0.00008 * 1e6) / 1e6; // example rate (volatile, unverified)
    return { usdLow: usd, usdHigh: usd, seconds: 4, basis: `${lines} characters`, verified: false };
  }
  if (e.connector === 'claude-cli' || e.connector === 'agent-sdk') {
    const cap = ROLE_CAP_USD[e.node.kind];
    if (cfg.agentBilling === 'api-key' && cap !== undefined) return { usdLow: 0, usdHigh: cap, seconds: 90, basis: 'role cap', verified: true };
    return { usdLow: 0, usdHigh: 0, seconds: 90, basis: 'Your Claude plan', verified: true };
  }
  return { usdLow: 0, usdHigh: 0, seconds: 1, basis: 'local', verified: true };
}

function fakeCost(cfg: FakeConfig, node: PipelineNode, mode: 'live' | 'mock', fallback: number | null): number | null {
  if (mode === 'mock') return 0;
  const c = pick(cfg.costs, node);
  if (c) return c.actual === undefined ? c.usdHigh : c.actual;
  return fallback;
}

/** Fake executors for every kind except narration-text (which is real, from). */
export function makeFakeExecutors(cfg: FakeConfig = {}): Record<Exclude<StepKind, 'narration-text'>, Executor> {
  const counters = (cfg.counters ??= newCounters());
  const out = {} as Record<Exclude<StepKind, 'narration-text'>, Executor>;
  for (const kind of Object.keys(MAKERS) as Exclude<StepKind, 'narration-text'>[]) {
    const make = MAKERS[kind];
    const runOnce = async (i: ExecInput): Promise<ExecResult> => {
      cfg.onStart?.(i.node.id, i.connector);
      try {
        bump(counters.runs, i.node.id);
        await sleep(pick(cfg.delayMs, i.node) ?? 0, i.signal);
        await cfg.holdUntil?.(i.node.id);
        const msg = cfg.fail?.[i.node.id];
        if (msg) throw new PostmakerError(502, 'step-failed', msg);
        const r = await make(i, cfg);
        return { ...r, costUsd: fakeCost(cfg, i.node, i.mode, r.costUsd ?? 0) ?? null, model: i.mode === 'mock' ? 'mock' : `fake-${kind}` };
      } finally {
        cfg.onEnd?.(i.node.id, i.connector);
      }
    };
    const ex: Executor = {
      kind,
      implVersion: `${kind}@1`,
      deterministic: KINDS[kind].deterministic,
      estimate: (e) => fakeEstimate(cfg, e),
      run: runOnce,
      contractOf: (data, node) => contractOfDoc(kind, data, node),
    };
    if (kind === 'lipsync' || kind === 'broll') {
      ex.job = {
        submit: async (i) => {
          const n = bump(counters.submits, i.node.id);
          const requestId = `fake-${i.node.id.replace(/[:#]/g, '-')}-${n}`;
          cfg.onSubmitted?.(i.node.id, requestId);
          return { requestId };
        },
        collect: async (requestId, i) => {
          bump(counters.collects, i.node.id);
          const r = await runOnce(i);
          return { ...r, requests: [{ id: requestId, at: new Date(i.now()).toISOString(), status: 'done', costUsd: r.costUsd }] };
        },
      };
    }
    out[kind] = ex;
  }
  return out;
}

/** The contract of an edited JSON output (`step.edit`), for the kinds whose documents the adapters know. */
export function contractOfDoc(kind: StepKind, data: Record<string, unknown>, node: PipelineNode): Contract {
  switch (kind) {
    case 'script':
      return scriptContract(data.script as ScriptDoc);
    case 'voice':
      return alignmentContract(data.alignment as AlignmentDoc);
    case 'motion':
      return motionContract(data.motion as MotionDoc);
    case 'compose':
      return timelineContract(data.timeline as TimelineDoc);
    case 'mix':
      return { totalFrames: (data.mixPlan as { durationFrames: number }).durationFrames };
    case 'post-copy': {
      const d = data.caption as PostCopyDoc;
      return { cta: { [d.lang]: d.cta } };
    }
    default:
      void node;
      return {};
  }
}
