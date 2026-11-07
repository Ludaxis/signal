// The Studio core names no brand, store or person: project-specific strings live in project packs outside the
// repository, and in this repository only in tests/fixtures/**. The generic guard checks store names; a maintainer
// can add their own private names in an untracked file named by SIGNAL_NAME_DENYLIST (one word or phrase per line,
// "#" starts a comment, matched case-insensitively) without writing those names into the repository.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maintainerDenylist } from './name-denylist';

const ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['lib/studio', 'app/studio', 'app/api/studio'];
/** Store names: the core says "the app stores" at most; a named store is a pack line (formats.json "lines"). */
const STORES = /google play|play store|\bapp store\b(?! page)|itunes store|steam store|microsoft store|amazon appstore/i;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|css|json|md)$/.test(name)) out.push(p);
  }
  return out;
}

function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const root of ROOTS)
    for (const f of files(path.join(ROOT, root))) {
      const rel = path.relative(ROOT, f);
      if (rel.split(path.sep).some((s) => s === 'fixtures' || s === '__fixtures__')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((text, i) => {
        if (re.test(text)) found.push(`${rel}:${i + 1}: ${text.trim().slice(0, 120)}`);
      });
    }
  return found;
}

describe('generic core', () => {
  it('scans real files', () => {
    expect(files(path.join(ROOT, 'lib/studio')).length).toBeGreaterThan(30);
    expect(files(path.join(ROOT, 'app/studio')).length).toBeGreaterThan(20);
    expect(files(path.join(ROOT, 'app/api/studio')).length).toBeGreaterThan(10);
  });
  it('names no app store: availability lines come from a pack, never the core', () => {
    expect(hits(STORES)).toEqual([]);
  });
  it('finds none of the names in the maintainer denylist (skipped without SIGNAL_NAME_DENYLIST)', () => {
    const re = maintainerDenylist();
    if (!re) return;
    expect(hits(re)).toEqual([]);
  });
});
