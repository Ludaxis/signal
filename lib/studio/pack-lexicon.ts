// Server-only: the Persian pronunciation list a project's pack ships (read-only, for the Brand screen's link).
// The pack folder is the Post maker one (postmaker/store/paths.ts packDirOf). Signal only reads it; a missing,
// unreadable or malformed pack simply has no list. Entries keep their review status: every form stays
// "proposed" until the owner, or a reader they name, approves it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LexEntry, LexiconFile } from './lang/fa/lexicon';
import { packDirOf } from './postmaker/store/paths';
import type { Project } from './projects';

export interface LexiconRow {
  id: string;
  /** The written form as the pack matches it. */
  display: string;
  roman: string;
  status: 'proposed' | 'approved';
}
export interface PackLexicon {
  /** Entries that are not retired, at most MAX_ROWS. */
  rows: LexiconRow[];
  /** All entries that are not retired. */
  count: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 200;

async function readJson(file: string): Promise<unknown> {
  const st = await fs.stat(/* turbopackIgnore: true */ file);
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error('too large');
  return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
}

/** A path inside `dir` from a pack-relative value, or null when it is missing or would leave the folder. */
function inside(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(dir, rel);
  return abs.startsWith(path.resolve(dir) + path.sep) ? abs : null;
}

/** The Persian list of the project's pack, or null when the project has no pack or the pack lists none. */
export async function packLexiconFa(project: Pick<Project, 'contentDir' | 'pack'>): Promise<PackLexicon | null> {
  const dir = packDirOf(project);
  let manifest: { lexicon?: Record<string, unknown> };
  try {
    manifest = (await readJson(path.join(dir, 'pack.json'))) as typeof manifest;
  } catch {
    return null;
  }
  const file = inside(dir, manifest?.lexicon?.fa);
  if (!file) return null;
  let lex: LexiconFile;
  try {
    lex = (await readJson(file)) as LexiconFile;
  } catch {
    return null;
  }
  if (!lex || !Array.isArray(lex.entries)) return null;
  const live = lex.entries.filter((e): e is LexEntry => Boolean(e && typeof e === 'object' && typeof e.id === 'string' && e.status !== 'retired'));
  const rows = live.slice(0, MAX_ROWS).map((e) => ({
    id: e.id.slice(0, 80),
    display: String(e.display?.fa ?? e.match?.display?.[0] ?? '').slice(0, 80),
    roman: String(e.roman ?? '').slice(0, 80),
    // Anything but an approval signed by a named person reads as proposed.
    status: e.status === 'approved' && typeof e.approvedBy === 'string' && e.approvedBy.trim() ? ('approved' as const) : ('proposed' as const),
  }));
  return { rows, count: live.length };
}
