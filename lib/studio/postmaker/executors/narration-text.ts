// `narration-text:<lang>` executor. Deterministic local step:
// fa lines become FaLineText (display, pron, roman, spans, hashes) via lib/studio/lang/fa; en lines
// keep { display, tts, register }. Linter findings become `checks`. An optional language-editor
// pass (mockable; a fixture in mock mode) proposes pron marks that land with reviewed: false.
// Mock mode writes gate records with reviewer "mock", which counts as unsigned.
// No network, no vendor call, no agent call of its own: `proposePronMarks` is injected.
// Shapes shared with the rest of the Post maker (Lang, run mode, the pack voice profile, step checks) come from
// ../types; since so do the line, check and projection shapes; only the shapes that depend on
// the Persian library (FaNarrationLine, the input and output of this step) are defined here.

import { buildFaLine, pendingDecisions, runLanguageAgentPass, type FaLineText, type PronError, type PronPatch } from '@/lib/studio/lang/fa/pron';
import { CORE_LEXICON, loadLexicon, type LexiconFile } from '@/lib/studio/lang/fa/lexicon';
import { mockSignoff } from '@/lib/studio/lang/fa/review';
import { project, type VoiceProfile as FaProjectionProfile } from '@/lib/studio/lang/fa/project';
import type { NormalizeOptions } from '@/lib/studio/lang/fa/normalize';
import type { LintContext } from '@/lib/studio/lang/fa/lint';
import { PostmakerError } from '../errors';
import type { EnNarrationLine, FaRegister, Lang, NarrationCheck, NarrationLine, NarrationScriptLine, Provenance, StepCheck, VoiceProfile } from '../types';

export type { EnNarrationLine, Lang, NarrationCheck, NarrationLine, NarrationScriptLine };

export interface NarrationTextInput {
  lang: Lang;
  lines: NarrationScriptLine[];
  mode: Provenance['mode'];
  lexicon?: { core?: LexiconFile; pack?: LexiconFile | null };
  normalize?: Partial<NormalizeOptions>;
  lint?: LintContext;
  /** The language-editor pass (structured patch only). In mock mode this is a fixture. */
  proposePronMarks?: (line: FaLineText, ctx: { lineId: string; previousErrors: PronError[] }) => PronPatch | Promise<PronPatch>;
  /** ISO timestamp for mock gate records (deterministic tests). */
  now?: string;
}

export interface FaNarrationLine extends FaLineText {
  id: string;
  beatId: string;
  speaker: string;
  register: FaRegister;
}

export interface NarrationTextOutput {
  lang: Lang;
  lines: (FaNarrationLine | EnNarrationLine)[];
  checks: NarrationCheck[];
  /** True when no check is an error (the S1 automated checks pass). */
  ok: boolean;
}

function normalizeEn(s: string): string {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/[ \t\u00A0]+/g, ' ').replace(/\.{3,}/g, '…').replace(/ +([,.!?;:])/g, '$1').trim();
}

export async function runNarrationText(input: NarrationTextInput): Promise<NarrationTextOutput> {
  const lex = loadLexicon(input.lexicon?.core ?? CORE_LEXICON, input.lexicon?.pack ?? null);
  const checks: NarrationCheck[] = [];
  const lines: (FaNarrationLine | EnNarrationLine)[] = [];
  const now = input.now ?? new Date().toISOString();

  for (const l of input.lines) {
    if (!l.langs.includes(input.lang)) continue;
    const src = l[input.lang];
    if (!src || !src.display?.trim()) {
      checks.push({ lineId: l.id, ruleId: 'MISSING_LANG_LINE', severity: 'error', message: `No ${input.lang} line for beat ${l.beatId}` });
      continue;
    }
    if (input.lang === 'en') {
      const display = normalizeEn(src.display);
      if (/[؀-ۿ]/.test(display)) checks.push({ lineId: l.id, ruleId: 'EN_SCRIPT_MIX', severity: 'error', message: 'Persian text in an English line' });
      const register = (l.en?.register ?? 'casual') as EnNarrationLine['register'];
      lines.push({ id: l.id, beatId: l.beatId, speaker: l.speaker, display, tts: display, register });
      continue;
    }
    const fa = l.fa!;
    const register = fa.register ?? 'colloquial';
    const built = buildFaLine(fa.display, {
      lexicon: lex,
      register,
      normalize: { ...input.normalize, allowDiacritics: fa.allowDiacritics },
      lint: input.lint,
    });
    let line = built.line;
    for (const i of built.issues) checks.push({ lineId: l.id, ruleId: i.ruleId, severity: i.severity, message: i.message, span: i.span, ...(i.suggestion ? { suggestion: i.suggestion } : {}) });
    for (const e of built.invariant) checks.push({ lineId: l.id, ruleId: e.code, severity: 'error', message: e.message });
    if (input.proposePronMarks) {
      const res = await runLanguageAgentPass(line, (ln, previousErrors) => input.proposePronMarks!(ln, { lineId: l.id, previousErrors }), { lexicon: lex });
      line = res.line;
      for (const e of res.errors) checks.push({ lineId: l.id, ruleId: e.code, severity: 'warning', message: `language-editor proposal rejected: ${e.message}` });
    }
    for (const i of pendingDecisions(line)) {
      checks.push({ lineId: l.id, ruleId: 'NEEDS_DECISION', severity: 'warning', message: `«${line.display.slice(line.spans[i]!.d[0], line.spans[i]!.d[1])}» needs the editor`, span: line.spans[i]!.d });
    }
    if (input.mode === 'mock') line = mockSignoff(line, now);
    lines.push({ ...line, id: l.id, beatId: l.beatId, speaker: l.speaker, register });
  }
  return { lang: input.lang, lines, checks, ok: !checks.some((c) => c.severity === 'error') };
}

/** The executor's checks as the store's StepVersion `checks`: one per finding, errors required. */
export function toStepChecks(out: Pick<NarrationTextOutput, 'lang' | 'checks'>): StepCheck[] {
  return out.checks.map((c, i) => ({
    id: `narration-text:${out.lang}:${c.lineId}:${c.ruleId}:${i}`,
    ok: false,
    required: c.severity === 'error',
    text: c.message,
    ...(c.span ? { evidence: `${c.lineId}@${c.span[0]}-${c.span[1]}` } : {}),
  }));
}

const FA_PROVIDER: Record<VoiceProfile['connector'], FaProjectionProfile['provider']> = { mock: 'mock', elevenlabs: 'elevenlabs', 'azure-speech': 'azure' };

/** A pack voice record (`pack/voices.json`) as the Persian projection profile. A fa voice must carry `projection`. */
export function projectionProfileOf(voice: VoiceProfile): FaProjectionProfile {
  if (!voice.projection) throw new PostmakerError(400, 'voice-projection', `Voice ${voice.id} has no Persian projection settings.`);
  return { id: voice.id, provider: FA_PROVIDER[voice.connector], model: voice.model, voiceId: voice.voiceId, ...voice.projection };
}

/** `NarrationLine` view of a fa line for one voice: spoken = tts, offsets = [spokenStart, spokenEnd, displayStart, displayEnd]. */
export function toNarrationLine(line: FaNarrationLine, voice: VoiceProfile): NarrationLine {
  const p = project(line, projectionProfileOf(voice));
  const offsets: [number, number, number, number][] = p.offsets
    .filter((o) => o.span >= 0)
    .map((o) => {
      const s = line.spans[o.span]!;
      return [o.t[0], o.t[1], s.d[0], s.d[1]];
    });
  return { id: line.id, beatId: line.beatId, speaker: line.speaker, display: line.display, spoken: p.tts, offsets, register: line.register === 'formal' ? 'formal' : 'colloquial', ttsHash: p.ttsHash };
}
