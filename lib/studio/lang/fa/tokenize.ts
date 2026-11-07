// tokenizeFa: split normalised Persian display text into tokens.
// Words split on spaces; ZWNJ words stay one token; Latin runs (MX-1), numbers with an attached
// percent sign and one-word «…» callouts are single tokens. Offsets are UTF-16 offsets.

import { EMOJI_RUN_RE, WORD_CLASS } from './chars';

export type TokenKind = 'word' | 'latin' | 'number' | 'punct' | 'callout' | 'emoji' | 'hashtag' | 'url' | 'handle';

export interface Token {
  text: string;
  start: number;
  end: number;
  kind: TokenKind;
}

const RULES: [TokenKind, RegExp][] = [
  ['url', /(?:https?:\/\/|www\.)[^\s«»،؛]+/y],
  ['handle', /@[A-Za-z0-9_.]+/y],
  ['hashtag', /#[^\s#،؛؟!.,:…«»()]+/y],
  ['callout', new RegExp(`«[${WORD_CLASS}]+»`, 'y')],
  ['number', /[0-9۰-۹](?:[0-9۰-۹]|[٫٬.,:/](?=[0-9۰-۹]))*[٪%]?/y],
  ['latin', /[A-Za-z][A-Za-z0-9'’-]*(?:\.[A-Za-z0-9]+)*/y],
  ['word', new RegExp(`[${WORD_CLASS}]+`, 'y')],
  ['emoji', new RegExp(EMOJI_RUN_RE.source, 'uy')],
];

export function tokenizeFa(text: string): Token[] {
  const raw: Token[] = [];
  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i] ?? '';
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    for (const [kind, re] of RULES) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i && m[0].length > 0) {
        raw.push({ text: m[0], start: i, end: i + m[0].length, kind });
        i += m[0].length;
        continue outer;
      }
    }
    // a single punctuation (or any other) character
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    raw.push({ text: text.slice(i, i + len), start: i, end: i + len, kind: 'punct' });
    i += len;
  }
  // MX-1: consecutive Latin words (and ASCII numbers after a Latin word) separated by one space are one run
  const out: Token[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    const asciiNumber = t.kind === 'number' && /^[0-9][0-9.,:]*$/.test(t.text);
    if (prev && prev.kind === 'latin' && (t.kind === 'latin' || asciiNumber) && text.slice(prev.end, t.start) === ' ') {
      prev.text = text.slice(prev.start, t.end);
      prev.end = t.end;
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/** Word-like tokens (the ones a caption or a pron span is built from). */
export function isContentToken(t: Token): boolean {
  return t.kind !== 'punct';
}
