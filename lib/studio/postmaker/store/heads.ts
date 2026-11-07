// Step heads: steps/<nodeId>/head.json, the only mutable file per node. A head is a pointer, never a copy.
// Every write checks that the version it points at exists and is intact, so a head can never name a missing version.
import { PostmakerError } from '../errors';
import type { StepHead } from '../types';
import { checkSchema, pretty, readJsonFile, writeReplace } from './fs';
import { withLock } from './mutex';
import { headFile, stepDir } from './paths';
import { readVersion } from './versions';

export const STEP_HEAD_SCHEMA = 'signal.pm.step-head/1' as const;

/** Store-internal per-node lock (separate from the engine's recipe mutex, so the engine can call the store inside it). */
export const nodeLockKey = (root: string, recipeId: string, nodeId: string) => `pm-node:${stepDir(root, recipeId, nodeId)}`;

export const emptyHead = (now = Date.now()): StepHead => ({
  schema: STEP_HEAD_SCHEMA,
  current: null,
  locked: false,
  lockedBy: null,
  lockedAt: null,
  skipped: false,
  pinnedBeats: [],
  updatedAt: new Date(now).toISOString(),
});

export async function readHead(root: string, recipeId: string, nodeId: string): Promise<StepHead> {
  const h = await readJsonFile<StepHead>(headFile(root, recipeId, nodeId));
  if (!h) return emptyHead(0);
  checkSchema(h, 'step-head', 1);
  return h;
}

export type HeadPatch = Partial<Pick<StepHead, 'current' | 'locked' | 'lockedBy' | 'lockedAt' | 'skipped' | 'pinnedBeats'>>;

/** Applies a patch while the caller holds the node lock. Exported for commit.ts only. */
export async function patchHeadLocked(root: string, recipeId: string, nodeId: string, patch: HeadPatch, o: { now?: number; allowCandidate?: boolean } = {}): Promise<StepHead> {
  const head = await readHead(root, recipeId, nodeId);
  if (patch.current !== undefined && patch.current !== null) {
    const v = await readVersion(root, recipeId, nodeId, patch.current);
    if (!v) throw new PostmakerError(404, 'version-missing', `Version ${patch.current} of ${nodeId} does not exist.`);
    if (v.status === 'candidate' && !o.allowCandidate) throw new PostmakerError(409, 'candidate', 'Choose or discard this candidate first.');
  }
  if (patch.pinnedBeats && !patch.pinnedBeats.every((b) => typeof b === 'string' && /^b\d{2,3}$/.test(b))) {
    throw new PostmakerError(400, 'validation', 'Pinned beats must be beat ids.');
  }
  const next: StepHead = { ...head, ...patch, schema: STEP_HEAD_SCHEMA, updatedAt: new Date(o.now ?? Date.now()).toISOString() };
  await writeReplace(headFile(root, recipeId, nodeId), pretty(next));
  return next;
}

export function updateHead(root: string, recipeId: string, nodeId: string, patch: HeadPatch, o: { now?: number; allowCandidate?: boolean } = {}): Promise<StepHead> {
  return withLock(nodeLockKey(root, recipeId, nodeId), () => patchHeadLocked(root, recipeId, nodeId, patch, o));
}

/** "Use this version": moves the pointer; `null` clears it. */
export const setCurrent = (root: string, recipeId: string, nodeId: string, n: number | null, o: { now?: number; allowCandidate?: boolean } = {}) =>
  updateHead(root, recipeId, nodeId, { current: n }, o);

export const lockStep = (root: string, recipeId: string, nodeId: string, by: string, now = Date.now()) =>
  updateHead(root, recipeId, nodeId, { locked: true, lockedBy: by, lockedAt: new Date(now).toISOString() }, { now });

export const unlockStep = (root: string, recipeId: string, nodeId: string, now = Date.now()) =>
  updateHead(root, recipeId, nodeId, { locked: false, lockedBy: null, lockedAt: null }, { now });

export const setSkipped = (root: string, recipeId: string, nodeId: string, skipped: boolean, now = Date.now()) =>
  updateHead(root, recipeId, nodeId, { skipped }, { now });
