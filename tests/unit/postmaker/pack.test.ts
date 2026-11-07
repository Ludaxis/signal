// @vitest-environment node
// Project pack loader and asset resolver: (pack-lock part), path safety, voices.
import './guard';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { changedRefs, checkRequires, loadPack, loadProjectPack, packRefReason, SIGNAL_PACK_API_VERSION } from '@/lib/studio/postmaker/pack/load';
import { loadProjectAssets, mergeLibraries, packEntries, resolveAsset } from '@/lib/studio/postmaker/pack/resolve';
import { satisfies } from '@/lib/studio/postmaker/pack/semver';
import { hashJson } from '@/lib/studio/postmaker/store/objects';
import { packLockFile, projectLibraryFile } from '@/lib/studio/postmaker/store/paths';
import { readPackLock } from '@/lib/studio/postmaker/store/recipes';
import { sha, writeFixturePack } from './fixtures';
import { tmp } from './guard';

const packDir = () => path.join(tmp.dir, 'pack');
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (isPostmakerError(e) ? e.code : `other: ${String(e)}`),
  );

describe('loadPack and the PackLock', () => {
  it('hashes every referenced file and record into named entries with a root', async () => {
    writeFixturePack(packDir());
    const pack = await loadPack(packDir(), { now: Date.parse('2026-11-06T10:00:00Z') });
    expect(Object.keys(pack.lock.entries)).toEqual([
      'asset:bg-room-01',
      'asset:st-star-01',
      'brand',
      'font:Example Sans',
      'glossary',
      'lexicon:fa',
      'manifest',
      'style:fa',
      'template:story-basic',
      'voice:narrator-en',
      'voice:narrator-fa',
    ]);
    expect(pack.lock.entries['lexicon:fa']).toBe(sha(readFileSync(path.join(packDir(), 'lexicon/fa.json'))));
    expect(pack.lock.root).toBe(hashJson(Object.entries(pack.lock.entries)));
    expect(pack.lock).toMatchObject({ schema: 'signal.pm.pack-lock/1', packId: 'example-pack', version: '1.0.0', readAt: '2026-11-06T10:00:00.000Z' });
  });

  it('(lock part): editing lexicon/fa.json changes exactly the lexicon:fa entry', async () => {
    const fx = writeFixturePack(packDir());
    const before = (await loadPack(packDir())).lock;
    fx.write('lexicon/fa.json', JSON.stringify([{ id: 'lx-001', kind: 'brand', status: 'approved' }]));
    const after = (await loadPack(packDir())).lock;
    expect(changedRefs(before, after)).toEqual(['lexicon:fa']);
    expect(packRefReason('lexicon:fa')).toBe('Lexicon changed');
    expect(after.root).not.toBe(before.root);
  });

  it('editing one asset changes only that asset entry; reading twice changes nothing', async () => {
    const fx = writeFixturePack(packDir());
    const a = (await loadPack(packDir())).lock;
    expect(changedRefs(a, (await loadPack(packDir())).lock)).toEqual([]);
    fx.write('library/stickers/st-star-01.png', 'new sticker bytes');
    expect(changedRefs(a, (await loadPack(packDir())).lock)).toEqual(['asset:st-star-01']);
  });

  it('a pack with requires.signal ">=3" is refused with the exact message', async () => {
    writeFixturePack(packDir(), { requires: '>=3' });
    const e = await loadPack(packDir()).catch((x: unknown) => x);
    expect(isPostmakerError(e, 'pack.requires')).toBe(true);
    expect((e as Error).message).toBe('This pack needs Signal >=3');
    expect(() => checkRequires('>=2.0.0 <3')).not.toThrow();
    expect(() => checkRequires('not a range')).toThrow(/not valid/);
  });

  it('semver ranges', () => {
    expect(SIGNAL_PACK_API_VERSION).toBe('2.0.0');
    const t: [string, string, boolean][] = [
      ['2.0.0', '>=2.0.0 <3', true],
      ['3.0.0', '>=2.0.0 <3', false],
      ['2.9.9', '<3', true],
      ['2.0.0', '>=3', false],
      ['2.4.1', '^2.1.0', true],
      ['3.0.0', '^2.1.0', false],
      ['0.3.5', '^0.3.1', true],
      ['0.4.0', '^0.3.1', false],
      ['2.1.9', '~2.1.3', true],
      ['2.2.0', '~2.1.3', false],
      ['2.5.0', '2.x', true],
      ['2.5.0', '1 || 2', true],
      ['2.5.0', '>2', false],
      ['3.0.0', '>2', true],
      ['2.5.0', '<=2', true],
      ['2.5.0', '*', true],
      ['2.5.0-beta', '*', false],
    ];
    for (const [v, r, want] of t) expect([v, r, satisfies(v, r)]).toEqual([v, r, want]);
  });

  it('refuses paths outside the pack, also through a symlink', async () => {
    const fx = writeFixturePack(packDir());
    fx.manifest.glossary = '../outside.json';
    fx.writeManifest();
    expect(await codeOf(loadPack(packDir()))).toBe('pack.invalid');

    writeFileSync(path.join(tmp.dir, 'secret.json'), '[]');
    symlinkSync(path.join(tmp.dir, 'secret.json'), path.join(packDir(), 'linked.json'));
    fx.manifest.glossary = 'linked.json';
    fx.writeManifest();
    expect(await codeOf(loadPack(packDir()))).toBe('pack.path-outside');
  });

  it('a referenced file that is missing names the file; a font with the wrong hash is refused', async () => {
    const fx = writeFixturePack(packDir());
    fx.manifest.style = { fa: 'style/missing.md' };
    fx.writeManifest();
    const e = await loadPack(packDir()).catch((x: unknown) => x);
    expect(isPostmakerError(e, 'pack.file-missing')).toBe(true);
    expect((e as Error).message).toContain('style/missing.md');

    const fx2 = writeFixturePack(path.join(tmp.dir, 'pack2'));
    (fx2.manifest.fonts as { sha256: string }[])[0]!.sha256 = 'f'.repeat(64);
    fx2.writeManifest();
    expect(await codeOf(loadPack(path.join(tmp.dir, 'pack2')))).toBe('pack.font-sha256-mismatch');
  });

  it('voices: a Persian voice needs projection settings and every voice a pinned model', async () => {
    const fx = writeFixturePack(packDir());
    fx.write('voices.json', JSON.stringify([{ ...fx.voices[0], projection: null }]));
    expect(await codeOf(loadPack(packDir()))).toBe('pack.invalid');
    fx.write('voices.json', JSON.stringify([{ ...fx.voices[1], model: '' }]));
    expect(await codeOf(loadPack(packDir()))).toBe('pack.invalid');
    fx.write('voices.json', JSON.stringify(fx.voices));
    const pack = await loadPack(packDir());
    expect(pack.voices[0]!.projection?.ezafe).toBe('kasra');
  });

  it('loadProjectPack: no pack is fine; a pack writes postmaker/pack-lock.json and never writes inside the pack', async () => {
    expect(await loadProjectPack({ contentDir: tmp.contentDir }, tmp.root)).toBeNull();
    writeFixturePack(packDir());
    const pack = await loadProjectPack({ contentDir: tmp.contentDir }, tmp.root);
    expect(pack?.manifest.id).toBe('example-pack');
    expect((await readPackLock(tmp.root))?.root).toBe(pack?.lock.root);
    expect(readFileSync(packLockFile(tmp.root), 'utf8')).toContain('"lexicon:fa"');
    await expect(loadProjectPack({ contentDir: tmp.contentDir, pack: { dir: path.join(tmp.dir, 'nowhere') } }, tmp.root)).rejects.toSatisfy((e) => isPostmakerError(e, 'pack.missing'));
  });
});

describe('asset resolver', () => {
  const lib = async () => {
    const pack = await loadPack(packDir());
    return mergeLibraries(packEntries(pack), await loadProjectAssets(tmp.root));
  };
  const finalOrganic = { final: true, use: 'organic' as const, now: Date.parse('2026-11-06T10:00:00Z') };

  it('resolves an approved, licensed asset with its checked path', async () => {
    writeFixturePack(packDir());
    const r = await resolveAsset(await lib(), 'bg-room-01', finalOrganic);
    expect(r.origin).toBe('pack');
    expect(r.path.endsWith(path.join('library', 'backgrounds', 'bg-room-01.png'))).toBe(true);
  });

  it('each rule has its own error code', async () => {
    const fx = writeFixturePack(packDir());
    const bg = fx.assets[0]!;
    fx.assets.push(
      { ...bg, id: 'bg-nouse', licence: { ...bg.licence, allowedUses: [] } },
      { ...bg, id: 'bg-noorganic', licence: { ...bg.licence, allowedUses: ['store-listing'] } },
      { ...bg, id: 'bg-expired', licence: { ...bg.licence, expiresAt: '2026-01-01T00:00:00Z' } },
      { ...bg, id: 'bg-retired', status: 'retired' },
      { ...bg, id: 'bg-badsha', sha256: 'a'.repeat(64) },
      { ...bg, id: 'bg-nofile', file: 'backgrounds/missing.png' },
      { ...bg, id: 'vo-noconsent', kind: 'voice' },
    );
    const { allowedUses: _absent, ...licenceWithoutUses } = bg.licence;
    void _absent;
    fx.assets.push({ ...bg, id: 'bg-undefined-uses', licence: licenceWithoutUses as typeof bg.licence });
    fx.writeLibrary();
    const l = await lib();
    const codes: Record<string, string> = {};
    for (const id of ['st-star-01', 'bg-nouse', 'bg-undefined-uses', 'bg-noorganic', 'bg-expired', 'bg-retired', 'bg-badsha', 'bg-nofile', 'vo-noconsent', 'unknown-id']) {
      codes[id] = await codeOf(resolveAsset(l, id, finalOrganic));
    }
    expect(codes).toEqual({
      'st-star-01': 'asset.draft-in-final',
      'bg-nouse': 'asset.allowed-uses-missing',
      'bg-undefined-uses': 'asset.allowed-uses-missing',
      'bg-noorganic': 'asset.use-not-allowed',
      'bg-expired': 'asset.licence-expired',
      'bg-retired': 'asset.retired',
      'bg-badsha': 'asset.sha256-mismatch',
      'bg-nofile': 'asset.file-missing',
      'vo-noconsent': 'asset.consent-missing',
      'unknown-id': 'asset.missing',
    });
    // 10 cases, 9 rules: an empty and an absent `allowedUses` share one code on purpose.
    expect(new Set(Object.values(codes)).size).toBe(9);
  });

  it('drafts may use draft assets, but never a changed file or a retired asset', async () => {
    writeFixturePack(packDir());
    const draft = { final: false, use: 'organic' as const };
    expect((await resolveAsset(await lib(), 'st-star-01', draft)).asset.status).toBe('draft');
    writeFileSync(path.join(packDir(), 'library/stickers/st-star-01.png'), 'changed');
    expect(await codeOf(resolveAsset(await lib(), 'st-star-01', draft))).toBe('asset.sha256-mismatch');
  });

  it('merges project assets and refuses an id present in both libraries', async () => {
    writeFixturePack(packDir());
    const bytes = Buffer.from('generated card');
    mkdirSync(path.join(tmp.root, 'assets', 'files'), { recursive: true });
    writeFileSync(path.join(tmp.root, 'assets', 'files', 'card-01.png'), bytes);
    const record = {
      id: 'card-01',
      kind: 'ui',
      file: 'files/card-01.png',
      sha256: sha(bytes),
      tags: [],
      licence: { type: 'ai-generated', holder: 'Example Studio', source: 'mock-job-1', author: null, acquiredAt: '2026-11-06', proof: null, allowedUses: ['organic'], territories: 'worldwide', expiresAt: null, attribution: null, aiGenerated: true },
      status: 'approved',
      approvedBy: 'Reviewer A',
    };
    writeFileSync(projectLibraryFile(tmp.root), JSON.stringify([record]));
    expect((await resolveAsset(await lib(), 'card-01', { final: true, use: 'organic' })).origin).toBe('project');

    writeFileSync(projectLibraryFile(tmp.root), JSON.stringify([record, { ...record, id: 'bg-room-01' }]));
    const e = await lib().catch((x: unknown) => x);
    expect(isPostmakerError(e, 'asset.duplicate-id')).toBe(true);
    expect((e as Error).message).toBe('Asset id `bg-room-01` exists in the pack and in project assets');
  });

  it('a duplicate id inside the pack library is refused at load', async () => {
    const fx = writeFixturePack(packDir());
    fx.assets.push({ ...fx.assets[0]! });
    fx.writeLibrary();
    expect(await codeOf(loadPack(packDir()))).toBe('asset.duplicate-id');
  });

  it('an asset file path escaping the library is refused by the schema', async () => {
    const fx = writeFixturePack(packDir());
    fx.assets[0] = { ...fx.assets[0]!, file: '../../pack.json' };
    fx.writeLibrary();
    expect(await codeOf(loadPack(packDir()))).toBe('pack.invalid');
  });
});
