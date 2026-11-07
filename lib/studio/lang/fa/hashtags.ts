// buildHashtagsFa: Persian hashtags (rules HT-1…HT-5). Platform hashtag behaviour is untested
// (platform rules are volatile and unverified), so the rules are conservative: no ZWNJ, no digits, `_` joins.

import { ZWNJ, hasPersian } from './chars';
import { normalizeFa } from './normalize';

export interface HashtagResult {
  tags: string[];
  /** Phrases the builder could not join safely; the editor confirms the proposal (HT-3). */
  needsEditor: { phrase: string; proposal: string; reason: string }[];
  rejected: { phrase: string; reason: 'HT-1' | 'HT-4' | 'EMPTY' }[];
}

export interface HashtagOptions {
  /** Hashtags already used by the other language block of the same post. */
  existing?: number;
  max?: number;
  maxFa?: number;
}

/** Turn phrases into hashtags. A 6th tag (counting `existing`) and a 4th Persian tag are rejected. */
export function buildHashtagsFa(phrases: string[], opts: HashtagOptions = {}): HashtagResult {
  const max = opts.max ?? 5;
  const maxFa = opts.maxFa ?? 3;
  const out: HashtagResult = { tags: [], needsEditor: [], rejected: [] };
  let total = opts.existing ?? 0;
  let fa = 0;
  for (const raw of phrases) {
    const phrase = normalizeFa(raw.replace(/^#/, '')).text.trim();
    if (!phrase) {
      out.rejected.push({ phrase: raw, reason: 'EMPTY' });
      continue;
    }
    if (total >= max || (hasPersian(phrase) && fa >= maxFa)) {
      out.rejected.push({ phrase: raw, reason: 'HT-1' });
      continue;
    }
    if (hasPersian(phrase) && /[0-9۰-۹]/.test(phrase)) {
      out.rejected.push({ phrase: raw, reason: 'HT-4' });
      continue;
    }
    const words = phrase.replace(/[،؛؟!.:…«»()]/g, ' ').split(/\s+/).filter(Boolean);
    // HT-3: a ZWNJ after a silent ه (خونه\u200Cی) cannot simply be dropped
    if (words.some((w) => w.includes(`ه${ZWNJ}`))) {
      out.needsEditor.push({ phrase: raw, proposal: `#${words.map((w) => w.split(ZWNJ).join('_')).join('_')}`, reason: 'ZWNJ after a silent ه' });
      continue;
    }
    const tag = hasPersian(phrase)
      ? `#${words.map((w) => w.replace(/\u200C/g, '')).join('_')}`
      : `#${words.map((w) => (w[0] ?? '').toUpperCase() + w.slice(1)).join('')}`; // HT-5 CamelCase
    out.tags.push(tag);
    total++;
    if (hasPersian(phrase)) fa++;
  }
  return out;
}
