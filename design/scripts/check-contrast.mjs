#!/usr/bin/env node
// Verifies every declared foreground/background token pair meets WCAG 2.1 AA.
// Usage: node design/scripts/check-contrast.mjs   (exit code 1 on any failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTokens } from './contrast.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, '..', 'tokens.json'), 'utf8'));
const rows = checkTokens(tokens);
let failures = 0;
for (const r of rows) {
  const status = r.pass ? 'pass' : 'FAIL';
  if (!r.pass) failures += 1;
  console.log(
    `${status}  ${r.theme.padEnd(5)}  ${r.group.padEnd(7)}  ${r.fg.padEnd(14)} on ${r.bg.padEnd(16)} ${r.ratio.toFixed(2).padStart(6)} (min ${r.min})${r.error ? ' ' + r.error : ''}`,
  );
}
console.log(`\n${rows.length - failures}/${rows.length} pairs meet WCAG 2.1 AA.`);
process.exit(failures ? 1 : 0);
