// Moved pipelines (field table, `migratedFrom` and `inputs.kind`).
// A v1 pipeline becomes a template whose whole pipeline is one `legacy-format` node: the v1 post generator
// (`generatePackage({format})`) for the pipeline's format, with the format's connector chain and the pipeline's prompt
// template and caption style as node params. The built-in format templates below are those one-node pipelines, one
// per format; a moved pipeline's template carries a copy of its format's node with its own params.
// - The Post maker engine never runs a `legacy-format` node (it is not one of the engine's step kinds): the daily run
//   makes the post with the v1 generator under the v1 rules (review step, trusted approval, Codex only when a person
//   presses Run now, the Higgsfield gate), and the made package keeps `pipeline.json` with the old `pl-…` id.
// - Repeat settings keep the pipeline's own ranges (a $0 to $20 daily budget), so a move changes no value.
// Pure data and checks: no file access, no engine, connector or vendor import. Generic core: no project names.
import { FORMAT_LABEL, FORMATS, type Format } from '../../formats';
import { PostmakerError } from '../errors';
import type { LegacyFormatNode, LegacyPipeline, RepeatSettings, Template } from '../types';

export const LEGACY_FORMAT_KIND = 'legacy-format' as const;
export const LEGACY_SCHEMA = 'signal.pm.legacy-pipeline/1' as const;
/** A moved pipeline has no Post maker recipe: its template's `recipeId` is empty (every recipe reader refuses it). */
export const LEGACY_RECIPE_ID = '';

/** Codex runs on the person's own sign-in only when the person presses a button (equals autopilot `ATTENDED_ONLY`). */
export const LEGACY_ATTENDED_FORMATS: readonly Format[] = ['codex-post'];

/** The pipeline ranges (equal to pipelines/store.ts PER_WEEK, MAKE_AHEAD, DAILY_USD and its 4 times; a test pins it). */
export const LEGACY_REPEAT_LIMITS = { perWeek: { min: 1, max: 14 }, makeAheadDays: { min: 1, max: 7 }, dailyUsd: { min: 0, max: 20 }, times: 4 } as const;

/** The connector chain a format's generator uses (empty: made on this computer, no outside service). */
export function formatChain(format: Format): string[] {
  if (LEGACY_ATTENDED_FORMATS.includes(format)) return ['codex'];
  if (format === 'higgsfield-image') return ['higgsfield-image'];
  if (format === 'higgsfield-reel') return ['higgsfield-image', 'higgsfield-video'];
  return [];
}

const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);

/** The one node of a format's pipeline. */
export function legacyNode(format: Format, params: { template?: string; captionStyle?: string } = {}): LegacyFormatNode {
  return {
    id: LEGACY_FORMAT_KIND,
    kind: LEGACY_FORMAT_KIND,
    title: FORMAT_LABEL[format],
    connectorChain: formatChain(format),
    params: { format, template: params.template ?? '', captionStyle: params.captionStyle ?? '' },
    attendance: LEGACY_ATTENDED_FORMATS.includes(format) ? 'attended-only' : 'any',
  };
}

/** The built-in format template id (code, not a file): `format:<format>`. */
export const builtInFormatId = (format: Format) => `format:${format}`;

/** The built-in templates: one one-node `legacy-format` pipeline per format (the moved pipelines' starting points). */
export const BUILT_IN_FORMAT_TEMPLATES: readonly { id: string; name: string; format: Format; pipeline: LegacyPipeline }[] = FORMATS.map((format) => ({
  id: builtInFormatId(format),
  name: FORMAT_LABEL[format],
  format,
  pipeline: { schema: LEGACY_SCHEMA, builtIn: builtInFormatId(format), nodes: [legacyNode(format)], review: true },
}));

/** A moved pipeline's own copy: its format's built-in pipeline with the pipeline's params and review flag. */
export function legacyPipelineOf(format: Format, o: { template: string; captionStyle: string; review: boolean }): LegacyPipeline {
  return { schema: LEGACY_SCHEMA, builtIn: builtInFormatId(format), nodes: [legacyNode(format, o)], review: o.review };
}

/** The format a moved pipeline's template makes, or null for a Post maker template. */
export function legacyFormatOf(t: Pick<Template, 'legacy'>): Format | null {
  const f = t.legacy?.nodes?.[0]?.params?.format;
  return isFormat(f) ? f : null;
}

const bad = (reason: string) => new PostmakerError(400, 'validation', reason);

/** Checks a template's `legacy` block (the store calls it on every write of a moved pipeline's template). */
export function checkLegacy(l: LegacyPipeline): void {
  if (!l || typeof l !== 'object' || l.schema !== LEGACY_SCHEMA) throw bad('The moved pipeline is not valid.');
  if (!Array.isArray(l.nodes) || l.nodes.length !== 1) throw bad('A moved pipeline has exactly one step.');
  const n = l.nodes[0]!;
  if (n.kind !== LEGACY_FORMAT_KIND || n.id !== LEGACY_FORMAT_KIND) throw bad('The moved pipeline step is not valid.');
  if (!isFormat(n.params?.format)) throw bad('The moved pipeline names an unknown post type.');
  if (l.builtIn !== builtInFormatId(n.params.format)) throw bad('The moved pipeline names another post type.');
  if (typeof n.params.template !== 'string' || n.params.template.length > 800 || typeof n.params.captionStyle !== 'string' || n.params.captionStyle.length > 200) throw bad('The moved pipeline prompt is not valid.');
  if (typeof l.review !== 'boolean') throw bad('Review is on or off.');
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The pipeline ranges for a moved pipeline's Repeat settings (a pipeline may have a budget under $0.50). */
export function checkLegacyRepeat(r: RepeatSettings): void {
  const L = LEGACY_REPEAT_LIMITS;
  const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (typeof r.enabled !== 'boolean') throw bad('Repeat is on or off.');
  if (!intIn(r.perWeek, L.perWeek.min, L.perWeek.max)) throw bad(`Posts a week must be ${L.perWeek.min} to ${L.perWeek.max}.`);
  if (!Array.isArray(r.days) || r.days.length < 1 || r.days.length > 7 || !r.days.every((d) => intIn(d, 0, 6)) || new Set(r.days).size !== r.days.length) throw bad('Choose at least one day of the week.');
  if (!Array.isArray(r.times) || r.times.length < 1 || r.times.length > L.times || !r.times.every((x) => typeof x === 'string' && TIME_RE.test(x)) || new Set(r.times).size !== r.times.length) throw bad(`Choose 1 to ${L.times} times, as 24-hour HH:MM.`);
  if (!intIn(r.makeAheadDays, L.makeAheadDays.min, L.makeAheadDays.max)) throw bad(`Make ahead must be ${L.makeAheadDays.min} to ${L.makeAheadDays.max} days.`);
  if (typeof r.dailyUsd !== 'number' || !Number.isFinite(r.dailyUsd) || r.dailyUsd < L.dailyUsd.min || r.dailyUsd > L.dailyUsd.max) throw bad('The daily budget must be $0 to $20.');
  if (r.approve !== 'ask' && r.approve !== 'trusted') throw bad('Choose "Ask me" or "Post by itself".');
}

/** `template.repeat.set` on a moved pipeline's template: the pipeline ranges; days and times come back sorted. */
export function checkLegacyRepeatInput(r: Omit<RepeatSettings, 'enabled'> & { enabled?: boolean }): RepeatSettings {
  const out: RepeatSettings = { enabled: r.enabled ?? false, perWeek: r.perWeek, days: Array.isArray(r.days) ? [...r.days].sort((a, b) => a - b) : r.days, times: Array.isArray(r.times) ? [...r.times].sort() : r.times, makeAheadDays: r.makeAheadDays, dailyUsd: r.dailyUsd, approve: r.approve };
  checkLegacyRepeat(out);
  if (Math.round(out.dailyUsd * 100) / 100 !== out.dailyUsd) throw bad('The daily budget is in whole cents.');
  return out;
}

/** Make a post, variants and skip proof need a Post maker proof; a moved pipeline makes its posts on its schedule. */
export const LEGACY_ONLY_REPEAT = 'This template came from a pipeline. It makes posts on its schedule only.';

export function notLegacy(t: Pick<Template, 'legacy'>): void {
  if (t.legacy) throw new PostmakerError(409, 'conflict', LEGACY_ONLY_REPEAT);
}
