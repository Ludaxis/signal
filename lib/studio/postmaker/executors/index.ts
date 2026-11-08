// The executor registry. `narration-text` is the real executor (lib/studio/lang/fa pipeline, wrapped here);
// `check` is real when the caller gives it the store root (`check: { root }`, which the engine does). The
// agent executors (`analyse`, `script`, `post-copy`) replace their fakes when `agents` is given (the engine wiring
// passes the AgentCall and the pack data). The render chain (captions, compose, mix, render) is real when the
// caller passes `render` deps (the render child or the fake 2-frame renderer). Every other kind is a fake until its
// real executor lands (connectors). Without these deps the registry is unchanged, so the engine tests keep fakes.
import type { LexiconFile } from '@/lib/studio/lang/fa/lexicon';
import type { ScriptDoc } from '../graph/adapters';
import type { StepKind } from '../types';
import { captionsExecutor } from './captions';
import { checkExecutor, type CheckDeps } from './check';
import { composeExecutor } from './compose';
import { makeFakeExecutors, type FakeConfig } from './fakes';
import { mixExecutor } from './mix';
import type { RenderChainDeps } from './render-chain';
import { renderExecutor } from './render-final';
import { runNarrationText, toStepChecks, type NarrationScriptLine } from './narration-text';
import type { Executor, ExecutorRegistry } from './types';
import { analyseExecutor, type AnalyseDeps } from './analyse';
import { postCopyExecutor, type PostCopyDeps } from './post-copy';
import { scriptExecutor, type ScriptDeps } from './script';
import type { AgentCall } from './agent';
import { artExecutor, type ArtDeps } from './art';
import { motionExecutor, type MotionDeps } from './motion';
import { musicExecutor, type MusicDeps } from './music';
import type { SfxDeps } from './sfx';

export interface AgentExecutorDeps {
  /** The agent call every agent executor makes in live mode (mock mode never calls it). */
  call: AgentCall | null;
  script?: Omit<ScriptDeps, 'call'>;
  postCopy?: Omit<PostCopyDeps, 'call'>;
  /** `analyse` needs to know where the reference and the work folder are. */
  analyse?: Omit<AnalyseDeps, 'call'>;
  /** `art` (art director): the library, rigs and template loader and the asset-request recorder. */
  art?: Omit<ArtDeps, 'call'>;
  /** `motion` (animator): the rigs loader; the default chain wiring is. */
  motion?: Omit<MotionDeps, 'call'>;
  /** `music` (sound designer): the pack policy and tracks; the default chain wiring is. */
  music?: Omit<MusicDeps, 'call'>;
  /** SFX cues on `mix` (sound designer): the pack `sfx` library; used only with the real render chain. */
  sfx?: Omit<SfxDeps, 'call'>;
}

/** The real agent executors. */
export function agentExecutors(d: AgentExecutorDeps): Partial<Record<StepKind, Executor>> {
  return {
    script: scriptExecutor({ ...d.script, call: d.call }),
    'post-copy': postCopyExecutor({ ...d.postCopy, call: d.call }),
    ...(d.analyse ? { analyse: analyseExecutor({ ...d.analyse, call: d.call }) } : {}),
    ...(d.art ? { art: artExecutor({ ...d.art, call: d.call }) } : {}),
    ...(d.motion ? { motion: motionExecutor({ ...d.motion, call: d.call }) } : {}),
    ...(d.music ? { music: musicExecutor({ ...d.music, call: d.call }) } : {}),
  };
}

export interface NarrationDeps {
  /** The pack lexicon per language (read by the caller from the pack; `lexicon:<lang>` in the pack lock). */
  lexicon?: Partial<Record<'fa' | 'en', LexiconFile | null>>;
}

export function narrationTextExecutor(deps: NarrationDeps = {}): Executor {
  return {
    kind: 'narration-text',
    implVersion: 'narration-text@1',
    deterministic: true,
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'On this computer', verified: true }),
    async run(i) {
      const lang = i.lang;
      if (!lang) throw new Error('narration-text needs a language');
      const script = i.byPort.script as ScriptDoc | null;
      const lines: NarrationScriptLine[] = (script?.lines ?? []).map((l) => ({ id: l.id, beatId: l.beatId, speaker: l.speaker, langs: l.langs, fa: l.fa ?? null, en: l.en ?? null }));
      const out = await runNarrationText({ lang, lines, mode: i.mode, lexicon: { pack: deps.lexicon?.[lang] ?? null }, now: new Date(i.now()).toISOString() });
      const gated = lang === 'fa';
      return {
        outputs: [{ port: 'lines', name: `narration.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: out }],
        provides: { lineIds: out.lines.map((l) => l.id) },
        checks: toStepChecks(out),
        status: out.ok ? 'ok' : 'needs-you',
        costUsd: 0,
        model: null,
        // Mock runs write the gate record as `mock`, which counts as unsigned.
        signoffs: gated && i.mode === 'mock' ? [{ gate: 'fa-native-editor', nodeId: i.node.id, by: 'mock', name: 'mock', at: new Date(i.now()).toISOString(), verdict: 'pass' }] : [],
      };
    },
  };
}

/** The default registry: the real narration-text executor, the real check (with `check`), the real agent executors
 * (with `agents`), the real render chain (with `render`), fakes for every other kind. */
export function defaultExecutors(o: { fakes?: FakeConfig; narration?: NarrationDeps; check?: CheckDeps; agents?: AgentExecutorDeps; render?: Partial<RenderChainDeps> } = {}): ExecutorRegistry {
  return {
    ...makeFakeExecutors(o.fakes),
    'narration-text': narrationTextExecutor(o.narration),
    ...(o.agents ? agentExecutors(o.agents) : {}),
    ...(o.render ? renderChainExecutors(o.render, o.agents?.sfx ? { ...o.agents.sfx, call: o.agents.call } : undefined) : {}),
    ...(o.check ? { check: checkExecutor(o.check) } : {}),
  } as Record<StepKind, Executor>;
}

/** The render chain executors (captions, compose, mix, render) over one set of deps. */
export function renderChainExecutors(d: Partial<RenderChainDeps>, sfx?: SfxDeps): Pick<ExecutorRegistry, 'captions' | 'compose' | 'mix' | 'render'> {
  return { captions: captionsExecutor({ fonts: d.fonts }), compose: composeExecutor(d), mix: mixExecutor(d, sfx ? { sfx } : {}), render: renderExecutor(d) };
}

export const implVersionsOf = (r: ExecutorRegistry): Partial<Record<StepKind, string>> => Object.fromEntries(Object.values(r).map((e) => [e.kind, e.implVersion]));
