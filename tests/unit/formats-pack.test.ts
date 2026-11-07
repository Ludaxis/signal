// Built-in formats, project packs (formats.json and the pack.json manifest) and the project wizard's
// time zone and pack fields.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANY_PROJECT_FORMATS, BRIEF_FORMATS, FORMAT_LABEL, FORMATS, HEADLINE_FORMATS, HIGGSFIELD_FORMATS, applyPackFormats, formatSetFor, loadPackFormats, packLine } from '@/lib/studio/formats';
import * as generate from '@/lib/studio/generate';
import { packAssets, packAssetsShape, packDir, packFile } from '@/lib/studio/pack';
import { checkNewProject, createProject, listProjects } from '@/lib/studio/projects';

let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-formats-'));
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'projects.json');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SIGNAL_PROJECTS_FILE;
});

describe('built-in formats', () => {
  it('lists the four generic formats and generate.ts re-exports the same records', () => {
    expect([...FORMATS]).toEqual(['website-card', 'codex-post', 'higgsfield-image', 'higgsfield-reel']);
    expect(ANY_PROJECT_FORMATS).toEqual([...FORMATS]);
    expect(BRIEF_FORMATS).toEqual(['codex-post', 'higgsfield-image', 'higgsfield-reel']);
    expect(HEADLINE_FORMATS).toEqual(['codex-post', 'higgsfield-image']);
    expect(HIGGSFIELD_FORMATS).toEqual(['higgsfield-image', 'higgsfield-reel']);
    expect(FORMAT_LABEL['website-card']).toBe('Website post');
    expect(generate.FORMATS).toBe(FORMATS);
    expect(generate.FORMAT_LABEL).toBe(FORMAT_LABEL);
    expect(generate.hashtag("Fish & Chips' Shop")).toBe('#FishAndChipsShop');
  });

  it('the default lines make no store or availability claim', () => {
    const set = formatSetFor({ name: 'Example' });
    expect(set.lines).toEqual({});
    const claim = /google play|app store|play store|steam|now on|available|download|install/i;
    expect(packLine(set, 'store')).toBe('Link in bio');
    expect(packLine(set, 'cta')).toBe('Example · link in bio');
    for (const k of ['store', 'cta'] as const) expect(packLine(set, k)).not.toMatch(claim);
  });
});

describe('project packs', () => {
  async function projectWithPack(pack: string) {
    writeFileSync(process.env.SIGNAL_PROJECTS_FILE!, JSON.stringify({ projects: [{ id: 'fixture', name: 'Example', handle: '@fixture.account', uploadPostProfile: '', contentDir: path.join(root, 'posts'), createdAt: '2026-01-01T00:00:00.000Z', pack: { dir: pack } }] }));
    return (await listProjects())[0]!;
  }

  it('reads labels and lines from <pack>/formats.json and reports what it ignores', async () => {
    const pack = path.join(root, 'pack');
    mkdirSync(pack);
    writeFileSync(path.join(pack, 'formats.json'), JSON.stringify({
      schema: 'signal.formats/1',
      labels: { 'codex-post': 'Illustration', nope: 'x' },
      lines: { store: 'Now in the Example store', cta: '{name} is in the Example store. Link in bio.', price: 'free', empty: '' },
      rotation: ['codex-post'],
    }));
    const p = await projectWithPack(pack);
    expect(packDir(p)).toBe(pack);
    const set = await loadPackFormats(p);
    expect(set.from).toBe('pack');
    expect(set.labels['codex-post']).toBe('Illustration');
    expect(set.lines).toEqual({ store: 'Now in the Example store', cta: '{name} is in the Example store. Link in bio.' });
    expect(set.problems).toEqual(['labels.nope is not used.', 'lines.price is not used.', 'lines.empty is not used.', 'rotation is not used.']);
    expect(packLine(set, 'cta')).toBe('Example is in the Example store. Link in bio.');
    // A newer or unknown schema is never half-applied.
    expect(applyPackFormats(formatSetFor(p), { schema: 'signal.formats/2', labels: { 'codex-post': 'x' } })).toMatchObject({ labels: FORMAT_LABEL, problems: ['formats.json was made by a newer Signal.'] });
    expect(applyPackFormats(formatSetFor(p), { lines: ['Now on a store'] })).toMatchObject({ lines: {}, problems: ['lines is not used.'] });
    expect(applyPackFormats(formatSetFor(p), { claims: { storeLine: 'x' } })).toMatchObject({ lines: {}, problems: ['claims is now "lines" (store, cta).'] });
    // Bad JSON and a missing file.
    writeFileSync(path.join(pack, 'formats.json'), '{');
    expect((await loadPackFormats(p)).problems).toEqual(['formats.json is not valid JSON.']);
    rmSync(path.join(pack, 'formats.json'));
    expect((await loadPackFormats(p)).from).toBe('built-in');
    expect((await loadPackFormats({ name: 'No pack' })).from).toBe('built-in');
  });

  it('pack files stay inside the pack folder', () => {
    const pack = path.join(root, 'pack');
    expect(packFile(pack, '../outside.png')).toBeNull();
    expect(packFile(pack, '/etc/passwd')).toBeNull();
    expect(packFile(pack, 'fonts/Display-Regular.ttf')).toBe(path.join(pack, 'fonts/Display-Regular.ttf'));
    expect(packDir({ pack: { dir: 'relative/pack' } })).toBeNull();
  });

  it('packAssets reads the manifest: the first Latin face and the one app-icon asset, both pinned', async () => {
    const pack = path.join(root, 'pack-manifest');
    mkdirSync(path.join(pack, 'library/fonts/Face'), { recursive: true });
    mkdirSync(path.join(pack, 'library/ui'), { recursive: true });
    const fontBytes = Buffer.from('not a real font, only pinned bytes');
    const png = Buffer.from('not a real png, only pinned bytes');
    writeFileSync(path.join(pack, 'library/fonts/Face/Face-Black.ttf'), fontBytes);
    writeFileSync(path.join(pack, 'library/fonts/Face/OFL.txt'), 'SIL Open Font License 1.1\n');
    writeFileSync(path.join(pack, 'library/ui/icon.png'), png);
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    const font = (o: Record<string, unknown> = {}) => ({ family: 'Face', file: 'library/fonts/Face/Face-Black.ttf', sha256: sha(fontBytes), licence: 'library/fonts/Face/OFL.txt', scripts: ['latin'], weights: [900], ...o });
    const icon = (o: Record<string, unknown> = {}) => ({ id: 'app-icon', kind: 'ui', file: 'ui/icon.png', sha256: sha(png), tags: ['app-icon'], status: 'approved', approvedBy: 'owner', ...o });
    const write = (fonts: unknown[], library: unknown[]) => {
      writeFileSync(path.join(pack, 'library/library.json'), JSON.stringify(library));
      writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ schema: 'signal.pack/1', library: 'library/library.json', fonts }));
    };
    const at = { pack: { dir: pack } };
    write([font({ family: 'Naskh', scripts: ['arabic'] }), font({ family: 'Web', file: 'library/fonts/Face/Face.woff2' }), font()], [icon()]);
    expect(await packAssets(at)).toEqual({ font: path.join(pack, 'library/fonts/Face/Face-Black.ttf'), fontLicence: 'Face, licence file library/fonts/Face/OFL.txt', icon: path.join(pack, 'library/ui/icon.png') });
    expect(await packAssetsShape(at)).toBe('manifest');
    // A wrong pin gives nothing for that asset; two app icons are a guess, so none.
    write([font({ sha256: '0'.repeat(64) })], [icon(), icon({ id: 'second' })]);
    expect(await packAssets(at)).toEqual({ font: null, fontLicence: null, icon: null });
    // The older shape is not read and is reported.
    writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ schema: 'signal.pack/1', fonts: { display: 'library/fonts/Face/Face-Black.ttf' }, icon: 'library/ui/icon.png' }));
    expect(await packAssets(at)).toEqual({ font: null, fontLicence: null, icon: null });
    expect(await packAssetsShape(at)).toBe('removed');
    expect(await packAssetsShape({})).toBe('none');
  });
});

describe('the project wizard', () => {
  it('keeps a valid time zone and pack folder and refuses bad ones', async () => {
    const base = { name: 'Example', handle: '@fixture.account', uploadPostProfile: '', contentDir: path.join(root, 'posts') };
    expect(await checkNewProject({ ...base, timeZone: 'Mars/Olympus', packDir: 'relative' })).toMatchObject({ timeZone: expect.any(String), packDir: expect.any(String) });
    const p = await createProject({ ...base, timeZone: 'Asia/Tehran', packDir: path.join(root, 'pack') });
    expect(p).toMatchObject({ timeZone: 'Asia/Tehran', pack: { dir: path.join(root, 'pack') } });
    expect((await listProjects())[0]).toMatchObject({ timeZone: 'Asia/Tehran' });
    const q = await createProject({ ...base, name: 'Other', handle: '@other.account' });
    expect(q.timeZone).toBeUndefined();
    expect(q.pack).toBeUndefined();
  });
});
