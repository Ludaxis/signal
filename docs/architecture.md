# Architecture

Signal is one Next.js (App Router) application: a React UI, a set of JSON API routes under `/api/studio/*`, and a server-side library under `lib/studio/` that owns every file on disk and every call to a provider. There is no database and no external Signal service: state is plain files in folders you own.

```
browser ── same origin ──▶ Next.js
   │   /login, /studio            React screens (app/studio/*.tsx)
   │   /api/session               owner sign-in → signed httpOnly cookie
   │   /api/studio/<area>         JSON routes; every one checks origin + session, then runs
   │                               inside the selected project (AsyncLocalStorage)
   └── instrumentation.ts         minute ticks: Signal's scheduler and the autopilot daily run

lib/server/      auth.ts (owner login, HMAC sessions) · session.ts (cookie) · security.ts (same-origin,
                 path guards) · signalConfig.ts (feature switches, data dirs) · studioAuth.ts · studioProject.ts
lib/studio/      projects · content (packages) · generate · render · reel · brand · campaigns ·
                 claude-agent (CLI runs) · team/ (Agent SDK roles, tools, reviewer, analyst) ·
                 memory/ (timeline, decision map, learnings, judge, router, packs) ·
                 autopilot/ (settings, trust, runner, pull) · meta · ig-unified · publish-meta ·
                 dispatch (Upload-Post) · uploadpost · analytics · r2 · higgsfield · codex · safety
```

## Projects and the current project

A project is one Instagram account: `{ id, name, handle, uploadPostProfile, contentDir }`, stored in `<SIGNAL_DATA_DIR>/projects.json`. Every API request names its project (`?project=` or `body.project`); `lib/server/studioProject.ts` resolves it and runs the handler inside `withProject()`, so library code calls `currentProject()` instead of threading a parameter. Without `projects.json`, `SIGNAL_CONTENT_DIR` (plus optional id/name/handle variables) defines a single project.

Per-account posting settings (`accounts.json`): the one-click posting switch, posts per day, total posts, optional end date, Codex images. They are written only from the app after typing the handle and are enforced by `currentLimits()` on approval, scheduling and sending.

## Packages (posts)

A post is a folder `<contentDir>/<NN>/` with `package.json` (title, format, destination handle, file list with SHA-256), the media files, `caption.txt` and `manifest.md`. State is added as small write-once JSON files next to it: `approval.json` (hashes of the approved bytes), `plan.json`, `scheduled.json`, `dispatch.json` (the single-use claim), `outcome.json`, `posted.json`, `label.json`, `discarded.json`, `metrics.json`, `review.json`, `campaign.json`, `autopilot.json`. `loadPackage()` derives the status from which files exist and whether the fingerprints still match; nothing is ever deleted, superseded files are renamed with a timestamp.

## Generators

`lib/studio/generate.ts` makes a package from a brief or a web page: `website-card` (two slides from a page of the imported website), `codex-post` (your Codex CLI draws the image), `higgsfield-image` / `higgsfield-reel` (Higgsfield API; the Reel is normalised to 1080×1920 H.264/AAC with the bundled ffmpeg). `render.ts` draws text as vector paths with the brand font (or the bundled Instrument Sans), adds the brand mark and the "AI-generated content" label.

## Publishing paths

- **Instagram API** (`meta.ts`, `publish-meta.ts`): media are uploaded to R2 under unguessable keys, containers are created, the one `media_publish` call is made, and the files are removed. An unclear answer becomes *uncertain* and is never retried; *Check status* only reads.
- **Upload-Post** (`dispatch.ts`): one multipart request with an idempotency key; scheduling, cancel and move use the provider's job API.
- Both paths re-verify the approved bytes, claim `dispatch.json` with an exclusive write, respect the account limits and `SIGNAL_PUBLISH_PAUSED`.

## Feature switches and kill switches

`lib/server/signalConfig.ts` reads `signal.config.json` (or `SIGNAL_FEATURE_<NAME>` variables). Every module that can spend, publish, schedule or run unattended asks `featureEnabled()` at the moment of use and reports a plain "turn on X" reason when it is off. `SIGNAL_PUBLISH_PAUSED` and `SIGNAL_AUTOPILOT_PAUSED` are read on every tick and before every send.

## Security

Owner login with a constant-time password check, sessions as HMAC tokens in an httpOnly cookie, same-origin checks on mutating requests, per-request CSP nonce (`proxy.ts`), secrets redacted from provider messages, Instagram tokens encrypted at rest (AES-256-GCM), agents in temporary folders with allow-listed environments. See `SECURITY.md`.
