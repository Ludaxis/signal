# Signal for Mac

The Mac app runs the same Studio as `npm run dev`, but in its own window and with access to your Mac:
project folders, Figma and the Claude Code / Codex CLIs you already use.

## Build it

On the Mac (Apple Silicon), in the Signal folder:

```sh
npm install
npm run app:build
```

This builds a self-contained server (`SIGNAL_STANDALONE=1 next build`), copies it into
`desktop/app-server`, and packages `desktop/dist/Signal-<version>-arm64.dmg` (plus a `.zip`).
Open the dmg and drag Signal to Applications. The build is unsigned (ad-hoc signed only), so it is
meant for your own Mac. Intel Macs: `npm run app:prepare && npm --prefix desktop install && npm --prefix desktop run dist:x64`.

To run a Signal folder you already use (its own `.env.local`, data and settings) instead of the
built-in server, build with `npm run build && node desktop/prepare.mjs --checkout`, then
`npm --prefix desktop install && npm --prefix desktop run dist`. Or set `SIGNAL_APP_DIR=/path/to/signal`
in signal.env. After pulling changes, quit Signal first (it serves that folder's `.next`), run
`npm run build` there, then open Signal again.

While developing the Studio, run `npm run dev` in one terminal and `npm run app:dev` in another. The
window then opens your dev server and you sign in with your normal password.

## Two modes

| | Bundled mode (what `npm run app:build` makes) | Checkout mode |
| --- | --- | --- |
| Server | The standalone server copied into the app | `next start` in a Signal folder, using its `.next` build |
| Config and data | `~/Library/Application Support/Signal` | That folder's `.env.local`, `signal.config.json` and data |
| Sign-in | The app signs the window in with a one-time password made at launch | You sign in once in the window, as for the web version |

The mode is checkout when `SIGNAL_APP_DIR` is set in signal.env, or `desktop/app-config.json` (written
by `prepare.mjs --checkout`) names a folder; signal.env wins. Otherwise it is bundled.

## Where settings come from

Highest first:

1. Keys and switches saved in Connections (`~/.signal/settings.json`, encrypted). Applied inside the
   server when it starts and on every save.
2. signal.env (File → Open Settings File).
3. The env in `desktop/app-config.json` (`prepare.mjs --checkout --env KEY=VALUE`).
4. The environment Signal was launched with.
5. In checkout mode, the folder's `.env.local` (and `.env`, `.env.production`). Next never overwrites a
   variable that is already set, so anything from 2 to 4 hides the same name in `.env.local`.

The app always sets the loopback bind address and port; in bundled mode it also sets the login, the
session and the data paths (`SIGNAL_DATA_DIR`, `SIGNAL_CONFIG_FILE`, `SIGNAL_PROMPTS_DIR`, unless
signal.env sets them).

**Publishing pause**: `SIGNAL_PUBLISH_PAUSED=1` (in signal.env or `.env.local`) or the Publishing switch
in Connections blocks Post now, Upload-Post scheduling, finishing an Instagram publish and every
scheduler tick. Reads still work. The switch you saved in Connections wins over the environment value.

## Where things live

| What | Where |
| --- | --- |
| Settings and keys (same names as `.env.local`) | `~/Library/Application Support/Signal/signal.env` (File → Open Settings File) |
| Feature switches | `~/Library/Application Support/Signal/signal.config.json` (File → Open Feature Switches) |
| Projects, posts, memory | `~/Library/Application Support/Signal/data` (or `SIGNAL_DATA_DIR` in signal.env) |
| Encrypted tokens | `~/.signal` (or `SIGNAL_SECRETS_DIR`) |
| Server log | File → Show Server Log |

Restart Signal (File → Restart Signal) after editing either file. To keep using the data folder of a
checkout, set `SIGNAL_DATA_DIR=/path/to/signal/data` in signal.env.

## How it stays safe

- The server listens on 127.0.0.1 on a random port. The window signs in with a one-time password
  made at launch; other apps on the Mac cannot use your session.
- `SIGNAL_TOKEN_KEY` encrypts tokens such as Figma's. A checkout uses the key in its `.env.local` (it
  decrypts tokens saved earlier) and the app never replaces it. Only when signal.env, the app-config
  env, the launch environment and the folder provide none does the app create one and keep it with
  macOS Keychain, and only at that moment.
- The window only loads the local server. Every other link opens in your browser.
- Feature switches start off, exactly like the web version. Nothing posts, schedules or spends money
  until you turn it on.

## Keys and switches without files

Everything you need for posting can be set in **Connections**, with no file to edit:

- **Posting**: the Publishing and Autopilot switches (the kill switches). They take effect at once
  and override `SIGNAL_PUBLISH_PAUSED` / `SIGNAL_AUTOPILOT_PAUSED`.
- **Keys**: Upload-Post, the media bucket (R2), the Meta app, Higgsfield and the Anthropic API.
  Values are encrypted on this Mac (`~/.signal/settings.json`), active at once, win over
  `.env.local`, and are never shown again. R2 and Upload-Post have a Test button.
- **Features**: every feature switch from signal.config.json, as on/off switches.

## Connections → Workspace

- **Project folders**: link folders with your art, screenshots and notes. Signal lists images,
  videos, design files, docs and fonts, shows thumbnails, and can import the brand from a folder. It
  only reads: nothing in a linked folder is changed, moved or deleted. Hidden folders, `node_modules`
  and build folders are skipped, and files reached through symlinks are not served.
- **Figma**: paste a personal access token (Figma → Settings → Security → Personal access tokens,
  scope `file_content:read`). Link files by URL, pick frames and export them as PNG into the
  project's brand folder (`brand/figma/`). Signal never writes to Figma.
- **Claude Code & Codex**: Signal finds the CLIs on your login shell's PATH (Homebrew, npm and the
  official installers), shows their versions and whether Codex is signed in, and lets you set a full
  path if they live somewhere else. `CLAUDE_BIN` / `CODEX_BIN` in signal.env win over both.

## Known limits

- **Connect with Meta is disabled in the app.** Meta login needs an HTTPS callback, and the app would
  open it in your browser without this session, so it cannot finish. Connect Instagram from the HTTPS
  dev server (`npm run dev:https`, see [instagram-unified-login.md](instagram-unified-login.md)).
  Upload-Post works in the app.
- No auto-update yet: rebuild to update.
