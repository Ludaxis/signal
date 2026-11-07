// Committing a new step version: allocate the next number, write the version once, then (optionally) move the head.
// The version file is on disk before the head can point at it; a crash in between leaves an unreferenced version,
// never a head pointing at nothing.
import { PostmakerError } from '../errors';
import type { StepHead, StepVersion, StepVersionDraft } from '../types';
import { nodeLockKey, patchHeadLocked, readHead } from './heads';
import { withLock } from './mutex';
import { assertNodeId, assertRecipeId } from './paths';
import { listVersionNumbers, STEP_VERSION_SCHEMA, versionHash, writeVersion } from './versions';

export interface CommitResult {
  version: StepVersion;
  head: StepHead;
}

/**
 * Writes `draft` as version n+1 of its node. Refuses a locked node (409, "Unlock to regenerate"): the runner never
 * writes to a locked node. `makeCurrent` defaults to true, except for a `candidate` (a contract break waits for
 * the user's choice and never becomes current by itself).
 */
export function commitVersion(root: string, draft: StepVersionDraft, o: { makeCurrent?: boolean; now?: number } = {}): Promise<CommitResult> {
  assertRecipeId(draft.recipeId);
  const kind = assertNodeId(draft.nodeId);
  return withLock(nodeLockKey(root, draft.recipeId, draft.nodeId), async () => {
    const head = await readHead(root, draft.recipeId, draft.nodeId);
    if (head.locked) throw new PostmakerError(409, 'locked', 'Unlock to regenerate');
    const numbers = await listVersionNumbers(root, draft.recipeId, draft.nodeId);
    const n = (numbers.at(-1) ?? 0) + 1;
    const now = o.now ?? Date.now();
    const { createdAt, ...rest } = draft;
    const body: Omit<StepVersion, 'hash'> = { schema: STEP_VERSION_SCHEMA, ...rest, n, createdAt: createdAt ?? new Date(now).toISOString() };
    if (!body.implVersion.startsWith(`${kind}@`)) throw new PostmakerError(400, 'validation', `implVersion must be ${kind}@<n>.`);
    const version: StepVersion = { ...body, hash: versionHash(body) };
    await writeVersion(root, version);
    const makeCurrent = o.makeCurrent ?? version.status !== 'candidate';
    const nextHead = makeCurrent ? await patchHeadLocked(root, draft.recipeId, draft.nodeId, { current: n }, { now }) : head;
    return { version, head: nextHead };
  });
}
