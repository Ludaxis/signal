// Pipelines: you define one chain (Source → Make → Review → Approve → Schedule, with a budget) and Signal
// makes posts from it by itself, inside the same daily autopilot run (same rules: feature switches, pause
// switches, budgets checked before spending, backlog limit, trust, no Codex without a button press).
// Server-only types, also imported (type-only) by the UI.
import type { Format } from '../generate';
import type { AutopilotRun } from '../autopilot/types';

/** Where ideas come from. */
export type SourceKind = 'ideas' | 'list' | 'website' | 'campaign';
export const SOURCE_KINDS: SourceKind[] = ['ideas', 'list', 'website', 'campaign'];

export interface PipelineSource {
  kind: SourceKind;
  /** 'list': your own prompts or topics, used in order (state.listNext points at the next one). */
  list: string[];
  /** 'campaign': the campaign whose planned slots are made. */
  campaign: string | null;
}
export interface PipelineMake {
  format: Format;
  /** Optional prompt template for brief formats; variables {topic} {brand} {tone}. Empty = the topic itself. */
  template: string;
  /** A short caption style hint passed to the ideas agent. */
  captionStyle: string;
  /**
   * (`PipelineMake.template`; named `fromTemplate` because `template` is the prompt above): when set, each
   * slot is made by a Post maker template (`makeFromTemplate`) instead of the post generator. Absent = the format.
   */
  fromTemplate?: { id: string; variant: string | null } | null;
}
export interface PipelineReview { enabled: boolean }
/** 'ask' = every post waits in Review; 'trusted' = formats that earned trust may publish (autopilot rules, never weaker). */
export interface PipelineApprove { mode: 'ask' | 'trusted' }
export interface PipelineSchedule {
  perWeek: number; // 1..14
  days: number[]; // 0 = Monday … 6 = Sunday
  times: string[]; // HH:MM, Studio time zone
  makeAheadDays: number; // 1..7
}
export interface PipelineBudget { dailyUsd: number }

export interface PipelineSteps {
  source: PipelineSource;
  make: PipelineMake;
  review: PipelineReview;
  approve: PipelineApprove;
  schedule: PipelineSchedule;
  budget: PipelineBudget;
}

/** <project content parent>/pipelines/<id>.json */
export interface Pipeline {
  id: string; // 'pl-YYYYMMDD-xxxx'
  name: string;
  enabled: boolean;
  archived: boolean; // delete = archive; the file stays
  steps: PipelineSteps;
  createdAt: string;
  updatedAt: string;
}

/** One idea for one post (from any source). */
export interface Idea {
  topic: string; // what the post is about (a line)
  hook?: string; // first caption line
  prompt?: string; // image prompt for brief formats
  headline?: string; // on-image headline
  caption?: string; // caption body
  articleUrl?: string; // website source
}

/** <project content parent>/pipelines/<id>.state.json — written by the runner only. */
export interface PipelineState {
  listNext: number; // next index into source.list
  ideas: Idea[]; // ideas the agent wrote and that are not used yet
  lastRunAt: string | null;
  lastResult: string | null; // one line
}

/** Provenance written into a package made by a pipeline (<package>/pipeline.json). */
export interface PipelineMark { pipeline: string; name: string; slotAt: string; idea: Idea; madeAt: string; run: string }

/** A time the pipeline wants a post at. */
export interface PipelineSlot { id: string; date: string; time: string; at: string; packageId: string | null }

/** GET /api/studio/pipelines?project= */
export interface PipelineRow extends Pipeline {
  next: PipelineSlot[]; // upcoming slots inside make-ahead (made or not)
  nextAt: string | null; // first upcoming slot without a post
  spendToday: number;
  state: PipelineState;
  status: { text: string; problems: { text: string; why: string }[] };
  last: { at: string; status: AutopilotRun['status']; made: number; problems: number; note: string | null } | null;
}
/** A template with Repeat settings, as the Pipelines and Calendar screens list pipelines (upcoming slots). */
export interface RepeatRow {
  templateId: string;
  name: string;
  /** Repeat is on for the template and the daily run may make it (the Repeat switch is on). */
  enabled: boolean;
  /** Why it makes nothing now (empty when it does). */
  reason: string;
  next: PipelineSlot[]; // upcoming slots inside make-ahead; packageId = the post, or null (not made or waiting at Proof)
  nextAt: string | null; // first upcoming slot nothing was started for
  /** Slots a post was started for that has no package yet (waiting at Proof or for a sign-off). */
  waiting: string[];
  spendToday: number;
}

export interface PipelinesPayload {
  pipelines: PipelineRow[];
  /** Templates with Repeat settings (on or off), listed like pipelines. */
  repeats: RepeatRow[];
  formats: { id: Format; name: string }[];
  campaigns: { id: string; name: string; status: string; autopilot: boolean }[]; // autopilot: the campaign's own switch (a campaign-source pipeline needs it on)
  switches: { autopilot: { enabled: boolean; reason: string }; trustedPublish: { enabled: boolean; reason: string }; higgsfield: { enabled: boolean; reason: string } };
  paused: { paused: boolean; reason: string };
  website: boolean; // a brand website is set (the 'website' source works)
  timeZone: string; // the Studio time zone the schedule times are in
  running: string | null; // id of the run in progress, if any
  nextRunAt: string | null;
  runs: AutopilotRun[]; // newest first, the last few that touched a pipeline (plus the one running)
}

/** A patch to any subset of steps; each step is merged over the stored one. */
export type StepsPatch = { [K in keyof PipelineSteps]?: Partial<PipelineSteps[K]> };

/** POST /api/studio/pipelines {project, action, …} */
export type PipelineAction =
  | { action: 'create'; pipeline: Partial<Pick<Pipeline, 'name' | 'enabled'>> & { steps?: StepsPatch } }
  | { action: 'update'; id: string; patch: Partial<Pick<Pipeline, 'name' | 'enabled'>> & { steps?: StepsPatch } }
  | { action: 'delete'; id: string }
  | { action: 'toggle'; id: string; enabled: boolean }
  | { action: 'run-now'; id: string };
