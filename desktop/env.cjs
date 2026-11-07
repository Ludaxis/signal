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
 * Which server the app runs. A Signal folder (SIGNAL_APP_DIR in signal.env, else `appDir` in
 * desktop/app-config.json written by `prepare.mjs --checkout`) means 'checkout': `next start` in that
 * folder. Otherwise 'bundled': the server copied into the app. signal.env wins over app-config.
 */
function resolveMode({ user = {}, cfg = {} } = {}) {
  const appDir = user.SIGNAL_APP_DIR || cfg.appDir || '';
  return { mode: appDir ? 'checkout' : 'bundled', appDir };
}

/** What a new signal.env contains (written once by the app; every line is a comment). */
function signalEnvTemplate() {
  return [
    '# Signal for Mac: settings and keys (same names as .env.local). Restart Signal after editing.',
    '# This file stays on this Mac. Never share it.',
    "# Values here (and the app-config env written by `prepare.mjs --checkout`) OVERRIDE a Signal folder's .env.local.",
    '# Keys and the Publishing / Autopilot switches are easier to set in Connections (kept encrypted in ~/.signal/settings.json).',
    '# Feature switches: signal.config.json (File > Open Feature Switches; a Signal folder uses its own).',
    '# UPLOAD_POST_API_KEY=',
    '# CLAUDE_BIN=/opt/homebrew/bin/claude',
    '# CODEX_BIN=/opt/homebrew/bin/codex',
    '# NEXT_PUBLIC_SIGNAL_TIME_ZONE=Europe/Berlin',
    '# Run a Signal folder (its own .env.local, data and settings) instead of the built-in server:',
    '# SIGNAL_APP_DIR=/path/to/signal',
    "# Sign-in password for a Signal folder (wins over its .env.local). The built-in server makes a one-time password at launch and ignores this.",
    '# SIGNAL_OWNER_PASSWORD=',
    '# 1 = block every post and schedule. The Publishing switch in Connections overrides it once saved.',
    '# SIGNAL_PUBLISH_PAUSED=1',
    '',
  ].join('\n');
}

/**
 * The server's environment. mode 'bundled' runs the server inside the app with its data in
 * ~/Library/Application Support/Signal; mode 'checkout' runs `next start` in a Signal folder
 * (SIGNAL_APP_DIR), which keeps using that folder's own .env.local and data. `user` (signal.env) wins over
 * the inherited environment, and both win over the folder's .env.local (@next/env never overwrites a
 * variable that is already set). The app then fixes what it must own: the bind address and, in bundled
 * mode, the login, the session and the data paths for this launch.
 * `tokenKey` is a string or a function; a function is called only when no SIGNAL_TOKEN_KEY is
 * provided (so the Keychain item is not created needlessly).
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
    env.SIGNAL_DATA_DIR = user.SIGNAL_DATA_DIR || path.join(userData, 'data');
    env.SIGNAL_CONFIG_FILE = user.SIGNAL_CONFIG_FILE || path.join(userData, 'signal.config.json');
    env.SIGNAL_PROMPTS_DIR = user.SIGNAL_PROMPTS_DIR || path.join(serverDir, 'agents');
  }
  // A checkout keeps its own key in .env.local (it decrypts tokens saved earlier): never replace it.
  // Otherwise signal.env, the app-config env or the launch environment may provide one; only without
  // any of them is the Keychain key created.
  if (!env.SIGNAL_TOKEN_KEY && !appEnvNames.has('SIGNAL_TOKEN_KEY')) {
    const key = typeof tokenKey === 'function' ? tokenKey() : tokenKey;
    if (key) env.SIGNAL_TOKEN_KEY = key;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { fallbackPath, loginShellPath, mergePath, parseEnvFile, readEnvFile, resolveMode, serverEnv, signalEnvTemplate };
