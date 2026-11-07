// Persian letter-by-letter brand reveal (preset `reveal` rows R2-R4): render successive prefixes
// of the word; every prefix except the last ends with U+200D (ZWJ) so its final letter keeps its connecting form.
// A word of N letters has N steps. Combining marks stay with their letter. Latin words use `letterSteps` instead
// (letter-stagger). Pure module: no imports outside render/.
import { ZWJ_STEP_FRAMES } from './curves';

export const ZWJ = '‍';
const MARK = /[ً-ٰٟۖ-ۭ]/;

/** The letters of a word, each with its combining marks. */
export function lettersOf(word: string): string[] {
  const out: string[] = [];
  for (const ch of word) {
    if (out.length && MARK.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** The N prefix steps of a Persian word: prefixes 1…N−1 end with ZWJ, then the complete word. */
export function zwjPrefixes(word: string): string[] {
  const letters = lettersOf(word);
  return letters.map((_, i) => letters.slice(0, i + 1).join('') + (i < letters.length - 1 ? ZWJ : ''));
}

/** Frames of the fa steps from the segment start S (R2: S + 6, then one every 5 frames; R4: the full word). */
export function zwjStepFrames(start: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + 6 + ZWJ_STEP_FRAMES * i);
}

/** en letter-stagger (R5): letter k enters at S + 6 + 3k with pop-in; the full-word punch starts after the last lands. */
export function letterStagger(start: number, word: string): { letters: { text: string; at: number }[]; punchAt: number } {
  const letters = [...word].map((text, k) => ({ text, at: start + 6 + 3 * k }));
  const last = letters.at(-1)?.at ?? start + 6;
  return { letters, punchAt: last + 9 };
}
