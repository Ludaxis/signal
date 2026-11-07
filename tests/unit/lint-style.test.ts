// The ESLint rule that keeps ad-hoc style objects out of the Studio is active.
import { ESLint } from 'eslint';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = join(__dirname, '..', '..');
// The config is plain ESM without types; load it by path.
const { STYLE_ALLOW_LIST, STYLE_ALLOW_LIST_DATE } = (await import(join(web, 'eslint.config.mjs'))) as { STYLE_ALLOW_LIST: string[]; STYLE_ALLOW_LIST_DATE: string };
const eslint = new ESLint({ cwd: web });
const lint = async (filePath: string, code: string) => {
  const [r] = await eslint.lintText(code, { filePath: join(web, filePath) });
  return r!.messages.filter((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'react/forbid-dom-props').map((m) => m.ruleId);
};
const component = (attr: string) => `export function X() {\n  return <div ${attr}>x</div>;\n}\n`;

describe('no ad-hoc style in the Studio', () => {
  it('rejects spacing or colour in a style object in new Studio code', async () => {
    expect(await lint('app/studio/NewScreen.tsx', component("style={{ gap: 8 }}"))).toEqual(['no-restricted-syntax']);
    expect(await lint('app/studio/NewScreen.tsx', component("style={{ color: '#a05e00' }}"))).toEqual(['no-restricted-syntax']);
    expect(await lint('app/studio/NewScreen.tsx', component("style={{ 'margin-top': 4 }}"))).toEqual(['no-restricted-syntax']);
    expect(await lint('app/studio/NewScreen.tsx', 'const s = { gap: 8 };\n' + component('style={s}'))).toEqual(['no-restricted-syntax']);
  }, 30_000);

  it('allows CSS custom properties for dynamic values', async () => {
    expect(await lint('app/studio/NewScreen.tsx', 'const p = 40;\n' + component("style={{ '--progress': `${p}%` } as React.CSSProperties}"))).toEqual([]);
    expect(await lint('app/studio/NewScreen.tsx', 'const p = 40;\n' + component("style={{ '--progress': p }}"))).toEqual([]);
  }, 30_000);

  it('forbids the style prop entirely inside app/studio/ui/**', async () => {
    expect(await lint('app/studio/ui/NewThing.tsx', component("style={{ '--progress': 1 }}"))).toContain('react/forbid-dom-props');
  }, 30_000);

  it('keeps a dated allow-list of screens the tab passes still have to clean, all of which exist', async () => {
    expect(STYLE_ALLOW_LIST_DATE).toBe('2026-11-06');
    for (const f of STYLE_ALLOW_LIST) expect(existsSync(join(web, f)), f).toBe(true);
    expect(STYLE_ALLOW_LIST.some((f) => f.startsWith('app/studio/ui/'))).toBe(false);
    expect(await lint('app/studio/Pipelines.tsx', component('style={{ gap: 8 }}'))).toEqual([]);
  }, 30_000);

  it('holds the Plan, Learn and Setup screens to the rule (they left the allow-list)', async () => {
    for (const f of ['Brand', 'Campaigns', 'Comments', 'Connections', 'Memory', 'Results']) {
      expect(STYLE_ALLOW_LIST).not.toContain(`app/studio/${f}.tsx`);
      expect(await lint(`app/studio/${f}.tsx`, component('style={{ gap: 8 }}')), f).toEqual(['no-restricted-syntax']);
    }
  }, 60_000);
});
