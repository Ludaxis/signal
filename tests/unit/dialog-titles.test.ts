// Every Dialog title in app/studio/** is at most 6 words and starts with a verb; its confirm
// repeats that verb and its body is at most two short lines. The scan reads the sources, so a new confirm or
// <Dialog> is checked without being listed here. A title is the copy key's English text (copy/*.ts); a
// placeholder such as {id} or {when} counts as one word, because it names one object.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/app/studio/copy/en';

const STUDIO = path.resolve(__dirname, '../../app/studio');
/** Verbs a dialog title may start with ("title = verb + object"). Add one here when a new dialog needs it. */
const VERBS = new Set(['Accept', 'Add', 'Delete', 'Discard', 'Disconnect', 'End', 'Make', 'Mark', 'Move', 'Post', 'Pull', 'Raise', 'Regenerate', 'Reject', 'Remove', 'Retire', 'Run', 'Schedule', 'Undo', 'Unschedule']);
const MAX_TITLE_WORDS = 6;
/** Two short lines in the 28rem dialog. */
const MAX_BODY_WORDS = 24;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** The English texts an expression can produce: every t('key') in it, or a string literal (with ${…} as {x}). */
function texts(raw: string): string[] {
  const expr = withoutVars(raw);
  const keys = [...expr.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1]!);
  if (keys.length) {
    for (const k of keys) expect(k in en, `unknown copy key ${k}`).toBe(true);
    return keys.map((k) => en[k as keyof typeof en] as string);
  }
  const lit = /^\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/.exec(expr);
  if (!lit) return [];
  return [(lit[1] ?? lit[2] ?? lit[3] ?? '').replace(/\$\{[^}]*\}/g, '{x}')];
}

/** Drops the `{ …vars }` argument of every t(…) call (balanced braces after a comma), so only message keys remain. */
function withoutVars(expr: string): string {
  let out = '';
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === ',' && /^,\s*\{/.test(expr.slice(i))) {
      let depth = 0;
      let j = expr.indexOf('{', i);
      for (; j < expr.length; j++) {
        if (expr[j] === '{') depth++;
        else if (expr[j] === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += expr[i];
  }
  return out;
}

/** Slice of `s` from `start` to the first of `ends` after it (or `max` characters). */
function until(s: string, start: number, ends: RegExp, max = 400): string {
  const rest = s.slice(start, start + max);
  const m = ends.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

interface Found { where: string; titles: string[]; confirms: string[]; bodies: string[] }

function dialogs(): Found[] {
  const out: Found[] = [];
  for (const f of files(STUDIO)) {
    const src = readFileSync(f, 'utf8');
    const rel = path.relative(STUDIO, f);
    // <Dialog …> elements (the shared confirm's own `title={req.title}` is the generic renderer, not a title).
    for (const m of src.matchAll(/<Dialog\b/g)) {
      const block = src.slice(m.index, m.index + 900);
      const ti = block.indexOf('title=');
      if (ti < 0 || block.slice(ti).startsWith('title={req.title}')) continue;
      const title = until(block, ti + 6, /\s(confirmLabel|body|busy|onCancel|onConfirm|role|cancelLabel|destructive)=/);
      const ci = block.indexOf('confirmLabel=');
      const bi = block.indexOf('body=');
      out.push({
        where: `${rel} <Dialog>`,
        titles: texts(title.replace(/^\{/, '')),
        confirms: ci >= 0 ? texts(until(block, ci + 13, /\s(busy|onCancel|onConfirm|body|destructive|role|cancelLabel|confirmDisabled)=/).replace(/^\{/, '')) : [],
        bodies: bi >= 0 ? texts(until(block, bi + 5, /\s(busy|onCancel|onConfirm|confirmLabel|destructive|role|cancelLabel)=/).replace(/^\{/, '')) : [],
      });
    }
    // Confirm requests: an object literal with a title and a confirmLabel (confirm({ … }) or a request builder).
    for (const m of src.matchAll(/\btitle:\s*/g)) {
      // The object reaches at most to the next title (or 600 characters): enough for a one-line or a builder object.
      const obj = until(src, m.index + 6, /\btitle:|\breturn\b|\bfunction\b/, 600);
      if (!obj.includes('confirmLabel:')) continue;
      const after = m.index + m[0].length;
      const title = until(src, after, /,\s*(body|confirmLabel|destructive):/);
      if (/^(string|ReactNode)\b/.test(title)) continue; // a type declaration (DialogProps, ConfirmRequest), not a dialog
      const ci = obj.indexOf('confirmLabel:');
      const bi = obj.indexOf('body:');
      out.push({
        where: `${rel}:${src.slice(0, m.index).split('\n').length}`,
        titles: texts(title),
        confirms: texts(until(obj, ci + 13, /,\s*(destructive|body|title):|\s\}/)),
        bodies: bi >= 0 ? texts(until(obj, bi + 5, /,\s*(confirmLabel|destructive|title):/)) : [],
      });
    }
  }
  return out;
}

const words = (s: string) => s.replace(/\{[^{}]*\}/g, 'X').replace(/[?.]$/, '').trim().split(/\s+/).filter(Boolean);

describe('Dialog titles', () => {
  const found = dialogs();

  it('finds the Studio dialogs (the scan is real)', () => {
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found.filter((d) => d.titles.length === 0).map((d) => d.where)).toEqual([]);
  });

  it('every title is at most 6 words and starts with a verb', () => {
    const bad = found.flatMap((d) => d.titles.filter((tt) => words(tt).length > MAX_TITLE_WORDS || !VERBS.has(words(tt)[0]!)).map((tt) => `${d.where}: "${tt}"`));
    expect(bad).toEqual([]);
  });

  it('every confirm repeats the title verb (never OK or Yes)', () => {
    const bad = found.flatMap((d) => d.confirms.filter((c) => !d.titles.some((tt) => words(tt)[0] === words(c)[0])).map((c) => `${d.where}: "${c}" vs "${d.titles.join(' / ')}"`));
    expect(bad).toEqual([]);
    for (const d of found) for (const c of d.confirms) expect(c).not.toMatch(/^(OK|Yes)\b/i);
  });

  it('every body is at most two short lines', () => {
    const bad = found.flatMap((d) => d.bodies.filter((b) => words(b).length > MAX_BODY_WORDS).map((b) => `${d.where}: "${b}"`));
    expect(bad).toEqual([]);
  });
});
