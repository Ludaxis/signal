# Post maker

Post maker turns a reference video into a short vertical video post. You drop a reference (a Reel or TikTok you
downloaded, or an image), Signal reads its structure into a **recipe**, builds a **pipeline** of steps from it, runs
them, and shows the result on **Proof**. When you **Accept**, it becomes one ordinary post package per language in the
Posts board, where the usual approval, fingerprint and posting rules apply.

Everything is **off by default**. The tab appears only while the `postmaker` switch is on, and every paid service has
its own switch and key on top of that. With nothing else switched on, Post maker still runs end to end on **mock**
steps: each mock step makes a stand-in output, every mock video carries a MOCK watermark on every frame, and a run with
any mock step can only be accepted **as a draft**, which proves the template but never makes a post.

Contents: [concepts](#concepts) · [the screens](#the-screens) · [switches, keys and the decision point](#switches-keys-and-the-decision-point)
· [costs and caps](#costs-and-caps) · [quality bar](#quality-bar) · [Persian](#persian) · [storage](#storage)
· [rendering](#rendering) · [running the slice](#running-the-slice) · [packs](project-pack-format.md).

## Concepts

| Term | What it is |
|---|---|
| Reference | The video or image you start from. Signal keeps its structure (beats, timing, shot types, on-screen text it detects), never its footage, music or characters. You say whether you own it or only use its structure. |
| Recipe | The structure Signal read from the reference: languages, length, shape, beats (time, purpose, on-screen text), style and the assets the video needs. You can edit beats or regenerate one with a note. |
| Pipeline | The step graph the recipe builds (`story-spine@1`): script, narration text, voice, art, b-roll, lip-sync, music, motion, captions, compose, mix, render, post copy and check. Steps that depend on a language run once per language, as lanes. |
| Step version | Every run of a step writes a new version (v1, v2, …) with its inputs, outputs, connector, cost and time. Versions are never deleted here; you can make an older one current again. |
| Out of date | A step whose inputs changed since its current version. It is derived, never stored; running it again brings it up to date. |
| Run | One execution of some or all steps, with its own cap, events and status. The server keeps working when you leave the tab; coming back reads the live state. |
| Proof | The check step's result: the two renders side by side per language, the verdict, the checks, the sign-off rows and your notes. |
| Template | What Accept leaves behind: the recipe and pipeline, named, so the next post can reuse them. A clean Accept proves it; Accept as draft keeps it as a draft. |
| Pack | An optional, read-only folder with a project's art, characters, fonts, voices, pronunciation, house style, templates and claims policy. See [project-pack-format.md](project-pack-format.md). |

Step statuses: Not run, Queued, Running, Done, Needs you, Failed, Skipped, Off (the step would run as a mock), and
Out of date.

## The screens

The Post maker tab has a home and a stepper: **Reference · Recipe · Pipeline · Proof** (a fifth item, Proven, is
shown but stays disabled: working from proven templates comes in a later release). The URL keeps the place
(`?tab=postmaker&r=<recipe>&s=<screen>&step=<node>`), so reload, deep links and Back work. Each screen has one primary
action.

| Screen | What you do there | Primary |
|---|---|---|
| Home | Drafts (recipes not yet accepted, with how far they got), Proven templates and Runs | Make a post |
| Reference | Drop a video (MP4/MOV up to 500 MB and 300 s) or image (PNG/JPG/WebP up to 20 MB), or paste a page link; pick languages, length and shape; see the cap | Make it |
| Recipe | Read and edit the beats on a timeline strip, the style and the assets needed (Have / Make / Missing) | Use this recipe |
| Pipeline | Step cards (one per kind, language lanes inside) with status, version, cost and provider; Edit opens the step drawer, plus Regenerate, Regenerate from here, Versions, Lock and Skip | Run ‹n› steps, or Go to proof |
| Proof | The 9:16 player with the beat strip and safe-zone overlay, the verdict, the 12 criteria, notes pinned to a time, the Persian sign-off rows | Accept, or Accept as draft |
| Runs | Every run with its trigger, steps, cost, time and status; a row opens the run drawer | Run again |

**Make it** runs from the reference straight to Proof unless you tick **Stop after the recipe**. Long actions answer at
once with a run id; the screen polls every second while the run goes and every five seconds while it waits on a pause.
The **run bar** under the stepper says which step is running, what was spent of the cap, and offers the one way on
from a pause: Continue run after an edit or a sign-off, Raise cap or Stop at the cap.

**Regenerate** asks first. The dialog lists what the step keeps (fixed inputs), what later steps expect (checked by
default; unchecking one lets that expectation break, with a warning), and the cost and the steps that will go out of
date, before you click. **Versions** compares two versions as two synced players, or as a word diff for text.

**Today** lists runs that need you (Proof ready, a pause, a failure) above the posts, and the nav shows their count.
Keys: ⌘1…⌘0 move between tabs, ⌘N makes a post, ⌘[ and ⌘] move along the stepper, and `?` lists the rest.
Single-key shortcuts work only outside text fields and can be turned off.

### Accept

- **Accept** (clean) needs: no mock step, a check verdict of Premium or Standard, and, for Persian, both sign-offs
  (text and listening) by a named person on the current versions. It writes one ready package per language with a
  `postmaker.json` lineage record; the package is approvable only while that record matches its files and the
  `postmaker` switch is on.
- **Accept as draft** is always possible at Proof. It saves the template as a draft and makes **no package**.
- When `signal.config.json` has a `contentGenerators` list, a clean Accept also needs `postmaker` in it. Without the
  list, every generator may be approved.

## Switches, keys and the decision point

All switches live in `signal.config.json` → `features` (or `SIGNAL_FEATURE_<NAME>=1` in the environment) and are off
on a fresh install. Keys are saved on the Connections screen (encrypted on this computer) or set in the environment.

| Switch | What it allows | Key |
|---|---|---|
| `postmaker` | The tab, its screens and Today rows, and every action that changes something | — |
| `postmakerElevenlabs` | ElevenLabs voice (paid) | `ELEVENLABS_API_KEY` |
| `postmakerAzureSpeech` | Azure Speech voice (paid) | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` |
| `postmakerSync` | Sync lip-sync (paid) | `SYNC_API_KEY` |
| `postmakerHedra` | Hedra lip-sync (paid) | `HEDRA_API_KEY` |
| `postmakerHiggsfieldVideo` | Higgsfield video clips for b-roll (paid) | `HF_API_KEY_ID`, `HF_API_KEY_SECRET` |
| `postmakerElevenlabsMusic` | ElevenLabs music (paid) | `ELEVENLABS_API_KEY` |
| `browserAgent` | A browser agent for music sites, only while you watch | — |

Post maker also reuses `agents` and `agentsApiKey` (script, analysis and review agents on your Claude Code sign-in or
your API key), `memory` and `higgsfield`. Turning a paid service on asks once to accept that service's terms; the time
is kept under `postmaker.acceptedTerms` in `signal.config.json` and the question is not asked again.

**The decision point.** Before every service call, one function decides, in this order: a binding blocked in code →
the kill switch → the connector's switch → its key → its gate refs (existing switches, or the terms you accepted) →
attendance (some connectors run only while you are at the screen). If any of these fails, the step runs its mock, or
refuses when the step needs a live result. Nothing is cached between calls.

**Kill switch.** Connections → Post maker → pause, or `SIGNAL_POSTMAKER_PAUSED=1`, stops every Post maker service
call at once, whatever the other switches say.

**While `postmaker` is off**, the API answers every action except the estimate with 403 and the message "Post maker is
switched off. Turn it on in Connections to make or change posts." Reading the home list, recipes, runs and media keeps
working.

Connections shows one **Making** row per capability (voice, lip-sync, music, video, images, agents, rendering) with
its primary connector's state and switch; the alternatives sit in the row's drawer. Each drawer has a free **Check**.

## Costs and caps

Every run has a **cap** in USD. Make it suggests the estimate × 1.25, rounded up to $0.50 ("Mock only · $0.00" while
every step would run as a mock). Before each paid call the runner reserves the call's upper bound against:

1. the run's cap (the run pauses with "Raise cap" when it would pass it),
2. the project's day ceiling (default $20 per project day, in the project's time zone), and
3. an optional per-connector day cap: `"postmaker": { "dayCapUsd": { "elevenlabs": 5 } }` in `signal.config.json`.

After the call the reservation settles to the real cost in the ledger. An estimate is bound to a token, so a run or
regenerate never starts on an estimate that changed since you saw it (the API answers 409 and the dialog shows the
new one).

## Quality bar

The **check** step scores each language on 12 criteria (1-5, each with an evidence note): C1 hook strength, C2
readability at phone size, C3 safe zones and crops, C4 typography craft, C5 motion craft, C6 pacing and rhythm, C7
brand consistency, C8 language correctness, C9 audio craft, C10 story and message clarity, C11 AI disclosure, rights
and provenance, C12 accessibility. C3, C8 and C11 are **hard gates**.

| Verdict | Rule |
|---|---|
| Premium | Hard gates 5, every other applicable criterion ≥ 4, mean ≥ 4.4 |
| Standard | Hard gates 5, every other ≥ 3, mean ≥ 3.6 |
| Regenerate | Any hard gate below 5, any criterion ≤ 2, or a mean below 3.6 |
| Unscored | No reviewer scores yet: score it by hand on Proof (a live run only), or Accept as draft |

A two-language run reads as its weaker language. Deterministic checks run beside the rubric: safe zones (on the
1080 × 1920 Reel canvas the top 268 px, the bottom 420 px and 60 px at each side stay clear of text), the type scale,
contrast, caption coverage, flashes, pacing, loudness (−14 LUFS integrated, true peak ≤ −1.0 dBTP) and the AI label
on the first and last frames.

## Persian

Persian is first-class. Every narrated line has three texts: `display` (what is on screen), `pron` (the canonical
pronunciation: numbers spelled out, ezafe and homograph vowels marked) and the per-voice text sent to the voice
service, derived from `pron`. A normaliser and a linter keep spelling consistent; a project pack can add a
pronunciation lexicon and a house style.

Every Persian form stays a **proposal** until the owner, or a reader they name, signs it: the text gate after the
narration text, and the listening gate after the voice. Agents and mock runs never sign. The full writing guide is
[persian.md](persian.md).

## Storage

Post maker writes beside the project's posts folder, never inside the app folder:

```
<content parent>/postmaker/
  objects/sha256/<2>/<sha>      every output, content-addressed
  recipes/<rc-…>/               recipe.json, recipe/vN.json, pipeline/vN.json, steps/<node>/vN.json + head.json,
                                notes.json, signoffs.jsonl
  refs/<ref-…>/ref.json         references (the file itself is an object)
  runs/<run-…>/                 run.json, events.jsonl, work/
  templates/<tpl-…>.json        accepted templates
  assets/library.json           assets made for this project
  ledger.jsonl                  reservations and settled costs
  pack-lock.json                hashes of the pack files read
```

`<content parent>` is the folder that holds the project's posts folder. The media route serves only objects that the
requested recipe references, so a hash from another recipe answers 404.

## Rendering

Videos are drawn by two compositions (`StorySpine` for the picture, `AudioMaster` for the mix) in a child process,
never inside the Next.js server. Real renders need the optional render workspace, which installs Remotion:

```sh
cd render && npm install
export SIGNAL_RENDER_BROWSER=/path/to/chrome-headless-shell   # or: npm --prefix render run browser:ensure
```

**Licence:** Signal's code is MIT; Remotion is published under its own licence. Check Remotion's current licence
before commercial renders. See [render/README.md](../render/README.md).

Without the workspace, the render steps run their stand-ins (a two-frame placeholder) and Connections lists the
renderer as Not installed. The unit tests render the compositions to static HTML against a small stub, so CI never
needs Remotion or a browser.

## Running the slice

The slice is the end-to-end check on your computer: the fixture pack (a fictional word-game brand), a synthetic
10-second reference, Make it with every connector off, and two real 30 s renders (Persian and English).

```sh
npm run postmaker:slice -- --browser /path/to/chrome-headless-shell
```

It runs hermetically (temporary data, secrets and `signal.config.json` with every switch off; no keys; the network is
blocked inside the run) and writes `test-results/postmaker-slice-<date>/`: `video.fa.mp4`, `video.en.mp4`,
`loudness.json`, frame grabs, `stats.json`, `run.json`, `events.json`, `network-guard.json` and `report.md`. The report
checks 1080 × 1920 at 30 fps and 900 frames, loudness, MOCK on every frame, the AI label and an empty network log. It
is marked as an automated run unless you pass `--human-run` and fill in the person section. Options: `--ref <mp4>`,
`--langs fa,en`, `--out <dir>`, `--work <dir>`.

The CI-safe version of the same path (fake renderer, no browser) runs in `npm test`. The real-render suites run only
when asked: `SIGNAL_RENDER=1` for the typography goldens, `SIGNAL_SLICE=1` for the slice (the script sets it).
