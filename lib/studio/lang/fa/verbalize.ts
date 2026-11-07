// verbalizeFa: numbers, dates, times, money and percent as spoken Persian words (PR-N*).
// `verbalizeFa` returns plain words (no harakat). The `*Pron` helpers return the marked `pron`
// form and the house `roman` form used by the pronunciation layer. Colloquial forms (چار، پونزده,
// هیجده …) are [editorial] proposals for the reader who signs the text.

import { ZWNJ, fromPersianDigits } from './chars';
import type { Register } from './normalize';

const ONES_FORMAL = ['صفر', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const TEENS_FORMAL = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const TEENS_COLLOQUIAL = ['ده', 'یازده', 'دوازده', 'سیزده', 'چارده', 'پونزده', 'شونزده', 'هیفده', 'هیجده', 'نوزده'];
const TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const HUNDREDS_FORMAL = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const HUNDREDS_COLLOQUIAL = ['', 'صد', 'دویست', 'سیصد', 'چارصد', 'پونصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const SCALES = ['', 'هزار', 'میلیون', 'میلیارد'];

/** Marked pron form and roman for every number word (and the unit words used with numbers). */
const WORD_PRON: Record<string, [string, string]> = {
  'صفر': ['صِفر', 'sefr'], 'یک': ['یِک', 'yek'], 'دو': ['دو', 'do'], 'سه': ['سه', 'se'], 'چهار': ['چَهار', 'chahaar'],
  'چار': ['چار', 'chaar'], 'پنج': ['پَنج', 'panj'], 'شش': ['شِش', 'shesh'], 'هفت': ['هَفت', 'haft'], 'هشت': ['هَشت', 'hasht'],
  'نه': ['نُه', 'noh'], 'ده': ['دَه', 'dah'], 'یازده': ['یازده', 'yaazda'], 'دوازده': ['دَوازده', 'davaazda'],
  'سیزده': ['سیزده', 'sizda'], 'چهارده': ['چَهارده', 'chahaarda'], 'چارده': ['چارده', 'chaarda'], 'پانزده': ['پانزده', 'paanzdah'],
  'پونزده': ['پونزده', 'punzda'], 'شانزده': ['شانزده', 'shaanzdah'], 'شونزده': ['شونزده', 'shunzda'], 'هفده': ['هِفده', 'hefdah'],
  'هیفده': ['هیفده', 'hifda'], 'هجده': ['هِجده', 'hejdah'], 'هیجده': ['هیجده', 'hijda'], 'نوزده': ['نوزده', 'nuzda'],
  'بیست': ['بیست', 'bist'], 'سی': ['سی', 'si'], 'چهل': ['چِهِل', 'chehel'], 'پنجاه': ['پَنجاه', 'panjaah'], 'شصت': ['شَصت', 'shast'],
  'هفتاد': ['هَفتاد', 'haftaad'], 'هشتاد': ['هَشتاد', 'hashtaad'], 'نود': ['نَوَد', 'navad'], 'صد': ['صَد', 'sad'],
  'دویست': ['دِویست', 'devist'], 'سیصد': ['سیصَد', 'sisad'], 'چهارصد': ['چَهارصَد', 'chahaarsad'], 'چارصد': ['چارصَد', 'chaarsad'],
  'پانصد': ['پانصَد', 'paansad'], 'پونصد': ['پونصَد', 'punsad'], 'ششصد': ['شِشصَد', 'sheshsad'], 'هفتصد': ['هَفتصَد', 'haftsad'],
  'هشتصد': ['هَشتصَد', 'hashtsad'], 'نهصد': ['نُهصَد', 'nohsad'], 'هزار': ['هِزار', 'hezaar'], 'میلیون': ['میلیون', 'milyun'],
  'میلیارد': ['میلیارد', 'milyaard'], 'و': ['و', 'o'], 'درصد': ['دَرصَد', 'darsad'], 'تومن': ['تومَن', 'toman'],
  'تومان': ['تومان', 'tomaan'], 'نیم': ['نیم', 'nim'], 'ربع': ['رُبع', 'rob'], 'ممیز': ['مُمَیِّز', 'momayyez'],
  'دقیقه': ['دَقیقه', 'daghighe'], 'منفی': ['مَنفی', 'manfi'], 'به': ['بِه', 'be'], 'تا': ['تا', 'taa'], 'یه': ['یه', 'ye'],
};

export interface Spoken {
  /** Marked pron text. */
  pron: string;
  /** House roman (ASCII). */
  roman: string;
  /** Plain words (no marks). */
  words: string;
}

function chunkWords(n: number, register: Register): string[] {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push((register === 'formal' ? HUNDREDS_FORMAL : HUNDREDS_COLLOQUIAL)[h] ?? '');
  if (rest >= 10 && rest < 20) parts.push((register === 'formal' ? TEENS_FORMAL : TEENS_COLLOQUIAL)[rest - 10] ?? '');
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) parts.push(TENS[t] ?? '');
    if (o) parts.push(o === 4 && register !== 'formal' ? 'چار' : (ONES_FORMAL[o] ?? ''));
  }
  return parts;
}

/** Cardinal number as words, joined with « و ». Colloquial uses the 11-19 table, «چار» (PR-N3). */
export function verbalizeFa(n: number, register: Register = 'colloquial'): string {
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`verbalizeFa: integer expected, got ${n}`);
  if (n < 0) return `منفی ${verbalizeFa(-n, register)}`;
  if (n === 0) return 'صفر';
  if (n >= 1e12) throw new Error('verbalizeFa: number too large');
  const groups: string[] = [];
  let rest = n;
  let scale = 0;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk) {
      const words = chunkWords(chunk, register).join(' و ');
      const scaleWord = SCALES[scale] ?? '';
      if (scale === 1 && chunk === 1) groups.unshift('هزار');
      else groups.unshift(scaleWord ? `${words} ${scaleWord}` : words);
    }
    rest = Math.floor(rest / 1000);
    scale++;
  }
  return groups.join(' و ');
}

/** Convert plain number words to the marked pron form and roman (unknown words pass through). */
export function wordsToSpoken(words: string): Spoken {
  const ws = words.split(' ').filter(Boolean);
  const pron = ws.map((w) => WORD_PRON[w]?.[0] ?? w).join(' ');
  let roman = '';
  for (const w of ws) {
    const r = WORD_PRON[w]?.[1] ?? w;
    if (w === 'و') roman += '-o';
    else roman += (roman ? ' ' : '') + r;
  }
  return { pron, roman, words };
}

export function verbalizeFaPron(n: number, register: Register = 'colloquial'): Spoken {
  return wordsToSpoken(verbalizeFa(n, register));
}

/** Append the ezafe to a marked pron word and to its roman (PR-E1; roman `-e` after a consonant, `-ye` after a vowel). */
export function withEzafe(s: Spoken): Spoken {
  const lastWord = s.words.split(' ').pop() ?? '';
  const pron = lastWord === 'سه' ? `${s.pron}${ZWNJ}یِ` : `${s.pron.replace(/\u0650$/, '')}\u0650`;
  const roman = /[aeiou]$/.test(s.roman) ? `${s.roman}-ye` : `${s.roman}-e`;
  return { pron, roman, words: s.words };
}

/** Ordinal (PR-N6): اول، دوم، سوم, otherwise cardinal + \u064Fم (سی\u200Cام after a final ی). */
export function verbalizeOrdinalFa(n: number, register: Register = 'colloquial'): string {
  if (n === 1) return 'اول';
  if (n === 2) return 'دوم';
  if (n === 3) return 'سوم';
  const c = verbalizeFa(n, register);
  return c.endsWith('ی') ? `${c}${ZWNJ}ام` : `${c}م`;
}

export const JALALI_MONTHS: { display: string; pron: string; roman: string }[] = [
  { display: 'فروردین', pron: 'فَروَردین', roman: 'farvardin' },
  { display: 'اردیبهشت', pron: 'اُردیبِهِشت', roman: 'ordibehesht' },
  { display: 'خرداد', pron: 'خُرداد', roman: 'khordaad' },
  { display: 'تیر', pron: 'تیر', roman: 'tir' },
  { display: 'مرداد', pron: 'مُرداد', roman: 'mordaad' },
  { display: 'شهریور', pron: 'شَهریوَر', roman: 'shahrivar' },
  { display: 'مهر', pron: 'مِهر', roman: 'mehr' },
  { display: 'آبان', pron: 'آبان', roman: 'aabaan' },
  { display: 'آذر', pron: 'آذَر', roman: 'aazar' },
  { display: 'دی', pron: 'دِی', roman: 'dey' },
  { display: 'بهمن', pron: 'بَهمَن', roman: 'bahman' },
  { display: 'اسفند', pron: 'اِسفَند', roman: 'esfand' },
];

export function monthIndexFa(word: string): number {
  return JALALI_MONTHS.findIndex((m) => m.display === word) + 1; // 0 when not a month
}

/** Parse Persian or ASCII digits (with ٬ or , separators and ٫ or . decimals) to a number. */
export function parseFaNumber(s: string): number {
  const ascii = fromPersianDigits(s).replace(/[٬,٪%]/g, '').replace('٫', '.');
  return Number(ascii);
}

/** PR-N7: day (cardinal) + ezafe + month; the year is added only when given. */
export function verbalizeDateFa(day: number, month: number, year?: number, register: Register = 'colloquial'): Spoken {
  const m = JALALI_MONTHS[month - 1];
  if (!m) throw new Error(`verbalizeDateFa: month ${month}`);
  const d = withEzafe(verbalizeFaPron(day, register));
  if (year === undefined) return { pron: `${d.pron} ${m.pron}`, roman: `${d.roman} ${m.roman}`, words: `${d.words} ${m.display}` };
  const y = verbalizeFaPron(year, register);
  return {
    pron: `${d.pron} ${m.pron}\u0650 ${y.pron}`,
    roman: `${d.roman} ${m.roman}-e ${y.roman}`,
    words: `${d.words} ${m.display} ${y.words}`,
  };
}

/** PR-N8: colloquial clock time («۱۰:۳۰» → «دَه و نیم»). 12-hour reading for 13-23 is [editorial]. */
export function verbalizeTimeFa(h: number, m: number, register: Register = 'colloquial'): Spoken {
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  if (m === 0) return verbalizeFaPron(hour, register);
  if (m === 30) return wordsToSpoken(`${verbalizeFa(hour, register)} و نیم`);
  if (m === 15) return wordsToSpoken(`${verbalizeFa(hour, register)} و ربع`);
  if (m === 45) {
    const next = hour === 12 ? 1 : hour + 1;
    return wordsToSpoken(`یه ربع به ${verbalizeFa(next, register)}`);
  }
  return wordsToSpoken(`${verbalizeFa(hour, register)} و ${verbalizeFa(m, register)} دقیقه`);
}

/** PR-N9: amount + «تومَن» (colloquial) or «تومان» (formal). */
export function verbalizeMoneyFa(amount: number, register: Register = 'colloquial', unit: 'تومان' = 'تومان'): Spoken {
  void unit;
  const unitWord = register === 'formal' ? 'تومان' : 'تومن';
  return wordsToSpoken(`${verbalizeFa(amount, register)} ${unitWord}`);
}

/** PR-N10: «X دَرصَد». */
export function verbalizePercentFa(n: number, register: Register = 'colloquial'): Spoken {
  if (Number.isInteger(n)) return wordsToSpoken(`${verbalizeFa(n, register)} درصد`);
  const d = verbalizeDecimalFa(n, register);
  return { pron: `${d.pron} دَرصَد`, roman: `${d.roman} darsad`, words: `${d.words} درصد` };
}

/** PR-N11: «X و نیم» for .5 in colloquial text, otherwise «X مُمَیِّز Y». */
export function verbalizeDecimalFa(n: number, register: Register = 'colloquial'): Spoken {
  const [intPart = '0', frac = ''] = String(n).split('.');
  const i = Number(intPart);
  if (frac === '5' && register !== 'formal') return wordsToSpoken(`${verbalizeFa(i, register)} و نیم`);
  return wordsToSpoken(`${verbalizeFa(i, register)} ممیز ${verbalizeFa(Number(frac), register)}`);
}

// ---------------------------------------------------------------------------------------------
// Jalali display (NU-5) through Intl. Requires full ICU (official Node builds include it).

const JALALI_PARTS = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const JALALI_DAY_MONTH = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function toDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`);
}

/** Jalali year, month, day of an ISO date (YYYY-MM-DD). */
export function jalaliParts(iso: string): { year: number; month: number; day: number } {
  const parts = JALALI_PARTS.formatToParts(toDate(iso));
  const get = (t: string) => Number(fromPersianDigits(parts.find((p) => p.type === t)?.value ?? 'NaN'));
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Display form «۱۵ آبان» (day and month) of an ISO date. */
export function formatJalaliDayMonthFa(iso: string): string {
  return JALALI_DAY_MONTH.format(toDate(iso));
}
