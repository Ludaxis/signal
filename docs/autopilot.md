# Autopilot

Autopilot makes a campaign's planned posts (and every pipeline's due posts) once a day while Signal runs, and — only for formats you trusted — approves and schedules them. Switches: `autopilot`, and `trustedPublish` for the second part. Kill switch: `SIGNAL_AUTOPILOT_PAUSED=1` (and `SIGNAL_PUBLISH_PAUSED=1` for anything that would go out).

## The daily run

- One `daily` run per project per calendar day, started by the minute tick inside the 08:00–12:00 window (Studio time zone). A day that passes while Signal is off is skipped, never caught up. You can also press **Run now**; manual runs share the day's budget.
- One run at a time per project (a lock shared across bundles). A run is written to `memory/autopilot/runs.jsonl` at start and at the end; a run cut off by a restart is shown as failed.
- The run stops at once when any post is *uncertain* (an unclear provider answer).
- Per campaign with autopilot on: extend the plan when it runs out inside the horizon (`autoPlan`, costs a planner run), then make the planned slots inside `makeAheadDays` oldest first, review each one when `review` is on, and finally try a trusted auto-approval.
- Per-campaign settings (`autopilot.json`): `enabled`, `makeAheadDays` (1–7), `autoPlan`, `review`, `autoPublish` (`never` | `trusted`), `formats` filter, `dailyBudgetUsd` (0–20, default 3).
- Budget is checked before each step with a deliberately high estimate (Higgsfield list prices, planner and reviewer caps), so the run stops before an overrun. Codex formats are never made unattended; Higgsfield formats need the `higgsfield` switch.
- Backlog limit: making pauses while seven autopilot posts wait in Review.

## Pipelines

A pipeline (`<project folder>/pipelines/<id>.json`, Pipelines screen) is a chain Signal runs inside the same daily run, after the campaigns, under the same lock and rules: **Source** → **Make** → **Review** → **Approve** → **Schedule**, with its own `dailyUsd` budget.

- Sources: `website` (the next unused page from the brand import, found through the sitemap or feed), `list` (your own topics in order; `state.listNext` remembers where it is), `ideas` (the planner agent writes a handful of ideas once, queued in `<id>.state.json` and used one per post; needs the `agents` switch and counts against the budget), `campaign` (the linked campaign's planned slots, made with its own briefs through `makeSlotPost`).
- Schedule: `perWeek` (1–14), `days` (0 = Monday), `times` (`HH:MM`, Studio time zone; a wall time that does not exist or exists twice on a daylight-saving day is skipped), `makeAheadDays` (1–7). A slot in the past is never caught up; a day that already has a post from elsewhere is left out.
- Every made post carries `pipeline.json` (pipeline, slot, idea, run) next to `autopilot.json`, is planned for the slot time, then goes through the shared review and trusted-approval steps (`lib/studio/autopilot/steps.ts`): the trust rules below apply unchanged.
- `Run now` on a card starts a manual run scoped to that one pipeline (campaigns are left alone; a switched-off pipeline still runs). Codex posts are made only in such a run.
- `delete` archives the file (`archived: true`); the posts stay. Spend per pipeline is summed from the run steps that carry its id and never counts against a campaign's budget.

## Trust

Trust is per format and per project (`memory/autopilot/trust.json`), earned only from your own decisions on posts that autopilot made: five approvals in a row make a format trusted; one rejection (discarding in Review, or pulling an auto-approved post) resets the count and removes trust. Decisions by Signal itself (the autopilot, the scheduler, agents) never count. You can revoke trust (sticky until you restore it, which needs the earned streak) on the Autopilot screen.

## Trusted auto-approval

All of these must hold, in order, or the post simply stays in Review with the reason recorded in the run:

1. `trustedPublish` on, nothing paused.
2. The format is trusted; review is on for the campaign and the reviewer said `ready`.
3. The account's posting settings exist, allow one-click posting and have room (per day, total, end date).
4. The slot is at least 15 minutes ahead.
5. A scheduling path exists: Signal's scheduler with a connected Instagram API account, else Upload-Post scheduling.

The approval and schedule go through the same `approvePackage` / `scheduleInSignal` / `dispatchPackage` functions and limit checks you use, with the actor `signal-autopilot (trusted format)`. The package carries `autopilot.json` with the run, slot and auto-approval details, and the Posts board shows **Pull**: cancelling the schedule, discarding the post and counting a rejection for the format.
