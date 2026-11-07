// Step versions: steps/<nodeId>/v<n>.json, written once, hashed over their canonical JSON. A version may only
// reference objects that are already stored, so a version on disk always has every byte it names.
import { PostmakerError } from '../errors';
import type { StepVersion } from '../types';
import { checkSchema, listDir, pretty, readJsonFile, writeOnce } from './fs';
import { hasObject, hashJson } from './objects';
import { stepDir, stepVersionFile, VERSION_FILE_RE } from './paths';

export const STEP_VERSION_SCHEMA = 'signal.pm.step-version/1' as const;

/** sha256(JCS(version without `hash`)). */
export function versionHash(v: Omit<StepVersion, 'hash'> & { hash?: string }): string {
  const { hash: _drop, ...rest } = v;
  void _drop;
  return hashJson(rest);
}

/** Writes a complete version. Refuses (409) when that version number exists, whatever the content. */
export async function writeVersion(root: string, v: StepVersion): Promise<void> {
  checkSchema(v, 'step-version', 1);
  if (versionHash(v) !== v.hash) throw new PostmakerError(400, 'version-hash', 'The version hash does not match its content.');
  for (const o of v.outputs) {
    if (!(await hasObject(root, o.sha256))) throw new PostmakerError(409, 'object-missing', `Output ${o.name} is not saved yet.`);
  }
  await writeOnce(stepVersionFile(root, v.recipeId, v.nodeId, v.n), pretty(v));
}

/** Reads one version, re-checking its hash; null when it does not exist. */
export async function readVersion(root: string, recipeId: string, nodeId: string, n: number): Promise<StepVersion | null> {
  const v = await readJsonFile<StepVersion>(stepVersionFile(root, recipeId, nodeId, n));
  if (!v) return null;
  checkSchema(v, 'step-version', 1);
  if (v.recipeId !== recipeId || v.nodeId !== nodeId || v.n !== n || versionHash(v) !== v.hash) {
    throw new PostmakerError(409, 'version-changed', `Version ${n} of ${nodeId} has changed on disk.`);
  }
  return v;
}

/** Version numbers present for a node, ascending. */
export async function listVersionNumbers(root: string, recipeId: string, nodeId: string): Promise<number[]> {
  const out: number[] = [];
  for (const f of await listDir(stepDir(root, recipeId, nodeId))) {
    const m = VERSION_FILE_RE.exec(f);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

export async function listVersions(root: string, recipeId: string, nodeId: string): Promise<StepVersion[]> {
  const out: StepVersion[] = [];
  for (const n of await listVersionNumbers(root, recipeId, nodeId)) {
    const v = await readVersion(root, recipeId, nodeId, n);
    if (v) out.push(v);
  }
  return out;
}
