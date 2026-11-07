# Signal

**Signal is a self-hosted Instagram content studio with AI agents.** It runs on your own machine, keeps every post in a folder you own, and never publishes anything you did not approve (or explicitly trust it to).

- **Brand import**: read your website or a project folder for colours, fonts, logo, voice and pages.
- **Campaigns**: a strategist agent proposes a strategy (with web research), you approve it, a planner writes a two-week plan of post briefs.
- **Post generators**: website posts from your own pages, Codex CLI image posts from a brief, Higgsfield images and Reels (paid API). Every post lands in Review with an on-image and in-caption AI disclosure.
- **Posts board**: approve with fingerprint checks, post by hand or in one click, confirm Instagram's AI label afterwards.
- **Calendar + scheduler**: drag posts onto days; Signal's own scheduler sends them while it runs, or Upload-Post holds them.
- **Results and comments**: numbers per post from Instagram's API (or Upload-Post analytics), best times and formats, reply / hide / delete comments.
- **Memory and mind map**: a decision map of goals → strategies → pillars → hypotheses → posts, with learnings computed from your results, and a routing "judge" that answers small questions cheaply.
- **Agent team**: nine roles (lead, researcher, strategist, planner, creative producer, motion designer, reviewer, analyst, community manager) on the Claude Agent SDK with hard tool allow-lists and budgets. Nothing in the team can publish.
- **Autopilot with trust**: once a day, make the planned posts; a format earns trust after five of your approvals in a row and only then may autopilot approve and schedule it, with a daily budget, a backlog limit and a one-click "pull".
- **Pipelines** (until you move them into Post maker): one chain per pipeline (Source → Make → Review → Approve → Schedule, with a budget) that runs inside the daily autopilot run without a campaign: new website pages, your own topic list, AI-written ideas or a campaign's plan, on the days and times you pick. With Post maker on, **Move my pipelines** turns each one into a proven template with Repeat (Post maker › Proven › Repeat), and the Pipelines tab goes away once nothing is left in it.
- **Post maker** (off by default): drop a reference video, get a recipe and a step pipeline, review the result on Proof, and accept it as one post per language. An accepted proof becomes a proven template: make more posts from it, add variants, attach it to a campaign, and let it repeat on a schedule (Repeat is off by default). Persian and English, with a pronunciation layer for Persian voices. Every paid service has its own switch and key; with none on, every step is a watermarked mock that can only be accepted as a draft.
- **Connections**: every service a project uses on one screen; link or change its Upload-Post profile and flip one-click posting there, without re-entering the posting limits.

## Screenshots

_Coming soon: `docs/screenshots/` is the place for them._

## Requirements

- Node.js 20.9 or newer (`.nvmrc` says 22). npm 10+.
- A Professional (Creator or Business) Instagram account for every project.
- Optional: Claude Code CLI (`claude`), Codex CLI (`codex`), an Anthropic API key, a Meta app, Upload-Post, Cloudflare R2, Higgsfield keys. Each unlocks one part; the app works without them for making and approving posts by hand.

Signal uses `sharp` (prebuilt) and `ffmpeg-static` (bundled binary); no system packages are needed on Linux/macOS/Windows x64 and arm64.

## Quick start

```bash
git clone <this repository> signal && cd signal
npm ci
cp .env.example .env.local                 # set SIGNAL_OWNER_PASSWORD (8+ characters)
cp signal.config.example.json signal.config.json   # everything is off; turn on what you need
npm run dev                                # http://localhost:3000
```

Sign in with the owner password, create a project (name + Instagram handle), set its posting limits, and you have a Posts board. Import your website on the Brand screen to make the first website post. Posting itself needs a connection (see below).

### Pipelines

A pipeline makes posts by itself, on a schedule, without a campaign plan. On the **Pipelines** screen, answer three questions (where ideas come from, what kind of post, how often) and the rest has a working default. Each card shows its chain as chips: **Source** (new website pages, your own topic list, AI-written ideas, or a campaign's planned slots) → **Make** (a post type, with an optional prompt template using `{topic}`, `{brand}`, `{tone}`) → **Review** (the AI reviewer) → **Approve** (ask you, or trusted post types publish by themselves) → **Schedule** (posts per week, days, times in the Studio time zone, make-ahead days), plus a daily budget behind **More**.

Pipelines run inside the daily autopilot run under exactly the same rules: the `autopilot` switch, the pause switches, the budget checked before each step, the backlog limit, trust, and never Codex without a button press (**Run now** on the card runs that one pipeline, Codex included). Every post lands in Review with "Made by autopilot" and the pipeline's name on its card. Pipelines live in `<project folder>/pipelines/<id>.json`; the runner's state (next topic, queued ideas, last result) in `<id>.state.json`. Removing a pipeline archives the file; its posts stay.

**Moving pipelines into Post maker.** With Post maker on, Post maker's home shows one row, **Move my pipelines (n)**.
The move is one-time and started only by you: it copies `pipelines/` byte for byte into `pipelines/.backup-<time>/`,
turns each pipeline into a template with Repeat equal to its schedule, budget and approval (Post maker › Proven, pill
**Moved**), copies its runner state, and marks the pipeline file `archived: true` without changing anything else in it.
Moved templates pause until Repeat is on. Pipelines that already make posts from a template, and pipelines whose post
type needs Codex at your desk, are not moved and keep the Pipelines tab (with the reason). **Undo** never deletes: the
moved templates go to `templates/.undone-<time>/` and the pipeline files come back from the backup byte for byte. Once
no pipeline is left, the nav has no Pipelines item and `?tab=pipelines` opens Post maker › Proven.

### Post maker

Turn on `postmaker` (Connections → Features, or `"postmaker": true` in `signal.config.json`) and the **Post maker** tab
appears. Drop a reference video or image, choose the languages, length and cap, and press **Make it**: Signal reads the
reference into a recipe (beats, style, assets), builds a pipeline (script, narration, voice, art, music, motion,
captions, compose, mix, render, post copy, check) and runs it to **Proof**, where the check scores it on twelve
criteria. **Accept** writes one ready post package per language to the Posts board; nothing is posted from Post maker.

What is real and what is mock:

- With only `postmaker` on, every step that needs a service runs as a **mock**: placeholder outputs, and a MOCK
  watermark on every frame of every video. A run with any mock step can only be **accepted as a draft**, which keeps
  the template and makes no post.
- Each paid service has its own switch (table below) and key (Connections → Keys), and asks once to accept that
  service's terms when you turn it on. Every run has a cap, each project a day ceiling, and each connector an optional
  day cap (`"postmaker": { "dayCapUsd": { "elevenlabs": 5 } }`). `SIGNAL_POSTMAKER_PAUSED=1` stops every Post maker
  service call.
- Persian lines are signed by the owner, or a reader they name, before a clean Accept; agents never sign.
- Real video renders need the optional render workspace: `cd render && npm install`, plus a Chrome Headless Shell
  (`SIGNAL_RENDER_BROWSER`, or `npm --prefix render run browser:ensure`). Without it, renders stay mock and Connections
  shows the renderer as Not installed. Remotion has its own licence, which is not MIT: **check Remotion's current
  licence before commercial renders** ([render/README.md](render/README.md)).
- An accepted proof is a **proven template** (Post maker › Proven): **Make a post** forks it with a new brief (the
  locked steps keep their versions; only what depends on the brief runs again) and stops at Proof; **variants** change
  only the declared settings (language, length, shape, hook, voice, music, dual captions) and need their own proof;
  attach it to a campaign, and a campaign slot can name it (**Choose** on the slot, then **Make**).
- With a project pack, the art, animation and sound steps plan from the pack's library (cut-out characters, music
  conformed to the script's tempo, sound effects); without one they stay mocks. Your own music track can be uploaded.
- **Repeat** (off by default) lets a proven template make its own posts inside the daily autopilot run, on the days,
  times and budget you set in its Repeat drawer. It needs the `autopilot` and `postmakerRepeat` switches; each post
  stops at Proof (Today › Needs you) unless **Skip proof for repeat runs** is on for that variant, which unlocks only
  after three Premium, live proofs in a row and holds only while every step is live and the signed Persian text and
  voice are unchanged. Autopilot never approves a Post maker post: you approve it in Review.
- `npm run postmaker:slice -- --browser <chrome-headless-shell>` runs the end-to-end check on your computer with every
  connector off and writes two real 30 s renders and a report to `test-results/`.

Guides: [Post maker](docs/postmaker.md) · [project packs](docs/project-pack-format.md) (art, fonts, voices, templates,
claims for one project) · [Persian writing guide](docs/persian.md).

For a production build: `npm run build && npm start`.

### HTTPS in development

Meta's login callback must be `https://`. Make a local certificate (for example with `mkcert`), put the files where `SIGNAL_DEV_CERT_KEY` / `SIGNAL_DEV_CERT` point (default `~/.signal/certs/signal-dev-key.pem` and `signal-dev.pem`), set `SIGNAL_DEV_HOST=<your-dev-hostname>` and run `npm run dev:https`. Use the same hostname in `META_REDIRECT_URI`.

## Mac app

Run Signal as a Mac app with project folders, Figma and your Claude Code / Codex CLIs:
`npm run app:build`, then open `desktop/dist/Signal-*.dmg`. See [docs/mac-app.md](docs/mac-app.md).

## Configuration

Two files, both git-ignored: `.env.local` (secrets and locations) and `signal.config.json` (feature switches). `SIGNAL_FEATURE_<NAME>=1` in the environment overrides a switch.

### Feature switches (`signal.config.json` → `features`)

All **off** by default. Each one is checked at the moment it would matter and the UI shows the exact message to turn it on.

| Switch | What it allows | Costs money? |
| --- | --- | --- |
| `instagramApi` | Posting, results and comments through the Instagram API for connected accounts | No |
| `unifiedLogin` | Connecting accounts with Meta Unified Login from the Connections screen | No |
| `scheduler` | Signal's own minute scheduler sends scheduled posts while the app runs | No |
| `agents` | Strategist / planner runs on your Claude Code CLI sign-in, on a button press | Your subscription |
| `agentsApiKey` | Bill agent runs to `SIGNAL_ANTHROPIC_API_KEY` (required by the agent team and the judge) | Yes |
| `memory` | Project memory, decision map, learnings and the agent team | Judge calls, agent runs |
| `autopilot` | The daily unattended run (makes planned posts; still stops in Review) | Agent runs, Higgsfield |
| `trustedPublish` | Autopilot may approve and schedule posts of trusted formats | — |
| `higgsfield` | Higgsfield images and Reels | Yes, per request |
| `uploadPostResults` | Read post results from Upload-Post | No |
| `uploadPostScheduling` | Schedule posts on Upload-Post (posts while your machine is off) | No |
| `uploadPostProfiles` | Create / inspect Upload-Post profiles from the project wizard | No |
| `postmaker` | The Post maker tab and every Post maker action (mock steps only, until a service below is on) | No |
| `postmakerRepeat` | Proven templates with Repeat on make their posts in the daily autopilot run (needs `autopilot`) | What their steps cost |
| `postmakerElevenlabs` | ElevenLabs voices for Post maker (`ELEVENLABS_API_KEY`) | Yes |
| `postmakerAzureSpeech` | Azure Speech voices for Post maker (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`) | Yes |
| `postmakerSync` | Sync lip-sync for Post maker (`SYNC_API_KEY`) | Yes |
| `postmakerHedra` | Hedra lip-sync for Post maker (`HEDRA_API_KEY`) | Yes |
| `postmakerHiggsfieldVideo` | Higgsfield video clips for Post maker b-roll (the Higgsfield keys) | Yes |
| `postmakerElevenlabsMusic` | ElevenLabs music for Post maker (`ELEVENLABS_API_KEY`) | Yes |
| `browserAgent` | A browser agent on music sites, only while you watch | Depends on the site |

Optional, beside `features`: `"contentGenerators": [...]` limits which package generators may be approved (absent:
all of them), and `"postmaker"` holds the per-connector day caps and the terms you accepted.

Per-account limits (posts per day, total posts, optional end date, the one-click posting switch and Codex images) are set in the app under **Manage projects → Set posting limits** after typing the handle, and stored in `data/accounts.json`.

### Environment variables (`.env.local`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGNAL_OWNER_PASSWORD` | — | **Required** unless the next one is set. The only login. 8+ characters. |
| `SIGNAL_LOCAL_ONLY_NO_PASSWORD` | `0` | `1` = no password, accepted only from loopback over plain http. |
| `SIGNAL_SESSION_SECRET` | random per start | Signs the session cookie. Set it so sessions survive restarts. |
| `SIGNAL_WEB_ORIGIN` | request origin | The only accepted `Origin` for mutating requests (behind a reverse proxy). |
| `SIGNAL_CONFIG_FILE` | `./signal.config.json` | Feature switches file. |
| `SIGNAL_DATA_DIR` | `./data` | `projects.json`, `accounts.json`, default content folders (`projects/<id>/posts`, `campaigns`, `brand`, `memory`). |
| `SIGNAL_SECRETS_DIR` | `~/.signal` | Encrypted Instagram tokens. |
| `SIGNAL_PROMPTS_DIR` | `./agents` | Optional prompt overrides (see `agents/README.md`). |
| `SIGNAL_PROJECTS_FILE`, `SIGNAL_ACCOUNTS_FILE` | in the data dir | Override the two data files. |
| `SIGNAL_CONTENT_DIR`, `SIGNAL_PROJECT_ID`, `SIGNAL_PROJECT_NAME`, `SIGNAL_PROJECT_HANDLE`, `UPLOAD_POST_PROFILE` | — | Single-project mode without the wizard (used until `projects.json` exists). |
| `NEXT_PUBLIC_SIGNAL_TIME_ZONE` | `UTC` | IANA zone for calendar days, posting times and the autopilot window. Set it before `npm run build`. |
| `SIGNAL_PUBLISH_PAUSED` | `0` | `1` = nothing is posted or scheduled anywhere (reads still work). |
| `SIGNAL_AUTOPILOT_PAUSED` | `0` | `1` = no automatic runs and no automatic approvals. |
| `SIGNAL_POSTMAKER_PAUSED` | `0` | `1` = no Post maker service call (steps run as mocks, or stop where they need a live result). |
| `ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `SYNC_API_KEY`, `HEDRA_API_KEY` | — | Post maker voice and lip-sync services (or save them in Connections → Keys). |
| `SIGNAL_RENDER_BROWSER` | — | The Chrome Headless Shell program file for real Post maker renders. |
| `SIGNAL_RENDER_SERVICE_DIR`, `SIGNAL_RENDER_CACHE_DIR` | `./render`, system temp | The render workspace and the render bundle cache. |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_REDIRECT_URI`, `SIGNAL_TOKEN_KEY`, `META_GRAPH_VERSION` | — / `v26.0` | Meta Unified Login; see the provider guide. |
| `INSTAGRAM_TOKEN_<PROJECT_ID>`, `INSTAGRAM_API_VERSION` | — | Legacy Instagram Login: one long-lived token per project. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE` | — | Cloudflare R2 for short-lived public media links while posting through Instagram's API. |
| `UPLOAD_POST_API_KEY` | — | Upload-Post. |
| `SIGNAL_ANTHROPIC_API_KEY` | — | Your Anthropic key for agent runs (with `agentsApiKey`), the agent team and the judge. |
| `CLAUDE_AGENT_MODEL`, `SIGNAL_TEAM_MODEL_OPUS/SONNET/HAIKU`, `SIGNAL_JUDGE_MODEL` | provider defaults | Model choices. |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | CLI paths. |
| `HF_API_KEY_ID`, `HF_API_KEY_SECRET` | — | Higgsfield. |
| `SIGNAL_DEV_HOST`, `SIGNAL_DEV_CERT_KEY`, `SIGNAL_DEV_CERT` | — | HTTPS dev server (above). |
| `SIGNAL_MEDIA_ORIGIN` | — | Extra origin allowed for images/media in the CSP. |
| `SIGNAL_ALLOW_PRIVATE_FETCH` | `0` | `1` lets the brand importer read private-network addresses (local test sites). |

## Provider setup guides

### Meta app (Instagram API with Unified Login)

1. In [Meta for Developers](https://developers.facebook.com/) create an app of type **Business** and add the **Instagram** product with **Facebook Login for Business**.
2. Create a login configuration (Unified Login / Business Integration System User token) that requests **`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`**. Note its configuration ID.
3. Add `https://<your host>/api/studio/instagram/callback` to the valid OAuth redirect URIs (https only; use the HTTPS dev server locally).
4. The Instagram account must be a Professional account inside a business portfolio the login can see.
5. Set `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_REDIRECT_URI`, `SIGNAL_TOKEN_KEY` (`openssl rand -base64 32`); turn on `unifiedLogin` and `instagramApi`; press **Connect** on the Connections screen.
6. While the app is in development mode only accounts with a role on the app can connect; App Review is needed for others.

Step by step: [docs/instagram-unified-login.md](docs/instagram-unified-login.md). The legacy **Instagram Login** path (a long-lived token you paste as `INSTAGRAM_TOKEN_<PROJECT_ID>`) still works for a single account.

### Upload-Post

Create an account at upload-post.com, make a profile per Instagram account and connect Instagram inside it, copy the API key into `UPLOAD_POST_API_KEY` and the profile username into the project. Turn on `uploadPostScheduling` and/or `uploadPostResults` as needed. The free plan allows a couple of profiles.

With `uploadPostProfiles` on, the **Connections** screen manages the profile per project: **Connect** / **Change profile** lists the profiles on your plan (or creates one and opens Upload-Post's own Instagram connect page), links the chosen username to the project (it must exist on the plan; nothing is created or deleted at Upload-Post by linking) and remembers the Instagram handle it saw; **Check** re-reads the profile; **Remove** unlinks it from the project only. The **Use for posting** switch on the same card is the account's one-click posting switch in `data/accounts.json` (Instagram's API first, Upload-Post as fallback): switching it on needs active posting limits, switching it off always works. The project wizard uses the same picker.

### Cloudflare R2

Instagram's API downloads media from a public URL. Create a bucket, enable public access (the public development subdomain or a custom domain) and an API token with object read/write. Fill the five `R2_*` variables. Signal uploads the approved files under unguessable keys just before publishing and deletes them afterwards.

### Anthropic API key (agent team, judge, paid agent runs)

Create a key at console.anthropic.com, set `SIGNAL_ANTHROPIC_API_KEY`, turn on `memory`, `agents` and `agentsApiKey`. Every run has a per-role budget cap and shows its cost. Without `agentsApiKey`, the strategist and planner use your Claude Code sign-in instead.

### Claude Code CLI and Codex CLI

Install and sign in to each (`claude`, `codex login`). Signal runs them in empty temporary folders with no file or shell tools. Codex image posts are enabled per account (the **Codex images** box in the posting limits) and only run when you press Generate.

### Higgsfield

Create API keys on higgsfield.ai and set `HF_API_KEY_ID` / `HF_API_KEY_SECRET`; turn on `higgsfield`. Every package records the request ids and an estimated spend; the Reel video price is a deliberately high placeholder estimate until you check your billing page.

## Safety defaults

- Every switch above is **off** on a fresh install; the app explains which one to turn on at the exact point it is needed.
- A post is published only after a human approval of the exact bytes (SHA-256 fingerprints), or by autopilot for a format you trusted after five approvals in a row, with review required, a daily budget, a backlog cap and a pull button.
- One dispatch per approval (claimed with an exclusive file write): double clicks and concurrent requests cannot post twice. Unclear provider answers are marked *uncertain* and never retried automatically.
- `SIGNAL_PUBLISH_PAUSED=1` and `SIGNAL_AUTOPILOT_PAUSED=1` stop everything at once.
- Per-account limits (posts per day, total, optional end date) are enforced on approval, scheduling and sending.
- Secrets never reach the browser; tokens are encrypted at rest; provider messages are redacted.

## Costs

Signal itself is free. What can cost money, and only when switched on: Anthropic API usage (agent team, judge, paid agent runs; budgets per run), Higgsfield requests (per image / video), Post maker's voice, lip-sync, music and video services (a cap per run, a day ceiling per project), Upload-Post plans beyond the free tier, Cloudflare R2 (negligible), and your own Claude / Codex subscriptions.

## Limitations

- Instagram only (feed images, carousels, Reels). TikTok / YouTube are not supported.
- One owner, one password; no roles, no multi-user.
- Runs on your machine: scheduled posts go out only while the app is running (or use Upload-Post scheduling); a missed time waits for you.
- Meta app review, Instagram's own rate limits and policies apply.

## Development

```bash
npm run lint       # eslint (next/core-web-vitals + typescript + jsx-a11y)
npm run typecheck  # next typegen && tsc
npm test           # vitest (no network; every provider is faked)
npm run build      # next build (webpack)
```

Docs: [architecture](docs/architecture.md) · [Post maker](docs/postmaker.md) · [project packs](docs/project-pack-format.md) · [Persian writing guide](docs/persian.md) · [memory and agent team](docs/memory-and-agent-team.md) · [autopilot and pipelines](docs/autopilot.md) · [loading states](docs/loading-states.md) · [Instagram Unified Login runbook](docs/instagram-unified-login.md).

`npm test` never starts a browser or Remotion: the Post maker compositions are tested as static HTML against a stub,
and renders use a fake. The real-render suites run only on request (`SIGNAL_RENDER=1`, or `npm run postmaker:slice`).

## Not affiliated

Signal is an independent open-source project. It is not affiliated with, endorsed by or connected to Meta Platforms, Instagram, or Signal Messenger / Signal Technology Foundation. Instagram and Meta are trademarks of Meta Platforms, Inc.

## Third-party components

- **Fonts** in `public/fonts/` (Vazirmatn, Estedad, Instrument Sans) are under the SIL Open Font License 1.1, not MIT.
  Each keeps its `OFL.txt` beside it; `public/fonts/fonts.lock.json` pins their files.
- **Remotion** is not part of Signal's dependencies. The optional `render/` workspace installs it on request; it has
  its own licence. Check Remotion's current licence before commercial renders.

## License

MIT — see [LICENSE](LICENSE). Third-party components keep their own licences (above).
