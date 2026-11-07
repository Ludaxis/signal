// normalizeFa: deterministic, idempotent Persian orthography normalisation (fa-norm-1.0).
// Runs before lint, storage and pronunciation building. Every change is logged with its rule id.
// Change offsets are UTF-16 offsets into the text as it stood when that rule ran (rules run in a
// fixed order, so the log can be replayed).

import { LETTER_CLASS, MARK_CLASS, NON_JOINING, ZWNJ, hasPersian, isLetter, isMark, lastLetter, stripMarks } from './chars';
import verbStems from './data/verb-stems.json';
import zwnjExceptions from './data/zwnj-exceptions.json';
import adjectivesData from './data/adjectives.json';
import hehFinal from './data/heh-final.json';
import prefixCompounds from './data/prefix-compounds.json';
import compoundsData from './data/compounds.json';

export type Register = 'colloquial' | 'neutral' | 'formal';

export interface NormalizeOptions {
  register: Register;
  /** Pack setting. Default 'zwnj-yeh' (ه\u200Cی). */
  ezafeAfterHeh: 'zwnj-yeh' | 'hamza';
  /** 1-9 in colloquial captions (D4). The normaliser never rewrites numbers; lint and pron read it. */
  smallNumbers: 'words' | 'digits';
  /** Whitespace-token indices (of the input) allowed to keep harakat: callout words (DI-1). */
  allowDiacritics?: number[];
  /** Glossary strings whose ASCII digits are kept (N-08). */
  keepDigits?: string[];
}

export interface Change {
  ruleId: string;
  from: [number, number];
  before: string;
  after: string;
}

export interface NormalizeResult {
  text: string;
  changes: Change[];
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  register: 'colloquial',
  ezafeAfterHeh: 'zwnj-yeh',
  smallNumbers: 'words',
};

/** Every rule id the normaliser can log. */
export const NORMALIZE_RULE_IDS = [
  'N-01', 'N-02', 'N-03', 'N-04', 'N-05', 'N-07', 'N-08', 'N-09', 'N-10', 'N-11', 'N-12', 'N-13', 'N-14', 'N-15', 'N-16', 'N-17',
  'PU-1', 'PU-2', 'ZC-1', 'ZC-2', 'ZC-3', 'Z01', 'Z02', 'Z03', 'Z04', 'Z05', 'Z06', 'Z07', 'EZ-5',
] as const;

const W = `${LETTER_CLASS}${MARK_CLASS}\\u200C`;
const NOT_W_BEHIND = `(?<![${W}])`;
const NOT_W_AHEAD = `(?![${W}])`;
const WORD_G = new RegExp(`[${W}]+`, 'g');
const LATIN_LETTER = /[A-Za-z]/;

const HEH = 'ه';
const YEH = 'ی';

// ---------------------------------------------------------------------------------------------
// Data sets

const PRESENT_STEMS = new Set(verbStems.present.filter((s) => s !== 'ب'));
const PAST_STEMS = new Set(verbStems.past);
const MI_EXCEPTIONS = new Set([...zwnjExceptions.mi, ...zwnjExceptions.solidVerbForms]);
const PLURAL_EXCEPTIONS = new Set([
  ...zwnjExceptions.plural,
  'الهام', 'ابهام', 'سهام', 'اتهام', 'اوهام', 'ایهام', 'توجهات', 'شبهات', 'جهات', 'مباهات', 'تشبیهات', 'تنبیهات',
]);
const INDEFINITE_EXCEPTIONS = new Set(zwnjExceptions.indefinite);
const ADJECTIVES = new Set(adjectivesData.adjectives);
const SOLID_COMPARATIVE_STEMS = new Set(adjectivesData.solid);
const SOLID_COMPARATIVE_RE = /^([^\u200C]+)\u200C(ترین|تری|تر)$/;
const SILENT_HEH = new Set(hehFinal.silent);
const CONSONANTAL_HEH = new Set(hehFinal.consonantal);
const HEH_NO_SPLIT = new Set(hehFinal.noSplit);

const PRESENT_ENDINGS = ['یم', 'ین', 'ید', 'ند', 'م', 'ی', 'ه', 'ن', 'د'];
const PAST_ENDINGS = ['یم', 'ین', 'ید', 'ند', 'م', 'ی', 'ن', ''];
const OBJECT_CLITICS = ['', 'شون', 'تون', 'مون', 'ش', 'ت', 'م', 'و'];
const PLURAL_SUFFIXES = ['هایی', 'هامون', 'هاتون', 'هاشون', 'های', 'هام', 'هات', 'هاش', 'ها'];
const SPACED_PLURAL_TOKENS = new Set(['ها', 'های', 'هایی', 'هام', 'هات', 'هاش', 'هامون', 'هاتون', 'هاشون']);
const HEH_SUFFIXES = ['شون', 'تون', 'مون', 'ای', 'ام', 'ات', 'اش', 'ست', 'یم', 'ین', 'م', 'ت', 'ش', 'ی', 'ن'];
const SPACED_HEH_TOKENS = new Set(['ای', 'ام', 'ات', 'اش']);
const COMPOUND_SUFFIX = '(?:م|ت|ش|مون|تون|شون|ه|و|ی)?';

/** Pairs [first, second] joined with a ZWNJ by Z07 (compounds) and Z06 (prefix allow-list). */
function pairsFrom(list: string[][]): [string, string][] {
  const out: [string, string][] = [];
  for (const parts of list) {
    const [a, b] = parts;
    if (!a || !b || parts.length !== 2) continue;
    const last = lastLetter(a);
    if (!last || NON_JOINING.has(last)) continue; // no ZWNJ needed after a non-joiner
    out.push([a, b]);
  }
  return out;
}
const COMPOUND_PAIRS = pairsFrom(compoundsData.compounds);
const PREFIX_PAIRS = pairsFrom(prefixCompounds.words.map((w) => w.split(ZWNJ)));

// ---------------------------------------------------------------------------------------------
// Helpers

function sub(
  text: string,
  re: RegExp,
  ruleId: string,
  changes: Change[],
  fn: (m: RegExpExecArray, text: string) => string,
): string {
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  g.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const rep = fn(m, text);
    if (rep !== m[0]) {
      out += text.slice(last, m.index) + rep;
      changes.push({ ruleId, from: [m.index, m.index + m[0].length], before: m[0], after: rep });
      last = m.index + m[0].length;
    }
    if (m[0].length === 0) g.lastIndex++;
  }
  return out + text.slice(last);
}

function mapChars(text: string, re: RegExp, to: string | ((ch: string) => string), ruleId: string, changes: Change[]): string {
  return sub(text, re, ruleId, changes, (m) => (typeof to === 'string' ? to : to(m[0])));
}

/** Previous base character before index i, skipping combining marks. */
function prevBase(text: string, i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const ch = text[j];
    if (!isMark(ch)) return ch;
  }
  return undefined;
}

function nearestLetter(text: string, i: number, dir: -1 | 1): 'fa' | 'latin' | null {
  for (let j = i + dir; j >= 0 && j < text.length; j += dir) {
    const ch = text[j];
    if (ch === '\n') return null;
    if (isLetter(ch)) return 'fa';
    if (ch && LATIN_LETTER.test(ch)) return 'latin';
  }
  return null;
}

/** Context of a punctuation mark: Persian if the nearest letter before (else after) is Arabic script. */
function inPersianRun(text: string, i: number, prefer: -1 | 1 = -1): boolean {
  const first = nearestLetter(text, i, prefer);
  if (first) return first === 'fa';
  return nearestLetter(text, i, prefer === -1 ? 1 : -1) === 'fa';
}

function wordKind(w: string): 'fa' | 'latin' | 'other' | 'none' {
  if (!w) return 'none';
  if (hasPersian(w)) return 'fa';
  if (LATIN_LETTER.test(w)) return 'latin';
  return 'other';
}

function lineOf(text: string, i: number): string {
  const s = text.lastIndexOf('\n', i - 1) + 1;
  const e = text.indexOf('\n', i);
  return text.slice(s, e === -1 ? text.length : e);
}

// ---------------------------------------------------------------------------------------------
// N-08 … N-11: digits, separators, decimals and percent

const ASCII_TO_FA = (s: string) => s.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);

function protectedRanges(text: string, keepDigits: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.]+|@[A-Za-z0-9_.]+|#[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  for (const k of keepDigits) {
    if (!k) continue;
    let from = 0;
    let at: number;
    while ((at = text.indexOf(k, from)) !== -1) {
      ranges.push([at, at + k.length]);
      from = at + k.length;
    }
  }
  return ranges;
}

function groupThousands(digits: string): string {
  // digits: Persian digits only
  if (digits.length <= 4) return digits; // < 10,000: no separator (N-11)
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += '٬';
  }
  return out;
}

function normalizeDigits(text: string, opts: NormalizeOptions, changes: Change[]): string {
  const protectedR = protectedRanges(text, opts.keepDigits ?? []);
  const re = /[0-9۰-۹](?:[0-9۰-۹]|[,٬.٫:](?=[0-9۰-۹]))*/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const run = m[0];
    if (protectedR.some(([s, e]) => start >= s && end <= e)) continue;
    const before = text[start - 1];
    const after = text[end];
    if ((before && LATIN_LETTER.test(before)) || (after && LATIN_LETTER.test(after))) continue; // mp3, v2
    const hasAscii = /[0-9]/.test(run);
    if (hasAscii) {
      const prevWord = text.slice(0, start).trimEnd().split(/\s+/).pop() ?? '';
      const nextWord = text.slice(end).trimStart().split(/\s+/)[0] ?? '';
      const pk = wordKind(prevWord);
      const nk = wordKind(nextWord);
      let persian = false;
      if (pk === 'latin') persian = false;
      else if (pk === 'fa' || nk === 'fa') persian = true;
      else if (nk === 'latin') persian = false;
      else persian = hasPersian(lineOf(text, start)) && !LATIN_LETTER.test(lineOf(text, start));
      if (!persian) continue;
    }
    let rep = ASCII_TO_FA(run);
    const ruleIds: string[] = [];
    if (rep !== run) ruleIds.push('N-08');
    // N-11 thousands separators
    if (/^[۰-۹]{1,3}(?:[,٬][۰-۹]{3})+$/.test(rep)) {
      const grouped = groupThousands(rep.replace(/[,٬]/g, ''));
      if (grouped !== rep) ruleIds.push('N-11');
      rep = grouped;
    } else if (/^[۰-۹]+[.٫][۰-۹]+$/.test(rep)) {
      const dec = rep.replace('.', '٫');
      if (dec !== rep) ruleIds.push('N-10');
      rep = dec;
    }
    // N-09 percent sign after the number
    let consumed = end;
    if (text[end] === '%') {
      rep += '٪';
      consumed = end + 1;
      ruleIds.push('N-09');
    }
    if (rep !== text.slice(start, consumed)) {
      for (const id of ruleIds) changes.push({ ruleId: id, from: [start, consumed], before: text.slice(start, consumed), after: rep });
      out += text.slice(last, start) + rep;
      last = consumed;
      re.lastIndex = consumed;
    }
  }
  return out + text.slice(last);
}

// ---------------------------------------------------------------------------------------------
// PU-1 / PU-2 punctuation and spacing

function normalizePunctuation(text: string, changes: Change[]): string {
  let t = sub(text, /\.{3,}|…{2,}/g, 'PU-1', changes, (m, s) => (inPersianRun(s, m.index) ? '…' : m[0]));
  t = sub(t, /[,;?]/g, 'PU-1', changes, (m, s) => {
    if (!inPersianRun(s, m.index)) return m[0];
    // keep a comma between two digits only when it is not between Persian digits
    return m[0] === ',' ? '،' : m[0] === ';' ? '؛' : '؟';
  });
  t = sub(t, /["“”]/g, 'PU-1', changes, (m, s) => {
    const i = m.index;
    const prev = s[i - 1];
    const opening = m[0] === '“' || (m[0] === '"' && (prev === undefined || /[\s(«\[]/.test(prev)));
    const persian = inPersianRun(s, i, opening ? 1 : -1);
    if (!persian) return m[0];
    return opening ? '«' : '»';
  });
  // PU-2: no space before Persian punctuation; no space inside «»
  t = sub(t, / +(?=[،؛؟…»])/g, 'PU-2', changes, () => '');
  t = sub(t, / +(?=[!.:])/g, 'PU-2', changes, (m, s) => {
    const b = prevBase(s, m.index);
    return isLetter(b) || (b !== undefined && /[۰-۹؟]/.test(b)) ? '' : m[0];
  });
  t = sub(t, /« +/g, 'PU-2', changes, () => '«');
  // one space after punctuation when a Persian word follows directly
  t = sub(t, new RegExp(`([،؛؟!…:»])(?=[${LETTER_CLASS}«])`, 'g'), 'PU-2', changes, (m, s) => {
    const prevChar = s[m.index - 1];
    if (m[1] === ':' && prevChar !== undefined && /[0-9۰-۹]/.test(prevChar)) return m[0];
    return `${m[1]} `;
  });
  t = sub(t, new RegExp(`([${LETTER_CLASS}${MARK_CLASS}])«`, 'g'), 'PU-2', changes, (m) => `${m[1]} «`);
  return t;
}

// ---------------------------------------------------------------------------------------------
// ZWNJ cleanup (ZC-1 … ZC-3)

function cleanupZwnj(text: string, changes: Change[]): string {
  let t = sub(text, /\u200C{2,}/g, 'ZC-1', changes, () => ZWNJ);
  t = sub(t, /\u200C/g, 'ZC-2', changes, (m, s) => {
    const i = m.index;
    const next = s[i + 1];
    const prev = prevBase(s, i);
    if (prev === undefined || next === undefined || !isLetter(next)) return '';
    if (!isLetter(prev)) return '';
    return m[0];
  });
  t = sub(t, /\u200C/g, 'ZC-3', changes, (m, s) => {
    const prev = prevBase(s, m.index);
    return prev !== undefined && NON_JOINING.has(prev) ? '' : m[0];
  });
  return t;
}

// ---------------------------------------------------------------------------------------------
// ZWNJ insertion (Z07 → Z06 → Z01 → Z03 → Z02 → Z04 → Z05), plus EZ-5

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinPairs(text: string, pairs: [string, string][], ruleId: string, changes: Change[]): string {
  let t = text;
  for (const [a, b] of pairs) {
    const spaced = new RegExp(`${NOT_W_BEHIND}${escapeRe(a)} ${escapeRe(b)}(${COMPOUND_SUFFIX})${NOT_W_AHEAD}`, 'g');
    t = sub(t, spaced, ruleId, changes, (m) => `${a}${ZWNJ}${b}${m[1] ?? ''}`);
    const solid = new RegExp(`${NOT_W_BEHIND}${escapeRe(a + b)}(${COMPOUND_SUFFIX})${NOT_W_AHEAD}`, 'g');
    t = sub(t, solid, ruleId, changes, (m) => `${a}${ZWNJ}${b}${m[1] ?? ''}`);
  }
  return t;
}

function isVerbRest(rest: string): boolean {
  const r = stripMarks(rest);
  for (let n = Math.min(r.length, 6); n >= 1; n--) {
    const stem = r.slice(0, n);
    const tail = r.slice(n);
    if (PRESENT_STEMS.has(stem) && PRESENT_ENDINGS.some((e) => OBJECT_CLITICS.some((c) => e + c === tail) && e !== '')) return true;
    if (PAST_STEMS.has(stem) && PAST_ENDINGS.some((e) => OBJECT_CLITICS.some((c) => e + c === tail))) return true;
  }
  return false;
}

function splitMi(word: string): { prefix: string; rest: string } | null {
  const m = /^((?:بر|در)?ن?می)(.+)$/.exec(word);
  if (!m || !m[1] || !m[2]) return null;
  return { prefix: m[1], rest: m[2] };
}

function z01(text: string, changes: Change[]): string {
  // spaced: «نمی تونم» → «نمی\u200Cتونم»
  let t = sub(text, new RegExp(`${NOT_W_BEHIND}(ن?می) ([${W}]+)`, 'g'), 'Z01', changes, (m) => {
    const rest = m[2] ?? '';
    if (rest.startsWith(ZWNJ) || !isVerbRest(rest)) return m[0];
    const joined = `${m[1]}${rest}`;
    if (MI_EXCEPTIONS.has(stripMarks(joined))) return m[0];
    return `${m[1]}${ZWNJ}${rest}`;
  });
  t = sub(t, WORD_G, 'Z01', changes, (m) => {
    const w = m[0];
    const bare = stripMarks(w);
    if (MI_EXCEPTIONS.has(bare) || w.includes(ZWNJ)) return w;
    const parts = splitMi(w);
    if (!parts) return w;
    if (!isVerbRest(parts.rest)) return w;
    return `${parts.prefix}${ZWNJ}${parts.rest}`;
  });
  return t;
}

function z03(text: string, changes: Change[]): string {
  const sufRe = /^(.+?)(ترین|تری|تر)(ه|ن|م)?$/;
  let t = sub(text, new RegExp(`${NOT_W_BEHIND}([${W}]+) (ترین|تری|تر)${NOT_W_AHEAD}`, 'g'), 'Z03', changes, (m) => {
    const adj = m[1] ?? '';
    const last = lastLetter(adj);
    if (!ADJECTIVES.has(stripMarks(adj)) || !last || NON_JOINING.has(last)) return m[0];
    return `${adj}${ZWNJ}${m[2]}`;
  });
  t = sub(t, WORD_G, 'Z03', changes, (m) => {
    const w = m[0];
    // solid by rule: «کم\u200Cتر» → «کمتر», «بیش\u200Cترین» → «بیشترین»
    const solid = SOLID_COMPARATIVE_RE.exec(w);
    if (solid && solid[1] && SOLID_COMPARATIVE_STEMS.has(stripMarks(solid[1]))) return `${solid[1]}${solid[2]}`;
    if (w.includes(ZWNJ)) return w;
    const mm = sufRe.exec(w);
    if (!mm || !mm[1] || !mm[2]) return w;
    const adj = mm[1];
    const last = lastLetter(adj);
    if (!ADJECTIVES.has(stripMarks(adj)) || !last || NON_JOINING.has(last)) return w;
    return `${adj}${ZWNJ}${mm[2]}${mm[3] ?? ''}`;
  });
  return t;
}

function z02(text: string, changes: Change[]): string {
  let t = sub(text, new RegExp(`${NOT_W_BEHIND}([${W}]+) (هایی|هامون|هاتون|هاشون|های|هام|هات|هاش|ها)(?![${W}؟!])`, 'g'), 'Z02', changes, (m) => {
    const noun = m[1] ?? '';
    const suf = m[2] ?? '';
    if (!SPACED_PLURAL_TOKENS.has(suf) || noun === 'می' || noun === 'نمی') return m[0];
    const last = lastLetter(noun);
    if (!last) return m[0];
    return NON_JOINING.has(last) || noun.endsWith(ZWNJ) ? `${noun}${suf}` : `${noun}${ZWNJ}${suf}`;
  });
  t = sub(t, WORD_G, 'Z02', changes, (m) => {
    const w = m[0];
    const bare = stripMarks(w);
    if (PLURAL_EXCEPTIONS.has(bare)) return w;
    for (const suf of PLURAL_SUFFIXES) {
      if (!w.endsWith(suf)) continue;
      const stem = w.slice(0, -suf.length);
      const last = lastLetter(stem);
      if (stripMarks(stem).length < 2 || !last || stem.endsWith(ZWNJ) || NON_JOINING.has(last)) return w;
      if (HEH_NO_SPLIT.has(bare)) return w;
      // «خانهای» is خانه + ای (Z04), not خان + های
      if (suf !== 'ها' && SILENT_HEH.has(bare.slice(0, -(suf.length - 1)))) return w;
      return `${stem}${ZWNJ}${suf}`;
    }
    return w;
  });
  return t;
}

function ezafeHeh(opts: NormalizeOptions): string {
  return opts.ezafeAfterHeh === 'hamza' ? '\u0654' : `${ZWNJ}${YEH}`;
}

function endsWithSilentHeh(word: string): boolean {
  const bare = stripMarks(word);
  if (!bare.endsWith(HEH)) return false;
  if (CONSONANTAL_HEH.has(bare) || bare.length < 3) return false;
  const lastWordPart = bare.split(ZWNJ).pop() ?? bare;
  return !CONSONANTAL_HEH.has(lastWordPart);
}

function z04(text: string, opts: NormalizeOptions, changes: Change[]): string {
  // spaced suffixes after a silent ه: «خانه ای» → «خانه\u200Cای»
  let t = sub(text, new RegExp(`${NOT_W_BEHIND}([${W}]+) (ای|ام|ات|اش)${NOT_W_AHEAD}`, 'g'), 'Z04', changes, (m) => {
    const w = m[1] ?? '';
    if (!SPACED_HEH_TOKENS.has(m[2] ?? '') || !endsWithSilentHeh(w)) return m[0];
    return `${w}${ZWNJ}${m[2]}`;
  });
  // EZ-5: a space-separated ی after a heh-final word
  t = sub(t, new RegExp(`${NOT_W_BEHIND}([${W}]+) ی${NOT_W_AHEAD}`, 'g'), 'EZ-5', changes, (m) => {
    const w = m[1] ?? '';
    if (!endsWithSilentHeh(w)) return m[0];
    return `${w}${ezafeHeh(opts)}`;
  });
  t = sub(t, WORD_G, 'Z04', changes, (m) => {
    const w = m[0];
    if (w.includes(ZWNJ)) {
      // only the last ZWNJ-free part can still need a split
      const idx = w.lastIndexOf(ZWNJ);
      const head = w.slice(0, idx + 1);
      const tail = w.slice(idx + 1);
      const fixed = splitHeh(head + tail, tail, opts);
      return fixed === null ? w : head + fixed;
    }
    const fixed = splitHeh(w, w, opts);
    return fixed ?? w;
  });
  return t;
}

/** Split «stem\u200Csuffix» for a listed silent-ه stem, or null. `full` is the whole word (for noSplit). */
function splitHeh(full: string, part: string, opts: NormalizeOptions): string | null {
  const bare = stripMarks(part);
  if (HEH_NO_SPLIT.has(stripMarks(full)) || HEH_NO_SPLIT.has(bare)) return null;
  for (const suf of HEH_SUFFIXES) {
    if (!bare.endsWith(suf)) continue;
    const stem = bare.slice(0, -suf.length);
    if (!SILENT_HEH.has(stem)) continue;
    const stemWithMarks = part.slice(0, part.length - suf.length);
    if (suf === YEH) return `${stemWithMarks}${ezafeHeh(opts)}`;
    return `${stemWithMarks}${ZWNJ}${suf}`;
  }
  return null;
}

function z05(text: string, changes: Change[]): string {
  let t = sub(text, new RegExp(`${NOT_W_BEHIND}([${W}]+ی) ای${NOT_W_AHEAD}`, 'g'), 'Z05', changes, (m) => `${m[1]}${ZWNJ}ای`);
  t = sub(t, WORD_G, 'Z05', changes, (m) => {
    const w = m[0];
    if (w.includes(ZWNJ) || !w.endsWith('یای')) return w;
    const bare = stripMarks(w);
    if (INDEFINITE_EXCEPTIONS.has(bare) || MI_EXCEPTIONS.has(bare)) return w;
    const stem = w.slice(0, -2);
    if (stripMarks(stem).length < 4) return w;
    return `${stem}${ZWNJ}ای`;
  });
  return t;
}

// ---------------------------------------------------------------------------------------------

export function normalizeFa(input: string, options: Partial<NormalizeOptions> = {}): NormalizeResult {
  const opts: NormalizeOptions = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
  const changes: Change[] = [];
  let t = input;

  // N-01
  const nfc = t.normalize('NFC');
  if (nfc !== t) changes.push({ ruleId: 'N-01', from: [0, t.length], before: t, after: nfc });
  t = nfc;

  t = mapChars(t, /[يى]/g, YEH, 'N-02', changes);
  t = mapChars(t, /ك/g, 'ک', 'N-03', changes);
  t = mapChars(t, /[ەہھ]/g, HEH, 'N-04', changes);
  t = mapChars(t, /\u06C0/g, opts.ezafeAfterHeh === 'hamza' ? `${HEH}\u0654` : `${HEH}${ZWNJ}${YEH}`, 'N-05', changes);
  // With the zwnj-yeh setting a typed hamza ezafe (ه + U+0654) is written ه\u200Cی as well (EZ-2).
  if (opts.ezafeAfterHeh === 'zwnj-yeh') t = mapChars(t, /\u0647\u0654/g, `${HEH}${ZWNJ}${YEH}`, 'N-05', changes);
  t = mapChars(t, /[٠-٩]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)] ?? d, 'N-07', changes);
  t = mapChars(t, /\u0640/g, '', 'N-12', changes);

  // N-13 harakat (keep tanvin after alef, and callout tokens in allowDiacritics)
  const allow = new Set(opts.allowDiacritics ?? []);
  let tokenIndex = -1;
  t = sub(t, /\S+/g, 'N-13', changes, (m) => {
    tokenIndex++;
    if (allow.has(tokenIndex)) return m[0];
    const tok = m[0];
    let out = '';
    for (let i = 0; i < tok.length; i++) {
      const ch = tok[i] ?? '';
      if (/[\u064C-\u0652\u0670]/.test(ch)) continue;
      if (ch === '\u064B') {
        const keep = prevBase(tok, i) === 'ا' || tok[i + 1] === 'ا';
        if (!keep) continue;
      }
      out += ch;
    }
    return out;
  });

  t = mapChars(t, /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g, '', 'N-14', changes);
  t = sub(t, /\u200D/g, 'N-15', changes, (m, s) => {
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const after = s.slice(m.index + 1, m.index + 3);
    const emoji = /\p{Extended_Pictographic}|\uFE0F/u;
    return emoji.test(before) && emoji.test(after) ? m[0] : '';
  });
  t = sub(t, /\u200B/g, 'N-16', changes, (m, s) => (isLetter(prevBase(s, m.index)) && isLetter(s[m.index + 1]) ? ZWNJ : ''));
  t = sub(t, /[ \t\u00A0\u202F]+/g, 'N-17', changes, (m) => (m[0] === ' ' ? m[0] : ' '));
  t = sub(t, /^ +| +$/gm, 'N-17', changes, () => '');

  t = normalizeDigits(t, opts, changes);
  t = normalizePunctuation(t, changes);

  t = cleanupZwnj(t, changes);
  t = joinPairs(t, COMPOUND_PAIRS, 'Z07', changes);
  t = joinPairs(t, PREFIX_PAIRS, 'Z06', changes);
  t = z01(t, changes);
  t = z03(t, changes);
  t = z02(t, changes);
  t = z04(t, opts, changes);
  t = z05(t, changes);
  t = cleanupZwnj(t, changes);

  return { text: t, changes };
}
