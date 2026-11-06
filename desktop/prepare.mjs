// Prepares the Studio server for the Mac app: copies Next's standalone build (SIGNAL_STANDALONE=1
// next build) into desktop/app-server, adds what the tracer does not see (static files, public/,
// native image and video tools, the fallback font, agent prompts) and strips anything private.
// Run from the Signal folder: npm run app:prepare
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const standalone = path.join(root, '.next', 'standalone');
const out = path.join(here, 'app-server');
const req = createRequire(path.join(root, 'package.json'));

function findServer(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, '.next'))) return dir;
  if (depth > 4) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const hit = findServer(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

const cp = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true });

function pkgDir(name) {
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    let d = path.dirname(req.resolve(name));
    while (!fs.existsSync(path.join(d, 'package.json'))) d = path.dirname(d);
    return d;
  }
}

/** Copies a package and its installed dependencies into <appDir>/node_modules. */
function copyPackage(name, appDir, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  let dir;
  try {
    dir = pkgDir(name);
  } catch {
    return; // optional dependency for another platform
  }
  cp(dir, path.join(appDir, 'node_modules', name));
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })) copyPackage(dep, appDir, seen);
}

/** Removes anything that must never ship inside the app: env files, local data, certificates. */
function strip(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      if (dir === out || dir === appDir ? ['data', 'certs', 'coverage', 'test-results', '.git'].includes(e.name) : e.name === '.git') {
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      strip(p);
    } else if (/^\.env(\.|$)/.test(e.name) || e.name === 'signal.config.json' || /\.(pem|key)$/.test(e.name)) fs.rmSync(p, { force: true });
  }
}

if (process.argv.includes('--checkout')) {
  // Checkout build: the app runs `next start` in this folder (its .env.local and data stay here).
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
    console.error('Run "npm run build" first.');
    process.exit(1);
  }
  fs.rmSync(out, { recursive: true, force: true });
  // --env KEY=VALUE (repeatable): defaults for this checkout. signal.env wins over them.
  const env = {};
  process.argv.forEach((a, i) => {
    const m = a === '--env' ? /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(process.argv[i + 1] ?? '') : null;
    if (m) env[m[1]] = m[2];
  });
  fs.writeFileSync(path.join(here, 'app-config.json'), JSON.stringify({ appDir: root, env }, null, 2) + '\n');
  console.log(`Signal.app will run ${root}. Next: npm --prefix desktop install && npm --prefix desktop run dist`);
  process.exit(0);
}
fs.rmSync(path.join(here, 'app-config.json'), { force: true });
if (!fs.existsSync(standalone)) {
  console.error('No standalone build found. Run: SIGNAL_STANDALONE=1 next build --webpack');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
cp(standalone, out);
const appDir = findServer(out);
if (!appDir) {
  console.error('server.js not found in the standalone build.');
  process.exit(1);
}
if (appDir !== out) fs.writeFileSync(path.join(out, 'server.js'), `require('./${path.relative(out, appDir).split(path.sep).join('/')}/server.js');\n`);

cp(path.join(root, '.next', 'static'), path.join(appDir, '.next', 'static'));
if (fs.existsSync(path.join(root, 'public'))) cp(path.join(root, 'public'), path.join(appDir, 'public'));
for (const name of ['sharp', 'ffmpeg-static', 'opentype.js']) copyPackage(name, appDir);
const imgDir = path.dirname(pkgDir('sharp'));
const scope = path.join(path.dirname(imgDir), '@img');
for (const base of [path.join(imgDir, '@img'), scope]) if (fs.existsSync(base)) for (const n of fs.readdirSync(base)) cp(path.join(base, n), path.join(appDir, 'node_modules', '@img', n));
const font = 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff';
const fontSrc = path.join(pkgDir('@fontsource/instrument-sans'), 'files', 'instrument-sans-latin-600-normal.woff');
fs.mkdirSync(path.dirname(path.join(appDir, font)), { recursive: true });
fs.copyFileSync(fontSrc, path.join(appDir, font));
if (fs.existsSync(path.join(root, 'agents'))) cp(path.join(root, 'agents'), path.join(out, 'agents'));
if (fs.existsSync(path.join(root, 'signal.config.example.json'))) fs.copyFileSync(path.join(root, 'signal.config.example.json'), path.join(out, 'signal.config.example.json'));
strip(out);

const du = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : e.isFile() ? fs.statSync(path.join(d, e.name)).size : 0), 0);
console.log(`Prepared desktop/app-server (${(du(out) / 1e6).toFixed(0)} MB). Next: npm --prefix desktop install && npm --prefix desktop run dist`);
