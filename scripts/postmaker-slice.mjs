#!/usr/bin/env node
// The Post maker slice on this computer. Calls the Post maker service directly (no dev server): builds the fixture
// pack, makes (or takes) the synthetic reference, presses Make it with every connector off (mock), renders the fa and
// en 30 s videos for real (the Remotion render child with Chrome Headless Shell, ffmpeg loudness), and writes the
// output folder: video.<lang>.mp4, loudness.json, frames/, stats.json, run.json, events.json, network-guard.json and a
// filled report.md.
//
//   npm run postmaker:slice -- [--ref <mp4>] [--langs fa,en] [--browser <chrome-headless-shell program file>]
//                              [--out <dir>] [--work <dir>] [--human-run]
//
// Needs the optional render workspace (`cd render && npm install`) and a Chrome Headless Shell: pass its program file
// with --browser (or SIGNAL_RENDER_BROWSER), or install Remotion's own with `npm --prefix render run browser:ensure`.
//
// The run is hermetic: a temporary secrets folder, data folder and signal.config.json with every switch off, no
// vendor key, no Claude or Codex program, and only PATH, HOME and TMPDIR from this shell. No paid call is possible
// (every connector stays mock) and the run's process blocks the network (network-guard.json must list nothing).
// Without --human-run the report is marked as an automated run, not checked by a person.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = 'tests/unit/postmaker/render/slice-run.test.ts';
const USAGE = 'npm run postmaker:slice -- [--ref <mp4>] [--langs fa,en] [--browser <file>] [--out <dir>] [--work <dir>] [--human-run]';

function args(argv) {
  const o = { langs: 'fa,en', humanRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (!x) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--ref') o.ref = path.resolve(v());
    else if (a === '--langs') o.langs = v();
    else if (a === '--browser') o.browser = path.resolve(v());
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--work') o.work = path.resolve(v());
    else if (a === '--human-run') o.humanRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

function main() {
  let o;
  try {
    o = args(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  if (o.ref && !existsSync(o.ref)) {
    console.error(`No reference at ${o.ref}`);
    process.exit(2);
  }
  const langs = o.langs.split(',').map((l) => l.trim());
  if (!langs.length || langs.some((l) => l !== 'fa' && l !== 'en')) {
    console.error('--langs takes fa, en or fa,en');
    process.exit(2);
  }
  const renderDir = process.env.SIGNAL_RENDER_SERVICE_DIR || path.join(APP, 'render');
  if (!existsSync(path.join(renderDir, 'node_modules/@remotion/renderer/package.json'))) {
    console.error('The render workspace is not installed. Run: cd render && npm install');
    process.exit(2);
  }
  const browser = o.browser ?? process.env.SIGNAL_RENDER_BROWSER ?? null;
  if (browser && !existsSync(browser)) {
    console.error(`No render browser at ${browser} (name the chrome-headless-shell program file)`);
    process.exit(2);
  }
  const day = new Date().toISOString().slice(0, 10);
  // test-results/ is ignored by git: the renders and the report stay on this computer.
  const out = o.out ?? path.join(APP, 'test-results', `postmaker-slice-${day}`);
  const work = o.work ?? mkdtempSync(path.join(os.tmpdir(), `signal-slice-${day}-`));
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(work, 'secrets'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(work, 'data'), { recursive: true });
  const config = path.join(work, 'signal.config.json');
  writeFileSync(config, JSON.stringify({ features: {} }));

  const shown = ['npm run postmaker:slice --', ...(o.ref ? ['--ref', path.relative(APP, o.ref)] : []), '--langs', langs.join(','), ...(browser ? ['--browser', '<chrome-headless-shell>'] : []), ...(o.humanRun ? ['--human-run'] : [])].join(' ');
  const env = {
    PATH: process.env.PATH ?? '',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    NODE_ENV: 'test',
    SIGNAL_SLICE: '1',
    SIGNAL_SLICE_OUT: out,
    SIGNAL_SLICE_WORK: work,
    SIGNAL_SLICE_LANGS: langs.join(','),
    SIGNAL_SLICE_COMMAND: shown,
    SIGNAL_SLICE_MARKING: o.humanRun ? 'run by a person on this computer (fill in the person section below)' : 'automated run, not checked by a person',
    ...(o.ref ? { SIGNAL_SLICE_REF: o.ref } : {}),
    ...(browser ? { SIGNAL_RENDER_BROWSER: browser } : {}),
    SIGNAL_APP_DIR: APP,
    SIGNAL_RENDER_SERVICE_DIR: renderDir,
    SIGNAL_PUBLISH_PAUSED: '1',
    SIGNAL_CONFIG_FILE: config,
    SIGNAL_SECRETS_DIR: path.join(work, 'secrets'),
    SIGNAL_DATA_DIR: path.join(work, 'data'),
    SIGNAL_PROJECTS_FILE: path.join(work, 'no-projects.json'),
    CLAUDE_BIN: path.join(work, 'no-claude'),
    CODEX_BIN: path.join(work, 'no-codex'),
    VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
  };
  console.log(`Post maker slice: output → ${out}`);
  console.log(`work folder → ${work}`);
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(APP, 'node_modules/vitest/vitest.mjs'), 'run', TEST], { cwd: APP, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`slice finished in ${((Date.now() - t0) / 1000).toFixed(1)} s (exit ${code}); report: ${path.join(out, 'report.md')}`);
    process.exit(code ?? 1);
  });
}

main();
