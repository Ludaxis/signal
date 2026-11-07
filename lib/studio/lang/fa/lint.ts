// lintFa: register, shekaste, deny-list, misspellings, digits, Latin runs, emoji, hashtags and
// length checks over *normalised* Persian text. Spans are UTF-16 offsets.

import { EMOJI_RE, ZWNJ, hasPersian, lastLetter, stripMarks, visibleLength } from './chars';
import { tokenizeFa, type Token } from './tokenize';
import type { Register } from './normalize';
import { SLOT_SPECS, type SlotId } from './breaks';
import { parseFaNumber, verbalizeFa, monthIndexFa } from './verbalize';
import formalDeny from './data/formal-deny.json';
import shekaste from './data/shekaste-allow.json';
import misspellings from './data/misspellings.json';
import hehFinal from './data/heh-final.json';

export interface LintIssue {
  ruleId: string;
  severity: 'error' | 'warning';
  span: [number, number];
  message: string;
  suggestion?: string;
}

export interface LintContext {
  register?: Register;
  slot?: SlotId;
  /** Narrated lines (default true): emoji and elongation are errors. */
  narrated?: boolean;
  /** Latin runs allowed inside Persian text (glossary display forms). */
  glossary?: string[];
  /** Pack claims policy: may the text say «رایگان» (free)? Default false (D13). */
  claimsAllowFree?: boolean;
  smallNumbers?: 'words' | 'digits';
}

export interface LintOverride {
  ruleId: string;
  span: [number, number];
  reason: string;
  by?: string;
}

const DENY = new Map(formalDeny.entries.map((e) => [e.word, e]));
const COLLOQUIAL_ONLY = new Set(shekaste.colloquialOnly);
const FORMAL_ONLY = new Set(shekaste.formalOnly);
const SHIFTS = shekaste.shifts;
const SHIFT_DENY = new Map(shekaste.shiftDeny.map((s) => [s.wrong, s.right]));
const NEUTRAL_FORBIDDEN = new Set(shekaste.neutralForbidden);
const MISSPELLINGS = new Map(misspellings.entries.map((e) => [e.wrong, e]));
const CONSONANTAL_HEH = new Set(hehFinal.consonantal);
const PRONOUNS = new Set(['من', 'تو', 'او', 'اون', 'این', 'ما', 'شما', 'اونا', 'اینا', 'ایشون']);
const SENTENCE_END = new Set(['.', '!', '؟', '?', '؛', '…']);
const LATIN_UNITS = new Set(['GB', 'MB', 'KB', 'TB', 'km', 'kg', 'cm', 'mm', 'g', 'm', 'ms', 's']);
const COUNTER_WORDS = new Set(['مرحله', 'مرحله\u200Cی', 'سطح', 'امتیاز', 'لول', 'شماره', 'ساعت', 'قسمت', 'فصل']);

const issue = (ruleId: string, severity: 'error' | 'warning', span: [number, number], message: string, suggestion?: string): LintIssue =>
  suggestion === undefined ? { ruleId, severity, span, message } : { ruleId, severity, span, message, suggestion };

function sentences(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const t of tokens) {
    out[out.length - 1]!.push(t);
    if (t.kind === 'punct' && SENTENCE_END.has(t.text)) out.push([]);
  }
  return out.filter((s) => s.length > 0);
}

function prevContent(tokens: Token[], i: number): Token | undefined {
  const t = tokens[i - 1];
  return t && t.kind !== 'punct' ? t : undefined;
}

function copulaSuggestion(prev: string): { ruleId: string; form: string } {
  const last = lastLetter(prev);
  const bare = stripMarks(prev);
  if (last === 'ا' || last === 'آ') return { ruleId: 'SK-C3', form: `${prev}ست` };
  if (last === 'و') {
    const before = bare[bare.length - 2];
    if (before === 'ا') return { ruleId: 'SK-C1', form: `${prev}ه` };
    return { ruleId: 'SK-C5', form: `${prev}ئه` };
  }
  if (last === 'ی') return { ruleId: 'SK-C2', form: `${prev}ه` };
  if (last === 'ه' && !CONSONANTAL_HEH.has(bare) && bare.length >= 3) return { ruleId: 'SK-C4', form: `${prev}${ZWNJ}ست` };
  return { ruleId: 'SK-C1', form: `${prev}ه` };
}

function objectMarkerSuggestion(prev: string): { ruleId: string; form: string } {
  if (prev === 'تو') return { ruleId: 'SK-R3', form: 'تو رو' };
  if (PRONOUNS.has(prev)) return { ruleId: 'SK-R2', form: `${prev}و` };
  return { ruleId: 'SK-R1', form: `${prev} رو` };
}

export function lintFa(text: string, ctx: LintContext = {}): LintIssue[] {
  const register: Register = ctx.register ?? 'colloquial';
  const narrated = ctx.narrated ?? true;
  const glossary = new Set(ctx.glossary ?? []);
  const tokens = tokenizeFa(text);
  const out: LintIssue[] = [];

  // character leftovers (normaliser not run, or pasted later)
  for (const m of text.matchAll(/[يىك]/g)) out.push(issue(m[0] === 'ك' ? 'N-03' : 'N-02', 'error', [m.index, m.index + 1], 'Use Persian ی and ک'));
  for (const m of text.matchAll(/ة/g)) out.push(issue('N-06', 'warning', [m.index, m.index + 1], 'Use ه unless this is a fixed Arabic phrase', 'ه'));
  for (const m of text.matchAll(/[ـ\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069]/g)) out.push(issue('N-14', 'error', [m.index, m.index + 1], 'Remove the control character or tatweel'));

  tokens.forEach((t, i) => {
    const span: [number, number] = [t.start, t.end];
    const prev = prevContent(tokens, i);
    const next = tokens[i + 1];

    if (t.kind === 'word') {
      const w = t.text;
      if (register === 'colloquial') {
        const d = DENY.get(w);
        if (d) out.push(issue(d.ruleId, d.severity as 'error' | 'warning', span, d.message, 'suggestion' in d ? (d.suggestion as string) : undefined));
        if (w === 'را' && prev) {
          const s = objectMarkerSuggestion(prev.text);
          out.push(issue(s.ruleId, 'error', [prev.start, t.end], 'Use رو after a noun (ـو after a pronoun)', s.form));
        }
        if (w === 'است' && prev) {
          const s = copulaSuggestion(prev.text);
          out.push(issue(s.ruleId, 'error', [prev.start, t.end], 'Write the colloquial copula', s.form));
        }
        for (const sh of SHIFTS) if (!sh.formal.includes(' ') && sh.formal === w) out.push(issue('SK-N1', 'warning', span, 'Colloquial form', sh.colloquial));
        if (w === 'چه' && next && next.kind === 'punct' && (next.text === '؟' || next.text === '?')) out.push(issue('SK-Q2', 'warning', span, 'Use چی in colloquial questions', 'چی'));
      }
      if (register !== 'formal') {
        const right = SHIFT_DENY.get(w);
        if (right) out.push(issue('SK-N2', 'warning', span, 'No /ān/→/un/ shift on proper nouns or high-prestige words', right));
      }
      if (register === 'neutral' && NEUTRAL_FORBIDDEN.has(w)) out.push(issue('REG-N', 'error', span, 'Not neutral: use a form that is the same in both registers'));
      const mis = MISSPELLINGS.get(w);
      if (mis && register !== 'formal') {
        out.push(issue(mis.ruleId, mis.severity as 'error' | 'warning', span, 'message' in mis ? (mis.message as string) : 'Spelling', mis.right));
      }
      if (/([ء-غف-يپچژکگی])\1\1/.test(w)) {
        const severity = narrated && ctx.slot !== 'sticker' ? 'error' : 'warning';
        out.push(issue('SK-X1', severity, span, 'No elongated spelling: the voice reads it literally'));
      }
      if (w === 'رایگان' && !ctx.claimsAllowFree) out.push(issue('CLAIM-1', 'error', span, 'The claims policy does not allow «free»'));
    }

    if (t.kind === 'latin') {
      const allowedPov = ctx.slot === 'pov-pill' && i === 0 && t.text === 'POV';
      if (!glossary.has(t.text) && !allowedPov) out.push(issue('MX-1', 'error', span, 'Latin text that is not in the glossary'));
    }

    if (t.kind === 'number') {
      const isAscii = /[0-9٠-٩]/.test(t.text);
      const latinBefore = prev?.kind === 'latin';
      if (isAscii && !latinBefore && hasPersian(text)) out.push(issue('NU-1', 'error', span, 'Use Persian digits in Persian text'));
      if (next && next.kind === 'latin' && LATIN_UNITS.has(next.text.split(' ')[0] ?? '')) {
        out.push(issue('MX-2', 'error', [t.start, next.end], 'No Latin units in Persian text'));
      }
      const after = tokens[i + 2];
      if (next?.text === '-' && after?.kind === 'number') {
        out.push(issue('NU-4', 'warning', [t.start, after.end], 'Ranges use «تا»', `${t.text} تا ${after.text}`));
      }
      const value = parseFaNumber(t.text);
      const smallWords = (ctx.smallNumbers ?? 'words') === 'words';
      const isCount = Number.isInteger(value) && value >= 1 && value <= 9 && /^[۰-۹0-9]$/.test(t.text);
      const nextWord = next && next.kind === 'word' ? next.text : '';
      const exempt = monthIndexFa(nextWord) > 0 || ['هزار', 'تومان', 'تومن', 'میلیون', 'درصد'].includes(nextWord) || (prev && COUNTER_WORDS.has(prev.text));
      if (register === 'colloquial' && smallWords && isCount && !exempt) {
        out.push(issue('NU-2', 'warning', span, 'Counts 1-9 are written as words in colloquial text', verbalizeFa(value, 'colloquial')));
      }
    }

    if (t.kind === 'emoji') {
      if (narrated) out.push(issue('EMO-1', 'error', span, 'No emoji inside narrated text; use a sticker layer'));
      const lineStart = text.lastIndexOf('\n', t.start - 1) + 1;
      if (text.slice(lineStart, t.start).trim() === '') out.push(issue('EMO-2', 'error', span, 'Never start a Persian line with an emoji'));
    }

    if (t.kind === 'hashtag') {
      if (t.text.includes(ZWNJ)) out.push(issue('HT-3', 'error', span, 'No ZWNJ inside a hashtag', t.text.replace(/\u200C/g, '')));
      if (hasPersian(t.text) && /[0-9۰-۹]/.test(t.text)) out.push(issue('HT-4', 'error', span, 'No digits in Persian hashtags'));
    }
  });

  // hashtag counts (HT-1)
  const tags = tokens.filter((t) => t.kind === 'hashtag');
  if (tags.length > 5) out.push(issue('HT-1', 'error', [tags[5]!.start, tags[tags.length - 1]!.end], 'At most 5 hashtags per post'));
  const faTags = tags.filter((t) => hasPersian(t.text));
  if (faTags.length > 3) out.push(issue('HT-1', 'error', [faTags[3]!.start, faTags[faTags.length - 1]!.end], 'At most 3 Persian hashtags'));

  // multi-word SK-N1 shifts
  if (register === 'colloquial') {
    for (const sh of SHIFTS) {
      if (!sh.formal.includes(' ')) continue;
      let from = 0;
      let at: number;
      while ((at = text.indexOf(sh.formal, from)) !== -1) {
        out.push(issue('SK-N1', 'warning', [at, at + sh.formal.length], 'Colloquial form', sh.colloquial));
        from = at + sh.formal.length;
      }
    }
  }

  // sentence-level: register mix, exclamations, question marks
  for (const s of sentences(tokens)) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    const span: [number, number] = [first.start, last.end];
    if (register !== 'formal') {
      const words = s.filter((t) => t.kind === 'word').map((t) => t.text);
      const coll = words.some((w) => COLLOQUIAL_ONLY.has(w));
      const form = words.some((w) => FORMAL_ONLY.has(w));
      if (coll && form) out.push(issue('SK-X3', 'error', span, 'One register per sentence'));
    }
    const bangs = s.filter((t) => t.text === '!').length;
    if (bangs > 1) out.push(issue('TONE-8', 'warning', span, 'At most one «!» per sentence'));
  }
  for (const m of text.matchAll(/؟؟+|!!!+|\?\?+/g)) out.push(issue('SK-Q5', 'error', [m.index, m.index + m[0].length], 'Never «؟؟» or «!!!»'));
  const qx = [...text.matchAll(/؟!/g)];
  if (qx.length > 1) out.push(issue('SK-Q5', 'warning', [qx[1]!.index, qx[1]!.index + 2], 'At most one «؟!» per piece'));

  // length per slot
  if (ctx.slot) {
    const spec = SLOT_SPECS[ctx.slot];
    const lines = text.split('\n');
    if (lines.length > spec.maxLines) out.push(issue('LEN-2', 'warning', [0, text.length], `At most ${spec.maxLines} lines`));
    let offset = 0;
    for (const line of lines) {
      if (visibleLength(line) > spec.maxChars) out.push(issue('LEN-1', 'warning', [offset, offset + line.length], `At most ${spec.maxChars} characters per line`));
      offset += line.length + 1;
    }
    const wordCount = tokens.filter((t) => t.kind !== 'punct' && t.kind !== 'emoji').length;
    if (wordCount > spec.maxWords) out.push(issue('LEN-3', 'warning', [0, text.length], `At most ${spec.maxWords} words`));
  }

  // emoji per caption page
  const emoji = tokens.filter((t) => t.kind === 'emoji' || EMOJI_RE.test(t.text));
  if (ctx.slot === 'kinetic-caption' && emoji.length > 1) out.push(issue('EMO-3', 'warning', [emoji[1]!.start, emoji[1]!.end], 'At most one emoji per caption page'));

  return out.sort((a, b) => a.span[0] - b.span[0] || a.ruleId.localeCompare(b.ruleId));
}

/** Errors that still block the text gate (S1): every error not overridden by the editor with a reason. */
export function textGateBlockers(issues: LintIssue[], overrides: LintOverride[] = []): LintIssue[] {
  return issues.filter(
    (i) =>
      i.severity === 'error' &&
      !overrides.some((o) => o.ruleId === i.ruleId && o.span[0] === i.span[0] && o.span[1] === i.span[1] && o.reason.trim().length > 0),
  );
}
