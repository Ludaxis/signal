import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastLevel, contrastRatio } from '@/lib/contrast';

const repo = join(__dirname, '..', '..');
const tokens = JSON.parse(readFileSync(join(repo, 'design', 'tokens.json'), 'utf8'));

describe('design tokens meet WCAG 2.1 AA', () => {
  for (const [themeName, theme] of Object.entries<Record<string, string>>(tokens.color.themes)) {
    for (const [group, min] of [
      ['text', 4.5],
      ['nonText', 3],
    ] as const) {
      for (const [fg, bg] of tokens.contrast[group] as [string, string][]) {
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
    const total = (tokens.contrast.text.length + tokens.contrast.nonText.length) * Object.keys(tokens.color.themes).length;
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
