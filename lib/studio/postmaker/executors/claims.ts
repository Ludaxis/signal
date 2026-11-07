// The claims lint for agent-written copy (rule BL-02): the reserved keys `free`,
// `level-count`, `price`, `ranking` (denied unless the pack's `claims.allowed` lists them) and `availability` (only
// through a pack claim statement, never as free text), plus the pack's literal phrases. `denied` wins over `allowed`;
// an allowed literal phrase is exempt from the reserved-key patterns. Matching runs on normalised text (Persian
// through the normaliser) in every language, so the claims result is the same across languages.
import { stripMarks } from '../../lang/fa/chars';
import { normalizeFa } from '../../lang/fa/normalize';
import type { Lang } from '../types';

export type ClaimKey = 'free' | 'level-count' | 'price' | 'ranking' | 'availability';
export const CLAIM_KEYS: readonly ClaimKey[] = ['free', 'level-count', 'price', 'ranking', 'availability'];

const PATTERNS: Record<ClaimKey, RegExp[]> = {
  free: [/\bfree\b/i, /رایگان|مجانی/],
  'level-count': [/\b\d[\d,.]*\+?\s*(levels?|stages?|puzzles?|worlds?)\b/i, /[\d۰-۹][\d۰-۹,٬.]*\+?\s*(تا\s*)?(مرحله|سطح|پازل|معما)/],
  price: [/[$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(usd|eur|dollars?|euros?)\b|\b\d+\s?%\s?off\b|\bdiscount\b|\bsale\b/i, /تومان|تومن|ریال|تخفیف|حراج/],
  ranking: [/\b(number\s?one|no\.?\s?1|#\s?1|top[\s-]?(rated|ranked|\d+)|best[\s-]?(selling|rated|game|app)?)\b/i, /بهترین|شماره\s*(یک|۱)|رتبه\s*(اول|یک|۱)|پرفروش/],
  availability: [/\b(now on|download (it )?(on|from|now)|available (on|now)|get it on|install (it )?now)\b/i, /دانلود\s*کن|نصب\s*کن|الان\s*(توی|تو|در)\s/],
};

export interface PackClaimsPolicy {
  allowed: string[];
  denied: string[];
}

export interface ClaimIssue {
  key: ClaimKey | 'denied-phrase';
  text: string;
}

const form = (s: string) =>
  stripMarks(normalizeFa(s).text)
    .toLowerCase()
    .replace(/‌/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Claims a piece of copy makes that the policy does not allow. */
export function claimsLint(text: string, policy: PackClaimsPolicy | null | undefined, lang?: Lang): ClaimIssue[] {
  void lang; // the patterns cover both languages; the same text gets the same result in either package
  const p = policy ?? { allowed: [], denied: [] };
  let t = form(text);
  if (!t) return [];
  const out: ClaimIssue[] = [];
  const reserved = new Set<string>(CLAIM_KEYS);
  for (const d of p.denied.filter((x) => !reserved.has(x))) {
    const f = form(d);
    if (f && t.includes(f)) out.push({ key: 'denied-phrase', text: d });
  }
  for (const a of p.allowed.filter((x) => !reserved.has(x))) {
    const f = form(a);
    if (f && !p.denied.some((d) => form(d) === f)) t = t.split(f).join(' ');
  }
  const allowed = new Set(p.allowed.filter((x) => reserved.has(x) && !p.denied.includes(x)));
  for (const key of CLAIM_KEYS) {
    if (key !== 'availability' && allowed.has(key)) continue; // availability only through a statement (rule 1)
    if (PATTERNS[key].some((re) => re.test(t))) out.push({ key, text });
  }
  return out;
}
