// Signal for Mac: starts the Studio server on 127.0.0.1 (a random free port), signs this window in
// with a one-time password, and opens Signal in its own window.
//
// - Your data lives in ~/Library/Application Support/Signal (data/, signal.config.json, signal.env).
//   Put the same keys you would put in .env.local into signal.env (File → Open Settings File).
// - Or set SIGNAL_APP_DIR=/path/to/signal in signal.env (or build with `prepare.mjs --checkout`):
//   the app then runs `next start` in that folder, with that folder's own .env.local and data.
// - SIGNAL_TOKEN_KEY (encrypts tokens such as Figma's) is created once and kept with macOS Keychain
//   (Electron safeStorage), unless you set your own in signal.env.
// - The window can only talk to the local server. Other links open in your browser. Nothing here
//   posts, schedules or spends anything: the Studio's own switches and approvals still apply.
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, session, shell, utilityProcess } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { loginShellPath, readEnvFile, serverEnv } = require('./env.cjs');

const DEV_URL = process.env.SIGNAL_DESKTOP_URL || '';
let server = null;
let origin = '';
let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

const userData = () => app.getPath('userData');
const envFile = () => path.join(userData(), 'signal.env');
const serverDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, 'app-server'));
/** desktop/app-config.json ({"appDir": "/path/to/signal"}) is written by `prepare.mjs --checkout`. */
function appConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'));
  } catch {
    return {};
  }
}
const logFile = () => path.join(userData(), 'logs', 'server.log');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 32 random bytes, kept encrypted by macOS Keychain (safeStorage). Created on first launch. */
function tokenKey() {
  const file = path.join(userData(), 'token-key.bin');
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    if (fs.existsSync(file)) return safeStorage.decryptString(fs.readFileSync(file));
    const key = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(userData(), { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    return key;
  } catch {
    return '';
  }
}

function ensureFiles() {
  fs.mkdirSync(path.join(userData(), 'logs'), { recursive: true });
  if (!fs.existsSync(envFile())) {
    fs.writeFileSync(
      envFile(),
      [
        '# Signal for Mac: settings and keys (same names as .env.local). Restart Signal after editing.',
        '# This file stays on this Mac. Never share it.',
        '# UPLOAD_POST_API_KEY=',
        '# CLAUDE_BIN=/opt/homebrew/bin/claude',
        '# CODEX_BIN=/opt/homebrew/bin/codex',
        '# NEXT_PUBLIC_SIGNAL_TIME_ZONE=Europe/Tallinn',
        '# Run a Signal folder (its own .env.local and data) instead of the built-in server:',
        '# SIGNAL_APP_DIR=/Users/you/signal',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  const cfg = path.join(userData(), 'signal.config.json');
  const example = path.join(serverDir(), 'signal.config.example.json');
  if (!fs.existsSync(cfg) && fs.existsSync(example)) fs.copyFileSync(example, cfg);
}

async function waitForHealth(url, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!server && !DEV_URL) throw new Error('The Signal server stopped while starting. See the log.');
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('The Signal server did not start in time. See the log.');
}

async function startServer() {
  ensureFiles();
  const user = readEnvFile(envFile());
  const appDir = user.SIGNAL_APP_DIR || appConfig().appDir || '';
  const mode = appDir ? 'checkout' : 'bundled';
  const dir = appDir || serverDir();
  let entry;
  let args = [];
  const port = await freePort();
  if (mode === 'checkout') {
    if (!fs.existsSync(path.join(dir, '.next', 'BUILD_ID'))) throw new Error(`No production build in ${dir}. Run "npm run build" there first.`);
    entry = require.resolve('next/dist/bin/next', { paths: [dir] });
    args = ['start', '-H', '127.0.0.1', '-p', String(port)];
  } else {
    entry = path.join(dir, 'server.js');
    if (!fs.existsSync(entry)) throw new Error(`The Studio server is missing (${entry}). Run "npm run app:prepare" first.`);
  }
  const appEnvNames = new Set(mode === 'checkout' ? ['.env', '.env.production', '.env.local', '.env.production.local'].flatMap((f) => Object.keys(readEnvFile(path.join(dir, f)))) : []);
  const ownerPassword = crypto.randomBytes(24).toString('base64url');
  const env = serverEnv({
    base: process.env,
    user,
    userData: userData(),
    serverDir: dir,
    port,
    ownerPassword,
    sessionSecret: crypto.randomBytes(32).toString('base64url'),
    tokenKey: tokenKey(),
    pathValue: loginShellPath(process.env),
    mode,
    appEnvNames,
  });
  if (env.SIGNAL_DATA_DIR) fs.mkdirSync(env.SIGNAL_DATA_DIR, { recursive: true });
  const log = fs.createWriteStream(logFile(), { flags: 'w' });
  server = utilityProcess.fork(entry, args, { cwd: dir, env, stdio: 'pipe', serviceName: 'Signal Studio server' });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox('Signal stopped', `The Studio server exited (code ${code}). The log is in ${logFile()}.`);
      app.quit();
    }
  });
  origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin);
  await signIn(ownerPassword);
}

/** Signs this window in with the one-time password; the session cookie stays httpOnly. */
async function signIn(password) {
  const r = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password }) });
  if (!r.ok) throw new Error(`Signing in to the local server failed (${r.status}).`);
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    await session.defaultSession.cookies.set({ url: origin, name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), httpOnly: true, sameSite: 'strict', expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400 });
  }
}

const sameOrigin = (u) => {
  try {
    return new URL(u).origin === origin;
  } catch {
    return false;
  }
};
const fromApp = (e) => sameOrigin(e.senderFrame?.url || '');

function openOutside(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') void shell.openExternal(url.toString());
  } catch {
    /* ignore */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Signal',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true } } };
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });
  win.on('closed', () => (win = null));
  void win.loadURL(`${origin}/studio`);
}

ipcMain.handle('signal:pick-folder', async (e) => {
  if (!fromApp(e)) return null;
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined, { title: 'Link a project folder', buttonLabel: 'Link folder', properties: ['openDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle('signal:reveal', (e, p) => {
  if (!fromApp(e) || typeof p !== 'string' || !path.isAbsolute(p)) return;
  shell.showItemInFolder(p);
});
ipcMain.handle('signal:open-external', (e, u) => {
  if (fromApp(e) && typeof u === 'string') openOutside(u);
});

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Open Settings File', click: () => void shell.openPath(envFile()) },
        { label: 'Open Feature Switches', click: () => void shell.openPath(path.join(userData(), 'signal.config.json')) },
        { label: 'Show Data Folder', click: () => void shell.openPath(userData()) },
        { label: 'Show Server Log', click: () => shell.showItemInFolder(logFile()) },
        { type: 'separator' },
        { label: 'Restart Signal', click: () => (app.relaunch(), app.quit()) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    if (DEV_URL) {
      origin = new URL(DEV_URL).origin;
      await waitForHealth(origin);
    } else await startServer();
    createWindow();
  } catch (e) {
    dialog.showErrorBox('Signal could not start', String(e && e.message ? e.message : e));
    quitting = true;
    server?.kill();
    app.quit();
  }
});

app.on('activate', () => {
  if (!win && origin) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});
