// The animation system is generic core. No game, brand, character, city, person, store or font name in
// anim/** or in the character component and composition (the project-wide grep in generic-core.test.ts covers the
// rest of lib/studio; this one also bans font family names and the fixture character's id).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maintainerDenylist } from '../../name-denylist';

const PM = path.resolve(__dirname, '../../../../lib/studio/postmaker');
const FILES = [
  ...(function walk(d: string): string[] {
    return readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  })(path.join(PM, 'anim')),
  path.join(PM, 'render/components/CutoutCharacter.tsx'),
  path.join(PM, 'render/compositions/CharacterTest.tsx'),
];
// Generic words only (the fictional fixture brand, cities, fonts, stores and the fixture character ids); a maintainer's
// own names come from the optional, untracked SIGNAL_NAME_DENYLIST file.
const BANNED = /harfino|حرفینو|tehran|berlin|vazirmatn|instrument sans|estedad|\binter\b|fraunces|char-cutout|char-lead|char-elder|google play|app store|steam/i;
const DENY = maintainerDenylist();

describe('anim/** is generic core', () => {
  it('scans the anim folder and the character component', () => expect(FILES.length).toBeGreaterThan(15));
  it('names no game, brand, character, city, store or font', () => {
    const hits = FILES.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (BANNED.test(l) || DENY?.test(l) ? [`${path.relative(PM, f)}:${i + 1}: ${l.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
});
