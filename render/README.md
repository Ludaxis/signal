# Render workspace (optional)

Post maker draws its videos with [Remotion](https://www.remotion.dev). Remotion is **not** part of Signal's own
dependencies: this folder installs it, only on computers that make real renders. Without it, Signal still runs every
Post maker step; renders stay mock (watermarked MOCK, never accepted as a post), and Connections lists the render
connector as **Not installed**.

## Licence

Signal's own code is MIT. Remotion is published under its own licence, which is not MIT. **Check Remotion's current
licence before commercial renders.** Installing this folder is your choice and your responsibility.

## Install

```sh
cd render
npm install                 # Remotion, its bundler and renderer, React (exact versions in package.json and package-lock.json)
npm run browser:ensure      # optional: Remotion's own Chrome Headless Shell (a download)
```

Instead of `browser:ensure`, you can point Signal at a Chrome Headless Shell you already have:

```sh
export SIGNAL_RENDER_BROWSER=/path/to/chrome-headless-shell   # the program file, not its folder
```

Signal never downloads a browser on its own. Without either, a render answers "The render browser is not installed on
this computer."

## How it is used

- The compositions live in `lib/studio/postmaker/render/compositions` (StorySpine for the video, AudioMaster for the
  mix). They import `remotion`, so the app's typecheck leaves them out; the unit tests render them to static HTML
  against a small stub.
- A render runs in a child process (`node lib/studio/postmaker/render/child.ts <job>`), never inside the Next.js
  server. The child resolves Remotion from this folder's `node_modules` and gets only `PATH`, `HOME` and `TMPDIR`.
- `SIGNAL_RENDER_SERVICE_DIR` moves this folder; `SIGNAL_RENDER_CACHE_DIR` moves the bundle cache (default: the system
  temp folder).

## Check it

```sh
npm run postmaker:slice -- --browser /path/to/chrome-headless-shell
```

runs the fixture slice with every connector off: make it to Proof, two real 30 s renders (Persian and English,
1080×1920), loudness, frame grabs and a report under `test-results/` (not committed). See
[docs/postmaker.md](../docs/postmaker.md#running-the-slice).
