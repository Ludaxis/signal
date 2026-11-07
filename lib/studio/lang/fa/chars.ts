// Shared Persian character classes and small helpers (fa-norm-1.0).
// Every Persian form produced by this library is a *proposal* until the owner, or a
// reader they name, signs it.

export const ZWNJ = '\u200C';
export const ZWJ = '\u200D';
export const NORM_VERSION = 'fa-norm-1.0' as const;

/** Arabic-script letters used in Persian text (no digits, no punctuation, no marks). */
export const LETTER_CLASS = '\\u0621-\\u063A\\u0641-\\u064A\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC';
/** Combining marks kept inside a word: harakat, shadda, sukun, hamza above, superscript alef. */
export const MARK_CLASS = '\\u064B-\\u0655\\u0670';
/** Characters that belong to a Persian word (letters, marks, ZWNJ). */
export const WORD_CLASS = `${LETTER_CLASS}${MARK_CLASS}\\u200C`;

export const LETTER_RE = new RegExp(`[${LETTER_CLASS}]`);
export const WORD_RE = new RegExp(`[${WORD_CLASS}]+`, 'g');
export const LATIN_RE = /[A-Za-z]/;
export const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Letters that never join to the following letter: a ZWNJ after them has no visual effect (ZC-3). */
export const NON_JOINING = new Set(['ا', 'آ', 'أ', 'إ', 'د', 'ذ', 'ر', 'ز', 'ژ', 'و', 'ؤ', 'ء', 'ة']);

/** Harakat removed by stripMarks: U+064B-U+0652 and superscript alef U+0670. */
const MARKS_RE = /[\u064B-\u0652\u0670]/g;

export function isLetter(ch: string | undefined): boolean {
  return !!ch && LETTER_RE.test(ch);
}

export function isMark(ch: string | undefined): boolean {
  return !!ch && /[\u064B-\u0655\u0670]/.test(ch);
}

export function isPersianDigit(ch: string | undefined): boolean {
  return !!ch && PERSIAN_DIGITS.includes(ch);
}

/** Last base letter of a word, skipping trailing marks. */
export function lastLetter(word: string): string | undefined {
  for (let i = word.length - 1; i >= 0; i--) {
    const ch = word[i];
    if (isLetter(ch)) return ch;
  }
  return undefined;
}

/** Remove harakat (U+064B-U+0652, U+0670). Hamza above U+0654 is kept (it is a display mark, EZ-2). */
export function stripMarks(s: string): string {
  return s.replace(MARKS_RE, '');
}

/** Canonical comparison form: marks stripped, the hamza ezafe written as ه\u200Cی, NFC. */
export function canonDisplay(s: string): string {
  return stripMarks(s.normalize('NFC')).replace(/هٔ/g, `ه${ZWNJ}ی`);
}

/** Count characters the way the slot limits count them: spaces counted, ZWNJ and marks not. */
export function visibleLength(s: string): number {
  return s.replace(/[\u200C\u064B-\u0655\u0670]/g, '').length;
}

export function toPersianDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d).replace(/[٠-٩]/g, (d) => PERSIAN_DIGITS[ARABIC_INDIC_DIGITS.indexOf(d)] ?? d);
}

export function fromPersianDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)));
}

/** Emoji detector (pictographs, variation selector 16, skin-tone modifiers, regional indicators). */
export const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]/u;
export const EMOJI_RUN_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3\u200D]+/gu;

/** Does the string contain any Arabic-script letter? */
export function hasPersian(s: string): boolean {
  return LETTER_RE.test(s);
}
