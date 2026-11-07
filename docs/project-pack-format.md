# Project pack format

A **pack** is an optional, read-only folder that fills in Signal's generic core for one project (or a studio's several
projects): art, characters, fonts, voices, pronunciation, house style, starter templates, the claims policy and the
music policy. Post maker reads it; the older image formats read its icon, display font and `formats.json`.

Examples marked **[Example]** are fictional. `{Brand}` and `{Store}` are placeholders you replace with your own names.
The test suite builds a complete example pack from `tests/fixtures/postmaker/pack-example/` (a fictional word game).

## 1. Rules

| Rule | Detail |
|---|---|
| Location | Default `<content parent>/pack/` (the folder beside the project's posts folder). Override per project with the pack folder in the project wizard (`Project.pack = { dir }`), so several projects can share one pack. |
| Read-only | Signal never writes inside a pack. Assets Signal makes and you approve go to `<content parent>/postmaker/assets/` with the same record shape. An id in both libraries is an error. |
| No pack is fine | A project without a pack uses the built-in templates, the core fonts and the brand kit from the Brand screen. |
| Paths | Relative, forward-slash, made of `A-Z a-z 0-9 . _ -` and spaces, no `.` or `..` segment, no leading `/`, no backslash, at most 240 characters. After symlinks a path must still resolve inside the pack. |
| Ids | Pack, voice, template and asset ids are slugs: `^[a-z0-9][a-z0-9-]{0,63}$`. Never reuse an id for different content. |
| Hashes | sha256, 64 lowercase hex characters. |
| Dates | ISO 8601 (`2026-11-06` or `2026-11-06T18:00:00Z`). |
| No personal data | No data about real people (players, buyers, followers), accounting data, credentials or contact details anywhere in a pack. |

## 2. Folder layout

```
<pack>/
  pack.json                         manifest (§3)
  brand/brand.json                  optional brand kit; null in pack.json = use the project's Brand screen (§4)
  voices.json                       voice profiles (§8)
  glossary.json                     names: brand, product, character, person, place, platform (§9)
  formats.json                      optional labels and lines for the image formats (§12)
  lexicon/fa.json                   Persian pronunciation lexicon (§9)
  style/fa.md                       Persian house style with front matter (§9)
  templates/<templateId>.json       starter templates (§10)
  library/library.json              asset index (§5)
  library/characters/<charId>/      rig.json, parts/, states/, turnaround.png (§6)
  library/backgrounds/ props/ stickers/ ui/
  library/fonts/<family>/           font files with their licence file (§7)
  library/sounds/sfx/ sounds/music/
```

Only files that `pack.json` references are hashed into the pack lock (§13).

## 3. `pack.json`

| Field | Type | Rule |
|---|---|---|
| `schema` | `"signal.pack/1"` | literal |
| `id` | slug | |
| `version` | `"MAJOR.MINOR.PATCH"` | digits only; raise it on every content change |
| `name` | string | 1-120 characters; shown in Connections and on Proof |
| `languages` | `("fa" \| "en")[]` | at least one |
| `brand` | path \| null | `brand/brand.json`, or null to use the project's brand |
| `library` | path | normally `library/library.json` |
| `fonts` | font[] | may be empty (§7) |
| `voices` | path | normally `voices.json` (§8) |
| `lexicon` | `{ "fa"?: path, "en"?: path }` | may be `{}` |
| `glossary` | path \| null | normally `glossary.json` |
| `style` | `{ "fa"?: path, "en"?: path }` | may be `{}` |
| `templates` | path[] | each `templates/<id>.json`; may be empty |
| `claims` | `{ "allowed": string[], "denied": string[] }` | §11 |
| `musicPolicy` | `{ "sources": [...], "attribution": boolean }` | §11 |
| `rigTier` | `{ "<charId>": "A" \| "B" \| "C" }` | one entry per character asset (§6) |
| `requires` | `{ "signal": "<semver range>" }` | e.g. `">=2.0.0 <3"`; a pack this Signal cannot read is refused with "This pack needs Signal ‹range›" |

**[Example]**

```json
{
  "schema": "signal.pack/1",
  "id": "example-word-game",
  "version": "1.0.0",
  "name": "{Brand} pack",
  "languages": ["fa", "en"],
  "brand": "brand/brand.json",
  "library": "library/library.json",
  "fonts": [
    { "family": "ExampleDisplay", "file": "library/fonts/ExampleDisplay/ExampleDisplay-Black.ttf", "sha256": "<64 hex>", "licence": "library/fonts/ExampleDisplay/OFL.txt", "scripts": ["latin"], "weights": [900] }
  ],
  "voices": "voices.json",
  "lexicon": { "fa": "lexicon/fa.json" },
  "glossary": "glossary.json",
  "style": { "fa": "style/fa.md" },
  "templates": ["templates/pov-story-spine.json"],
  "claims": { "allowed": [], "denied": ["free", "ranking"] },
  "musicPolicy": { "sources": ["library", "owner-upload"], "attribution": false },
  "rigTier": { "char-lead": "A", "char-friend": "B" },
  "requires": { "signal": ">=2.0.0 <3" }
}
```

## 4. Brand

`brand/brand.json` has the same shape the Brand screen saves: `name`, `tagline`, `website`, `colors { primary,
background, text, accent }`, `palette[]`, `fonts[]`, `logo`, `voice[]`, `copy[]`, `instagram`, `sources[]`,
`updatedAt`.

Templates refer to colours by role: `primary`, `accent`, `background`, `text` (from `colors`), `secondary` (the first
palette colour that differs from those four, else `accent`) and `background-dark` (the template's own value, else
`text` when it is dark enough, else `#141414`). Text on any role is drawn in a colour with at least 4.5:1 contrast.

## 5. `library/library.json`

An array of assets.

| Field | Type | Rule |
|---|---|---|
| `id` | slug | stable; unique across the pack and project assets |
| `kind` | `character`, `prop`, `background`, `sticker`, `ui`, `font`, `sfx`, `music`, `voice`, `broll` | |
| `file` | path | relative to `library/` |
| `sha256` | hash | re-checked every time the asset is used |
| `dims` | `{ "w", "h" }` | images, in px |
| `durationMs` | number | audio and video |
| `tags` | string[] | each ≤ 40 characters (see below) |
| `palette` | `#rrggbb[]` | optional sampled colours |
| `licence` | object | below |
| `status` | `draft`, `approved`, `retired` | a final render uses `approved` assets only |
| `approvedBy` | string \| null | a name or role, never a contact detail |

**Licence record:** `type` (`owned`, `commissioned`, `ofl-1.1`, `cc-by-4.0`, `cc0`, `stock`, `ai-generated`,
`vendor-output`), `holder`, `source` (a path, job id or URL), `author`, `acquiredAt`, `proof` (a path to the licence,
invoice or terms snapshot), `allowedUses` (`organic`, `paid-ads`, `store-listing`; required for a final render),
`territories` (a list or `"worldwide"`), `expiresAt`, `attribution` (text the caption must credit), `aiGenerated`
(drives the AI label), `vendor` (`name`, `model`, `requestId`, `promptRef`, `c2pa`, for generated assets) and
`consentRef` (required for voices and any real likeness).

The resolver refuses, each with its own code: a missing, retired or (in a final render) draft asset; missing or
non-matching `allowedUses`; an expired licence; a missing consent record; a missing file; a hash mismatch; a duplicate
id.

**Tags with a meaning:** `app-icon` marks the end card's icon (exactly one approved `ui` asset); `phone-frame` marks a
phone frame for insert shots; `pop`, `whoosh`, `tap`, `swipe`, `success`, `clap`, `hit`, `riser`, `confetti` and
`tick` name the sound cue an `sfx` asset plays. Other tags are free search words.

## 6. Characters and tiers

Each character is one asset of kind `character` whose id is the character id, plus a `rigTier` entry.

| Tier | The asset's `file` | What motion can reach |
|---|---|---|
| A: source rig | `characters/<charId>/rig.json` (`cutout-rig/1`) with layered parts, mouth shapes, hand shapes and at least two views | full cut-out acting: blinks, mouth shapes, gestures, view turns |
| B: flat renders | `characters/<charId>/flat.png` | whole-body squash, bob, tilt and hop; motion craft (C5) is capped, so a video led by a Tier B character is capped at Standard |
| C: reconstructed | flat renders cut into parts | an approximate rig; capped like Tier B until someone checks it against the reference sheet |

A rig lists its parts (`head`, eyes and lids with `open half closed happy wide`, `mouth` with the shapes
`X A E O U M F L` and `smile grin frown shock`, arms, hands with `open fist point wave hold thumb peace`, legs, plus
prop and accessory slots), each with its view, file, parent, pivot, anchor, draw order and rotation limits. Draw
parts at twice their largest on-screen size, with a little overdraw at every joint.

## 7. Fonts

| Field | Rule |
|---|---|
| `family` | 1-80 characters; the name the renderer loads |
| `file` | `.ttf`, `.otf`, `.woff` or `.woff2`; its sha256 must equal `sha256` |
| `sha256` | pinned |
| `licence` | the licence file beside the font; must exist |
| `scripts` | `latin` and/or `arabic`; Persian text uses an `arabic` face, Latin runs inside it use a `latin` face |
| `weights` | the weights the file contains (100-1000) |

Bundled files only: no system or web fonts. Without pack faces, Signal uses its bundled Vazirmatn (Persian text),
Estedad (Persian display) and Instrument Sans (Latin), all under the SIL Open Font License. A Persian display face used
for the letter-by-letter brand reveal must contain a zero-width-joiner glyph; otherwise the reveal falls back to whole
words. The image formats use the first `latin` face with a `.ttf`, `.otf` or `.woff` file as their display font.

## 8. `voices.json`

An array of voice profiles.

| Field | Rule |
|---|---|
| `id` | slug, unique in the file |
| `lang` | `fa` or `en` |
| `speaker` | a character id or `narrator` |
| `connector` | `elevenlabs`, `azure-speech` or `mock` |
| `model` | a pinned model id; never empty (the vendor default is never used) |
| `voiceId` | a designed voice, or one with a consent record |
| `settings` | vendor settings, stored as data |
| `consentRef` | required when the voice is cloned from a person |
| `approvedBy` | who approved the voice after listening |
| `projection` | required for Persian: `diacritics` (`all`, `homographs`, `none`), `ezafe` (`kasra`, `display`), `conjO`, `zwnj` (`keep`, `space`), `ipaInline`, `lockedBy`, `lockedAt`, `testId` |
| `measuredRate` | `{ wordsPerSec, syllablesPerSec, sampleLines }` after the first approved takes; until then the hook-fit check uses 2.6 (fa) and 2.8 (en) words per second |

A Persian voice whose `projection.lockedBy` is null has not passed a listening test and cannot make a clean Persian
proof. See [persian.md](persian.md#listening-test).

## 9. Persian layer

- **`lexicon/fa.json`**: `{ "schema": "signal.fa-lexicon/1", "scope": "pack", "packId", "version", "updatedAt",
  "entries": [...] }`. Entries are homographs, ezafe rules, loanwords, acronyms and number words, each `proposed`,
  `approved` or `retired`. Only approved entries apply in a final render; a pack entry overrides a core entry with the
  same display form.
- **`glossary.json`**: the same file shape, holding only names (`brand`, `product`, `character`, `person`, `place`,
  `platform`), each with its Persian and English display forms and a romanised form. Names change only here.
- **`style/fa.md`**: the house style, as Markdown with front matter that code reads:

  | Key | Values | Default |
  |---|---|---|
  | `schema` | `signal.pack-style/1` | required |
  | `lang` | `fa` | required |
  | `version` | integer | required |
  | `editor` | the name or role of the reader who owns the style | null |
  | `faAddress` | `to` (informal) or `shoma` | `to` |
  | `ezafeAfterHeh` | `zwnj-yeh` or `hamza` | `zwnj-yeh` |
  | `smallNumbers` | `words` or `digits` | `words` |
  | `disabledRules` | lint rule ids | `[]` |
  | `allowWords` | extra words the register check allows | `[]` |

**[Example]** a glossary entry:

```json
{ "id": "gl-brand", "kind": "brand", "match": { "display": ["{Brand}"], "mode": "word", "inflects": true },
  "display": { "fa": "{Brand}", "en": "{Brand}" }, "pron": "<marked Persian respelling>", "roman": "<roman>",
  "source": "editor", "status": "proposed", "approvedBy": null, "approvedAt": null }
```

## 10. `templates/<templateId>.json`

Starter templates for the `story-spine@1` pipeline builder.

| Field | Rule |
|---|---|
| `schema` | `"signal.pack-template/1"` |
| `id` | equals the file name without `.json` |
| `version` | integer ≥ 1; raise on every change |
| `name` | ≤ 60 characters; shown on the template card |
| `builder` | `"story-spine@1"` |
| `media` | `"video"` |
| `canvases` | `[{ "shape": "9:16", "w": 1080, "h": 1920 }]` (the builder makes 9:16 only for now) |
| `fps` | `30` |
| `durationSec` | `{ "min", "max" }`, 15 ≤ min ≤ max ≤ 90; the length chips offer only lengths inside it |
| `languages` | a subset of the pack's languages |
| `tempo` | `{ "bpmRange": [low, high], "chantBeatsPerCard": 2 \| 4, "beatsPerBar"?: 3 \| 4 }`, 90 ≤ low ≤ high ≤ 128 |
| `segments` | in playback order (below) |
| `cast` | `{ "lead": charId, "foil"?: charId, "crowd"?: charId[] }` |
| `styles` | `{ "caption": "plate-highlight" \| "plate" \| "outline" \| "scrim", "palette": "pack", "cardPalette": [2-6 roles], "backgroundDark"?: "#rrggbb" }` |
| `variants` | optional starter variants: `{ "id", "label", "lengthSec", "lang"?, "segmentSec"? }` |

A **segment** has an `id` (`hook`, `story`, `interrupt`, `demo`, `chant`, `escalation`, `reveal`, `endcard`), a
`share` of the length (all shares sum to 1.00 ± 0.01), `minSec`, optional `maxSec`, a `shot` (`wide`, `medium`,
`close`, `insert`, `card`), `require` tokens (for example `stickers>=3`, `colourCards>=3`, `onDownbeats`, `appIcon`,
`cta`), a `music` cue (`bed-low`, `drop`, `build`, `full`, `hit`, `resolve`), `optional` (dropped first under 40 s)
and an optional `preset`.

**Scaling to a length `T`:** drop optional segments when `T < 40`; give each segment `share × T`; clamp to
`[minSec, maxSec]`; round `chant` and `reveal` to whole bars at the script's tempo; split what is left over between
`hook` and `story` in proportion to their shares; convert boundaries to frames at 30 fps. A segment that cannot fit
fails with its name ("cannot scale"). A variant's `segmentSec` replaces that calculation: it must name every kept
segment, stay inside each range and sum to `T`.

**[Example]** (abridged):

```json
{
  "schema": "signal.pack-template/1", "id": "pov-story-spine", "version": 1, "name": "POV story",
  "builder": "story-spine@1", "media": "video", "canvases": [{ "shape": "9:16", "w": 1080, "h": 1920 }], "fps": 30,
  "durationSec": { "min": 30, "max": 90 }, "languages": ["fa", "en"],
  "tempo": { "bpmRange": [90, 128], "chantBeatsPerCard": 2, "beatsPerBar": 4 },
  "segments": [
    { "id": "hook",    "share": 0.30, "minSec": 6, "shot": "wide",   "require": ["kineticCaptions", "stickers>=3"], "music": "bed-low" },
    { "id": "story",   "share": 0.30, "minSec": 4, "shot": "medium", "require": ["speechBubble"], "music": "bed-low" },
    { "id": "demo",    "share": 0.10, "minSec": 5, "shot": "insert", "require": ["phoneInsert"], "music": "build" },
    { "id": "chant",   "share": 0.10, "minSec": 3, "shot": "card",   "require": ["colourCards>=3", "onDownbeats"], "music": "full" },
    { "id": "reveal",  "share": 0.08, "minSec": 2, "shot": "card",   "require": ["brandRevealLetters"], "music": "hit" },
    { "id": "endcard", "share": 0.12, "minSec": 6, "maxSec": 9, "shot": "card", "require": ["appIcon", "cta"], "music": "resolve" }
  ],
  "cast": { "lead": "char-lead", "foil": "char-friend" },
  "styles": { "caption": "plate-highlight", "palette": "pack", "cardPalette": ["primary", "accent", "secondary", "background-dark"] }
}
```

## 11. Claims and music

**Claims** are what a post may assert about the product. `allowed` and `denied` hold reserved keys or literal phrases;
`denied` wins. Reserved keys: `free`, `level-count`, `price`, `ranking` (all denied unless allowed) and `availability`.
Literal phrases are matched case-insensitively on normalised text in every language. The core itself never states
availability, a price or a ranking (its default lines say "Link in bio"); a pack that can say one truthfully does so in
its own text (`formats.json` lines, §12). You are responsible for those lines being true.

**`musicPolicy.sources`** is the order of the music step's connector chain: `library` (the pack's tracks),
`owner-upload` (a track you add), `elevenlabs-music` (still needs its switch, key and terms), `browser-agent` (only
while you watch), or `none` (silent videos). `attribution: true` when your track licences require a caption credit.

## 12. `formats.json` (image formats)

Optional names and lines for the four built-in image formats: `{ "schema": "signal.formats/1", "labels"?: { "<format>":
"<name>" }, "lines"?: { "store"?, "cta"? } }`. `store` is the small end-card line and `cta` the closing caption line;
each is at most 120 characters and may use `{name}` (the project name). Other keys are reported as not used. Post maker
does not read this file.

## 13. Pack lock and versioning

When a pack is loaded, Signal hashes every file the manifest references and writes
`<content parent>/postmaker/pack-lock.json` (refs `manifest`, `brand`, `lexicon:<lang>`, `style:<lang>`, `glossary`,
`template:<id>`, `font:<family>`, `voice:<id>`, `asset:<id>`). Each step version records only the refs it read: editing
an unused asset changes nothing, while editing `lexicon:fa` puts every Persian narration-text step out of date
("Lexicon changed"). Raise `version` in `pack.json` on every content change; the lock compares hashes, not versions.

## 14. Checklist

1. `pack.json` validates and `requires.signal` covers this Signal.
2. Every path is relative and inside the pack.
3. Every asset's hash matches, its licence is complete with `allowedUses`, and it is `approved`.
4. No third-party characters, art, music, logos or brand names; every generated asset has `aiGenerated: true` and its
   vendor record.
5. Every character has a `rigTier`; Tier A rigs have every face part, all eight mouth shapes and two views.
6. Exactly one `app-icon` asset.
7. Every font matches its pinned hash and has its licence file beside it.
8. Every voice pins its model; Persian voices have projection settings; voices are designed or have consent.
9. The lexicon, glossary and house style are owned by the reader you named; new entries stay `proposed` until that
   reader approves them.
10. Every template validates and scales to its minimum and maximum length.
11. `denied` covers what you never say.
12. The music policy lists only sources you have rights to.
13. No personal data, credentials or contact details anywhere.
