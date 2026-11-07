// Content language of a piece of user text: comments, replies and captions render with
// their own `lang`, and `dir="auto"` picks the direction. Only the script is read; nothing leaves the browser.

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-zÀ-ɏ]/g;
/** Letters only Persian uses (pe, che, zhe, gaf, Persian kaf and yeh). */
const PERSIAN_ONLY = /[پچژگکی]/;
/** Letters Arabic uses where Persian writes another (Arabic yeh, kaf, teh marbuta). */
const ARABIC_ONLY = /[يكة]/;

/** 'fa' or 'ar' when Arabic-script letters outnumber Latin ones; 'en' for Latin text; undefined when unsure. */
export function detectLang(text: string | null | undefined): 'fa' | 'ar' | 'en' | undefined {
  if (!text) return undefined;
  const arabic = text.match(ARABIC_SCRIPT)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (arabic === 0 && latin === 0) return undefined;
  if (arabic > latin) return ARABIC_ONLY.test(text) && !PERSIAN_ONLY.test(text) ? 'ar' : 'fa';
  return 'en';
}
