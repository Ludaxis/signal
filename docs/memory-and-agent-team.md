# Project memory and the agent team

Memory lives next to a project's posts folder (`<contentDir>/../memory/`), is never committed and never leaves the machine except as the compact context packs the agents receive. Switch: `memory` (the agent team also needs `agents` and `agentsApiKey`).

## Timeline

`timeline/YYYY-MM.jsonl` is append-only. Events are typed (`post.made`, `post.approved`, `post.published`, `metrics.snapshot`, `comments.theme`, `strategy.approved`, `plan.made`, `pivot.proposed`, `research.finding`, …) and carry refs (package, slot, campaign, branch, run). Hooks in `memory/hooks.ts` turn package status changes into events; comments reach memory only as themes and anonymised questions, never usernames.

## Decision map and learnings

`graph.ts` rebuilds a tree idempotently from campaigns, plans, packages and the timeline: goal → strategy versions → pillars → hypotheses (hook style, format) → variants (posts). Node ids are stable (`memory/ids.ts`), so the map grows without duplicates and keeps each node's creation date.

`stats.ts` computes learnings from results: recency-weighted means per scope (branch, format, hook style, hour) against the project baseline, an effect ratio with an interval, `nEff` (Σ recency weight × maturity), and a capped confidence. Branch status (`exploring`, `promising`, `winning`, `weak`, `pruned`) and explore/exploit weights (Thompson sampling) feed the planner's context pack.

## Routing: rule → cache → judge → threshold → escalate

Small typed questions (`decisions.ts`: predicate / choice / score, with the roles that may ask them) go through `router.ts`. A rule answers for free when it can; a cached confident answer with the same inputs hash is reused; otherwise the **judge** (`judge.ts`, Anthropic Messages API on your key) answers with probabilities. Below the threshold the question is escalated to you. Decisions are logged with only a hash of the inputs; evidence is stripped of handles and e-mails before it leaves the machine and wrapped as untrusted data.

## Context packs

`packs.ts` builds a per-role, per-campaign pack with a token budget and the most important sections first (goal and strategy, branch weights, free days, recent hooks, learnings, baselines, comment themes, brand). Packs are cached by content hash and clearly marked as information, not instructions.

## The agent team (`lib/studio/team/`)

Nine roles run on the Claude Agent SDK, one role per run, one structured JSON answer: lead, researcher (the only role with web tools), strategist, planner, creative producer, motion designer, reviewer, analyst, community manager. A role is a fixed envelope decided in code: model tier, USD budget cap, turn cap, a tool allow-list and a system prompt (built-in, or your override under `agents/`).

Safety by construction:

- The subprocess gets an empty temporary working folder, an allow-listed environment plus `ANTHROPIC_API_KEY` from `SIGNAL_ANTHROPIC_API_KEY`, no user/project settings, no persisted session.
- Built-in tools are disabled (`tools: []`, a deny list, and a `PreToolUse` hook that denies anything outside the allow-list and audits every call); the researcher gets `WebSearch`/`WebFetch` only.
- The in-process MCP tools (`tools.ts`) read packs and posts and **write proposals only**: `write_review`, `write_report`, `write_spec`, `draft_reply`, `propose_pivot`, `add_finding`. There is no tool anywhere that publishes, schedules, approves, sends or deletes.
- Budget and turn stops are recorded as `stopped-budget`; every run is written to `runs.jsonl` at start and end with cost, turns and model, and shown on the Memory screen.

The reviewer (`reviewer.ts`) scores a made post against its brief, the brand rules, legibility and the AI label and stores `review.json`; autopilot uses the verdict but the review never changes a post. The analyst (`analyst.ts`) writes the weekly report from numbers the code computed; it never recomputes or invents figures.
