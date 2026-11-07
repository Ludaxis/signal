// @vitest-environment node
// Cache-key stability: same inputs → same key, whatever the order of inputs and pack refs; any param, seed or
// connector change → a new key; the index survives deletion of its file (rebuilt from versions).
import './guard';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cacheKey, lookupCache, rebuildCacheIndex, recordCache } from '@/lib/studio/postmaker/store/cache';
import { commitVersion } from '@/lib/studio/postmaker/store/commit';
import { cacheIndexFile } from '@/lib/studio/postmaker/store/paths';
import type { CacheKeyInput } from '@/lib/studio/postmaker/types';
import { versionDraft } from './fixtures';
import { tmp } from './guard';

const H = (c: string) => c.repeat(64);
const input = (o: Partial<CacheKeyInput> = {}): CacheKeyInput => ({
  kind: 'captions',
  implVersion: 'captions@2',
  connector: 'local',
  model: null,
  voiceId: null,
  settings: { maxWords: 5, minMs: 800 },
  params: { style: 'word-pop', lines: 2 },
  inputs: [
    ['lines', H('a')],
    ['alignment', H('b')],
  ],
  packRefs: [
    { ref: 'font:Example Sans', sha256: H('c') },
    { ref: 'lexicon:fa', sha256: H('d') },
  ],
  seed: null,
  ...o,
});

describe('cache key stability', () => {
  it('same inputs → same key, independent of key, input and pack-ref order', () => {
    const k = cacheKey(input());
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(input())).toBe(k);
    const shuffled = input({
      settings: { minMs: 800, maxWords: 5 },
      params: { lines: 2, style: 'word-pop' },
      inputs: [
        ['alignment', H('b')],
        ['lines', H('a')],
      ],
      packRefs: [
        { sha256: H('d'), ref: 'lexicon:fa' },
        { ref: 'font:Example Sans', sha256: H('c') },
      ],
    });
    expect(cacheKey(shuffled)).toBe(k);
  });

  it('a param, setting, input, pack ref, seed, model, connector or implementation change → a new key', () => {
    const k = cacheKey(input());
    const variants = [
      input({ params: { style: 'word-pop', lines: 1 } }),
      input({ settings: { maxWords: 4, minMs: 800 } }),
      input({ inputs: [['lines', H('e')], ['alignment', H('b')]] }),
      input({ packRefs: [{ ref: 'lexicon:fa', sha256: H('f') }, { ref: 'font:Example Sans', sha256: H('c') }] }),
      input({ seed: 2 }),
      input({ model: 'model-b' }),
      input({ voiceId: 'voice-b' }),
      input({ connector: 'mock' }), // mock output never satisfies a live lookup
      input({ implVersion: 'captions@3' }),
      input({ kind: 'compose' }),
    ];
    const keys = variants.map(cacheKey);
    expect(keys).not.toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cache index', () => {
  const RC = 'rc-20261106-77b2';
  it('records and looks up the newest live entry', async () => {
    const key = cacheKey(input());
    const v1 = (await commitVersion(tmp.root, versionDraft(RC, 'captions:fa', { key }))).version;
    await recordCache(tmp.root, { key, recipeId: RC, nodeId: 'captions:fa', version: v1.n, hash: v1.hash });
    const v2 = (await commitVersion(tmp.root, versionDraft(RC, 'captions:fa', { key, note: 'second' }))).version;
    await recordCache(tmp.root, { key, recipeId: RC, nodeId: 'captions:fa', version: v2.n, hash: v2.hash });
    expect(await lookupCache(tmp.root, key)).toMatchObject({ version: 2, hash: v2.hash });
    expect(await lookupCache(tmp.root, cacheKey(input({ seed: 9 })))).toBeNull();
  });

  it('an entry whose version hash does not match is a miss', async () => {
    const key = cacheKey(input());
    const v1 = (await commitVersion(tmp.root, versionDraft(RC, 'captions:fa', { key }))).version;
    await recordCache(tmp.root, { key, recipeId: RC, nodeId: 'captions:fa', version: v1.n, hash: H('0') });
    await recordCache(tmp.root, { key, recipeId: RC, nodeId: 'captions:fa', version: 7, hash: v1.hash });
    expect(await lookupCache(tmp.root, key)).toBeNull();
  });

  it('is rebuilt from the version files when index.jsonl is missing', async () => {
    const key = cacheKey(input());
    await commitVersion(tmp.root, versionDraft(RC, 'captions:en', { key }));
    await commitVersion(tmp.root, versionDraft(RC, 'captions:en', { key: cacheKey(input({ seed: 3 })), status: 'failed' }));
    rmSync(cacheIndexFile(tmp.root), { force: true });
    expect(await lookupCache(tmp.root, key)).toMatchObject({ recipeId: RC, nodeId: 'captions:en', version: 1 });
    expect(await lookupCache(tmp.root, cacheKey(input({ seed: 3 })))).toBeNull(); // failed versions are never cached
    expect(await rebuildCacheIndex(tmp.root, { onlyIfMissing: true })).toBe(0);
  });
});
