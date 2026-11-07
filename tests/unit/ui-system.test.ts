// UI system rules that must stay true across the Studio: logical CSS only, no native confirm or alert, no white text
// on brand green, colours from tokens, sentence case, and the Persian face for Persian content.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = join(__dirname, '..', '..');
const studio = join(web, 'app', 'studio');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const studioCss = ['studio.css', 'memory.css', 'ui/ui.css', 'plan-setup.css', 'work.css'].map((f) => join(studio, f));
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Every `selector { declarations }` block (nested @media blocks are flattened). */
const rules = (css: string) => Array.from(stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ selector: m[1]!.trim(), body: m[2]! }));

describe('logical CSS only', () => {
  // A grep for physical directions, run over every Studio stylesheet. Allow-list: none.
  const PHYSICAL = /(margin|padding)-(left|right)|border-(left|right)|[^-]left:|[^-]right:|text-align: ?(left|right)/;
  for (const file of studioCss) {
    it(`${relative(web, file)} has no physical direction`, () => {
      const hits = read(file)
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => PHYSICAL.test(line));
      expect(hits).toEqual([]);
    });
  }

  // Physical values that grep cannot see: four-value padding/margin whose inline sides differ, and inset
  // shadows with a horizontal offset that does not follow --dir.
  const FOUR_VALUE = /(?:^|[;{\s])(padding|margin):\s*([^;{}]+);/g;
  const asymmetric = (css: string) =>
    Array.from(stripComments(css).matchAll(FOUR_VALUE), (m) => m[2]!.trim())
      .filter((v) => !v.includes('('))
      .map((v) => v.split(/\s+/))
      .filter((parts) => parts.length === 4 && parts[1] !== parts[3]);
  const physicalShadow = (css: string) =>
    Array.from(stripComments(css).matchAll(/box-shadow:\s*inset\s+(-?[\d.]+)px/g), (m) => m[0]).filter((m) => !/inset\s+-?0(px)?\b/.test(m));
  for (const file of studioCss) {
    it(`${relative(web, file)} has no four-value shorthand with unequal inline sides and no fixed inset shadow`, () => {
      expect(asymmetric(read(file))).toEqual([]);
      expect(physicalShadow(read(file))).toEqual([]);
    });
  }

  it('keeps the Memory mindmap canvas LTR, since its fades and layout use physical SVG coordinates', () => {
    expect(read(join(studio, 'MemoryMindmap.tsx'))).toMatch(/className=\{`mem-canvas [^`]*`\} dir="ltr"/);
  });

  it('slides drawers in from the inline end in both directions', () => {
    const css = read(join(studio, 'ui', 'ui.css'));
    expect(css).toMatch(/\.ui-drawer \{[^}]*inset-inline-end: 0;/);
    expect(css).toContain('translateX(calc(40px * var(--dir)))');
    expect(read(join(studio, 'studio-tokens.css'))).toMatch(/\[dir="rtl"\] \.studio,\s*\.studio\[dir="rtl"\] \{\s*--dir: -1;/);
  });
});

describe('no native confirm or alert', () => {
  it('app/studio/** never calls window.confirm or window.alert', () => {
    const hits = walk(studio)
      .filter((f) => /\.(tsx?|mjs)$/.test(f))
      .flatMap((f) => read(f).split('\n').map((line, i) => ({ f: relative(web, f), i: i + 1, line })))
      .filter(({ line }) => /\bwindow\.(confirm|alert)\s*\(|(^|[^.\w])(confirm|alert)\s*\(\s*[`'"]/.test(line));
    expect(hits).toEqual([]);
  });
});

describe('no white text on brand green', () => {
  for (const file of studioCss) {
    it(`${relative(web, file)} never pairs color #fff with a brand fill`, () => {
      const bad = rules(read(file)).filter(
        ({ body }) => /(^|[;\s])color:\s*(#fff\b|#ffffff\b|white\b)/i.test(body) && /background(-color)?:\s*(var\(--brand\)|#02bf7d\b)/i.test(body),
      );
      expect(bad.map((r) => r.selector)).toEqual([]);
    });
  }

  it('puts --on-brand on every brand-filled text rule', () => {
    const css = read(join(studio, 'studio.css'));
    for (const sel of ['.studio .real-pill', '.studio .cal2-todaydot', '.studio .cx-ready-badge.is-ok', '.studio .cx-step.is-done .cx-step-mark']) {
      const rule = rules(css).find((r) => r.selector === sel);
      expect(rule?.body, sel).toContain('color: var(--on-brand)');
    }
  });
});

describe('studio colours come from tokens', () => {
  const tokens = JSON.parse(read(join(web, 'design', 'tokens.json')));
  const opaque = new Set(
    Object.values<string>(tokens.color.themes.studio)
      .filter((v) => /^#[0-9a-f]{6}$/i.test(v))
      .map((v) => v.toLowerCase()),
  );
  const expand = (hex: string) => (hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex).toLowerCase();

  for (const file of studioCss) {
    it(`${relative(web, file)} keeps no literal for a colour that has a token (alpha variants allowed)`, () => {
      const literals = Array.from(stripComments(read(file)).matchAll(/#[0-9a-f]{3,8}\b/gi), (m) => m[0]).filter((h) => h.length === 4 || h.length === 7);
      expect(literals.filter((h) => opaque.has(expand(h)))).toEqual([]);
    });
  }

  it('studio.css no longer defines the palette itself; the generated studio-tokens.css does', () => {
    expect(read(join(studio, 'studio.css'))).not.toMatch(/--paper:\s*#/);
    expect(read(join(studio, 'studio-tokens.css'))).toMatch(/--paper: #f4f4f5;/);
    const page = read(join(studio, 'page.tsx'));
    expect(page.indexOf("'./studio-tokens.css'")).toBeGreaterThan(-1);
    expect(page.indexOf("'./studio-tokens.css'")).toBeLessThan(page.indexOf("'./studio.css'"));
    expect(page.indexOf("'./studio.css'")).toBeLessThan(page.indexOf("'./ui/ui.css'"));
  });
});

describe('labels are sentence case', () => {
  for (const file of studioCss) {
    it(`${relative(web, file)} uppercases nothing`, () => {
      expect(stripComments(read(file))).not.toMatch(/text-transform:\s*uppercase/);
    });
  }

  it('the Persian block comes after every rule that sets the font, so controls keep the Persian face', () => {
    const all = rules(read(join(studio, 'ui', 'ui.css')));
    const at = all.findIndex((r) => r.selector === '.studio :lang(fa)');
    expect(at).toBeGreaterThan(-1);
    const sets = /(^|[;\s])(font|font-family|letter-spacing|text-transform):/;
    const before = all.slice(0, at).filter((r) => sets.test(r.body)).map((r) => r.selector);
    // .btn, .chip and .toast-undo reset `font: inherit` at the same specificity: they must come first.
    expect(before).toEqual(expect.arrayContaining(['.studio .btn', '.studio .chip', '.studio .toast-undo']));
    const after = all.slice(at + 1).filter((r) => sets.test(r.body) && !r.selector.includes(':lang(fa)'));
    expect(after.map((r) => r.selector)).toEqual([]);
  });

  it('Persian content is never letter-spaced, cased or italic', () => {
    const rule = rules(read(join(studio, 'ui', 'ui.css'))).find((r) => r.selector === '.studio :lang(fa)');
    expect(rule?.body).toMatch(/font-family: var\(--font-fa\)/);
    expect(rule?.body).toMatch(/letter-spacing: 0;/);
    expect(rule?.body).toMatch(/text-transform: none;/);
    expect(rule?.body).toMatch(/font-style: normal;/);
  });
});
