// Server-only: project folders linked to a Signal project (read-only).
//
// You link folders from your machine (a game repo, an art or marketing folder) to a project.
// Signal lists the images, videos, design files and notes in them, shows thumbnails, and can
// import the brand from one. It never writes, moves or deletes anything in a linked folder.
// Links live in <SIGNAL_DATA_DIR>/folders.json; every file read is checked to stay inside its
// folder after symlinks are resolved.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './local-data';

export interface LinkedFolder { id: string; path: string; label: string; addedAt: string }
export type FileKind = 'image' | 'video' | 'design' | 'doc' | 'font';
export interface FolderFile { rel: string; kind: FileKind; size: number; mtime: string }

export class FolderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Store { v: 1; projects: Record<string, LinkedFolder[]> }
const storeFile = () => path.join(dataDir(), 'folders.json');
export const MAX_FOLDERS = 12;
export const MAX_FILES = 1500;
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Pods', 'DerivedData', 'build', 'dist', 'out', 'Temp', 'Logs', 'obj', 'vendor', '__pycache__', 'venv']);

const KINDS: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|webp|gif|svg|heic|avif)$/i, 'image'],
  [/\.(mp4|mov|m4v|webm)$/i, 'video'],
  [/\.(fig|sketch|psd|ai|xd|afdesign|kra|aseprite)$/i, 'design'],
  [/\.(md|markdown|txt|pdf)$/i, 'doc'],
  [/\.(ttf|otf|woff2?)$/i, 'font'],
];
export const kindOf = (name: string): FileKind | null => KINDS.find(([re]) => re.test(name))?.[1] ?? null;

async function readStore(): Promise<Store> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ storeFile(), 'utf8')) as Store;
    return j?.v === 1 && j.projects && typeof j.projects === 'object' ? j : { v: 1, projects: {} };
  } catch {
    return { v: 1, projects: {} };
  }
}
async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dataDir(), { recursive: true });
  const tmp = `${storeFile()}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(s, null, 2) + '\n');
  await fs.rename(tmp, storeFile());
}

export async function listFolders(projectId: string): Promise<LinkedFolder[]> {
  return (await readStore()).projects[projectId] ?? [];
}

const expand = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(/* turbopackIgnore: true */ os.homedir(), p.slice(2)) : p);

/** Refuses the disk root, the home folder itself and private system or credential folders. Exported for tests. */
export function unsafeFolderReason(real: string, home = os.homedir()): string | null {
  const r = path.resolve(real);
  if (r === '/' || r === path.resolve(home)) return 'Pick a project folder, not the whole disk or your home folder.';
  const rel = path.relative(home, r);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const top = inside ? rel.split(path.sep)[0]! : '';
  if (inside && (top.startsWith('.') || top === 'Library')) return 'That is a private system folder. Pick a project folder instead.';
  if (/^\/(System|private|etc|usr|bin|sbin|var|dev|Library)(\/|$)/.test(r)) return 'That is a system folder. Pick a project folder instead.';
  return null;
}

export async function linkFolder(projectId: string, input: string, label?: string): Promise<LinkedFolder> {
  const raw = expand(String(input ?? '').trim());
  if (!raw || !path.isAbsolute(raw)) throw new FolderError(400, 'Use a full folder path, like ~/Projects/my-game.');
  let real: string;
  try {
    real = await fs.realpath(/* turbopackIgnore: true */ raw);
    if (!(await fs.stat(/* turbopackIgnore: true */ real)).isDirectory()) throw new Error();
  } catch {
    throw new FolderError(404, 'That folder was not found on this machine.');
  }
  const bad = unsafeFolderReason(real);
  if (bad) throw new FolderError(400, bad);
  const s = await readStore();
  const list = s.projects[projectId] ?? [];
  const same = list.find((f) => f.path === real);
  if (same) return same;
  if (list.length >= MAX_FOLDERS) throw new FolderError(409, `Up to ${MAX_FOLDERS} folders per project.`);
  const f: LinkedFolder = { id: randomBytes(6).toString('hex'), path: real, label: (label ?? '').trim().slice(0, 60) || path.basename(real), addedAt: new Date().toISOString() };
  s.projects[projectId] = [...list, f];
  await writeStore(s);
  return f;
}

export async function unlinkFolder(projectId: string, id: string): Promise<boolean> {
  const s = await readStore();
  const list = s.projects[projectId] ?? [];
  if (!list.some((f) => f.id === id)) return false;
  s.projects[projectId] = list.filter((f) => f.id !== id);
  await writeStore(s);
  return true;
}

export async function getFolder(projectId: string, id: string): Promise<LinkedFolder> {
  const f = (await listFolders(projectId)).find((x) => x.id === id);
  if (!f) throw new FolderError(404, 'That folder is not linked to this project.');
  return f;
}

/** Media, design files and notes in a linked folder, newest first. Skips hidden and build folders. */
export async function listFiles(folder: LinkedFolder, maxDepth = 5): Promise<{ files: FolderFile[]; truncated: boolean; missing: boolean }> {
  const files: FolderFile[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number) => {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
      } else if (e.isFile()) {
        const kind = kindOf(e.name);
        if (!kind) continue;
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        try {
          const st = await fs.stat(/* turbopackIgnore: true */ p);
          files.push({ rel: path.relative(folder.path, p), kind, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* vanished */
        }
      }
    }
  };
  try {
    await fs.access(/* turbopackIgnore: true */ folder.path);
  } catch {
    return { files: [], truncated: false, missing: true };
  }
  await walk(folder.path, 0);
  files.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { files, truncated, missing: false };
}

/** Resolves a file inside a linked folder; refuses anything that escapes it (../ or symlinks). */
export async function resolveInside(folder: LinkedFolder, rel: string): Promise<string> {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) throw new FolderError(400, 'Bad file path.');
  const joined = path.resolve(folder.path, rel);
  let real: string;
  try {
    real = await fs.realpath(/* turbopackIgnore: true */ joined);
  } catch {
    throw new FolderError(404, 'File not found.');
  }
  const root = await fs.realpath(/* turbopackIgnore: true */ folder.path).catch(() => folder.path);
  const back = path.relative(root, real);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new FolderError(403, 'That file is outside the linked folder.');
  if (back.split(path.sep).some((s) => s.startsWith('.'))) throw new FolderError(403, 'Hidden files are not shown.');
  return real;
}
