// `captions:<lang>` executor. Deterministic local step.
// Pages of 3-5 words, at most 2 lines, each 0.8-2.5 s; narrated pages follow the word timings; a page never splits
// across a punctuation boundary when a cleaner cut exists. The bundled-font width test is authoritative: every page's
// lines, set at the caption size of `typeScale('caption', lang)`, must fit the reel text area (x 108-972 = 865 px).
// Persian lines are broken with `breakFa` (LB-1…LB-7) and measured with the bundled text face (opentype.js over the
// WOFF2, fontFile.ts). The unit is a whitespace-delimited token (a ZWNJ stays inside it); consecutive Latin words
// are one unit (one <bdi> run). Persian pages animate per word, never per letter.
// Output: graph/adapters.ts `CaptionsDoc` plus per-page words, line breaks and the highlight/emphasis token.
import { breakFa } from '@/lib/studio/lang/fa/breaks';
import type { AlignmentDoc, CaptionPage, CaptionsDoc } from '../graph/adapters';
import { measuringFont, resolveFonts, type FontFile } from '../render/fonts';
import { SAFE_ZONES } from '../render/safeZones';
import { typeScale } from '../render/typeScale';
import type { Lang, StepCheck } from '../types';
import type { Executor } from './types';

export interface CaptionWord {
  text: string;
  latin: boolean;
  /** From the start of the line's beat (like `CaptionPage.beatOffsetMs`). */
  beatOffsetMs: number;
  endMs: number;
}

export interface CaptionPageX extends CaptionPage {
  words: CaptionWord[];
  /** Index of the first word of each line after the first (at most one: 2 lines). */
  breaks: number[];
  highlight: number | null;
  emphasis: number | null;
  widthPx: number;
}

export interface CaptionsDocX extends CaptionsDoc {
  pages: CaptionPageX[];
  sizePx: number;
  maxWidthPx: number;
  font: { family: string; sha256: string } | null;
}

export type Measure = (text: string) => number;

const LATIN = /[A-Za-z]/;
const PUNCT_END = /[،؛؟!.,:…?;»)]$/;
const MIN_MS = 800;
const MAX_MS = 2500;

/** Whitespace tokens; in Persian text, consecutive Latin words are merged into one unit (one <bdi> run). */
export function captionUnits(words: { token: string; startMs: number; endMs: number }[], lang: Lang = 'fa'): { text: string; latin: boolean; startMs: number; endMs: number }[] {
  const out: { text: string; latin: boolean; startMs: number; endMs: number }[] = [];
  for (const w of words) {
    const latin = LATIN.test(w.token) && !/[؀-ۿ]/.test(w.token);
    const prev = out.at(-1);
    if (lang === 'fa' && prev && prev.latin && latin && !PUNCT_END.test(prev.text)) {
      prev.text = `${prev.text} ${w.token}`;
      prev.endMs = w.endMs;
      continue;
    }
    out.push({ text: w.token, latin, startMs: w.startMs, endMs: w.endMs });
  }
  return out;
}

/** Splits a page's words into ≤ 2 lines: fa by breakFa then the width test, en by the most balanced fitting cut. */
export function breakPage(texts: string[], lang: Lang, measure: Measure, maxPx: number): { breaks: number[]; widthPx: number; fits: boolean } {
  const whole = texts.join(' ');
  const width = (from: number, to: number) => measure(texts.slice(from, to).join(' '));
  const one = width(0, texts.length);
  let candidates: number[] = [];
  if (lang === 'fa') {
    const lines = breakFa(whole, 'kinetic-caption');
    if (lines.length === 2) {
      const first = lines[0]!.split(/\s+/).filter(Boolean).length;
      if (first > 0 && first < texts.length) candidates.push(first);
    }
  }
  if (one <= maxPx && candidates.length === 0) return { breaks: [], widthPx: one, fits: true };
  for (let c = 1; c < texts.length; c++) if (!candidates.includes(c)) candidates.push(c);
  if (one <= maxPx && lang === 'fa' && candidates.length) {
    // breakFa asked for two lines (character limit); keep its cut only if both lines fit.
    const c = candidates[0]!;
    const w = Math.max(width(0, c), width(c, texts.length));
    return w <= maxPx ? { breaks: [c], widthPx: w, fits: true } : { breaks: [], widthPx: one, fits: true };
  }
  candidates = candidates.sort((a, b) => Math.abs(width(0, a) - width(a, texts.length)) - Math.abs(width(0, b) - width(b, texts.length)));
  for (const c of lang === 'fa' ? [candidates[0]!, ...candidates.slice(1)] : candidates) {
    const w = Math.max(width(0, c), width(c, texts.length));
    if (w <= maxPx) return { breaks: [c], widthPx: w, fits: true };
  }
  return { breaks: texts.length > 1 ? [candidates[0]!] : [], widthPx: one, fits: false };
}

interface Unit {
  text: string;
  latin: boolean;
  startMs: number;
  endMs: number;
}

/** Pages for one line's units (DP over cut points; cost = rule penalties). */
export function pageLine(units: Unit[], lineMs: number, lang: Lang, measure: Measure, maxPx: number): { from: number; to: number; breaks: number[]; widthPx: number; fits: boolean }[] {
  const n = units.length;
  if (n === 0) return [];
  const startOf = (i: number) => units[i]!.startMs;
  const endOf = (j: number) => (j < n ? units[j]!.startMs : Math.max(lineMs, units[n - 1]!.endMs));
  const best: { cost: number; prev: number }[] = Array.from({ length: n + 1 }, () => ({ cost: Infinity, prev: -1 }));
  best[0] = { cost: 0, prev: -1 };
  const pageCost = (i: number, j: number) => {
    const count = j - i;
    if (count > 5) return Infinity;
    const b = breakPage(units.slice(i, j).map((u) => u.text), lang, measure, maxPx);
    if (!b.fits && count > 1) return Infinity;
    let c = b.fits ? 0 : 1000;
    if (count < 3 && n >= 3) c += 30 * (3 - count);
    const ms = endOf(j) - startOf(i);
    if (ms < MIN_MS) c += (MIN_MS - ms) / 10;
    if (ms > MAX_MS) c += (ms - MAX_MS) / 10;
    for (let k = i; k < j - 1; k++) if (PUNCT_END.test(units[k]!.text)) c += 40; // punctuation inside the page
    if (j < n && !PUNCT_END.test(units[j - 1]!.text)) c += 2;
    return c;
  };
  for (let j = 1; j <= n; j++)
    for (let i = Math.max(0, j - 5); i < j; i++) {
      const c = best[i]!.cost + pageCost(i, j);
      if (c < best[j]!.cost) best[j] = { cost: c, prev: i };
    }
  const cuts: number[] = [];
  for (let j = n; j > 0; j = best[j]!.prev) {
    if (best[j]!.prev < 0) break;
    cuts.unshift(j);
  }
  const pages: { from: number; to: number; breaks: number[]; widthPx: number; fits: boolean }[] = [];
  let from = 0;
  for (const to of cuts) {
    const b = breakPage(units.slice(from, to).map((u) => u.text), lang, measure, maxPx);
    pages.push({ from, to, ...b });
    from = to;
  }
  return pages;
}

export interface CaptionsInput {
  lang: Lang;
  alignment: AlignmentDoc;
  measure: Measure;
  maxPx?: number;
  sizePx?: number;
  /** Beats whose technique list asks for a highlight marker / an emphasis punch (one token per page). */
  highlightBeats?: Set<string>;
  emphasisBeats?: Set<string>;
  font?: { family: string; sha256: string } | null;
}

/** The text area width of the reel (inclusive columns 108-972). */
export const CAPTION_MAX_PX = SAFE_ZONES.reel.text.x[1] - SAFE_ZONES.reel.text.x[0] + 1;

export function buildCaptions(i: CaptionsInput): { doc: CaptionsDocX; checks: StepCheck[] } {
  const maxPx = i.maxPx ?? CAPTION_MAX_PX;
  const sizePx = i.sizePx ?? typeScale('caption', i.lang).size;
  const pages: CaptionPageX[] = [];
  const checks: StepCheck[] = [];
  const offset = new Map<string, number>();
  for (const l of i.alignment.lines) {
    const base = offset.get(l.beatId) ?? 0;
    const units = captionUnits(l.words, i.lang);
    const plan = pageLine(units, l.ms, i.lang, i.measure, maxPx);
    for (const p of plan) {
      const ws = units.slice(p.from, p.to);
      const next = p.to < units.length ? units[p.to]!.startMs : Math.max(l.ms, ws.at(-1)!.endMs);
      const key = ws.length >= 2 ? ws.reduce((b, w, k) => (w.text.length > ws[b]!.text.length ? k : b), 0) : 0;
      const page: CaptionPageX = {
        lineId: l.id,
        beatId: l.beatId,
        text: ws.map((w) => w.text).join(' '),
        beatOffsetMs: base + ws[0]!.startMs,
        durationMs: next - ws[0]!.startMs,
        words: ws.map((w) => ({ text: w.text, latin: w.latin, beatOffsetMs: base + w.startMs, endMs: base + w.endMs })),
        breaks: p.breaks,
        highlight: i.highlightBeats?.has(l.beatId) ? key : null,
        emphasis: i.emphasisBeats?.has(l.beatId) ? key : null,
        widthPx: Math.round(p.widthPx),
      };
      pages.push(page);
      const n = pages.length - 1;
      if (!p.fits) checks.push({ id: `captions:${i.lang}:width:${l.id}:${n}`, ok: false, required: true, text: `A caption page of line ${l.id} is wider than the text area`, evidence: `${page.widthPx}px > ${maxPx}px` });
      if (ws.length > 5) checks.push({ id: `captions:${i.lang}:words:${l.id}:${n}`, ok: false, required: true, text: `A caption page of line ${l.id} has more than 5 words` });
      if (page.durationMs > MAX_MS) checks.push({ id: `captions:${i.lang}:long:${l.id}:${n}`, ok: false, required: false, text: `A caption page of line ${l.id} stays longer than 2.5 s`, evidence: `${page.durationMs} ms` });
      if (page.durationMs < MIN_MS && units.length >= 3) checks.push({ id: `captions:${i.lang}:short:${l.id}:${n}`, ok: false, required: false, text: `A caption page of line ${l.id} is shorter than 0.8 s`, evidence: `${page.durationMs} ms` });
    }
    offset.set(l.beatId, base + l.ms);
  }
  return { doc: { lang: i.lang, pages, sizePx, maxWidthPx: maxPx, font: i.font ?? null }, checks };
}

/** A measure for a language with the bundled faces (Persian at the caption weight; Latin by the Latin face if any). */
export function captionMeasure(lang: Lang, fonts: FontFile[], sizePx = typeScale('caption', lang).size): { measure: Measure; font: FontFile } {
  const face = (lang === 'en' ? fonts.find((f) => f.role === 'latin') : null) ?? fonts.find((f) => f.role === 'text')!;
  const font = measuringFont(face);
  const weight = typeScale('caption', lang).weight[1];
  return { measure: (text) => font.measure(text, sizePx, weight), font: face };
}

export function captionsExecutor(deps: { fonts?: () => FontFile[] } = {}): Executor {
  return {
    kind: 'captions',
    implVersion: 'captions@2',
    deterministic: true,
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'On this computer', verified: true }),
    async run(i) {
      const lang = i.lang;
      if (!lang) throw new Error('captions needs a language');
      const fonts = deps.fonts?.() ?? resolveFonts().fonts;
      const { measure, font } = captionMeasure(lang, fonts);
      const beatsWith = (t: string) => new Set(i.recipe.beats.filter((b) => b.techniques.includes(t)).map((b) => b.id));
      const { doc, checks } = buildCaptions({
        lang,
        alignment: i.byPort.alignment as AlignmentDoc,
        measure,
        highlightBeats: beatsWith('highlight-marker'),
        emphasisBeats: beatsWith('emphasis-punch'),
        font: { family: font.family, sha256: font.sha256 },
      });
      return {
        outputs: [{ port: 'captionPages', name: `captions.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: doc }],
        provides: {},
        checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd: 0,
        model: null,
      };
    },
  };
}
