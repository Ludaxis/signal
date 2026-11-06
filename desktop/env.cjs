// Environment for the Studio server inside the Mac app. Pure functions, tested without Electron.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Common places CLIs live on a Mac when Signal is opened from Finder (no shell PATH). */
function fallbackPath(home = os.homedir()) {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.bun/bin`, `${home}/.volta/bin`, `${home}/.claude/local`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

/** PATH from your login shell (so Homebrew, nvm, npm -g and the official installers are found), merged with fallbacks. */
function loginShellPath(env = process.env) {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  let fromShell = '';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__SIGNAL_PATH__%s__SIGNAL_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
    fromShell = (out.match(/__SIGNAL_PATH__(.*)__SIGNAL_PATH__/s) || [])[1] || '';
  } catch {
    /* slow or broken shell profile: fall back */
  }
  return mergePath(fromShell, env.PATH || '', fallbackPath(env.HOME || os.homedir()).join(':'));
}

function mergePath(...parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts.join(':').split(':')) if (p && !seen.has(p)) (seen.add(p), out.push(p));
  return out.join(':');
}

/** Minimal .env parser: KEY=value lines, optional quotes, # comments. Never logs values. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The server's environment. mode 'bundled' runs the server inside the app with its data in
 * ~/Library/Application Support/Signal; mode 'checkout' runs `next start` in a Signal folder
 * (SIGNAL_APP_DIR), which keeps using that folder's own .env.local and data. `user` (signal.env) wins over the inherited environment; the app then
 * fixes what it must own: the bind address, the login and the session for this launch.
 */
function serverEnv({ base, user, userData, serverDir, port, ownerPassword, sessionSecret, tokenKey, pathValue, mode = 'bundled', appEnvNames = new Set(), defaults = {} }) {
  const env = { ...base, ...defaults, ...user };
  env.NODE_ENV = 'production';
  env.PORT = String(port);
  env.HOSTNAME = '127.0.0.1';
  env.PATH = pathValue;
  env.SIGNAL_DESKTOP = '1';
  env.SIGNAL_WEB_ORIGIN = `http://127.0.0.1:${port}`;
  if (mode === 'bundled') {
    // The app signs its own window in. A checkout keeps its own sign-in (you sign in once in the window).
    env.SIGNAL_OWNER_PASSWORD = ownerPassword;
    env.SIGNAL_SESSION_SECRET = sessionSecret;
    delete env.SIGNAL_LOCAL_ONLY_NO_PASSWORD;
  }
  if (mode === 'bundled') {
    env.SIGNAL_DATA_DIR = user.SIGNAL_DATA_DIR || path.join(userData, 'data');
    env.SIGNAL_CONFIG_FILE = user.SIGNAL_CONFIG_FILE || path.join(userData, 'signal.config.json');
    env.SIGNAL_PROMPTS_DIR = user.SIGNAL_PROMPTS_DIR || path.join(serverDir, 'agents');
  }
  // A checkout keeps its own key in .env.local (it decrypts tokens saved earlier): never replace it.
  if (!user.SIGNAL_TOKEN_KEY && !base.SIGNAL_TOKEN_KEY && !appEnvNames.has('SIGNAL_TOKEN_KEY') && tokenKey) env.SIGNAL_TOKEN_KEY = tokenKey;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { fallbackPath, loginShellPath, mergePath, parseEnvFile, readEnvFile, serverEnv };
