// Server-only: the routing pipeline (design 5.1): rule → cache → judge → threshold → escalate.
// `decide` answers one catalogued decision, `decideMany` answers several and sends every question
// that needs a model in one judge call. Every result is logged through the store (decisions.jsonl)
// with only a hash of the inputs; raw evidence never reaches disk. Without the memory switch pure rule
// decisions still work, but nothing is persisted and no judge is called.
import { createHash } from 'node:crypto';
import { currentProject } from '../projects';
import { choicesFor, DECISIONS, judgeOutcome, type Answer, type Choice, type DecisionDefinition, type DecisionInput } from './decisions';
import { redact, stripIdentifiers, type Judge, type JudgeAnswer, type JudgeQuestion } from './judge';
import { appendDecision, findCachedDecision, listDecisions, memoryAllowed, newId } from './store';
import type { DecisionId, DecisionRecord, Goal, MetricKey } from './types';

export type { DecisionInput } from './decisions';
export interface DecideOptions {
  judge?: Judge;
  /** Clock for record times (ms since epoch); defaults to Date.now(). */
  now?: number;
  /** Skip the cache lookup (the result is still logged and becomes the newest cache entry). */
  noCache?: boolean;
}
export interface DecideItem { id: DecisionId; input: DecisionInput }

type Draft = Omit<DecisionRecord, 'id' | 'at' | 'project'>;
/** Reserved context keys that are rendered elsewhere (candidates) and left out of the judge's context JSON. */
const CONTEXT_KEYS_NOT_FOR_JUDGE = new Set(['choices', 'branches', 'themes', 'seed']);
const MAX_CONTEXT_CHARS = 6000;

// ---- inputs hash ------------------------------------------------------------------------------------
/** JSON with sorted keys and no undefined values, so equal inputs hash equally. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const normaliseEvidence = (t: string | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

/** sha256 of the decision id, its kind and threshold, and the normalised input (evidence whitespace-collapsed, context key-sorted). */
export function inputsHash(id: DecisionId, input: DecisionInput): string {
  const d = DECISIONS[id];
  // The definition's kind and threshold are part of the key: changing either retires cached answers.
  const body = stableJson({ id, kind: d?.kind ?? null, threshold: d?.threshold ?? null, evidence: normaliseEvidence(input.evidence), untrusted: input.untrusted === true, context: input.context ?? {}, campaign: input.campaign ?? null });
  return createHash('sha256').update(body).digest('hex');
}

// ---- drafts ------------------------------------------------------------------------------------------------
function base(def: DecisionDefinition, input: DecisionInput, hash: string): Pick<Draft, 'campaign' | 'decision' | 'kind' | 'inputsHash' | 'threshold' | 'outcome'> {
  return { campaign: input.campaign ?? null, decision: def.id, kind: def.kind, inputsHash: hash, threshold: def.threshold, outcome: null };
}
function escalatedDraft(def: DecisionDefinition, input: DecisionInput, hash: string, note: string, extra: Partial<Pick<Draft, 'answer' | 'probabilities' | 'confidence' | 'judge' | 'costUsd'>> = {}): Draft {
  return { ...base(def, input, hash), via: 'escalated', answer: def.fallbackAnswer ?? null, probabilities: null, confidence: null, judge: null, costUsd: null, note: `${note} → ${def.elsePath}`, ...extra };
}
function ruleDraft(def: DecisionDefinition, input: DecisionInput, hash: string, r: { answer: Answer; confidence?: number; probabilities?: Record<string, number> | null; note?: string }): Draft {
  return { ...base(def, input, hash), via: 'rule', answer: r.answer, probabilities: r.probabilities ?? null, confidence: r.confidence ?? 1, judge: null, costUsd: null, note: r.note ?? null };
}
function cacheDraft(def: DecisionDefinition, input: DecisionInput, hash: string, c: DecisionRecord): Draft {
  return { ...base(def, input, hash), via: 'cache', answer: c.answer, probabilities: c.probabilities, confidence: c.confidence, judge: c.judge, costUsd: null, note: `cache hit: ${c.id}` };
}
function judgeDraft(def: DecisionDefinition, input: DecisionInput, hash: string, a: JudgeAnswer, choices: Choice[] | null, model: string, costUsd: number | null): Draft {
  const o = judgeOutcome(def, a.probabilities, choices);
  if (!o.pass) {
    const answer = def.fallbackAnswer ?? (def.kind === 'score' ? o.answer : null);
    return escalatedDraft(def, input, hash, o.note, { answer, probabilities: a.probabilities, confidence: o.confidence, judge: model, costUsd });
  }
  return { ...base(def, input, hash), via: 'judge', answer: o.answer, probabilities: a.probabilities, confidence: o.confidence, judge: model, costUsd, note: o.note };
}

// ---- judge questions ------------------------------------------------------------------------------------
/** Trusted context for the judge, as compact JSON (identifiers stripped, size capped). */
function contextForJudge(context: Record<string, unknown> | undefined): string | null {
  if (!context) return null;
  const picked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) if (!CONTEXT_KEYS_NOT_FOR_JUDGE.has(k) && v !== undefined) picked[k] = v;
  if (!Object.keys(picked).length) return null;
  const json = stripIdentifiers(JSON.stringify(picked));
  return json.length > MAX_CONTEXT_CHARS ? `${json.slice(0, MAX_CONTEXT_CHARS)}…` : json;
}
function questionFor(def: DecisionDefinition, input: DecisionInput, name: string, choices: Choice[] | null, blockLabel: string | null): JudgeQuestion {
  const ctx = contextForJudge(input.context);
  const instructions = [blockLabel ? `Use evidence block ${blockLabel}.` : null, def.description, ctx ? `Context (trusted, from Signal): ${ctx}` : null].filter((x): x is string => x !== null).join('\n');
  return { name, kind: def.kind, instructions, choices: def.kind === 'choice' ? (choices ?? []) : undefined, levels: def.kind === 'score' ? def.levels : undefined };
}

interface Pending { i: number; def: DecisionDefinition; input: DecisionInput; hash: string; choices: Choice[] | null }

/** One judge call for every pending item: distinct evidence texts become labelled blocks. */
async function askJudge(judge: Judge, pending: Pending[]): Promise<Map<number, Draft>> {
  const out = new Map<number, Draft>();
  const blocks: string[] = [];
  const blockOf = new Map<string, number>();
  for (const p of pending) {
    const ev = (p.input.evidence ?? '').trim();
    if (!blockOf.has(ev)) {
      blockOf.set(ev, blocks.length);
      blocks.push(ev);
    }
  }
  const single = blocks.length === 1;
  const label = (p: Pending) => (single ? null : `[E${blockOf.get((p.input.evidence ?? '').trim())! + 1}]`);
  const questions = pending.map((p) => questionFor(p.def, p.input, `${p.def.id}#${p.i}`, p.choices, label(p)));
  const evidence = single ? blocks[0]! : blocks.map((b, i) => `[E${i + 1}]\n${b || '(none)'}`).join('\n\n');
  const untrusted = pending.some((p) => p.input.untrusted === true);
  try {
    const res = await judge.ask({ evidence, untrusted, questions });
    const byName = new Map(res.answers.map((a) => [a.name, a]));
    const share = res.costUsd === null ? null : Math.round((res.costUsd / pending.length) * 1e6) / 1e6;
    for (const p of pending) {
      const a = byName.get(`${p.def.id}#${p.i}`);
      out.set(p.i, a ? judgeDraft(p.def, p.input, p.hash, a, p.choices, res.model, share) : escalatedDraft(p.def, p.input, p.hash, 'judge gave no answer'));
    }
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
    for (const p of pending) out.set(p.i, escalatedDraft(p.def, p.input, p.hash, `judge error: ${msg}`));
  }
  return out;
}

// ---- pipeline ---------------------------------------------------------------------------------------------
/** Answers several decisions; questions that need a model go to the judge in one call. Results keep the input order. */
export async function decideMany(items: DecideItem[], opts: DecideOptions = {}): Promise<DecisionRecord[]> {
  const allowed = (await memoryAllowed()).enabled;
  const drafts = new Map<number, Draft>();
  const pending: Pending[] = [];
  for (const [i, item] of items.entries()) {
    const def = DECISIONS[item.id];
    if (!def) throw new Error(`Unknown decision: ${String(item.id)}`);
    const input = item.input;
    const hash = inputsHash(def.id, input);
    const choices = def.kind === 'choice' ? choicesFor(def, input.context) : null;
    const rule = def.rule?.(input) ?? null;
    if (rule) drafts.set(i, ruleDraft(def, input, hash, rule));
    else if (def.ruleOnly) drafts.set(i, escalatedDraft(def, input, hash, 'rule inputs missing'));
    else if (!allowed) drafts.set(i, escalatedDraft(def, input, hash, 'memory switched off'));
    else if (def.kind === 'choice' && !choices?.length) drafts.set(i, escalatedDraft(def, input, hash, 'no candidates'));
    else {
      const cached = opts.noCache ? null : await findCachedDecision(def.id, hash);
      if (cached) drafts.set(i, cacheDraft(def, input, hash, cached));
      else pending.push({ i, def, input, hash, choices });
    }
  }
  if (pending.length) {
    if (!opts.judge) for (const p of pending) drafts.set(p.i, escalatedDraft(p.def, p.input, p.hash, 'no judge configured'));
    else for (const [i, d] of await askJudge(opts.judge, pending)) drafts.set(i, d);
  }
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const records: DecisionRecord[] = [];
  for (let i = 0; i < items.length; i++) {
    const d = drafts.get(i)!;
    records.push(allowed ? await appendDecision({ ...d, at }) : { ...d, id: newId('dc', Date.parse(at)), at, project: currentProject().id });
  }
  return records;
}

/** Answers one decision through the pipeline. */
export async function decide(id: DecisionId, input: DecisionInput = {}, opts: DecideOptions = {}): Promise<DecisionRecord> {
  return (await decideMany([{ id, input }], opts))[0]!;
}

/** Appends a follow-up record noting whether an earlier decision turned out right or wrong (for threshold tuning). */
export async function markOutcome(recordId: string, outcome: 'right' | 'wrong', note?: string, opts: Pick<DecideOptions, 'now'> = {}): Promise<DecisionRecord | null> {
  if (!(await memoryAllowed()).enabled) return null;
  const e = (await listDecisions(Number.MAX_SAFE_INTEGER)).find((d) => d.id === recordId);
  if (!e) return null;
  return appendDecision({
    campaign: e.campaign, decision: e.decision, kind: e.kind, inputsHash: e.inputsHash, via: e.via, answer: e.answer, probabilities: e.probabilities, confidence: e.confidence, threshold: e.threshold, judge: e.judge,
    costUsd: null, outcome, note: `outcome of ${recordId}: ${outcome}${note ? ` (${note})` : ''}`, at: new Date(opts.now ?? Date.now()).toISOString(),
  });
}

// ---- goals (design 5.3) ---------------------------------------------------------------------------------
/** Metrics a goal can be measured by. The last three are not in `MetricKey` yet (contract gap noted in the report). */
export type GoalMetric = MetricKey | 'link_taps' | 'profile_visits' | 'follows';
export interface GoalProfile {
  goal: Goal;
  primary: GoalMetric;
  primaryLabel: string;
  secondary: GoalMetric;
  secondaryLabel: string;
  /** What the planner leans toward under this goal. */
  leanings: string[];
  /** Recency half-life for learnings under this goal (design 4; launches use 7). */
  halfLifeDays: number;
  /** Window after which a post's result counts fully (hours). */
  maturityHours: number;
}
const PROFILES: Record<Goal, GoalProfile> = {
  awareness: { goal: 'awareness', primary: 'reach', primaryLabel: 'reach per post', secondary: 'shares_per_reach', secondaryLabel: 'shares', leanings: ['broad hooks', 'Reels', 'trending formats'], halfLifeDays: 14, maturityHours: 48 },
  engagement: { goal: 'engagement', primary: 'saves_per_reach', primaryLabel: 'saves + comments per reach', secondary: 'likes_per_reach', secondaryLabel: 'likes', leanings: ['questions', 'puzzles with a reveal', 'carousels'], halfLifeDays: 14, maturityHours: 48 },
  installs: { goal: 'installs', primary: 'link_taps', primaryLabel: 'link taps, profile visits', secondary: 'saves_per_reach', secondaryLabel: 'saves', leanings: ['clear CTA', 'product-moment clips', 'link in bio'], halfLifeDays: 14, maturityHours: 48 },
  traffic: { goal: 'traffic', primary: 'link_taps', primaryLabel: 'link taps, profile visits', secondary: 'saves_per_reach', secondaryLabel: 'saves', leanings: ['clear CTA', 'product-moment clips', 'link in bio'], halfLifeDays: 14, maturityHours: 48 },
  launch: { goal: 'launch', primary: 'reach', primaryLabel: 'reach in the first 48 h', secondary: 'follows', secondaryLabel: 'follows', leanings: ['teasers', 'countdowns', 'date-tied posts'], halfLifeDays: 7, maturityHours: 48 },
  community: { goal: 'community', primary: 'comments_per_reach', primaryLabel: 'comments, replies', secondary: 'saves_per_reach', secondaryLabel: 'saves', leanings: ['questions', 'polls', 'replies to comments'], halfLifeDays: 14, maturityHours: 48 },
};
/** How the active goal changes routing: which metrics decisions use and what the planner leans toward. */
export function goalProfile(goal: Goal): GoalProfile {
  return { ...PROFILES[goal], leanings: [...PROFILES[goal].leanings] };
}
