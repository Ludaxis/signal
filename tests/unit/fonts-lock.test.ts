// The bundled core faces: every file matches its pinned sha256, each face has its OFL licence beside it, each face's
// provenance is either its project's official GitHub release or an installed npm package (package name, version and
// the sha256 of the file inside it), and the Studio stylesheet loads exactly the locked Persian files (the Studio UI
// loads Instrument Sans through the @fontsource package import instead).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = join(__dirname, '..', '..');
const fonts = join(web, 'public', 'fonts');
interface LockedFace {
  family: string;
  role: string;
  version: string;
  licence: string;
  reservedFontName: boolean;
  release?: string;
  archive?: { url: string; sha256: string };
  npm?: { package: string; version: string; integrity: string; upstream?: string };
  files: { path: string; from: string; url?: string; sha256: string; bytes: number }[];
}
const lock = JSON.parse(readFileSync(join(fonts, 'fonts.lock.json'), 'utf8')) as { fonts: LockedFace[] };
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const pkgJson = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const pkgLock = JSON.parse(readFileSync(join(web, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string; integrity: string; license?: string }> };

describe('fonts.lock.json', () => {
  it('pins Vazirmatn (text), Estedad (display) and Instrument Sans (latin), all OFL 1.1 without a Reserved Font Name', () => {
    expect(lock.fonts.map((f) => [f.family, f.role, f.licence, f.reservedFontName])).toEqual([
      ['Vazirmatn', 'text', 'OFL-1.1', false],
      ['Estedad', 'display', 'OFL-1.1', false],
      ['Instrument Sans', 'latin', 'OFL-1.1', false],
    ]);
  });

  it('every face has exactly one provenance: a GitHub release or an npm package', () => {
    for (const f of lock.fonts) expect([Boolean(f.release), Boolean(f.npm)].filter(Boolean), f.family).toHaveLength(1);
  });

  for (const font of lock.fonts) {
    for (const file of font.files) {
      it(`${file.path} matches its sha256 and size`, () => {
        const p = join(fonts, file.path);
        expect(sha256(p)).toBe(file.sha256);
        expect(statSync(p).size).toBe(file.bytes);
      });
    }

    if (font.release) {
      it(`${font.family} comes from its project's official GitHub release`, () => {
        expect(font.release).toMatch(/^https:\/\/github\.com\/(rastikerdar\/vazirmatn|aminabedi68\/Estedad)\/releases\/tag\//);
        expect(font.archive!.url.startsWith(font.release!.replace('/releases/tag/', '/releases/download/'))).toBe(true);
        expect(font.archive!.sha256).toMatch(/^[0-9a-f]{64}$/);
      });
    }

    if (font.npm) {
      const npm = font.npm;
      it(`${font.family} comes from the npm package ${npm.package}@${npm.version}, pinned in package.json and package-lock.json`, () => {
        expect(npm.package).toMatch(/^@fontsource\//);
        expect(npm.version).toBe(font.version);
        expect(pkgJson.dependencies?.[npm.package]).toBe(npm.version); // an exact pin, not a range
        const locked = pkgLock.packages[`node_modules/${npm.package}`]!;
        expect(locked).toMatchObject({ version: npm.version, integrity: npm.integrity, license: 'OFL-1.1' });
        for (const f of font.files) expect(f.from, f.path).toMatch(/^(files\/[a-z0-9-]+\.woff2|LICENSE)$/);
      });

      // The installed package (CI installs it from the lock) holds byte-identical files; skipped only without node_modules.
      const pkgDir = join(web, 'node_modules', ...npm.package.split('/'));
      it.skipIf(!existsSync(join(pkgDir, 'package.json')))(`${font.family}: each bundled file equals the file inside the installed package`, () => {
        expect((JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version).toBe(npm.version);
        for (const f of font.files) expect(sha256(join(pkgDir, f.from)), f.path).toBe(f.sha256);
      });
    }

    it(`${font.family} has OFL.txt beside the font`, () => {
      const woff2 = font.files.filter((f) => f.path.endsWith('.woff2'));
      expect(woff2).toHaveLength(1);
      const licence = join(fonts, dirname(woff2[0]!.path), 'OFL.txt');
      expect(existsSync(licence)).toBe(true);
      expect(readFileSync(licence, 'utf8')).toContain('SIL Open Font License, Version 1.1');
      expect(font.files.map((f) => f.path)).toContain(`${dirname(woff2[0]!.path)}/OFL.txt`);
    });
  }

  it('locks every file in public/fonts (nothing unpinned ships)', () => {
    const onDisk = readdirSync(fonts, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== 'fonts.lock.json')
      .map((e) => join(e.parentPath, e.name).slice(fonts.length + 1))
      .sort();
    expect(onDisk).toEqual(lock.fonts.flatMap((f) => f.files.map((x) => x.path)).sort());
  });

  it('fonts.css declares one @font-face per locked Persian face, pointing at the locked file', () => {
    const css = readFileSync(join(web, 'app', 'studio', 'fonts.css'), 'utf8');
    for (const font of lock.fonts.filter((f) => f.role !== 'latin')) {
      const file = font.files.find((f) => f.path.endsWith('.woff2'))!;
      expect(css).toMatch(new RegExp(`font-family: '${font.family}';\\s*src: url\\('/fonts/${file.path.replace(/[.]/g, '\\.')}'\\) format\\('woff2'\\);`));
    }
  });
});
