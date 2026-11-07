// Core + pack lexicon. Pack entries win over core entries; among the entries of one
// scope the longest match wins. Matching is on normalised display tokens. Only `approved` entries
// apply in a final render; `proposed` entries apply in drafts (and are listed on the review card).

import coreLexiconData from './data/core-lexicon.json';
import type { Token } from './tokenize';

export type LexKind =
  | 'brand' | 'product' | 'character' | 'person' | 'place' | 'loanword' | 'acronym' | 'homograph' | 'ezafe' | 'number-word' | 'platform';

export interface LexContext {
  beforeAny?: string[];
  afterAny?: string[];
  objectAny?: string[];
  /** Accepted for forward compatibility; not evaluated in fa-norm-1.0. */
  pos?: 'noun' | 'verb' | 'adj' | 'pron';
}

export interface LexReading {
  key: string;
  pron: string;
  roman: string;
  gloss: string;
  context: LexContext | null;
  default?: boolean;
}

export interface LexEntry {
  id: string;
  kind: LexKind;
  match: { display: string[]; mode: 'word' | 'exact' | 'prefix'; inflects: boolean };
  display?: Partial<Record<'fa' | 'en', string>>;
  hashtags?: Partial<Record<'fa' | 'en', string>>;
  pron: string | null;
  roman: string;
  ipa?: string;
  readings?: LexReading[] | null;
  voices?: Record<string, { tts: string; result: 'pass' | 'fail'; testId: string; checkedAt: string }>;
  notes?: string;
  source: 'core' | 'editor' | 'listening-test' | 'agent-proposal';
  status: 'proposed' | 'approved' | 'retired';
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface LexiconFile {
  schema: 'signal.fa-lexicon/1' | string;
  scope: 'core' | 'pack' | string;
  packId?: string | null;
  version: number;
  updatedAt?: string;
  entries: LexEntry[];
}

export interface Lexicon {
  pack: LexEntry[];
  core: LexEntry[];
  versions: { core: number; pack: number };
}

export interface LexMatch {
  entry: LexEntry;
  scope: 'pack' | 'core';
  /** Number of tokens the match covers (multi-word entries cover several). */
  tokens: number;
  /** Clitic suffix after the matched form (inflecting entries only). */
  suffix: string;
  reading?: LexReading;
  needsDecision: boolean;
}

export const CORE_LEXICON = coreLexiconData as unknown as LexiconFile;

/** Suffixes an inflecting entry may carry (SK-C copula, clitics, plural, object marker). */
const INFLECT_SUFFIXES = ['\u200Cها', '\u200Cهای', '\u200Cشون', '\u200Cمون', '\u200Cتون', '\u200Cست', '\u200Cم', '\u200Cت', '\u200Cش', 'ئه', 'شون', 'مون', 'تون', 'ست', 'ه', 'م', 'ت', 'ش', 'و', 'ی'];

export function loadLexicon(core: LexiconFile = CORE_LEXICON, pack?: LexiconFile | null): Lexicon {
  return {
    core: [...core.entries].filter((e) => e.status !== 'retired'),
    pack: pack ? [...pack.entries].filter((e) => e.status !== 'retired') : [],
    versions: { core: core.version, pack: pack?.version ?? 0 },
  };
}

function words(display: string): string[] {
  return display.split(' ').filter(Boolean);
}

function tokenMatches(form: string, token: string, entry: LexEntry, last: boolean): string | null {
  if (token === form) return '';
  if (entry.match.mode === 'prefix' && token.startsWith(form)) return token.slice(form.length);
  if (last && entry.match.inflects && token.startsWith(form)) {
    const suffix = token.slice(form.length);
    if (INFLECT_SUFFIXES.includes(suffix)) return suffix;
  }
  return null;
}

function contextHit(list: string[] | undefined, token: Token | undefined, kindWhenMissing: '<end>' | null): boolean {
  if (!list || list.length === 0) return false;
  if (!token) return kindWhenMissing !== null && list.includes(kindWhenMissing);
  if (token.kind === 'punct') return list.includes('<punct>');
  for (const item of list) {
    if (item === '<word>') return true;
    if (item.endsWith('*') && token.text.startsWith(item.slice(0, -1))) return true;
    if (item === token.text) return true;
  }
  return false;
}

/** Strip an attached object marker so «هندونه\u200Cرو» or «کیکو» still finds its noun. */
function bareNoun(t: string): string[] {
  const out = [t];
  if (t.endsWith('و')) out.push(t.slice(0, -1));
  return out;
}

export function readingMatches(ctx: LexContext | null, tokens: Token[], i: number, span: number): boolean {
  if (!ctx) return false;
  const before = tokens[i - 1];
  const after = tokens[i + span];
  if (contextHit(ctx.afterAny, after, '<end>')) return true;
  if (ctx.beforeAny && before && before.kind !== 'punct' && ctx.beforeAny.includes(before.text)) return true;
  if (ctx.objectAny) {
    for (let j = i - 1, seen = 0; j >= 0 && seen < 3; j--) {
      const t = tokens[j];
      if (!t || t.kind === 'punct') break;
      seen++;
      if (bareNoun(t.text).some((w) => ctx.objectAny!.includes(w))) return true;
    }
  }
  return false;
}

function chooseReading(entry: LexEntry, tokens: Token[], i: number, span: number): { reading?: LexReading; needsDecision: boolean } {
  const readings = entry.readings ?? [];
  if (readings.length === 0) return { needsDecision: false };
  for (const r of readings) if (r.context && readingMatches(r.context, tokens, i, span)) return { reading: r, needsDecision: false };
  const def = readings.find((r) => r.default);
  if (def) return { reading: def, needsDecision: false };
  return { needsDecision: true };
}

function matchIn(entries: LexEntry[], tokens: Token[], i: number, final: boolean): Omit<LexMatch, 'scope'> | null {
  let best: Omit<LexMatch, 'scope'> | null = null;
  for (const entry of entries) {
    if (final && entry.status !== 'approved') continue;
    for (const form of entry.match.display) {
      const parts = words(form);
      if (parts.length === 0 || (best && parts.length <= best.tokens)) continue;
      let suffix = '';
      let ok = true;
      for (let k = 0; k < parts.length; k++) {
        const t = tokens[i + k];
        const prev = tokens[i + k - 1];
        if (!t || t.kind === 'punct' || (k > 0 && prev && t.start !== prev.end + 1)) {
          ok = false;
          break;
        }
        const s = tokenMatches(parts[k] ?? '', t.text, entry, k === parts.length - 1);
        if (s === null) {
          ok = false;
          break;
        }
        suffix = s;
      }
      if (!ok) continue;
      const { reading, needsDecision } = chooseReading(entry, tokens, i, parts.length);
      best = { entry, tokens: parts.length, suffix, reading, needsDecision };
    }
  }
  return best;
}

/** Find the lexicon entry for the token at index i: pack before core, then the longest match. */
export function matchToken(lex: Lexicon, tokens: Token[], i: number, opts: { final?: boolean } = {}): LexMatch | null {
  const final = !!opts.final;
  const p = matchIn(lex.pack, tokens, i, final);
  if (p) return { ...p, scope: 'pack' };
  const c = matchIn(lex.core, tokens, i, final);
  return c ? { ...c, scope: 'core' } : null;
}

export function findEntry(lex: Lexicon, id: string): LexEntry | undefined {
  return lex.pack.find((e) => e.id === id) ?? lex.core.find((e) => e.id === id);
}

/** Lines whose spans use the given entry (listed as stale before an edit is saved). */
export function affectedLines<T extends { id: string; line: { spans: { ruleId?: string }[] } }>(lines: T[], entryId: string): string[] {
  return lines.filter((l) => l.line.spans.some((s) => s.ruleId === entryId)).map((l) => l.id);
}

/** A listener's pronunciation note always becomes a proposed entry, never a one-off edit. */
export function proposeLexiconEntry(input: {
  id: string;
  kind: LexKind;
  display: string;
  pron: string;
  roman: string;
  source: 'listening-test' | 'agent-proposal' | 'editor';
  notes?: string;
}): LexEntry {
  return {
    id: input.id,
    kind: input.kind,
    match: { display: [input.display], mode: 'word', inflects: false },
    pron: input.pron,
    roman: input.roman,
    readings: null,
    notes: input.notes,
    source: input.source,
    status: 'proposed',
    approvedBy: null,
    approvedAt: null,
  };
}
