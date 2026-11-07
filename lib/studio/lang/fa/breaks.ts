// breakFa: line breaks for Persian text in vertical-video slots (rules LB-1…LB-7) and the
// width test. Character limits are lint warnings; type sizes come from the quality bar's type scale.
// The width test is authoritative: a line rendered at the slot size must fit the 960 px text box.

import { visibleLength } from './chars';
import { tokenizeFa, type Token } from './tokenize';

export type SlotId = 'kinetic-caption' | 'hook-headline' | 'speech-bubble' | 'sticker' | 'pov-pill' | 'end-card-tagline' | 'cta-pill';

export interface SlotSpec {
  /** Persian size range in px at 1080 wide (where it defines the role). */
  sizePx: [number, number];
  maxLines: number;
  maxChars: number;
  maxWords: number;
}

export const SLOT_SPECS: Record<SlotId, SlotSpec> = {
  'kinetic-caption': { sizePx: [70, 92], maxLines: 2, maxChars: 22, maxWords: 5 },
  'hook-headline': { sizePx: [96, 132], maxLines: 2, maxChars: 14, maxWords: 4 },
  'speech-bubble': { sizePx: [52, 66], maxLines: 3, maxChars: 18, maxWords: 9 },
  sticker: { sizePx: [44, 64], maxLines: 1, maxChars: 14, maxWords: 3 },
  'pov-pill': { sizePx: [40, 48], maxLines: 1, maxChars: 24, maxWords: 5 },
  'end-card-tagline': { sizePx: [80, 104], maxLines: 1, maxChars: 20, maxWords: 4 },
  'cta-pill': { sizePx: [48, 56], maxLines: 1, maxChars: 16, maxWords: 3 },
};

/** The text box width at 1080 px with 60 px side gutters. */
export const TEXT_BOX_PX = 960;

const PREPOSITIONS = new Set(['به', 'از', 'با', 'تو', 'توی', 'واسه', 'برای', 'در', 'سر', 'پیش']);
const BREAK_BEFORE = new Set(['و', 'ولی', 'که', 'تا']);
const COUNTERS = new Set(['تا', 'نفر', 'هزار', 'میلیون', 'تومان', 'تومن', 'درصد', 'ساعت', 'دقیقه', 'روز', 'سال']);

/** A span-like record: any display range with an ezafe junction after it (PronSpan is compatible). */
export interface EzafeSpanLike {
  d: [number, number];
  ezafeAfter?: boolean;
}

interface Unit {
  text: string;
  start: number;
  end: number;
  first: Token;
  last: Token;
}

/** Words with their trailing punctuation attached (LB-6: a line never starts with punctuation). */
function units(text: string): Unit[] {
  const toks = tokenizeFa(text);
  const out: Unit[] = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    const closing = t.kind === 'punct' && !['«', '('].includes(t.text);
    if (prev && (closing || (prev.last.kind === 'punct' && ['«', '('].includes(prev.last.text)))) {
      prev.end = t.end;
      prev.last = t;
      prev.text = text.slice(prev.start, prev.end);
      continue;
    }
    out.push({ text: t.text, start: t.start, end: t.end, first: t, last: t });
  }
  return out;
}

function forbiddenAfter(u: Unit, next: Unit, spans: EzafeSpanLike[]): boolean {
  // LB-2: never split an ezafe chain
  if (spans.some((s) => s.ezafeAfter && s.d[1] > u.start && s.d[1] <= u.end)) return true;
  if (spans.some((s) => s.d[0] < next.start && s.d[1] > u.end)) return true; // a span covering both (number+unit, date)
  // LB-3: preposition + object; number + unit/counter
  if (u.last.kind === 'word' && PREPOSITIONS.has(u.last.text) && u.end === u.last.end) return true;
  if (u.last.kind === 'number' && next.first.kind === 'word' && (COUNTERS.has(next.first.text) || isMonth(next.first.text))) return true;
  // LB-6: never end a line with an opening «
  if (u.last.text === '«') return true;
  return false;
}

const MONTHS = new Set(['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']);
function isMonth(w: string): boolean {
  return MONTHS.has(w);
}

function preferred(u: Unit, next: Unit): boolean {
  // LB-1: after ، or ؛, or before و / ولی / که / تا
  return u.last.text === '،' || u.last.text === '؛' || (next.first.kind === 'word' && BREAK_BEFORE.has(next.first.text));
}

function joinUnits(text: string, us: Unit[]): string {
  if (us.length === 0) return '';
  return text.slice(us[0]!.start, us[us.length - 1]!.end);
}

/**
 * Break `text` into at most the slot's lines. Returns the lines (unchanged text, split at spaces).
 * When no break satisfies every rule, the least-bad split is returned; `checkBreaks` reports why.
 */
export function breakFa(text: string, slot: SlotId, spans: EzafeSpanLike[] = []): string[] {
  const spec = SLOT_SPECS[slot];
  const us = units(text);
  if (visibleLength(text) <= spec.maxChars || us.length < 2 || spec.maxLines < 2) return [text];
  type Plan = { cuts: number[]; score: number };
  let best: Plan | null = null;
  const evaluate = (cuts: number[]) => {
    const bounds = [0, ...cuts, us.length];
    const lines: Unit[][] = [];
    for (let k = 0; k < bounds.length - 1; k++) lines.push(us.slice(bounds[k], bounds[k + 1]));
    let score = 0;
    for (const c of cuts) {
      const u = us[c - 1]!;
      const n = us[c]!;
      if (forbiddenAfter(u, n, spans)) score += 1000;
      if (!preferred(u, n)) score += 3;
    }
    const lens = lines.map((l) => visibleLength(joinUnits(text, l)));
    for (const len of lens) if (len > spec.maxChars) score += 100 + (len - spec.maxChars);
    if (lines.length >= 2 && lines[lines.length - 1]!.length === 1) score += 20; // LB-5 orphan
    const shortest = Math.min(...lens);
    const longest = Math.max(...lens);
    if (longest > 0 && shortest / longest < 0.6) score += 10; // LB-5 balance
    score += (longest - shortest) / 100;
    if (!best || score < best.score) best = { cuts, score };
  };
  for (let a = 1; a < us.length; a++) {
    evaluate([a]);
    if (spec.maxLines >= 3) for (let b = a + 1; b < us.length; b++) evaluate([a, b]);
  }
  const plan = best as Plan | null;
  if (!plan) return [text];
  const bounds = [0, ...plan.cuts, us.length];
  const out: string[] = [];
  for (let k = 0; k < bounds.length - 1; k++) out.push(joinUnits(text, us.slice(bounds[k], bounds[k + 1])));
  return out;
}

export interface BreakIssue {
  ruleId: 'LB-2' | 'LB-3' | 'LB-5' | 'LB-6' | 'LEN-1' | 'LEN-2';
  line: number;
  message: string;
}

/** Check an existing set of lines (for example typed by a person) against LB-2…LB-6 and the slot limits. */
export function checkBreaks(lines: string[], slot: SlotId, spans: EzafeSpanLike[] = []): BreakIssue[] {
  const spec = SLOT_SPECS[slot];
  const out: BreakIssue[] = [];
  if (lines.length > spec.maxLines) out.push({ ruleId: 'LEN-2', line: lines.length - 1, message: `At most ${spec.maxLines} lines` });
  const text = lines.join(' ');
  const us = units(text);
  let offset = 0;
  lines.forEach((line, k) => {
    if (visibleLength(line) > spec.maxChars) out.push({ ruleId: 'LEN-1', line: k, message: `Line ${k + 1} is too long` });
    if (/^[،؛؟!.:…»)]/.test(line)) out.push({ ruleId: 'LB-6', line: k, message: 'A line starts with punctuation' });
    if (line.trimEnd().endsWith('«')) out.push({ ruleId: 'LB-6', line: k, message: 'A line ends with an opening «' });
    const end = offset + line.length;
    const u = us.find((x) => x.end === end);
    const n = us.find((x) => x.start === end + 1);
    if (u && n && k < lines.length - 1) {
      if (spans.some((s) => s.ezafeAfter && s.d[1] > u.start && s.d[1] <= u.end)) {
        out.push({ ruleId: 'LB-2', line: k, message: 'An ezafe chain is split' });
      } else if (forbiddenAfter(u, n, spans)) out.push({ ruleId: 'LB-3', line: k, message: 'A preposition, number or unit is separated' });
    }
    offset = end + 1;
  });
  if (lines.length >= 2 && (lines[lines.length - 1] ?? '').trim().split(/\s+/).length === 1) out.push({ ruleId: 'LB-5', line: lines.length - 1, message: 'One-word last line' });
  return out;
}

/** Measures a line in px at a font size. Supply one backed by the bundled font (opentype.js or the renderer). */
export type MeasureText = (text: string, sizePx: number) => number;

export interface WidthFailure {
  lineId: string;
  text: string;
  widthPx: number;
  maxPx: number;
}

/** fail any line wider than the text box at its slot size, naming the line id. */
export function widthTestFa(lines: { id: string; text: string }[], slot: SlotId, measure: MeasureText, sizePx?: number, maxPx = TEXT_BOX_PX): WidthFailure[] {
  const size = sizePx ?? SLOT_SPECS[slot].sizePx[1];
  const out: WidthFailure[] = [];
  for (const l of lines) {
    for (const part of l.text.split('\n')) {
      const w = measure(part, size);
      if (w > maxPx) out.push({ lineId: l.id, text: part, widthPx: w, maxPx });
    }
  }
  return out;
}

/** Adapter for a loaded font object (for example an opentype.js Font of the bundled Persian face). */
export function measureWithFont(font: { getAdvanceWidth(text: string, fontSize: number): number }): MeasureText {
  return (text, sizePx) => font.getAdvanceWidth(text, sizePx);
}
