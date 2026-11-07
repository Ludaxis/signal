// zod schemas for the Post maker API payloads: `PostmakerAction` (the body of POST /api/studio/postmaker)
// and `GraphOp` (pipeline.edit). Every id that later becomes a path segment is checked against the store's own
// patterns, numbers are bounded, free text is capped, objects are strict (an unknown key is a 400, never ignored),
// and open `params` / `output.json` values are size-capped. `parseAction` returns the typed action or throws a 400
// `PostmakerError` naming the first problem; it never echoes the request back.
import { z } from 'zod';
import { PostmakerError } from '../errors';
import { NODE_ID_RE, RECIPE_ID_RE, REF_ID_RE, RUN_ID_RE, TEMPLATE_ID_RE, VARIANT_ID_RE } from '../store/paths';
import { TEMPLATE_NAME_MAX } from '../template-name';
import { LANGS, STEP_KINDS, type GraphOp, type PostmakerAction } from '../types';

const id = (re: RegExp, what: string) => z.string().regex(re, `Unknown ${what}.`);
const recipeId = id(RECIPE_ID_RE, 'recipe');
const runId = id(RUN_ID_RE, 'run');
const nodeId = id(NODE_ID_RE, 'step');
const templateId = id(TEMPLATE_ID_RE, 'template');
const referenceId = id(REF_ID_RE, 'reference');
const variantId = id(VARIANT_ID_RE, 'variant');
const version = z.number().int().min(1).max(9_999_999);
const usd = z.number().finite().min(0).max(1000);
const text = (max: number) => z.string().max(max);
const lang = z.enum(LANGS);
const shape = z.enum(['9:16', '4:5', '1:1']);
const token = z.string().min(1).max(200);

/** An open JSON object, at most `maxBytes` when serialised (params, edited outputs). */
const jsonRecord = (maxBytes: number) =>
  z.record(z.string().max(80), z.unknown()).refine((v) => {
    try {
      return Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes;
    } catch {
      return false;
    }
  }, `Too large (at most ${Math.round(maxBytes / 1024)} KB).`);

const params = jsonRecord(20_000);

// ---- recipe parts (recipe.update) -------------------------------------------------------------------------

const segment = z.enum(['hook', 'story', 'interrupt', 'demo', 'chant', 'escalation', 'reveal', 'endcard', 'other']);
const beatSchema = z.strictObject({
  id: z.string().regex(/^b\d{2,3}$/, 'Beat ids look like b01.'),
  start: z.number().finite().min(0).max(300),
  end: z.number().finite().min(0).max(300),
  segment,
  name: text(80),
  purpose: text(400),
  visual: text(800),
  techniques: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/)).max(20),
  onScreenText: z.partialRecord(lang, text(400)),
  audio: text(400),
  motion: text(400),
}).refine((b) => b.end > b.start, 'A beat must end after it starts.');

const styleSchema = z.strictObject({
  captions: z.enum(['word-pop', 'line', 'karaoke']),
  pace: z.enum(['calm', 'fast', 'very-fast']),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(12),
  type: text(80),
  voice: text(80),
  music: text(80),
});

const recipePatch = z
  .strictObject({
    beats: z.array(beatSchema).min(1).max(40),
    style: styleSchema,
    languages: z.array(lang).min(1).max(LANGS.length),
    lengthSec: z.number().int().min(5).max(300),
    shape,
    capUsd: usd,
    campaignId: z.string().regex(/^c-\d{8}-[0-9a-z]{4}$/).nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change.');

// ---- pipeline parts (GraphOp add) -------------------------------------------------------------------------

const contractKey = z.enum(['beatIds', 'beatFrames', 'lineIds', 'lineMs', 'wordTimings', 'assetIds', 'anchors', 'textZones', 'tempo', 'cutFrames', 'totalFrames', 'coverFrame', 'cta']);
const port = z.string().regex(/^[a-zA-Z][a-zA-Z0-9:-]{0,39}$/, 'Port names are letters, digits, : and -.');
const connectorId = z.string().regex(/^[a-z][a-z0-9:.-]{0,47}$/);
const gateId = z.enum(['fa-native-editor', 'fa-native-listener', 'storyboard', 'draft-preview', 'listen', 'proof']);

const expectRule = z.strictObject({
  // Rule and adapter ids are the builder's (`narration.lineIds.exact`, `motion.retimeHolds`): camelCase segments.
  id: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,63}$/),
  from: nodeId,
  key: contractKey,
  tolerance: z.union([z.literal('exact'), z.literal('recompute'), z.strictObject({ pct: z.number().min(0).max(100).optional(), ms: z.number().min(0).max(60_000).optional(), frames: z.number().int().min(0).max(10_000).optional(), px: z.number().min(0).max(4000).optional(), bpm: z.number().min(0).max(300).optional() })]),
  label: text(120),
  adapter: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,63}$/).nullable(),
});

const nodeSchema = z.strictObject({
  id: nodeId,
  kind: z.enum(STEP_KINDS),
  lang: lang.nullable(),
  title: z.string().min(1).max(80),
  role: z.string().regex(/^[a-z][a-z-]{0,39}$/).nullable(),
  connectorChain: z.array(connectorId).min(1).max(8),
  params,
  instructions: text(4000),
  inputs: z.array(z.strictObject({ port, from: nodeId, fromPort: port, required: z.boolean() })).max(16),
  expects: z.array(expectRule).max(32),
  gate: z.strictObject({ id: gateId, blocks: z.enum(['before-paid-downstream', 'before-accept']) }).nullable(),
});

export const GraphOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), node: nodeSchema, after: nodeId }),
  z.strictObject({ op: z.literal('remove'), nodeId }),
  z.strictObject({ op: z.literal('move'), nodeId, after: nodeId }),
  z.strictObject({ op: z.literal('set-params'), nodeId, params }),
  z.strictObject({ op: z.literal('set-connector-chain'), nodeId, chain: z.array(connectorId).min(1).max(8) }),
  z.strictObject({ op: z.literal('set-instructions'), nodeId, text: text(4000) }),
]);

// ---- actions ----------------------------------------------------------------------------------------------

const scope = z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ nodes: z.array(nodeId).min(1).max(40) }), z.strictObject({ from: nodeId })]);
const makeOptions = z.strictObject({
  languages: z.array(lang).min(1).max(LANGS.length),
  lengthSec: z.number().int().min(5).max(300),
  shape,
  campaignId: z.string().regex(/^c-\d{8}-[0-9a-z]{4}$/).nullable().optional(),
  capUsd: usd.optional(),
  stopAfterRecipe: z.boolean().optional(),
});
const note = text(2000);
const perLine = z.array(z.strictObject({ lineId: z.string().regex(/^[a-z]\d{1,4}$/), ok: z.boolean(), note: text(500).optional() })).max(500);
const stepRef = { recipeId, nodeId };

// A variant as the client sends it (status, streak and proof are the server's); only the declared parameters.
// Ranges here are coarse type bounds; template-rules.ts (`checkVariantDraft`, `checkRepeat`) gives the plain reasons.
const variantSchema = z.strictObject({
  id: variantId.optional(),
  label: z.string().min(1).max(60),
  params: z.strictObject({ lang, lengthSec: z.number().int().min(1).max(300), shape, hook: text(200), voice: text(80), music: text(80), dualCaptions: z.boolean() }).partial(),
});
const repeatSchema = z.strictObject({
  enabled: z.boolean().optional(),
  perWeek: z.number().int().min(0).max(100),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  times: z.array(z.string().max(5)).max(24),
  makeAheadDays: z.number().int().min(0).max(100),
  dailyUsd: usd,
  approve: z.enum(['ask', 'trusted']),
});
const campaignId = z.string().regex(/^c-\d{8}-[0-9a-z]{4}$/, 'Unknown campaign.');

export const PostmakerActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('make-it'), referenceId, options: makeOptions }),
  z.strictObject({ action: z.literal('analyse'), referenceId, options: z.strictObject({ languages: makeOptions.shape.languages, lengthSec: makeOptions.shape.lengthSec, shape }) }),
  z.strictObject({ action: z.literal('recipe.update'), recipeId, baseVersion: version, patch: recipePatch }),
  z.strictObject({ action: z.literal('recipe.regenerate-beat'), recipeId, beatId: z.string().regex(/^b\d{2,3}$/), note: note.optional() }),
  z.strictObject({ action: z.literal('pipeline.build'), recipeId, recipeVersion: version }),
  z.strictObject({ action: z.literal('pipeline.edit'), recipeId, baseVersion: version, ops: z.array(GraphOpSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal('estimate'), recipeId, scope: scope.optional(), nodeId: nodeId.optional(), exact: z.boolean().optional(), fromHere: z.boolean().optional(), capUsd: usd.optional(), for: z.enum(['run', 'regenerate', 'regenerate-from-here']).optional() }),
  z.strictObject({ action: z.literal('run'), recipeId, scope, capUsd: usd, estimateToken: token }),
  z.strictObject({ action: z.literal('step.regenerate'), ...stepRef, mode: z.enum(['keep-contracts', 'allow-breaks']), note: note.optional(), beats: z.array(z.string().regex(/^b\d{2,3}$/)).max(40).optional(), uncheckedExpects: z.array(z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,63}$/)).max(32).optional(), overwriteEdit: z.boolean().optional(), estimateToken: token }),
  z.strictObject({ action: z.literal('step.regenerate-from-here'), ...stepRef, note: note.optional(), overwriteEdit: z.boolean().optional(), capUsd: usd, estimateToken: token }),
  z.strictObject({
    action: z.literal('step.edit'),
    ...stepRef,
    baseVersion: version,
    output: z.strictObject({ json: jsonRecord(2_000_000).optional(), replaceFile: z.strictObject({ port, uploadId: z.string().regex(/^up-[0-9a-f]{8,32}$/) }).optional() }),
    params: params.optional(),
    instructions: text(4000).optional(),
  }),
  z.strictObject({ action: z.literal('step.lock'), ...stepRef }),
  z.strictObject({ action: z.literal('step.unlock'), ...stepRef }),
  z.strictObject({ action: z.literal('step.skip'), ...stepRef }),
  z.strictObject({ action: z.literal('step.unskip'), ...stepRef }),
  z.strictObject({ action: z.literal('step.use-version'), ...stepRef, version }),
  z.strictObject({ action: z.literal('step.choose-candidate'), ...stepRef, version, accept: z.boolean() }),
  z.strictObject({ action: z.literal('run.pause'), runId }),
  z.strictObject({ action: z.literal('run.continue'), runId }),
  z.strictObject({ action: z.literal('run.stop'), runId }),
  z.strictObject({ action: z.literal('run.raise-cap'), runId, capUsd: usd }),
  z.strictObject({ action: z.literal('gate.sign-off'), ...stepRef, version, gate: gateId, name: z.string().min(1).max(80), verdict: z.enum(['pass', 'fail']), perLine: perLine.optional() }),
  z.strictObject({ action: z.literal('note.add'), runId, atSec: z.number().finite().min(0).max(300), box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(), text: z.string().min(1).max(1000), nodeId: nodeId.optional() }),
  z.strictObject({ action: z.literal('proof.accept'), runId, asDraft: z.boolean(), templateName: z.string().trim().min(1).max(TEMPLATE_NAME_MAX) }),
  z.strictObject({ action: z.literal('proof.score'), runId, lang, scores: z.array(z.strictObject({ criterion: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12']), score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), note: z.string().trim().min(1).max(140) })).min(1).max(12) }),
  z
    .strictObject({ action: z.literal('template.make-post'), templateId, variantId: variantId.optional(), brief: z.strictObject({ topic: z.string().trim().min(1).max(200), hook: text(200).optional(), notes: text(2000).optional() }).optional(), campaignSlot: z.strictObject({ campaignId, slotId: z.string().regex(/^[0-9a-z:-]{1,40}$/, 'Unknown slot.') }).optional(), capUsd: usd.optional() })
    .refine((a) => a.brief !== undefined || a.campaignSlot !== undefined, 'Give the post a topic.'),
  z.strictObject({ action: z.literal('template.variant.save'), templateId, variant: variantSchema }),
  z.strictObject({ action: z.literal('template.repeat.set'), templateId, repeat: repeatSchema }),
  z.strictObject({ action: z.literal('template.skip-proof.set'), templateId, variantId: variantId.nullable(), on: z.boolean() }),
  z.strictObject({ action: z.literal('template.campaign.attach'), templateId, campaignId }),
  z.strictObject({ action: z.literal('template.campaign.detach'), templateId, campaignId }),
  z.strictObject({ action: z.literal('template.duplicate'), templateId, name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX).optional() }),
  z.strictObject({ action: z.literal('template.retire'), templateId }),
  // The pipelines move and its undo (the newest move unless one is named).
  z.strictObject({ action: z.literal('postmaker.migrate') }),
  z.strictObject({ action: z.literal('postmaker.migrate.undo'), migrationId: z.string().regex(/^mig-\d{8}T\d{9}Z-[0-9a-f]{4}$/, 'Unknown move.').optional() }),
]);

// Compile-time guards: what the schemas accept is assignable to the types (and so to the engine).
type Parsed = z.infer<typeof PostmakerActionSchema>;
const _actionFits = (a: Parsed): PostmakerAction => a;
const _opFits = (o: z.infer<typeof GraphOpSchema>): GraphOp => o;
void _actionFits;
void _opFits;

function firstIssue(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return 'Bad request.';
  const where = i.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.');
  // zod's own wording for structural errors is technical; keep it short and never echo the value.
  const msg = i.code === 'custom' || i.code === 'invalid_format' ? i.message : i.code === 'unrecognized_keys' ? 'Unknown field.' : i.code === 'invalid_union' && i.path.length === 0 ? 'Unknown action.' : 'Not valid.';
  return where ? `${where}: ${msg}` : msg;
}

/** Parses the body of POST /api/studio/postmaker (without `project`). */
export function parseAction(body: unknown): PostmakerAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PostmakerError(400, 'validation', 'Bad request.');
  const { project: _project, ...rest } = body as Record<string, unknown>;
  void _project;
  if (typeof rest.action !== 'string') throw new PostmakerError(400, 'validation', 'Unknown action.');
  const r = PostmakerActionSchema.safeParse(rest);
  if (!r.success) {
    const unknownAction = r.error.issues.some((i) => i.code === 'invalid_union' && i.path.length === 0) || r.error.issues.some((i) => i.path.length === 1 && i.path[0] === 'action');
    throw new PostmakerError(400, 'validation', unknownAction ? 'Unknown action.' : firstIssue(r.error));
  }
  return r.data as PostmakerAction;
}

export function parseGraphOps(ops: unknown): GraphOp[] {
  const r = z.array(GraphOpSchema).min(1).max(50).safeParse(ops);
  if (!r.success) throw new PostmakerError(400, 'validation', firstIssue(r.error));
  return r.data as GraphOp[];
}
