# Post maker slice fixtures

[Pack example] Everything here is synthetic or original to the Signal test fixtures: no reference
frames, transcript, third-party art or music. Only text sources are committed; the binaries are built on demand.

| File | What it is |
|---|---|
| `make-ref.mjs` | Writes `ref-9x16-10s.mp4`: 10 s, 1080×1920, 30 fps, four `testsrc2` shots with hard cuts at 2.5, 5.0 and 7.5 s, a 440 Hz tone with a short gap. `node make-ref.mjs <out.mp4>` (bundled ffmpeg). |
| `make-pack.mjs` | Builds the loadable pack from `pack-example/` into a folder: SVG → PNG (sharp), the 100 BPM click-plus-chord loop (WAV synthesised in JavaScript), the fonts copied from files the web app already bundles (Vazirmatn from `public/fonts`, Instrument Sans from `@fontsource/instrument-sans`) with their OFL licences, and `library/library.json` with every sha256. `node make-pack.mjs <out-dir>`. |
| `make-rig.mjs` | Writes the synthetic Tier A character `char-cutout`: a `cutout-rig/1` rig (`front` and `three-quarter-L`) of original flat geometric SVG parts drawn in the script, with every required part, the 5 eye states, lids, the 8 visemes and 4 expression mouths, the 7 hand shapes, slots and a turnaround sheet composed from the parts. Limbs are capsules with their round ends on the joints. `make-pack.mjs` calls it; alone: `node make-rig.mjs <character-folder>`. |
| `pack-example/` | The pack sources: `pack.json` (placeholder name `{Brand} example pack`, fonts pinned by sha256), `voices.json` (mock voices), `glossary.json`, `lexicon/fa.json` (10 generic entries), `style/fa.md`, `templates/pov-story-spine.json` (shape; limits follow the motion presets; variants V1, V2, V3 and the slice cut), `library/library.src.json`, the SVG art (two flat characters (Tier B) plus the generated rig `char-cutout` (Tier A), a background, a phone frame with UI targets, an app icon) and the music licence record declaring BPM and first downbeat. |
| `recipe-story-spine.json` | The slice recipe: the template's `slice-30` cut (100 BPM) with lines from the Persian guide original script, plus the scripted mock voice lengths. |

Persian forms in the lexicon, glossary, style guide and recipe are proposed until the owner, or a reader they name, signs them
. The brand «حرفینو» / Harfino is fictional and appears only in fixtures.
