import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastLevel, contrastRatio } from '@/lib/contrast';

const repo = join(__dirname, '..', '..');
const tokens = JSON.parse(readFileSync(join(repo, 'design', 'tokens.json'), 'utf8'));
type Pairs = { text: [string, string][]; nonText: [string, string][] };
/** A theme listed under contrast.byTheme has its own pair lists (the studio theme); the rest share contrast.text/nonText. */
const pairsFor = (theme: string): Pairs => tokens.contrast.byTheme?.[theme] ?? tokens.contrast;

describe('design tokens meet WCAG 2.1 AA', () => {
  for (const [themeName, theme] of Object.entries<Record<string, string>>(tokens.color.themes)) {
    for (const [group, min] of [
      ['text', 4.5],
      ['nonText', 3],
    ] as const) {
      for (const [fg, bg] of pairsFor(themeName)[group]) {
        it(`${themeName}: ${fg} on ${bg} ≥ ${min}:1`, () => {
          expect(theme[fg], `${fg} missing in ${themeName}`).toMatch(/^#[0-9A-F]{6}$/i);
          expect(theme[bg], `${bg} missing in ${themeName}`).toMatch(/^#[0-9A-F]{6}$/i);
          expect(contrastRatio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
        });
      }
    }
  }

  it('defines the same colour roles in every theme', () => {
    const [dark, light] = [tokens.color.themes.dark, tokens.color.themes.light];
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it('has reduced-motion variants for every duration', () => {
    expect(Object.keys(tokens.motion.reducedMotion.duration).sort()).toEqual(Object.keys(tokens.motion.duration).sort());
    for (const v of Object.values<string>(tokens.motion.reducedMotion.duration)) expect(v).toBe('0ms');
  });

  it('keeps touch targets at 44 px or more', () => {
    expect(parseInt(tokens.size['touch-target'], 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(tokens.size['control-height'], 10)).toBeGreaterThanOrEqual(44);
  });
});

describe('studio theme', () => {
  const studio = tokens.color.themes.studio as Record<string, string>;
  const has = (group: 'text' | 'nonText', fg: string, bg: string) =>
    pairsFor('studio')[group].some(([a, b]) => a === fg && b === bg);

  it('checks the pairs the Studio needs', () => {
    for (const [fg, bg] of [['rule-strong', 'surface'], ['rule-strong', 'paper']] as const) expect(has('nonText', fg, bg)).toBe(true);
    for (const [fg, bg] of [['on-brand', 'brand'], ['brand-ink', 'paper'], ['brand-ink', 'surface'], ['brand-ink', 'brand-soft'], ['amber-ink', 'amber-soft'], ['danger', 'danger-soft'], ['violet-ink', 'violet-soft']] as const) {
      expect(has('text', fg, bg), `${fg}/${bg}`).toBe(true);
    }
  });

  it('keeps the shipped palette values', () => {
    expect(studio).toMatchObject({ paper: '#F4F4F5', surface: '#FFFFFF', ink: '#242526', brand: '#02BF7D', 'brand-ink': '#017A50', 'on-brand': '#242526', 'rule-strong': '#8A8B8E' });
  });

  it('puts brand green on paper below 3:1, so it stays a fill (never text)', () => {
    expect(contrastRatio(studio.brand!, studio.paper!)).toBeLessThan(3);
  });

  it('emits spacing, radius, motion and both type scales', () => {
    const css = readFileSync(join(repo, 'app', 'studio', 'studio-tokens.css'), 'utf8');
    for (const name of ['--space-4: 16px', '--radius-md: 12px', '--radius-pill: 9999px', '--dur-slow: 320ms', '--t-md: 14px', '--t-md-fa: 15px', '--t-md-fa-lh: 26px', '--rule-strong: #8a8b8e', '--dir: -1']) {
      expect(css).toContain(name);
    }
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*--dur-slow: 0\.01ms/);
  });
});

describe('generated CSS', () => {
  // The design scripts are plain Node ESM outside this package; run them as the CLI does.
  const run = (script: string, args: string[] = []) =>
    spawnSync(process.execPath, [join(repo, 'design', 'scripts', script), ...args], { encoding: 'utf8' });

  it('is up to date with design/tokens.json', () => {
    const r = run('build-tokens.mjs', ['--check']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('passes the design contrast checker, which uses the same maths as lib/contrast', () => {
    const r = run('check-contrast.mjs');
    expect(r.status).toBe(0);
    const total = Object.keys(tokens.color.themes).reduce((n, t) => n + pairsFor(t).text.length + pairsFor(t).nonText.length, 0);
    expect(r.stdout).toContain(`${total}/${total} pairs meet WCAG 2.1 AA.`);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('classifies contrast levels', () => {
    expect(contrastLevel(21)).toBe('AAA');
    expect(contrastLevel(4.6)).toBe('AA');
    expect(contrastLevel(3.2)).toBe('AA-large');
    expect(contrastLevel(2)).toBe('fail');
  });
});
