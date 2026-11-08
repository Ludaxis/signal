// Template rules: pure functions shared by the
// templates server and its tests, with no file access, so every rule is testable on its own.
// - Limits: what the template can make. Today the core builder's (story-spine@1: 30-90 s, 9:16 only) and the
//   languages its source recipe was made in; a variant may change only the declared parameters, within those limits.
// - Repeat (the Pipelines editors moved here): posts a week 1-14, days, 24 h times, make ahead 1-7 days,
//   daily budget $0.50-$20, approval "ask" or "trusted"; off unless the person turns it on.
// - Streak and skip-proof per template + variant: the template-level fields are the default variant's. A clean
//   accept adds one only for a Premium, live proof with ≤ 2 regenerations and no hard-gate override (a manual score);
//   anything else resets it to 0, and skip-proof turns itself off whenever the streak falls below 3.
// - Gates inherited: a fork keeps the template's Persian sign-offs only while its narration-text and voice
//   versions are the very versions the template (or its proven variant) was accepted with.
// Generic core: no project, brand or character names.
import { PostmakerError } from './errors';
import { TEMPLATE_NAME_MAX, clipName } from './template-name';
import type { Lang, RepeatInput, RepeatSettings, Shape, StepVersion, Template, TemplateSummary, TemplateVariant, VariantDraft, VariantParams } from './types';
import { VARIANT_PARAMS } from './types';

// ---- limits -----------------------------------------------------------------------------------------------

export interface TemplateLimits {
  builder: string;
  durationSec: { min: number; max: number };
  canvases: Shape[];
}

/** The core template's limits when no pack template says otherwise (story-spine@1, see docs/project-pack-format.md). */
export const CORE_TEMPLATE_LIMITS: TemplateLimits = { builder: 'story-spine@1', durationSec: { min: 30, max: 90 }, canvases: ['9:16'] };

const bad = (m: string) => new PostmakerError(400, 'validation', m);
const LANG_WORD: Record<Lang, string> = { fa: 'Persian', en: 'English' };
export const MAX_VARIANTS = 12;
const TEXT_MAX = { hook: 200, voice: 80, music: 80 } as const;

/**
 * A variant a client asks to save: only the declared parameters (`VARIANT_PARAMS`), at least one of them, each one
 * something this template can make. Throws 400 with a plain reason; returns the cleaned parameters.
 */
export function checkVariantDraft(d: VariantDraft, o: { limits: TemplateLimits; languages: Lang[] }): { label: string; params: VariantParams } {
  const label = typeof d.label === 'string' ? d.label.replace(/\s+/g, ' ').trim() : '';
  if (!label || label.length > 60) throw bad('Give the variant a name (up to 60 characters).');
  const p = (d.params ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(p).filter((k) => !(VARIANT_PARAMS as readonly string[]).includes(k));
  if (unknown.length) throw bad('A variant can change only the language, length, shape, hook, voice, music and dual captions.');
  const out: VariantParams = {};
  if (p.lang !== undefined) {
    if (p.lang !== 'fa' && p.lang !== 'en') throw bad('Choose Persian or English.');
    if (!o.languages.includes(p.lang)) throw bad(`This template is not made in ${LANG_WORD[p.lang]}.`);
    out.lang = p.lang;
  }
  if (p.lengthSec !== undefined) {
    const n = p.lengthSec;
    const { min, max } = o.limits.durationSec;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw bad('The length is a whole number of seconds.');
    if (n < min || n > max) throw bad(`This template makes ${min}-${max} s videos.`);
    out.lengthSec = n;
  }
  if (p.shape !== undefined) {
    if (p.shape !== '9:16' && p.shape !== '4:5' && p.shape !== '1:1') throw bad('Choose 9:16, 4:5 or 1:1.');
    if (!o.limits.canvases.includes(p.shape)) throw bad(`This template makes ${o.limits.canvases.join(', ')} videos only.`);
    out.shape = p.shape;
  }
  for (const k of ['hook', 'voice', 'music'] as const) {
    if (p[k] === undefined) continue;
    const v = typeof p[k] === 'string' ? (p[k] as string).trim() : null;
    if (!v || v.length > TEXT_MAX[k]) throw bad(`The ${k} is text of 1 to ${TEXT_MAX[k]} characters.`);
    out[k] = v;
  }
  if (p.dualCaptions !== undefined) {
    if (typeof p.dualCaptions !== 'boolean') throw bad('Dual captions is on or off.');
    out.dualCaptions = p.dualCaptions;
  }
  if (Object.keys(out).length === 0) throw bad('A variant changes at least one setting.');
  return { label, params: out };
}

const sameParams = (a: VariantParams, b: VariantParams) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * `template.variant.save` as data: a new variant is Draft with streak 0; changing an existing variant's parameters
 * makes it a new thing to prove (Draft, streak 0, skip-proof off, no gate hashes); a new label alone keeps its state.
 */
export function saveVariant(t: Template, d: VariantDraft, o: { limits: TemplateLimits; languages: Lang[]; newId: () => string }): { template: Template; variant: TemplateVariant } {
  if (t.status === 'retired') throw new PostmakerError(409, 'conflict', 'This template is retired.');
  const { label, params } = checkVariantDraft(d, o);
  const at = d.id ? t.variants.findIndex((v) => v.id === d.id) : -1;
  if (d.id && at < 0) throw new PostmakerError(404, 'not_found', 'Unknown variant.');
  let variant: TemplateVariant;
  let variants: TemplateVariant[];
  if (at >= 0) {
    const prev = t.variants[at]!;
    variant = sameParams(prev.params, params) ? { ...prev, label } : { ...prev, label, params, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, gateHashes: null };
    variants = t.variants.map((v, i) => (i === at ? variant : v));
  } else {
    if (t.variants.length >= MAX_VARIANTS) throw new PostmakerError(409, 'conflict', `A template has at most ${MAX_VARIANTS} variants.`);
    let id = o.newId();
    for (let i = 0; i < 8 && t.variants.some((v) => v.id === id); i++) id = o.newId();
    variant = { id, label, params, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, gateHashes: null };
    variants = [...t.variants, variant];
  }
  return { template: { ...t, variants }, variant };
}

// ---- Repeat --------------------------------------------------------------------------------------------

/** The Pipelines ranges (lib/studio/pipelines/store.ts PER_WEEK, MAKE_AHEAD) and the UX daily budget $0.50-$20. */
export const REPEAT_LIMITS = { perWeek: { min: 1, max: 14 }, makeAheadDays: { min: 1, max: 7 }, dailyUsd: { min: 0.5, max: 20 }, times: 4 } as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates Repeat settings; `enabled` is false unless the person sets it. Days and times come back sorted. */
export function checkRepeat(r: RepeatInput): RepeatSettings {
  const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const L = REPEAT_LIMITS;
  if (!intIn(r.perWeek, L.perWeek.min, L.perWeek.max)) throw bad(`Posts a week must be ${L.perWeek.min} to ${L.perWeek.max}.`);
  if (!Array.isArray(r.days) || r.days.length < 1 || r.days.length > 7 || !r.days.every((d) => intIn(d, 0, 6))) throw bad('Choose at least one day of the week.');
  if (new Set(r.days).size !== r.days.length) throw bad('Each day can be chosen once.');
  if (!Array.isArray(r.times) || r.times.length < 1 || r.times.length > L.times || !r.times.every((x) => typeof x === 'string' && TIME_RE.test(x))) throw bad(`Choose 1 to ${L.times} times, as 24-hour HH:MM.`);
  if (new Set(r.times).size !== r.times.length) throw bad('Each time can be chosen once.');
  if (!intIn(r.makeAheadDays, L.makeAheadDays.min, L.makeAheadDays.max)) throw bad(`Make ahead must be ${L.makeAheadDays.min} to ${L.makeAheadDays.max} days.`);
  if (typeof r.dailyUsd !== 'number' || !Number.isFinite(r.dailyUsd) || r.dailyUsd < L.dailyUsd.min || r.dailyUsd > L.dailyUsd.max) throw bad('The daily budget must be $0.50 to $20.');
  // Compare in dollars: cents arithmetic is float-unsafe (0.57 * 100 is 56.99999999999999).
  if (Math.round(r.dailyUsd * 100) / 100 !== r.dailyUsd) throw bad('The daily budget is in whole cents.');
  if (r.approve !== 'ask' && r.approve !== 'trusted') throw bad('Choose "Ask me" or "Post by itself".');
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw bad('Repeat is on or off.');
  return {
    enabled: r.enabled ?? false,
    perWeek: r.perWeek,
    days: [...r.days].sort((a, b) => a - b),
    times: [...r.times].sort(),
    makeAheadDays: r.makeAheadDays,
    dailyUsd: r.dailyUsd,
    approve: r.approve,
  };
}

// ---- streak and skip-proof per template + variant ---------------------------------------------------------

export const SKIP_PROOF_STREAK = 3;

/** What a clean accept records about its proof (accept.ts computes it). */
export interface AcceptOutcome {
  verdict: 'premium' | 'standard';
  live: boolean;
  regenerations: number;
  /** The verdict came from a hard-gate override: the person's manual score on an Unscored proof. */
  override: boolean;
}

/** Premium, live, ≤ 2 regenerations and no override adds one; anything else resets to 0. */
export function nextPremiumStreak(prev: number, o: Pick<AcceptOutcome, 'verdict' | 'live' | 'regenerations'> & { override?: boolean }): number {
  return o.verdict === 'premium' && o.live && o.regenerations <= 2 && !o.override ? prev + 1 : 0;
}

/** The streak and skip-proof of one variant (null = the default variant, the template-level fields). */
export function streakOf(t: Pick<Template, 'premiumStreak' | 'skipProofForRepeats' | 'variants'>, variantId: string | null): { streak: number; skipProof: boolean } | null {
  if (variantId === null) return { streak: t.premiumStreak, skipProof: t.skipProofForRepeats };
  const v = t.variants.find((x) => x.id === variantId);
  return v ? { streak: v.premiumStreak, skipProof: v.skipProofForRepeats } : null;
}

/**
 * The template after a clean accept of a proof of `variantId` (null = default variant): the streak moves for that
 * variant only; skip-proof turns off when the streak falls below 3; Premium proves the variant (with the gate hashes
 * it was accepted with) or, for the default variant, the template. A Standard accept never demotes anything.
 * `proveTemplate` false keeps an already proven template's proof (a post made from it is not a new proof).
 */
export function applyAcceptToTemplate(t: Template, o: AcceptOutcome & { variantId: string | null; runId: string; at: string; by: string; gateHashes: Record<string, string>; proveTemplate: boolean }): Template {
  const premium = o.verdict === 'premium';
  if (o.variantId !== null) {
    if (!t.variants.some((v) => v.id === o.variantId)) throw new PostmakerError(409, 'conflict', 'This variant is no longer on the template.');
    const variants = t.variants.map((v) => {
      if (v.id !== o.variantId) return v;
      const streak = nextPremiumStreak(v.premiumStreak, o);
      return {
        ...v,
        premiumStreak: streak,
        skipProofForRepeats: v.skipProofForRepeats && streak >= SKIP_PROOF_STREAK,
        ...(premium ? { status: 'proven' as const, provenRunId: o.runId, gateHashes: o.gateHashes } : {}),
      };
    });
    return { ...t, variants };
  }
  const streak = nextPremiumStreak(t.premiumStreak, o);
  return {
    ...t,
    premiumStreak: streak,
    skipProofForRepeats: t.skipProofForRepeats && streak >= SKIP_PROOF_STREAK,
    ...(premium && o.proveTemplate ? { status: 'proven' as const, provenRunId: o.runId, provenAt: o.at, provenBy: o.by } : {}),
  };
}

export const SKIP_PROOF_LOCKED_TEXT = 'Skip proof unlocks after 3 Premium proofs in a row.';

/** `template.skip-proof.set`: on only at streak ≥ 3 on a template that is not retired; off always. */
export function setSkipProof(t: Template, variantId: string | null, on: boolean): Template {
  const cur = streakOf(t, variantId);
  if (!cur) throw new PostmakerError(404, 'not_found', 'Unknown variant.');
  if (on && t.status === 'retired') throw new PostmakerError(409, 'conflict', 'This template is retired.');
  if (on && cur.streak < SKIP_PROOF_STREAK) throw new PostmakerError(409, 'streak', SKIP_PROOF_LOCKED_TEXT);
  if (variantId === null) return { ...t, skipProofForRepeats: on };
  return { ...t, variants: t.variants.map((v) => (v.id === variantId ? { ...v, skipProofForRepeats: on } : v)) };
}

/** Retire: the template and every variant lose skip-proof, and Repeat turns off (its settings stay). */
export const retired = (t: Template): Template => ({
  ...t,
  status: 'retired',
  skipProofForRepeats: false,
  variants: t.variants.map((v) => ({ ...v, skipProofForRepeats: false })),
  repeat: t.repeat ? { ...t.repeat, enabled: false } : null,
});

// ---- gates inherited ----------------------------------------------------------------------------------

/** The node ids whose sign-offs a fork may inherit: narration text and voice, per language. */
export const GATED_KINDS_RE = /^(narration-text|voice):[a-z]{2}$/;

/** The template version a fork's version stands for: the one it was forked from, else itself. */
export const originHash = (v: Pick<StepVersion, 'hash' | 'forkedFrom'>): string => v.forkedFrom?.hash ?? v.hash;

/**
 * True only when every `narration-text:*` and `voice:*` step of the fork has a current version whose origin hash is
 * the one the template's snapshot (default variant) or the variant's accepted proof (`gateHashes`) recorded, and
 * every such step the reference names for the fork's languages exists in the fork. A variant that is not proven yet,
 * or an unknown variant, inherits nothing.
 */
export function gatesInherited(t: Pick<Template, 'snapshot' | 'variants'>, variantId: string | null, fork: { current: Record<string, Pick<StepVersion, 'hash' | 'forkedFrom'> | null>; languages: Lang[] }): boolean {
  let ref: Record<string, string>;
  if (variantId === null) ref = Object.fromEntries(Object.entries(t.snapshot.heads).map(([id, h]) => [id, h.hash]));
  else {
    const v = t.variants.find((x) => x.id === variantId);
    if (!v || v.status !== 'proven' || !v.gateHashes) return false;
    ref = v.gateHashes;
  }
  const want = new Set(Object.keys(ref).filter((id) => GATED_KINDS_RE.test(id) && fork.languages.includes(id.split(':')[1] as Lang)));
  for (const id of Object.keys(fork.current)) if (GATED_KINDS_RE.test(id)) want.add(id);
  for (const id of want) {
    const v = fork.current[id] ?? null;
    if (!v || !ref[id] || originHash(v) !== ref[id]) return false;
  }
  return true;
}

/** The gate hashes a variant's accepted proof records (origin hashes of its narration-text and voice versions). */
export function gateHashesOf(current: Record<string, Pick<StepVersion, 'hash' | 'forkedFrom'> | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(current).filter((e): e is [string, Pick<StepVersion, 'hash' | 'forkedFrom'>] => GATED_KINDS_RE.test(e[0]) && e[1] !== null).map(([id, v]) => [id, originHash(v)]));
}

// ---- read-time migration and projections ---------------------------------------------------------------------------

/** A variant written before the per-variant streak reads as streak 0, skip-proof off. */
export function withVariantDefaults(t: Template): Template {
  if (!Array.isArray(t.variants) || t.variants.every((v) => Number.isInteger(v.premiumStreak) && typeof v.skipProofForRepeats === 'boolean')) return t;
  return { ...t, variants: t.variants.map((v) => ({ ...v, premiumStreak: Number.isInteger(v.premiumStreak) && v.premiumStreak >= 0 ? v.premiumStreak : 0, skipProofForRepeats: v.skipProofForRepeats === true })) };
}

/** `template.duplicate` as data: a new Draft with streaks 0, skip-proof off, Repeat off and unproven variants. */
export function duplicateOf(t: Template, o: { id: string; name?: string }): Template {
  const name = clipName(o.name?.trim() || `${t.name} copy`, TEMPLATE_NAME_MAX);
  if (!name) throw bad(`Give the template a name (up to ${TEMPLATE_NAME_MAX} characters).`);
  return {
    ...t,
    id: o.id,
    name,
    status: 'draft',
    provenRunId: null,
    provenAt: null,
    provenBy: null,
    builtIn: false,
    variants: t.variants.map((v) => ({ ...v, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, gateHashes: null })),
    repeat: t.repeat ? { ...t.repeat, enabled: false } : null,
    skipProofForRepeats: false,
    premiumStreak: 0,
    migratedFrom: null,
    revision: 1,
  };
}

/** The template as Home and the Recipe screen show it. */
export function templateSummary(t: Template): TemplateSummary {
  const allowed = (streak: number) => t.status !== 'retired' && streak >= SKIP_PROOF_STREAK;
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    recipeId: t.recipeId,
    provenRunId: t.provenRunId,
    premiumStreak: t.premiumStreak,
    skipProofForRepeats: t.skipProofForRepeats,
    skipProofAllowed: allowed(t.premiumStreak),
    campaignIds: [...t.campaignIds],
    revision: t.revision,
    variants: t.variants.map((v) => ({ id: v.id, label: v.label, params: { ...v.params }, status: v.status, provenRunId: v.provenRunId, premiumStreak: v.premiumStreak, skipProofForRepeats: v.skipProofForRepeats, skipProofAllowed: allowed(v.premiumStreak) })),
    repeat: t.repeat ? { ...t.repeat, days: [...t.repeat.days], times: [...t.repeat.times] } : null,
    migratedFrom: t.migratedFrom ?? null,
  };
}
