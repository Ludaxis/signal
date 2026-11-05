// Shared output contracts of the agent team: zod schemas (what we validate and store) and the JSON
// schema handed to the SDK's `outputFormat` (what the model is asked to produce). One source of truth
// per shape, so the reviewer, the analyst, the tools and the tests agree on field names.
import { z } from 'zod';

/** Keywords the structured-output endpoint may not accept; validation still applies them on our side. */
const STRIP = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'multipleOf']);

/** JSON schema for `outputFormat` derived from a zod schema (descriptions kept; numeric/length limits removed). */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!STRIP.has(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(z.toJSONSchema(schema, { unrepresentable: 'any' })) as Record<string, unknown>;
}

const short = (max: number) => z.string().trim().max(max);

// ---- review (design decisions 10–14) --------------------------------------------------------------
export const reviewSchema = z.object({
  briefMatch: z.number().int().min(1).max(5).describe('Decision 10: does the post match the brief? 1–5'),
  briefNotes: short(600).describe('What matches and what does not; quote the mismatch'),
  answerUnambiguous: z.number().min(0).max(1).describe('Decision 11: probability that the puzzle has exactly one correct answer (1 for non-puzzles that make no claim)'),
  answerNotes: short(400).describe('Any second valid answer, or why the answer is clear'),
  brandRules: z.array(z.object({ rule: short(120), pass: z.boolean(), note: short(300) })).max(20).describe('Decision 12: one entry per rule checked'),
  visualQuality: z.number().int().min(1).max(5).describe('Decision 13: overall visual quality 1–5'),
  visualNotes: z.object({
    firstFrame: short(300).describe('Does the first frame hook in one second and make the task clear?'),
    contrast: short(300).describe('Text against background, on a phone at medium brightness'),
    legibility: short(300).describe('Type size, line length, safe margins, Instagram UI overlap'),
    motion: short(300).describe('Reels: pacing, reveal timing, cuts; "n/a" for stills'),
  }),
  aiLabel: z.object({ pass: z.boolean(), note: short(300) }).describe('Decision 14: on-image AI disclosure visible and the caption carries the disclosure line'),
  verdict: z.enum(['ready', 'revise', 'reject']),
  fixes: z.array(short(300)).max(12).describe('Imperative, testable fixes in priority order'),
  summary: short(500).describe('Two or three sentences for the owner'),
});
export type Review = z.infer<typeof reviewSchema>;
export const REVIEW_OUTPUT_SCHEMA = toOutputSchema(reviewSchema);

/** What review.json holds: the review plus provenance, never an approval. */
export interface StoredReview extends Review {
  packageId: string;
  reviewedAt: string;
  by: string; // 'agent:reviewer'
  run: string | null; // AgentRunRecord id
  model: string | null;
  costUsd: number | null;
  hashes: Record<string, string>; // files the review looked at (name → sha256)
}

// ---- weekly report (design §8) -------------------------------------------------------------------
export const reportSchema = z.object({
  headline: short(200).describe('The one thing that matters most this week'),
  whatWorked: z.array(short(300)).max(8),
  whatDidnt: z.array(short(300)).max(8),
  recommendations: z.array(short(300)).max(6).describe('Concrete actions the planner can take tomorrow'),
  learningsChanged: z.array(short(300)).max(10).describe('One line per learning that changed, with its numbers from the stats'),
});
export type Report = z.infer<typeof reportSchema>;
export const REPORT_OUTPUT_SCHEMA = toOutputSchema(reportSchema);

export interface StoredReport {
  date: string; // YYYY-MM-DD (Studio time zone)
  period: { from: string; to: string };
  by: string;
  run: string | null;
  model: string | null;
  costUsd: number | null;
  stats: Record<string, unknown>; // numbers from code, never from the model
  narrative: Report;
}

// ---- production spec (creative producer, planner, motion designer) ------------------------------------
export const specSchema = z.object({
  kind: z.enum(['brief', 'production', 'motion']),
  title: short(120),
  concept: short(1200).optional(),
  format: short(40).optional(),
  pillar: short(60).optional(),
  hook: short(160).optional(),
  items: z.array(z.object({ category: short(60), itemIds: z.array(short(60)).max(12) })).max(8).optional(),
  frames: z.array(z.object({ index: z.number().int().min(0).max(60), onScreenText: short(300), visual: short(600), timingMs: z.number().int().min(0).max(120_000).optional(), motion: short(600).optional() })).max(60).optional(),
  prompts: z.array(z.object({ target: short(40), prompt: short(2000) })).max(12).optional(),
  caption: short(2200).optional(),
  timeline: z.array(z.object({ atMs: z.number().int().min(0).max(120_000), element: short(80), action: short(80), durationMs: z.number().int().min(0).max(30_000), easing: short(40).optional() })).max(200).optional(),
  checklist: z.array(short(200)).max(20).optional(),
  notes: short(1500).optional(),
});
export type Spec = z.infer<typeof specSchema>;
