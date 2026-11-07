// A small semver range matcher for `pack.json` `requires.signal`. Supports `1.2.3`, partial versions
// (`3` = 3.0.0), comparators `>= > <= < =`, caret `^`, tilde `~`, `*`/`x`, space-separated AND and `||` OR.
// Pre-release tags are not accepted (packs pin released Signal versions).
type V = [number, number, number];

const VERSION_RE = /^v?(\d{1,6})(?:\.(\d{1,6}|[xX*]))?(?:\.(\d{1,6}|[xX*]))?$/;

export function parseVersion(text: string): V | null {
  const m = VERSION_RE.exec(text.trim());
  if (!m || /[xX*]/.test(m[2] ?? '') || /[xX*]/.test(m[3] ?? '') || m[2] === undefined || m[3] === undefined) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

type Test = (v: V) => boolean;

function partial(text: string): { v: V; parts: number } | null {
  if (/^[xX*]$/.test(text)) return { v: [0, 0, 0], parts: 0 };
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const wild = (s: string | undefined) => s === undefined || /[xX*]/.test(s);
  const parts = wild(m[2]) ? 1 : wild(m[3]) ? 2 : 3;
  return { v: [Number(m[1]), parts > 1 ? Number(m[2]) : 0, parts > 2 ? Number(m[3]) : 0], parts };
}

/** Exclusive upper bound of a partial version: `3` → 4.0.0, `3.1` → 3.2.0. */
const bump = (v: V, parts: number): V => (parts <= 1 ? [v[0] + 1, 0, 0] : parts === 2 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1]);

function comparator(token: string): Test | null {
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]!);
  if (!p) return null;
  const { v, parts } = p;
  if (parts === 0) return op === '' || op === '>=' || op === '=' ? () => true : null;
  switch (op) {
    case '>=':
      return (x) => cmp(x, v) >= 0;
    case '>':
      return parts === 3 ? (x) => cmp(x, v) > 0 : (x) => cmp(x, bump(v, parts)) >= 0;
    case '<':
      return (x) => cmp(x, v) < 0;
    case '<=':
      return parts === 3 ? (x) => cmp(x, v) <= 0 : (x) => cmp(x, bump(v, parts)) < 0;
    case '^': {
      const hi: V = v[0] > 0 || parts === 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || parts === 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1];
      return (x) => cmp(x, v) >= 0 && cmp(x, hi) < 0;
    }
    case '~': {
      const hi: V = parts === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
      return (x) => cmp(x, v) >= 0 && cmp(x, hi) < 0;
    }
    default: // '' or '=': exact, or the whole partial range
      return parts === 3 ? (x) => cmp(x, v) === 0 : (x) => cmp(x, v) >= 0 && cmp(x, bump(v, parts)) < 0;
  }
}

/** Compiles a range; null when it is not a range this matcher understands. */
export function parseRange(range: string): Test | null {
  if (typeof range !== 'string' || !range.trim() || range.length > 200) return null;
  const alternatives: Test[] = [];
  for (const alt of range.split('||')) {
    const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const tests: Test[] = [];
    for (const t of tokens) {
      const c = comparator(t);
      if (!c) return null;
      tests.push(c);
    }
    alternatives.push((v) => tests.every((t) => t(v)));
  }
  return (v) => alternatives.some((a) => a(v));
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const r = parseRange(range);
  return Boolean(v && r && r(v));
}
