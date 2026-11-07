// The optional maintainer denylist for the name guards. The core names no brand, store or person; a maintainer who
// wants to check for their own private names lists them in an untracked file and points SIGNAL_NAME_DENYLIST at it
// (one word or phrase per line, "#" starts a comment, matched case-insensitively). Without it the guards check only
// the generic words they name themselves.
import { existsSync, readFileSync } from 'node:fs';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The maintainer's own denylist as one case-insensitive pattern, or null when none is configured. */
export function maintainerDenylist(): RegExp | null {
  const file = process.env.SIGNAL_NAME_DENYLIST;
  if (!file || !existsSync(file)) return null;
  const words = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  return words.length ? new RegExp(words.map(escape).join('|'), 'i') : null;
}
