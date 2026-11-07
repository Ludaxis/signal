# Post maker port map

The Post maker engine, the Persian language library and the generic-core pieces they need came into this
repository as a **one-time port** from the edition Signal was first built in (called *upstream* below). From here
on this repository is its own fork: changes are made here, and nothing is synced back or forth automatically.

Paths on the left are relative to the upstream app folder; paths on the right are relative to this repository's
root (the same layout, since the app folder is the root here).

## 1. What was ported, and how

Status: **port** = copied, comments cleaned; **adapt** = copied and changed to use this edition's mechanisms (§2).

### Generic core

| Upstream | Here | Status | Notes |
|---|---|---|---|
| `lib/time.ts` (zone-parameter helpers) | `lib/time.ts` | adapt | The `zoned*` helpers take an optional IANA zone (default `TIMEZONE`); `isTimeZone`, `zoneCity` added. |
| `lib/studio/time.ts` | same | adapt | `DEFAULT_TIME_ZONE = TIMEZONE` (`NEXT_PUBLIC_SIGNAL_TIME_ZONE`, default UTC). |
| `lib/studio/formats.ts` | same | adapt | Only the four built-in formats; `formats.json` gives labels and `lines` (store, cta). Level-catalog formats are not ported. `generate.ts` re-exports the records. |
| `lib/studio/pack.ts`, `pack-lexicon.ts` | same | port | Read-only project pack: pinned display font, app icon, Persian pronunciation list. |
| `lib/studio/projects.ts` (time zone, pack) | same | adapt | `Project.timeZone?`, `Project.pack?`, `description?`; the wizard accepts `timeZone` and `packDir`. No level source. |
| `lib/studio/content.ts` (Post maker lineage) | same | adapt | `postmaker.json` lineage lock, mock-step refusal, the `postmaker` switch and the optional `contentGenerators` list (§2.3). |
| `lib/studio/app-settings.ts` (vendor key groups) | same | adapt | ElevenLabs, Azure Speech, Sync and Hedra groups; the `postmaker` kill switch; `SECRET_FIELD_NAMES`, `groupComplete`. Feature switches stay in `signal.config.json`. |
| `lib/studio/claude-agent.ts` (Post maker agents, vision mode) | same | adapt | Envelopes moved to `lib/studio/agent-envelopes.ts`; prompts are built-ins with `<SIGNAL_PROMPTS_DIR>` overrides; the gate is the `agents` switch. |
| `lib/studio/team/roles.ts`, `team/runtime.ts` | same | adapt | Post maker role registry, the reviewer prompt, SDK envelopes; copywriter and deconstructor prompts are built in. |
| `lib/studio/figma.ts`, `brand.ts`, `memory/types.ts` | same | adapt | Small additions only (`figmaWhoAmI`, Persian register, project time zone). |
| `lib/studio/lang/fa/**` | same | port | The Persian library and its data and fixtures. |
| `public/fonts/**` | same | port | Vazirmatn, Estedad and Instrument Sans with their OFL licences, pinned in `fonts.lock.json`. |
| `app/studio/copy/en*.ts` | same | adapt | The engine reads its messages through `t()`; wording says "this computer" and names this edition's settings. |

### Post maker engine (`lib/studio/postmaker/**`)

| Upstream | Status | Notes |
|---|---|---|
| `types.ts`, `errors.ts`, `verdict*.ts`, `template-name.ts`, `estimate.ts`, `context.ts`, `manual-score.ts`, `media-probe.ts`, `references.ts`, `signoffs.ts`, `wiring.ts`, `runner.ts`, `service.ts` | port | Comments cleaned; the day cap comes from `signal.config.json`. |
| `accept.ts` | adapt | No experiment label; a clean Accept needs the `postmaker` switch and, when present, `contentGenerators` naming `postmaker`. |
| `store/**`, `graph/**`, `pack/**`, `checks/**`, `browser-agent/**`, `api/schemas.ts` | port | |
| `api/http.ts` | adapt | `postmakerOffRefusal` is async (`featureEnabled('postmaker')`). |
| `connectors/features.ts` | adapt | A thin layer over `signalConfig` (`featureOn` is async). |
| `connectors/allowed.ts` | adapt | One gate backend (§2.3); no approval-record backend. |
| `connectors/index.ts` | adapt | `switchConnector` writes `signal.config.json` and asks once for a paid service's terms. |
| `connectors/**` other, `executors/**` | port | Sources point at vendor documentation, never at upstream notes. |
| `render/**` | adapt | `appDir()` and `renderServiceDir()` (default `<app>/render`) replace the upstream repository paths. Compositions and components are excluded from `tsc`; Remotion is not installed here, so the render connector reports not installed and renders stay mock. |

### Studio UI system and tabs

| Upstream | Here | Status | Notes |
|---|---|---|---|
| `design/tokens.json` studio theme, `design/scripts/*` | same | adapt | `npm run tokens` also writes `app/studio/studio-tokens.css`; `npm run tokens:check` checks the studio pairs. |
| `app/studio/ui/**`, `url-state.ts`, `approve-undo.ts`, `content-lang.ts`, `fonts.css`, `work.css`, `plan-setup.css` | same | port | Components, the `?tab=` URL state and logical CSS only; dialogs replace every native confirm. |
| `eslint.config.mjs` style rule | same | adapt | No ad-hoc `style` in the Studio; the dated allow-list names this edition's untouched screens. |
| Today, Posts (with Gallery), Calendar, Campaigns, Brand, Results, Comments, Memory | `app/studio/*.tsx` | adapt | Copy through `t()`, project time zones, the account's posting settings (no end date allowed) instead of approvals; the make form lists the built-in formats with the Codex and Higgsfield switches. Campaign slot templates come with the Post maker screens. |
| `app/studio/connections-making.ts`, `Connections.tsx` | same | adapt | Making rows from `connectorRows()`; the Features group lists the eight Post maker switches as rows (the paid services through `connector.switch`, so the one-time terms step always applies), then the other `signal.config.json` switches. Connect with Meta stays a browser flow; there is no server-information row. |
| `lib/studio/{format, package-id, posting-blocks, results-templates}.ts` | same | port | Count format, package id order, Today's connection rows, Results by template. |
| Route deltas: `content`, `calendar`, `campaigns`, `brand`, `results`, `memory`, `instagram`, `connections`, `settings` | same | adapt | Project zones, pack format names, `connectionBlocks`, `making`, `connector.test` / `connector.switch` (409 `terms-needed` until `acceptTerms`). |

### Tests and fixtures

| Upstream | Here | Status |
|---|---|---|
| `tests/unit/postmaker/**` (engine, store, graph, checks, connectors, render without `@render`) | same | port / adapt |
| `tests/unit/fa-*.test.ts`, `project-time.test.ts`, `fonts-lock.test.ts`, `woff2-font.ts` | same | port / adapt |
| `tests/setup/network-guard.ts`, `tests/fixtures/postmaker/**`, `tests/postmaker/golden/*.png` | same | port |
| `tests/unit/generic-core*.test.ts` | `generic-core.test.ts`, `formats-pack.test.ts` | adapt (generic guard plus the optional `SIGNAL_NAME_DENYLIST` file) |

Test zones: tests that need daylight saving use `Europe/Berlin`. Synthetic ids: project `fixture` / `demo`, account
`@fixture.account`, people `owner@example.test`, `Editor A`.

## 2. Mechanisms that differ from upstream

### 2.1 Feature switches

All Post maker switches are `FEATURES` in `lib/server/signalConfig.ts`, off by default and listed in
`signal.config.example.json`: `postmaker`, `postmakerElevenlabs`, `postmakerAzureSpeech`, `postmakerSync`,
`postmakerHedra`, `postmakerHiggsfieldVideo`, `postmakerElevenlabsMusic`, `browserAgent`. Post maker also reuses
`agents`, `agentsApiKey`, `memory` and `higgsfield`. `SIGNAL_FEATURE_<NAME>` in the environment overrides a switch.
The kill switch `SIGNAL_POSTMAKER_PAUSED=1` (Connections → Post maker) wins over every switch.

### 2.2 The decision point

`connectorAllowed` checks, in order: a blocked binding (Suno, blocked in code) → the kill switch → the connector's
feature switch → its key → its gate refs → attendance. Any failure runs the mock, or refuses when the step requires a
live result. Nothing is cached between calls.

### 2.3 Gate refs, terms, caps and the generator list

- `approval:<name>` refs reuse existing switches and settings: `claude-cli-agents` → `agents`, `agent-team` →
  `memory`, `agents` and `agentsApiKey` with an API key, `codex-images` → the account's Codex images setting (and
  open posting settings), `higgsfield-api` → `higgsfield`.
- `vendor:<id>` and `terms:<topic>` refs pass once you accepted that service's terms. Turning a paid service on in
  Connections asks once ("you accept ‹service› terms"); `switchConnector(id, true, { acceptTerms: true })` stores the
  time under `postmaker.acceptedTerms` in `signal.config.json` and does not ask again.
- Optional per-connector day caps: `"postmaker": { "dayCapUsd": { "elevenlabs": 5 } }`. Without them only the run cap
  and the project day ceiling apply.
- Optional `"contentGenerators": [...]`: when absent, every package generator may be approved (the earlier
  behaviour). When present, only the listed generators may be approved. A Post maker package is approvable only while
  the `postmaker` switch is on, and never when a step was a mock or its lineage record does not match its files.

### 2.4 Time zones, prompts and paths

- Project days use `Project.timeZone`, else the Studio zone.
- Agent prompts are built into `lib/studio/team/roles.ts`; `<SIGNAL_PROMPTS_DIR>/<agent>/prompt.md` overrides one
  (see `agents/README.md`).
- The app folder is the root here: `appDir()` = `SIGNAL_APP_DIR` or the working directory.

### 2.5 Persian sign-off

Every Persian form stays a proposal until the owner, or a reader they name, signs it. Agents and mock runs never
sign.

## 3. Not ported in this step (later work)

- The Post maker screens (`app/studio/postmaker/**`), the Post maker tab, its Today rows and global keys, and campaign
  slot templates, with their tests.
- The Post maker API routes (`app/api/studio/postmaker/**`) and their route tests (they need a signed owner session
  helper instead of upstream's login).
- The optional Remotion render workspace (`render/`, with its own licence notice) and the `@render` runs.
- The slice script and the end-to-end specs.
- Public documentation: the pack guide, a condensed Post maker overview and the Persian writing guide.

## 4. Upstream-only (never ported)

- Upstream's approval records and their backend: vendor records, written terms decisions, a signed generator list.
  Here the owner's switch, key and one-time terms acceptance decide.
- The level-catalog formats, the level source and the legacy default-project fixtures.
- Upstream governance notes, plans, research notes, evidence folders and their references in comments.

## 5. Repeating a port

This was a one-time port. If a later upstream change has to come over by hand:

1. Map the path (drop the upstream app-folder prefix).
2. For a file that exists here, apply only the upstream delta on top of this file; never copy the whole file.
3. Replace upstream mechanisms with the ones in §2.
4. Clean comments: no project, brand, person or host names, no spec, ticket or requirement ids, no upstream paths.
   Run the name guards with your own untracked list: `SIGNAL_NAME_DENYLIST=<file> npm test`.
5. Keep all four checks green: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
