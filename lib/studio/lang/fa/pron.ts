// The pronunciation layer: `display` (on screen), `pron` (canonical, marked, reviewed by a
// person) and `roman` (house transliteration). `pron` is always rebuilt from its spans, never typed
// free-hand; the sync invariant guarantees that a marked span changes vowels only, never letters.

import { createHash } from 'node:crypto';
import { EMOJI_RE, NORM_VERSION, ZWNJ, canonDisplay, isLetter, isMark, lastLetter, stripMarks } from './chars';
import { normalizeFa, type Change, type NormalizeOptions, type Register } from './normalize';
import { lintFa, type LintContext, type LintIssue } from './lint';
import { tokenizeFa, type Token } from './tokenize';
import { findEntry, loadLexicon, matchToken, type LexEntry, type Lexicon } from './lexicon';
import {
  monthIndexFa, parseFaNumber, verbalizeDateFa, verbalizeDecimalFa, verbalizeFaPron, verbalizeMoneyFa, verbalizePercentFa,
  verbalizeTimeFa, type Spoken,
} from './verbalize';
import hehFinal from './data/heh-final.json';

export type SpanKind = 'marked' | 'number' | 'date' | 'time' | 'currency' | 'percent' | 'glossary' | 'lexicon' | 'acronym' | 'silent' | 'override';

export interface PronSpan {
  /** Display UTF-16 range: one token, a Latin run, or number + unit. */
  d: [number, number];
  /** Pron range ([x, x] for a silent span). */
  p: [number, number];
  kind: SpanKind;
  /** 'PR-N7', a lexicon entry id, … Required on every span that is not `marked`. */
  ruleId?: string;
  /** Chosen homograph reading key. */
  reading?: string;
  /** An ezafe junction follows this token. */
  ezafeAfter?: boolean;
  reviewed: boolean;
  /** The span's pron text without the ezafe suffix (pron is rebuilt from it). */
  base: string;
  /** Roman of the token without the ezafe suffix. */
  roman?: string;
  /** Homograph with no default and no matching context: the editor decides (PR-H1). */
  needsDecision?: boolean;
  /** Flag for the review card. */
  flag?: 'invariant' | 'roman-unresolved' | 'latin-unresolved';
  /** Written reason for an `override` span. */
  overrideReason?: string;
}

export interface ReviewState {
  status: 'draft' | 'approved' | 'failed';
  by: string | null;
  at: string | null;
  items?: Record<string, 'pass' | 'fail'>;
  note?: string;
  /** Hash the review was signed against: displayHash + pronHash for text, ttsHash for listening. */
  hash?: string;
}

export interface FaLineText {
  display: string;
  pron: string;
  roman: string;
  spans: PronSpan[];
  displayHash: string;
  pronHash: string;
  lexiconVersion: { core: number; pack: number };
  normVersion: typeof NORM_VERSION;
  review: { text: ReviewState; listen: Record<string, ReviewState> };
}

export interface BuildOptions {
  lexicon?: Lexicon;
  register?: Register;
  normalize?: Partial<NormalizeOptions>;
  /** Final render: only approved lexicon entries apply. */
  final?: boolean;
  lint?: LintContext;
  /** Carry marks and review flags over from the previous version for unchanged tokens. */
  previous?: FaLineText;
}

export interface BuildResult {
  line: FaLineText;
  issues: LintIssue[];
  changes: Change[];
  /** Lint errors stop the build; the line is still returned for the review card. */
  blocked: boolean;
  invariant: PronError[];
}

export interface PronError {
  code: 'PRON_INVARIANT' | 'PRON_RULE_MISSING' | 'PRON_LATIN' | 'PRON_EMOJI' | 'BAD_SPAN' | 'BAD_READING' | 'BAD_ROMAN' | 'OVERRIDE_REASON_REQUIRED';
  spanIndex?: number;
  message: string;
}

export interface PronPatchItem {
  spanIndex: number;
  ezafeAfter?: boolean;
  reading?: string;
  /** The display token with short vowels added (letters must not change). */
  vowels?: string;
  /** Roman for the token (ASCII). */
  roman?: string;
}

export type PronPatch = PronPatchItem[];

const CONSONANTAL_HEH = new Set(hehFinal.consonantal);
const GLOSSARY_KINDS = new Set(['brand', 'product', 'character', 'person', 'place', 'platform']);
const LETTER_NAMES: Record<string, [string, string]> = {
  A: ['اِی', 'ey'], B: ['بی', 'bi'], C: ['سی', 'si'], D: ['دی', 'di'], E: ['ای', 'i'], F: ['اِف', 'ef'], G: ['جی', 'ji'], H: ['اِیچ', 'eych'],
  I: ['آی', 'aay'], J: ['جِی', 'jey'], K: ['کِی', 'key'], L: ['اِل', 'el'], M: ['اِم', 'em'], N: ['اِن', 'en'], O: ['اُو', 'o'], P: ['پی', 'pi'],
  Q: ['کیو', 'kyu'], R: ['آر', 'aar'], S: ['اِس', 'es'], T: ['تی', 'ti'], U: ['یو', 'yu'], V: ['وی', 'vi'], W: ['دابلیو', 'daablyu'],
  X: ['اِکس', 'eks'], Y: ['وای', 'vaay'], Z: ['زِد', 'zed'],
};
const SUFFIX_ROMAN: Record<string, string> = {
  'ه': '-e', 'ئه': '-e', 'ست': '-st', 'م': '-m', 'ت': '-t', 'ش': '-sh', 'و': '-o', 'ی': '-i', 'مون': '-mun', 'تون': '-tun', 'شون': '-shun',
  '\u200Cها': '-haa', '\u200Cهای': '-haa-ye', '\u200Cست': '-st', '\u200Cم': '-m', '\u200Cت': '-t', '\u200Cش': '-sh', '\u200Cمون': '-mun', '\u200Cتون': '-tun', '\u200Cشون': '-shun',
};

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------
// Ezafe and roman helpers

/** The span's pron piece: base plus the ezafe suffix when `ezafeAfter` is set (marking conventions). */
export function pieceOf(span: Pick<PronSpan, 'base' | 'ezafeAfter' | 'kind'>): string {
  if (!span.ezafeAfter || span.kind === 'silent') return span.base;
  const b = span.base.replace(/\u0650$/, '');
  if (/هٔ$/.test(b)) return `${b.slice(0, -1)}${ZWNJ}یِ`;
  const last = lastLetter(b);
  if (last === 'ا' || last === 'آ' || last === 'و') return `${b}یِ`;
  if (last === 'ه' && !b.endsWith(`${ZWNJ}ی`) && !CONSONANTAL_HEH.has(stripMarks(b)) && stripMarks(b).length >= 3) return `${b}${ZWNJ}یِ`;
  return `${b}\u0650`;
}

export function romanWithEzafe(roman: string, ezafe: boolean | undefined): string {
  if (!ezafe || !roman || roman.endsWith('-ye')) return roman;
  return /[aeiou]$/i.test(roman) ? `${roman}-ye` : `${roman}-e`;
}

const CONS_ROMAN: Record<string, string> = {
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'ژ': 'zh',
  'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': "'", 'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'گ': 'g', 'ل': 'l',
  'م': 'm', 'ن': 'n', 'ء': "'", 'ئ': "'", 'أ': "'", 'ؤ': "'",
};
const VOWEL_MARK: Record<string, string> = { '\u064E': 'a', '\u0650': 'e', '\u064F': 'o', '\u064B': 'an' };

/**
 * House transliteration of one Persian token. `resolved` is false when the token has no
 * marked vowel and contains a consonant cluster whose vowel cannot be known (the token is flagged).
 */
export function romanizeToken(token: string): { roman: string; resolved: boolean } {
  // the display ezafe \u200Cی after a silent ه is the ezafe itself: «خونه\u200Cی» → khune-ye
  if (token.length > 2 && token.endsWith(`ه${ZWNJ}ی`)) {
    const stem = romanizeToken(token.slice(0, -2));
    return { roman: `${stem.roman}-ye`, resolved: stem.resolved };
  }
  const chars = [...token];
  let out = '';
  const hasMark = chars.some((c) => isMark(c) && c !== '\u0654');
  let ambiguous = false;
  let lastWasConsonant = false;
  let lastVowel = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const next = chars[i + 1];
    const atStart = i === 0 || chars[i - 1] === ZWNJ;
    if (c === ZWNJ) {
      out += '-';
      lastWasConsonant = false;
      continue;
    }
    if (isMark(c)) {
      if (c === '\u0651') {
        const m = /(ch|sh|kh|gh|zh|[a-z'])$/.exec(out);
        if (m) out += m[1];
      } else if (c in VOWEL_MARK) {
        out += VOWEL_MARK[c];
        lastVowel = VOWEL_MARK[c] ?? '';
        lastWasConsonant = false;
      }
      continue;
    }
    const nextIsVowel = next !== undefined && (next in VOWEL_MARK || next === 'ا' || next === 'آ');
    if (c === 'آ') {
      out += 'aa';
      lastWasConsonant = false;
      lastVowel = 'aa';
      continue;
    }
    if (c === 'ا') {
      if (atStart) {
        if (next && next in VOWEL_MARK) continue; // the mark gives the vowel
        if (next === 'ی') {
          out += 'i';
          i++;
          lastWasConsonant = false;
          continue;
        }
        if (next === 'و') {
          out += 'u';
          i++;
          lastWasConsonant = false;
          continue;
        }
        ambiguous = true;
        continue;
      }
      out += 'aa';
      lastWasConsonant = false;
      lastVowel = 'aa';
      continue;
    }
    if (c === 'و') {
      if (atStart || nextIsVowel || (next !== undefined && isMark(next))) {
        out += 'v';
        lastWasConsonant = true;
        continue;
      }
      if (lastVowel === 'o' && !lastWasConsonant) continue; // تُو: the damma already gave /o/
      if (token === 'و') {
        out += 'o';
        continue;
      }
      out += 'u';
      lastWasConsonant = false;
      lastVowel = 'u';
      continue;
    }
    if (c === 'ی') {
      if (atStart || nextIsVowel || (next !== undefined && isMark(next)) || !lastWasConsonant) {
        out += 'y';
        lastWasConsonant = true;
        continue;
      }
      out += 'i';
      lastWasConsonant = false;
      lastVowel = 'i';
      continue;
    }
    if (c === 'ه') {
      const isFinal = next === undefined || next === ZWNJ;
      if (isFinal && lastWasConsonant && !CONSONANTAL_HEH.has(stripMarks(token))) {
        out += 'e';
        lastWasConsonant = false;
        lastVowel = 'e';
        continue;
      }
      if (lastWasConsonant && !hasMark) ambiguous = true;
      out += 'h';
      lastWasConsonant = true;
      continue;
    }
    if (c === '\u0654') {
      out += '-ye';
      continue;
    }
    const r = CONS_ROMAN[c];
    if (r === undefined) {
      if (!isLetter(c)) out += c;
      continue;
    }
    if (lastWasConsonant && !hasMark) ambiguous = true;
    out += r;
    lastWasConsonant = true;
  }
  return { roman: out.replace(/^'/, ''), resolved: hasMark || !ambiguous };
}

function acronymFor(latin: string): { pron: string; roman: string } | null {
  if (!/^[A-Z]{2,6}$/.test(latin)) return null;
  const parts = [...latin].map((ch) => LETTER_NAMES[ch]);
  if (parts.some((p) => !p)) return null;
  return { pron: parts.map((p) => p![0]).join(ZWNJ), roman: parts.map((p) => p![1]).join('-') };
}

// ---------------------------------------------------------------------------------------------
// Deterministic pass (buildPronBase)

interface SpanDraft extends Omit<PronSpan, 'p'> {
  tokens: number;
}

function adjacent(a: Token | undefined, b: Token | undefined): boolean {
  return !!a && !!b && b.start === a.end + 1;
}

function numberSpan(tokens: Token[], i: number, register: Register): SpanDraft {
  const t = tokens[i]!;
  const reg: Register = register === 'formal' ? 'formal' : 'colloquial';
  const draft = (kind: SpanKind, ruleId: string, s: Spoken, n: number): SpanDraft => ({
    d: [t.start, tokens[i + n - 1]!.end], kind, ruleId, reviewed: false, base: s.pron, roman: s.roman, tokens: n,
  });
  const text = t.text;
  if (/[٪%]$/.test(text)) return draft('percent', 'PR-N10', verbalizePercentFa(parseFaNumber(text), reg), 1);
  if (text.includes(':')) {
    const [h = '0', m = '0'] = text.split(':');
    return draft('time', 'PR-N8', verbalizeTimeFa(parseFaNumber(h), parseFaNumber(m), reg), 1);
  }
  if (/[٫.]/.test(text)) return draft('number', 'PR-N11', verbalizeDecimalFa(parseFaNumber(text), reg), 1);
  if (/[/]/.test(text)) {
    const parts = text.split('/').map((p) => verbalizeFaPron(parseFaNumber(p), reg));
    return { ...draft('number', 'PR-N1', { pron: parts.map((p) => p.pron).join(' '), roman: parts.map((p) => p.roman).join(' '), words: '' }, 1), needsDecision: true };
  }
  const n = parseFaNumber(text);
  const next = tokens[i + 1];
  const after = tokens[i + 2];
  if (next && next.kind === 'word' && adjacent(t, next)) {
    const month = monthIndexFa(next.text);
    if (month > 0) {
      if (after && after.kind === 'number' && adjacent(next, after) && /^[۰-۹0-9]{4}$/.test(after.text)) {
        return draft('date', 'PR-N7', verbalizeDateFa(n, month, parseFaNumber(after.text), reg), 3);
      }
      return draft('date', 'PR-N7', verbalizeDateFa(n, month, undefined, reg), 2);
    }
    if ((next.text === 'هزار' || next.text === 'میلیون') && after && after.kind === 'word' && adjacent(next, after) && (after.text === 'تومان' || after.text === 'تومن')) {
      return draft('currency', 'PR-N9', verbalizeMoneyFa(n * (next.text === 'هزار' ? 1000 : 1_000_000), reg), 3);
    }
    if (next.text === 'تومان' || next.text === 'تومن') return draft('currency', 'PR-N9', verbalizeMoneyFa(n, reg), 2);
    if (next.text === 'درصد') return draft('percent', 'PR-N10', verbalizePercentFa(n, reg), 2);
  }
  const rule = n >= 11 && n <= 19 ? 'PR-N2' : n >= 1000 && n <= 9999 ? 'PR-N5' : 'PR-N1';
  return draft('number', rule, verbalizeFaPron(n, reg), 1);
}

function lexSpan(entry: LexEntry, tokens: Token[], i: number, n: number, suffix: string, readingKey: string | undefined, needsDecision: boolean): SpanDraft {
  const t = tokens[i]!;
  const last = tokens[i + n - 1]!;
  const reading = readingKey ? entry.readings?.find((r) => r.key === readingKey) : undefined;
  const kind: SpanKind = GLOSSARY_KINDS.has(entry.kind) ? 'glossary' : entry.kind === 'acronym' ? 'acronym' : 'lexicon';
  const displayText = tokens.slice(i, i + n).map((x) => x.text).join(' ');
  const basePron = needsDecision ? displayText : `${reading?.pron ?? entry.pron ?? displayText}${suffix}`;
  const baseRoman = needsDecision ? undefined : `${reading?.roman ?? entry.roman}${SUFFIX_ROMAN[suffix] ?? (suffix ? `-${romanizeToken(suffix).roman}` : '')}`;
  const s: SpanDraft = { d: [t.start, last.end], kind, ruleId: entry.id, reviewed: false, base: basePron, tokens: n };
  if (baseRoman !== undefined) s.roman = baseRoman;
  if (reading) s.reading = reading.key;
  if (needsDecision) s.needsDecision = true;
  return s;
}

/** Deterministic spans for normalised display text. */
export function buildPronBase(display: string, opts: { lexicon?: Lexicon; register?: Register; final?: boolean } = {}): Omit<PronSpan, 'p'>[] {
  const lex = opts.lexicon ?? loadLexicon();
  const register = opts.register ?? 'colloquial';
  const tokens = tokenizeFa(display);
  const out: SpanDraft[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === 'punct') {
      i++;
      continue;
    }
    let s: SpanDraft;
    if (t.kind === 'emoji' || t.kind === 'hashtag' || t.kind === 'url' || t.kind === 'handle') {
      s = { d: [t.start, t.end], kind: 'silent', ruleId: 'PR-S1', reviewed: true, base: '', roman: '', tokens: 1 };
    } else if (t.kind === 'callout') {
      const r = romanizeToken(t.text.slice(1, -1));
      s = { d: [t.start, t.end], kind: 'marked', ruleId: 'PR-C1', reviewed: false, base: t.text, roman: `«${r.roman}»`, tokens: 1 };
      if (!r.resolved) s.flag = 'roman-unresolved';
    } else if (t.kind === 'number') {
      s = numberSpan(tokens, i, register);
    } else {
      const m = matchToken(lex, tokens, i, { final: opts.final });
      if (m) {
        s = lexSpan(m.entry, tokens, i, m.tokens, m.suffix, m.reading?.key, m.needsDecision);
      } else if (t.kind === 'latin') {
        const ac = acronymFor(t.text);
        if (ac) s = { d: [t.start, t.end], kind: 'acronym', ruleId: 'PR-A1', reviewed: false, base: ac.pron, roman: ac.roman, tokens: 1 };
        else s = { d: [t.start, t.end], kind: 'silent', ruleId: 'PR-B1', reviewed: false, base: '', roman: '', flag: 'latin-unresolved', tokens: 1 };
      } else {
        const r = romanizeToken(t.text);
        s = { d: [t.start, t.end], kind: 'marked', reviewed: false, base: t.text, tokens: 1 };
        if (r.resolved) s.roman = r.roman;
        else s.flag = 'roman-unresolved';
      }
    }
    out.push(s);
    i += s.tokens;
  }
  return out.map(({ tokens: _t, ...rest }) => {
    void _t;
    return rest;
  });
}

// ---------------------------------------------------------------------------------------------
// Composition

function gapPron(gap: string, soFar: string): string {
  let g = gap.replace(/…/g, '،').replace(/\s+/g, ' ');
  if (soFar === '' || soFar.endsWith(' ')) g = g.replace(/^ +/, '');
  return g;
}

function gapRoman(gap: string, soFar: string): string {
  let g = gap.replace(/،/g, ',').replace(/؛/g, ';').replace(/؟/g, '?').replace(/\u200C/g, '').replace(/\s+/g, ' ');
  if (soFar === '' || soFar.endsWith(' ')) g = g.replace(/^ +/, '');
  return g;
}

/** Rebuild pron, roman, offsets and hashes from display + spans. */
export function composeLine(display: string, spans: Omit<PronSpan, 'p'>[], base: Pick<FaLineText, 'lexiconVersion' | 'review'>): FaLineText {
  let pron = '';
  let roman = '';
  let cursor = 0;
  const out: PronSpan[] = [];
  const sorted = [...spans].sort((a, b) => a.d[0] - b.d[0]);
  for (const s of sorted) {
    const gap = display.slice(cursor, s.d[0]);
    pron += gapPron(gap, pron);
    roman += gapRoman(gap, roman);
    const start = pron.length;
    pron += pieceOf(s);
    const span: PronSpan = { ...s, p: [start, pron.length] };
    out.push(span);
    const r = romanWithEzafe(s.roman ?? '', s.ezafeAfter);
    if (s.kind === 'silent' && roman.endsWith(' ')) {
      // nothing to add
    } else roman += r;
    cursor = s.d[1];
  }
  pron += gapPron(display.slice(cursor), pron);
  roman += gapRoman(display.slice(cursor), roman);
  pron = pron.replace(/ +$/, '');
  roman = roman.replace(/ +$/, '').replace(/ {2,}/g, ' ');
  return {
    display,
    pron,
    roman,
    spans: out,
    displayHash: sha256(display),
    pronHash: sha256(pron),
    lexiconVersion: base.lexiconVersion,
    normVersion: NORM_VERSION,
    review: base.review,
  };
}

const draftReview = (): FaLineText['review'] => ({ text: { status: 'draft', by: null, at: null }, listen: {} });

/** Carry marks and review flags from the previous version for tokens whose display text did not change (LCS). */
function carryOver(prev: FaLineText, display: string, spans: Omit<PronSpan, 'p'>[]): Omit<PronSpan, 'p'>[] {
  const a = prev.spans.map((s) => prev.display.slice(s.d[0], s.d[1]));
  const b = spans.map((s) => display.slice(s.d[0], s.d[1]));
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let x = a.length - 1; x >= 0; x--)
    for (let y = b.length - 1; y >= 0; y--) dp[x]![y] = a[x] === b[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
  const out = spans.map((s) => ({ ...s }));
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) {
      const old = prev.spans[x]!;
      const cur = out[y]!;
      if (old.kind === cur.kind) {
        const { p: _p, d: _d, ...keep } = old;
        void _p;
        void _d;
        out[y] = { ...keep, d: cur.d };
      }
      x++;
      y++;
    } else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) x++;
    else y++;
  }
  return out;
}

/** Normalise, lint and build the three texts of one fa line (without the agent pass). */
export function buildFaLine(input: string, opts: BuildOptions = {}): BuildResult {
  const lex = opts.lexicon ?? loadLexicon();
  const register = opts.register ?? 'colloquial';
  const { text: display, changes } = normalizeFa(input, { ...opts.normalize, register });
  const latinGlossary = [...lex.pack, ...lex.core].flatMap((e) => e.match.display).filter((d) => /[A-Za-z]/.test(d));
  const issues = lintFa(display, { register, ...opts.lint, glossary: [...latinGlossary, ...(opts.lint?.glossary ?? [])] });
  let spans = buildPronBase(display, { lexicon: lex, register, final: opts.final });
  if (opts.previous) spans = carryOver(opts.previous, display, spans);
  const line = composeLine(display, spans, { lexiconVersion: { ...lex.versions }, review: draftReview() });
  const invariant = checkPronInvariant(line);
  return { line, issues, changes, blocked: issues.some((i) => i.severity === 'error') || invariant.length > 0, invariant };
}

/** Build guards for an edited line: letters never change, every rule span is named, no Latin, no emoji. */
export function checkPronInvariant(line: FaLineText): PronError[] {
  const errs: PronError[] = [];
  line.spans.forEach((s, i) => {
    const piece = line.pron.slice(s.p[0], s.p[1]);
    if (piece !== pieceOf(s)) errs.push({ code: 'PRON_INVARIANT', spanIndex: i, message: 'pron text is out of sync with its span' });
    if ((s.kind === 'marked' || s.kind === 'lexicon') && !s.needsDecision) {
      const disp = line.display.slice(s.d[0], s.d[1]);
      if (s.kind === 'marked' && canonDisplay(s.base) !== canonDisplay(disp)) {
        errs.push({ code: 'PRON_INVARIANT', spanIndex: i, message: `marks changed letters: «${disp}» → «${s.base}»` });
      }
    }
    if (s.kind !== 'marked' && !s.ruleId) errs.push({ code: 'PRON_RULE_MISSING', spanIndex: i, message: 'a non-marked span needs a rule id' });
  });
  if (/[A-Za-z]/.test(line.pron)) errs.push({ code: 'PRON_LATIN', message: 'Latin letters left in fa pron' });
  if (EMOJI_RE.test(line.pron)) errs.push({ code: 'PRON_EMOJI', message: 'emoji left in pron' });
  return errs;
}

// ---------------------------------------------------------------------------------------------
// Agent patches (language-editor) and editor edits

const ROMAN_RE = /^[A-Za-z' «»-]+$/;

export type PatchResult = { ok: true; line: FaLineText } | { ok: false; line: FaLineText; errors: PronError[] };

/**
 * Apply a `language-editor` patch. Every item is validated; a patch that
 * breaks the sync invariant is rejected as a whole (`PRON_INVARIANT`) and the line is unchanged.
 * Accepted proposals land with `reviewed: false` and the text review returns to draft.
 */
export function applyPronPatch(line: FaLineText, patch: PronPatch, opts: { lexicon?: Lexicon } = {}): PatchResult {
  const lex = opts.lexicon ?? loadLexicon();
  const errors: PronError[] = [];
  const spans = line.spans.map(({ p: _p, ...s }) => {
    void _p;
    return { ...s };
  });
  for (const item of patch) {
    const s = spans[item.spanIndex];
    if (!s) {
      errors.push({ code: 'BAD_SPAN', spanIndex: item.spanIndex, message: 'no such span' });
      continue;
    }
    const disp = line.display.slice(s.d[0], s.d[1]);
    if (item.vowels !== undefined) {
      if (s.kind !== 'marked') {
        errors.push({ code: 'PRON_INVARIANT', spanIndex: item.spanIndex, message: `vowels may only be added to marked spans (span is ${s.kind})` });
        continue;
      }
      if (canonDisplay(item.vowels) !== canonDisplay(disp)) {
        errors.push({ code: 'PRON_INVARIANT', spanIndex: item.spanIndex, message: `the patch changes letters: «${disp}» → «${item.vowels}»` });
        continue;
      }
      s.base = item.vowels.normalize('NFC');
      if (item.roman === undefined) {
        const r = romanizeToken(s.base);
        if (r.resolved) {
          s.roman = r.roman;
          delete s.flag;
        }
      }
    }
    if (item.reading !== undefined) {
      const entry = s.ruleId ? findEntry(lex, s.ruleId) : undefined;
      const reading = entry?.readings?.find((r) => r.key === item.reading);
      if (!entry || !reading) {
        errors.push({ code: 'BAD_READING', spanIndex: item.spanIndex, message: `unknown reading «${item.reading}»` });
        continue;
      }
      const form = entry.match.display.find((f) => disp.startsWith(f)) ?? disp;
      const suffix = disp.slice(form.length);
      s.base = `${reading.pron}${suffix}`;
      s.roman = `${reading.roman}${SUFFIX_ROMAN[suffix] ?? ''}`;
      s.reading = reading.key;
      delete s.needsDecision;
    }
    if (item.roman !== undefined) {
      if (!ROMAN_RE.test(item.roman)) {
        errors.push({ code: 'BAD_ROMAN', spanIndex: item.spanIndex, message: 'roman must be ASCII' });
        continue;
      }
      s.roman = item.roman;
      if (s.flag === 'roman-unresolved') delete s.flag;
    }
    if (item.ezafeAfter !== undefined) s.ezafeAfter = item.ezafeAfter;
    s.reviewed = false;
  }
  if (errors.length) return { ok: false, line, errors };
  const next = composeLine(line.display, spans, { lexiconVersion: line.lexiconVersion, review: { text: { status: 'draft', by: null, at: null }, listen: line.review.listen } });
  const inv = checkPronInvariant(next);
  if (inv.length) return { ok: false, line, errors: inv };
  return { ok: true, line: next };
}

/** The language-agent pass: one retry with the errors, then the spans are flagged for the editor. */
export async function runLanguageAgentPass(
  line: FaLineText,
  propose: (line: FaLineText, previousErrors: PronError[]) => PronPatch | Promise<PronPatch>,
  opts: { lexicon?: Lexicon; attempts?: number } = {},
): Promise<{ line: FaLineText; accepted: boolean; errors: PronError[] }> {
  const attempts = opts.attempts ?? 2;
  let errors: PronError[] = [];
  for (let k = 0; k < attempts; k++) {
    const patch = await propose(line, errors);
    const r = applyPronPatch(line, patch, opts);
    if (r.ok) return { line: r.line, accepted: true, errors: [] };
    errors = r.errors;
  }
  const flagged = {
    ...line,
    spans: line.spans.map((s, i) => (errors.some((e) => e.spanIndex === i) ? { ...s, flag: 'invariant' as const } : s)),
  };
  return { line: flagged, accepted: false, errors };
}

/** A respelling that breaks the invariant must be a written override ("Edits and staleness"). */
export function overrideSpan(line: FaLineText, spanIndex: number, pron: string, reason: string): PatchResult {
  const s = line.spans[spanIndex];
  if (!s) return { ok: false, line, errors: [{ code: 'BAD_SPAN', spanIndex, message: 'no such span' }] };
  if (!reason.trim()) return { ok: false, line, errors: [{ code: 'OVERRIDE_REASON_REQUIRED', spanIndex, message: 'an override needs a written reason' }] };
  if (/[A-Za-z]/.test(pron)) return { ok: false, line, errors: [{ code: 'PRON_LATIN', spanIndex, message: 'no Latin letters in fa pron' }] };
  const spans = line.spans.map(({ p: _p, ...x }, i) => {
    void _p;
    return i === spanIndex ? { ...x, kind: 'override' as const, ruleId: 'override', base: pron, overrideReason: reason, reviewed: false } : x;
  });
  return { ok: true, line: composeLine(line.display, spans, { lexiconVersion: line.lexiconVersion, review: { text: { status: 'draft', by: null, at: null }, listen: line.review.listen } }) };
}

/** Spans the S1 card must resolve before approval: needsDecision, invariant flags, unresolved Latin. */
export function pendingDecisions(line: FaLineText): number[] {
  return line.spans.flatMap((s, i) => (s.needsDecision || s.flag === 'invariant' || s.flag === 'latin-unresolved' ? [i] : []));
}

/** Convenience: the tokens of the display text (for callers that map spans to words). */
export function displayTokens(line: FaLineText): Token[] {
  return tokenizeFa(line.display);
}

