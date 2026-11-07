// Automated parts of bilingual authoring: missing language lines, BL-04 same dates,
// single-language burnt-in captions, the literalness check (BL-09), and the D9 similarity guard
// against a reference transcript (normalised edit similarity ≤ 0.6).

import { hasPersian, stripMarks, fromPersianDigits } from './chars';
import { normalizeFa } from './normalize';
import { tokenizeFa } from './tokenize';
import { jalaliParts, monthIndexFa } from './verbalize';
import glossData from './data/gloss-en.json';

export interface BilingualLineRef {
  id: string;
  beatId: string;
  langs: ('fa' | 'en')[];
  fa?: { display: string } | null;
  en?: { display: string } | null;
}

export interface BilingualIssue {
  code: 'MISSING_LANG_LINE';
  lineId: string;
  beatId: string;
  lang: 'fa' | 'en';
}

/** every language a line declares must have its line. */
export function checkLangLines(lines: BilingualLineRef[]): BilingualIssue[] {
  const out: BilingualIssue[] = [];
  for (const l of lines) {
    for (const lang of l.langs) {
      const v = l[lang];
      if (!v || !v.display || !v.display.trim()) out.push({ code: 'MISSING_LANG_LINE', lineId: l.id, beatId: l.beatId, lang });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// BL-04 dates

export interface JalaliDate {
  year?: number;
  month: number;
  day: number;
}

/** «۳۰ آذر ۱۴۰۵» → { day: 30, month: 9, year: 1405 } (the first date in the text). */
export function parseFaDate(display: string): JalaliDate | null {
  const toks = tokenizeFa(display);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    if (t.kind !== 'number' || !next || next.kind !== 'word') continue;
    const month = monthIndexFa(next.text);
    if (!month) continue;
    const day = Number(fromPersianDigits(t.text));
    const y = toks[i + 2];
    const year = y && y.kind === 'number' && /^[۰-۹0-9]{4}$/.test(y.text) ? Number(fromPersianDigits(y.text)) : undefined;
    return year === undefined ? { month, day } : { month, day, year };
  }
  return null;
}

const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Dec 21, 2026", "December 21, 2026" or "21 Dec 2026" → "2026-12-21". */
export function parseEnDate(display: string): string | null {
  const m1 = /\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/.exec(display);
  const m2 = /\b(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})\b/.exec(display);
  let mon: string | undefined;
  let day: string | undefined;
  let year: string | undefined;
  if (m1) [, mon, day, year] = m1;
  else if (m2) [, day, mon, year] = m2;
  if (!mon || !day || !year) return null;
  const idx = EN_MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  return `${year}-${String(idx + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** BL-04: the fa Jalali date equals the en Gregorian date (converted with Intl). */
export function checkSameDate(faDisplay: string, enDisplay: string): { ok: boolean; fa: JalaliDate | null; en: { iso: string; jalali: JalaliDate } | null } {
  const fa = parseFaDate(faDisplay);
  const iso = parseEnDate(enDisplay);
  if (!fa || !iso) return { ok: false, fa, en: null };
  const j = jalaliParts(iso);
  const ok = j.month === fa.month && j.day === fa.day && (fa.year === undefined || fa.year === j.year);
  return { ok, fa, en: { iso, jalali: j } };
}

// ---------------------------------------------------------------------------------------------
// Captions never mix languages (acceptance 4)

export function captionLanguageMix(pages: string[], lang: 'fa' | 'en', glossary: string[] = []): { page: number; word: string }[] {
  const allowed = new Set(glossary);
  const out: { page: number; word: string }[] = [];
  pages.forEach((p, i) => {
    for (const t of tokenizeFa(p)) {
      if (lang === 'fa' && t.kind === 'latin' && !allowed.has(t.text)) out.push({ page: i, word: t.text });
      if (lang === 'en' && t.kind === 'word' && hasPersian(t.text) && !allowed.has(t.text)) out.push({ page: i, word: t.text });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Literalness (BL-09): a word-gloss back-translation proxy; > 0.85 is flagged "too literal"

const GLOSS = glossData.gloss as Record<string, string[]>;
const STOP = new Set(glossData.stop);
export const LITERALNESS_FLAG = 0.85;

export function literalness(fa: string, en: string): number {
  const enWords = new Set(en.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean));
  const faWords = tokenizeFa(normalizeFa(fa).text)
    .filter((t) => t.kind === 'word' && !STOP.has(t.text))
    .map((t) => t.text);
  if (faWords.length === 0) return 0;
  let covered = 0;
  for (const w of faWords) {
    const g = GLOSS[w] ?? GLOSS[w.replace(/(م|ت|ش|و|ه)$/, '')] ?? [];
    if (g.some((x) => enWords.has(x))) covered++;
  }
  return covered / faWords.length;
}

/** Lines with fewer content words than this are too short to judge (a three-word line glosses itself). */
export const LITERALNESS_MIN_WORDS = 4;

export function isTooLiteral(fa: string, en: string): boolean {
  const words = tokenizeFa(normalizeFa(fa).text).filter((t) => t.kind === 'word' && !STOP.has(t.text)).length;
  return words >= LITERALNESS_MIN_WORDS && literalness(fa, en) > LITERALNESS_FLAG;
}

// ---------------------------------------------------------------------------------------------
// D9 similarity guard

function guardForm(s: string): string {
  return stripMarks(normalizeFa(s).text)
    .replace(/[\u200C\s]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** Normalised edit similarity in [0, 1] (1 = identical after normalisation). */
export function editSimilarity(a: string, b: string): number {
  const x = guardForm(a);
  const y = guardForm(b);
  const m = Math.max([...x].length, [...y].length);
  if (m === 0) return 1;
  return 1 - levenshtein(x, y) / m;
}

export const SIMILARITY_LIMIT = 0.6;

/** Lines whose similarity to any reference line is above the limit (they fail the guard). */
export function similarityGuard(lines: { id: string; display: string }[], reference: string[], limit = SIMILARITY_LIMIT) {
  const out: { id: string; refIndex: number; similarity: number }[] = [];
  for (const l of lines) {
    reference.forEach((r, k) => {
      const s = editSimilarity(l.display, r);
      if (s > limit) out.push({ id: l.id, refIndex: k, similarity: s });
    });
  }
  return out;
}
