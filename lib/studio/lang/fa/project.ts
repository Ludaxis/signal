// project(pron, profile): the vendor string for one voice ("Projection"). A pure function:
// the same pron and profile always give the same tts and ttsHash. A take records the ttsHash it was
// made from; a different hash means the take is stale.

import { ZWNJ, stripMarks } from './chars';
import { findEntry, type Lexicon } from './lexicon';
import { pieceOf, sha256, type FaLineText, type PronSpan } from './pron';

export interface VoiceProfile {
  id: string;
  provider: 'mock' | 'elevenlabs' | 'azure' | 'google';
  /** Pinned model id; never omitted (the vendor default model may have no Persian). */
  model: string;
  voiceId: string;
  diacritics: 'all' | 'homographs' | 'none';
  ezafe: 'kasra' | 'display';
  conjO: boolean;
  zwnj: 'keep' | 'space';
  ipaInline: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  testId: string | null;
}

export class ProjectionError extends Error {
  constructor(
    readonly code: 'MODEL_ID_REQUIRED' | 'VOICE_ID_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectionError';
  }
}

/** Fails before any provider call when the model id is missing. */
export function assertVoiceProfile(profile: Partial<VoiceProfile>): asserts profile is VoiceProfile {
  if (!profile.model || !String(profile.model).trim()) throw new ProjectionError('MODEL_ID_REQUIRED', `voice profile ${profile.id ?? '?'} has no model id`);
  if (!profile.voiceId) throw new ProjectionError('VOICE_ID_REQUIRED', `voice profile ${profile.id ?? '?'} has no voice id`);
}

export interface ProjectionOffset {
  /** Index into line.spans, or -1 for text between spans. */
  span: number;
  t: [number, number];
  p: [number, number];
}

export interface Projection {
  tts: string;
  offsets: ProjectionOffset[];
  ttsHash: string;
}

function splitPiece(span: PronSpan): { core: string; suffix: string } {
  const full = pieceOf(span);
  if (full.startsWith(span.base)) return { core: span.base, suffix: full.slice(span.base.length) };
  const core = span.base.slice(0, -1); // hamza ezafe: هٔ → ه + \u200Cیِ
  return { core, suffix: full.slice(core.length) };
}

function projectPiece(span: PronSpan, profile: VoiceProfile, lexicon?: Lexicon): string {
  const entry = lexicon && span.ruleId ? findEntry(lexicon, span.ruleId) : undefined;
  const override = entry?.voices?.[profile.id]?.tts;
  if (override !== undefined) return override;
  if (profile.ipaInline && entry?.ipa && span.kind === 'glossary') return `/${entry.ipa}/`;
  const { core, suffix } = splitPiece(span);
  const keepMarks = profile.diacritics === 'all' || (profile.diacritics === 'homographs' && span.reading !== undefined);
  let c = keepMarks ? core : stripMarks(core);
  // a date span carries its own ezafe junctions (day\u200C\u0650 month): keep them under ezafe: 'kasra'
  if (!keepMarks && span.kind === 'date' && profile.ezafe === 'kasra') {
    const ws = core.split(' ');
    c = ws.map((w, k) => (k < ws.length - 1 && w.endsWith('\u0650') ? `${stripMarks(w)}\u0650` : stripMarks(w))).join(' ');
  }
  if (profile.conjO) c = c.replace(/ و (?=\S)/g, '\u064F ');
  const s = profile.ezafe === 'kasra' ? suffix : suffix.replace(/\u0650/g, '');
  return c + s;
}

/** Project a line's pron for one voice profile. */
export function project(line: Pick<FaLineText, 'pron' | 'spans'>, profile: VoiceProfile, opts: { lexicon?: Lexicon } = {}): Projection {
  assertVoiceProfile(profile);
  let tts = '';
  const offsets: ProjectionOffset[] = [];
  let cursor = 0;
  const pushGap = (to: number) => {
    if (to <= cursor) return;
    let g = line.pron.slice(cursor, to);
    if (profile.zwnj === 'space') g = g.replace(/\u200C/g, ' ');
    const t0 = tts.length;
    tts += g;
    offsets.push({ span: -1, t: [t0, tts.length], p: [cursor, to] });
  };
  line.spans.forEach((span, i) => {
    pushGap(span.p[0]);
    let piece = projectPiece(span, profile, opts.lexicon);
    if (profile.zwnj === 'space') piece = piece.split(ZWNJ).join(' ');
    if (profile.conjO && span.kind === 'marked' && span.base === 'و' && tts.endsWith(' ')) {
      tts = tts.slice(0, -1);
      piece = '\u064F';
    }
    const t0 = tts.length;
    tts += piece;
    offsets.push({ span: i, t: [t0, tts.length], p: [span.p[0], span.p[1]] });
    cursor = span.p[1];
  });
  pushGap(line.pron.length);
  return { tts, offsets, ttsHash: sha256(tts + profile.id + profile.model) };
}

/** A take is stale when the current projection's hash differs from the hash it was made from. */
export function isTakeStale(take: { ttsHash: string }, current: Projection): boolean {
  return take.ttsHash !== current.ttsHash;
}
