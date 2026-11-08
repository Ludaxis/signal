// @vitest-environment node
// The pack-format `uiTargets` field. A `phone-frame` asset lists its UI targets in `<file>.ui.json`
// (`signal.pack-ui/1`); the motion world takes their centres in phone-local px, else DEFAULT_UI_TARGETS. Synthetic
// files in a temp folder; no network.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHONE_SCREEN, phoneTargets, readUiTargets, uiTargetsFor, uiTargetsPath } from '@/lib/studio/postmaker/pack/ui-targets';
import type { LibraryEntry } from '@/lib/studio/postmaker/pack/resolve';
import { DEFAULT_UI_TARGETS } from '@/lib/studio/postmaker/anim/compile';
import { motionBasis } from '@/lib/studio/postmaker/executors/motion';
import './guard';

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signal-ui-targets-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string, file: string, o: { dims?: { w: number; h: number }; tags?: string[] } = {}): LibraryEntry =>
  ({ asset: { id, kind: 'ui', file, sha256: '0'.repeat(64), tags: o.tags ?? ['phone-frame'], status: 'approved', approvedBy: null, licence: {} as never, ...(o.dims ? { dims: o.dims } : {}) }, origin: 'pack', base: dir }) as LibraryEntry;
const write = (rel: string, data: unknown) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data));
};
const TARGETS = { schema: 'signal.pack-ui/1', targets: [{ id: 'tile-1', x: 80, y: 620, w: 110, h: 110 }, { id: 'tile-2', x: 215, y: 620, w: 110, h: 110 }] };

describe('phone UI targets from the pack', () => {
  it('reads <file>.ui.json beside the image and scales each centre to the phone screen', async () => {
    write('ui/phone.ui.json', TARGETS);
    expect(uiTargetsPath('ui/phone.png')).toBe('ui/phone.ui.json');
    const file = await readUiTargets(entry('ui-phone', 'ui/phone.png', { dims: { w: 540, h: 1080 } }));
    const c = phoneTargets(file, { w: 540, h: 1080 });
    expect(c['tile-1']).toEqual({ x: Math.round(135 * (PHONE_SCREEN.w / 540)), y: Math.round(675 * (PHONE_SCREEN.h / 1080)) });
    expect(Object.keys(c)).toEqual(['tile-1', 'tile-2']);
  });

  it('refuses a rect outside the image, duplicate ids and a missing file with asset.ui-targets-invalid', async () => {
    write('ui/wide.ui.json', { ...TARGETS, targets: [{ id: 'tile-1', x: 500, y: 0, w: 100, h: 10 }] });
    await expect(readUiTargets(entry('ui-wide', 'ui/wide.png', { dims: { w: 540, h: 1080 } }))).rejects.toMatchObject({ code: 'asset.ui-targets-invalid' });
    write('ui/dupe.ui.json', { ...TARGETS, targets: [TARGETS.targets[0], TARGETS.targets[0]] });
    await expect(readUiTargets(entry('ui-dupe', 'ui/dupe.png'))).rejects.toMatchObject({ code: 'asset.ui-targets-invalid' });
    await expect(readUiTargets(entry('ui-none', 'ui/none.png'))).rejects.toMatchObject({ code: 'asset.ui-targets-invalid' });
  });

  it('uiTargetsFor prefers the phone frame the scenes use; none or invalid gives null (the default applies)', async () => {
    write('ui/a.ui.json', { schema: 'signal.pack-ui/1', targets: [{ id: 'a-1', x: 0, y: 0, w: 10, h: 10 }] });
    write('ui/b.ui.json', TARGETS);
    const lib = [entry('ui-a', 'ui/a.png'), entry('ui-b', 'ui/b.png'), entry('ui-icon', 'ui/icon.png', { tags: ['app-icon'] })];
    expect(Object.keys((await uiTargetsFor(lib, 'ui-b'))!)).toEqual(['tile-1', 'tile-2']);
    expect(Object.keys((await uiTargetsFor(lib, null))!)).toEqual(['a-1']);
    expect(await uiTargetsFor([entry('ui-none', 'ui/none.png')])).toBeNull();
    expect(await uiTargetsFor([])).toBeNull();
  });

  it('the motion basis takes the world targets when present, else DEFAULT_UI_TARGETS', () => {
    const i = { recipe: { beats: [], languages: ['en'], shape: '9:16', tempo: null } as never, byPort: {}, lang: 'en' as const, params: {} };
    expect(motionBasis(i, { rigs: {} }).uiTargets).toEqual(DEFAULT_UI_TARGETS);
    expect(motionBasis(i, { rigs: {}, uiTargets: { 'tile-1': { x: 1, y: 2 } } }).uiTargets).toEqual({ 'tile-1': { x: 1, y: 2 } });
  });
});
