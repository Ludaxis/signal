// The pack's Persian pronunciation list, read-only: rows keep their review status, and a missing or malformed pack
// simply has no list.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packLexiconFa } from '@/lib/studio/pack-lexicon';

let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-pack-lexicon-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const FIXTURE = path.resolve(__dirname, '../fixtures/postmaker/pack-example');

describe('packLexiconFa', () => {
  it('lists the fixture pack entries, all proposed until a named person approves them', async () => {
    const pack = path.join(root, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });
    const lex = await packLexiconFa({ contentDir: path.join(root, 'posts'), pack: { dir: pack } });
    expect(lex).not.toBeNull();
    expect(lex!.count).toBeGreaterThan(0);
    expect(lex!.rows.length).toBe(lex!.count);
    expect(lex!.rows.every((r) => r.status === 'proposed')).toBe(true);
    expect(lex!.rows[0]).toMatchObject({ id: 'lx-pack-mobile', display: 'موبایل', roman: 'mo-baayl' });
  });

  it('reads <content parent>/pack by default and approves only an entry signed by a named person', async () => {
    const pack = path.join(root, 'pack');
    mkdirSync(path.join(pack, 'lexicon'), { recursive: true });
    writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ lexicon: { fa: 'lexicon/fa.json' } }));
    const entry = (id: string, o: Record<string, unknown>) => ({ id, match: { display: ['تست'] }, roman: 'test', ...o });
    writeFileSync(path.join(pack, 'lexicon/fa.json'), JSON.stringify({ entries: [entry('a', { status: 'approved', approvedBy: 'Reader A' }), entry('b', { status: 'approved', approvedBy: '' }), entry('c', { status: 'retired' })] }));
    const lex = await packLexiconFa({ contentDir: path.join(root, 'posts') });
    expect(lex).toEqual({ count: 2, rows: [expect.objectContaining({ id: 'a', status: 'approved' }), expect.objectContaining({ id: 'b', status: 'proposed' })] });
  });

  it('has no list for a missing pack, a lexicon path outside the pack or a malformed file', async () => {
    expect(await packLexiconFa({ contentDir: path.join(root, 'posts') })).toBeNull();
    const pack = path.join(root, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ lexicon: { fa: '../outside.json' } }));
    expect(await packLexiconFa({ contentDir: path.join(root, 'posts') })).toBeNull();
    writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ lexicon: { fa: 'fa.json' } }));
    writeFileSync(path.join(pack, 'fa.json'), '{ not json');
    expect(await packLexiconFa({ contentDir: path.join(root, 'posts') })).toBeNull();
  });
});
