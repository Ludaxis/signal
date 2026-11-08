// Autopilot: the shared contract for automatic making and trusted auto-publishing.
// Everything here is OFF until you turn the switches on in signal.config.json. Server-only types,
// also imported (type-only) by the UI.
import type { Format } from '../generate';

/** Feature switches in signal.config.json (features.<name>) that autopilot depends on. */
export const AUTOPILOT_SWITCHES = {
  /** Daily automatic making run while the app is running. */
  autopilot: 'autopilot',
  /** Trusted formats may be approved and scheduled by Signal without a per-post approval. */
  trustedPublish: 'trustedPublish',
  /** Higgsfield API (paid per request) for images and Reels. */
  higgsfield: 'higgsfield',
} as const;

/** Kill switch: SIGNAL_AUTOPILOT_PAUSED=1 stops every automatic run and every automatic approval. */
export const AUTOPILOT_PAUSE_ENV = 'SIGNAL_AUTOPILOT_PAUSED';

/** Per-campaign autopilot settings, stored in the campaign folder as autopilot.json. */
export interface AutopilotSettings {
  campaign: string; // campaign id
  enabled: boolean; // the daily run makes this campaign's planned posts
  makeAheadDays: number; // 1..7: make posts for slots up to this many days ahead (default 3)
  autoPlan: boolean; // when fewer than makeAheadDays of planned slots remain, the planner extends the plan (agent cost)
  review: boolean; // run the reviewer agent on every made post (needs the agent team)
  autoPublish: 'never' | 'trusted'; // 'trusted' = formats that earned trust may publish without a per-post approval
  formats: Format[] | null; // null = the campaign's own formats
  dailyBudgetUsd: number; // cap for this campaign's automatic spend per calendar day (Claude + Higgsfield), default 3
  updatedAt: string;
  updatedBy: string;
}

/** Project-wide trust per format (memory/autopilot/trust.json). Earned only from your own decisions. */
export interface FormatTrust {
  format: Format;
  approvedInARow: number; // consecutive approvals by you of automatically made posts of this format (no rejection in between)
  approvedTotal: number;
  rejectedTotal: number;
  lastDecisionAt: string | null;
  trusted: boolean; // approvedInARow >= threshold && !revoked
  revoked: boolean; // you switched trust off for this format (sticky until switched on again)
}
export interface TrustFile { version: 1; project: string; threshold: number; formats: FormatTrust[]; updatedAt: string }
export const DEFAULT_TRUST_THRESHOLD = 5;

/** One daily run (memory/autopilot/runs.jsonl, one line per run; last line per id wins).
 *  Steps of pipeline work carry `pipeline` (the pipeline id); campaign steps carry `campaign`. Older runs have
 *  neither on review/approve steps and no 'ideas' steps, and still read fine. */
/** A post format in a run step: a built-in format, or `postmaker` for a post a Post maker template made. */
export type StepFormat = Format | 'postmaker';
export type RunStep =
  | { kind: 'plan'; campaign: string; slots: number; costUsd: number | null }
  | { kind: 'ideas'; pipeline: string; ideas: number; costUsd: number | null; error?: string }
  | { kind: 'make'; campaign: string | null; slot: string; package: string | null; format: StepFormat; costUsd: number | null; error?: string; pipeline?: string; /** A Post maker post (its recipe) */ recipe?: string; /** Why it waits for you (at Proof, a sign-off, the cap); no package yet */ waiting?: string }
  | { kind: 'review'; package: string; verdict: string | null; costUsd: number | null; error?: string; pipeline?: string }
  | { kind: 'auto-approve'; package: string; format: Format; scheduledFor: string | null; via: 'meta' | 'upload-post' | null; error?: string; pipeline?: string }
  | { kind: 'skip'; campaign: string | null; reason: string; pipeline?: string };
export interface AutopilotRun {
  id: string; // 'ap_' + time-sortable id
  project: string;
  day: string; // calendar date (Studio time zone) YYYY-MM-DD the run belongs to
  trigger: 'daily' | 'manual'; // manual = you pressed "Run autopilot now" (or "Run now" on one pipeline)
  /** Set when you pressed Run now on one pipeline: only that pipeline runs (Codex allowed, the button was pressed). */
  pipeline?: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'stopped' | 'failed';
  steps: RunStep[];
  costUsd: number;
  note: string | null;
}

/** GET /api/studio/autopilot?project= */
export interface AutopilotPayload {
  switches: { autopilot: { enabled: boolean; reason: string }; trustedPublish: { enabled: boolean; reason: string }; higgsfield: { enabled: boolean; reason: string }; /** Post maker Repeat in the daily run. */ repeat: { enabled: boolean; reason: string } };
  paused: { paused: boolean; reason: string };
  schedule: { time: string; timeZone: string; window: string; nextRunAt: string | null; schedulerRunning: boolean };
  campaigns: { id: string; name: string; status: string; formats: Format[]; settings: AutopilotSettings }[];
  trust: TrustFile;
  runs: AutopilotRun[]; // newest first, last 20
  spendToday: number; // USD, all campaigns of the project
}

/** POST /api/studio/autopilot {project, action, …} */
export type AutopilotAction =
  | { action: 'settings'; campaign: string; patch: Partial<Omit<AutopilotSettings, 'campaign' | 'updatedAt' | 'updatedBy'>> }
  | { action: 'run-now' } // one manual run for this project (same rules as the daily run)
  | { action: 'trust'; format: Format; trusted: boolean } // revoke or restore trust for a format
  | { action: 'pull'; package: string }; // you pull an auto-approved post before it goes out (cancels its schedule, discards it)

/** Marker file written into a package made by autopilot (<package>/autopilot.json). */
export interface AutopilotMark { run: string; campaign: string | null; slot: string; pipeline?: string; madeAt: string; autoApproved: null | { at: string; trustInARow: number; scheduledFor: string | null; via: 'meta' | 'upload-post' | null } }
