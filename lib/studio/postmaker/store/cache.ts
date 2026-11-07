// The step cache. Key = sha256(JCS({kind, implVersion, connector, model, voiceId, settings, params,
// inputs sorted, packRefs sorted, seed})). The connector is part of the key, so a mock output never satisfies a live
// lookup. Index: cache/index.jsonl, last line per key wins; rebuilt from the version files when missing. A hit is only
// returned when its version still exists with the same hash.
import path from 'node:path';
import { PostmakerError } from '../errors';
import type { CacheEntry, CacheKeyInput } from '../types';
import { appendLine, exists, listDir, readJsonLines } from './fs';
import { withLock } from './mutex';
import { hashJson } from './objects';
import { cacheIndexFile, NODE_ID_RE, recipeDir, SHA_RE } from './paths';
import { listRecipeIds } from './recipes';
import { listVersions, readVersion } from './versions';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function cacheKey(input: CacheKeyInput): string {
  const inputs = [...input.inputs].map(([port, hash]) => [port, hash] as [string, string]).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const packRefs = [...input.packRefs].map((r) => ({ ref: r.ref, sha256: r.sha256 })).sort((a, b) => cmp(a.ref, b.ref) || cmp(a.sha256, b.sha256));
  return hashJson({
    kind: input.kind,
    implVersion: input.implVersion,
    connector: input.connector,
    model: input.model ?? null,
    voiceId: input.voiceId ?? null,
    settings: input.settings ?? {},
    params: input.params ?? {},
    inputs,
    packRefs,
    seed: input.seed ?? null,
  });
}

const lockKey = (root: string) => `pm-cache:${cacheIndexFile(root)}`;

function validEntry(e: CacheEntry): void {
  if (!SHA_RE.test(e.key) || !SHA_RE.test(e.hash) || !NODE_ID_RE.test(e.nodeId) || !Number.isInteger(e.version) || e.version < 1) {
    throw new PostmakerError(400, 'validation', 'Not a valid cache entry.');
  }
}

export function recordCache(root: string, entry: Omit<CacheEntry, 'at'> & { at?: string }): Promise<void> {
  const e: CacheEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  validEntry(e);
  return withLock(lockKey(root), () => appendLine(cacheIndexFile(root), JSON.stringify(e)));
}

/** Rebuilds the index from every `ok` step version on disk (oldest first, so the newest wins). */
export function rebuildCacheIndex(root: string, o: { onlyIfMissing?: boolean } = {}): Promise<number> {
  return withLock(lockKey(root), async () => {
    if (o.onlyIfMissing && (await exists(cacheIndexFile(root)))) return 0;
    const entries: CacheEntry[] = [];
    for (const recipeId of await listRecipeIds(root)) {
      for (const nodeId of await listDir(path.join(recipeDir(root, recipeId), 'steps'))) {
        if (!NODE_ID_RE.test(nodeId)) continue;
        const versions = await listVersions(root, recipeId, nodeId).catch(() => []); // a damaged node is skipped, not fatal
        for (const v of versions) {
          if (v.status === 'ok' && SHA_RE.test(v.key)) entries.push({ key: v.key, recipeId, nodeId, version: v.n, hash: v.hash, at: v.createdAt });
        }
      }
    }
    entries.sort((a, b) => cmp(a.at, b.at));
    for (const e of entries) await appendLine(cacheIndexFile(root), JSON.stringify(e));
    return entries.length;
  });
}

/** The newest live entry for `key`, or null. Entries whose version vanished or changed are skipped. */
export async function lookupCache(root: string, key: string): Promise<CacheEntry | null> {
  if (!(await exists(cacheIndexFile(root)))) await rebuildCacheIndex(root, { onlyIfMissing: true });
  const lines = await readJsonLines<CacheEntry>(cacheIndexFile(root));
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i]!;
    if (e.key !== key) continue;
    try {
      validEntry(e);
      const v = await readVersion(root, e.recipeId, e.nodeId, e.version);
      if (v && v.hash === e.hash && v.key === key && v.status === 'ok') return e;
    } catch {
      // a stale or damaged entry is a miss
    }
  }
  return null;
}
