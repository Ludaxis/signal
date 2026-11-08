// The `art` step (roles doc, quality bar S3): the art director decides what is on screen in every
// beat, using only library assets, and asks for a missing asset through `newAssets` (gated generators only).
//
// - The answer is a `ScenePlan` proposal (zod), then code applies the Rejects as named errors (`ArtPlanRejected`,
//   one code per rule): an asset that is not approved (or a draft in a final run), a face or text inside a safe-zone
//   reserve or the right rail, a face box over the chosen text zone, a shot that differs from the template, a pose or
//   view the character's rig lacks, and a background change inside a segment (unless the node names that segment in
//   `params.cutSegments`).
// - Mock mode, and live mode when the art director cannot be called (agents off, not approved, not attended), plan
//   deterministically from the template and the library (`planScenes`); the same validator checks that plan.
// - `newAssets` never call a generator here: each request is recorded as pending ("Needs you") through `onRequests`;
//   only a person pressing "Make with Codex" in an open app session runs Codex (art-assets.ts `makeRequestedAsset`).
// - Faces are boxes derived from the anchor (the rig root `hip` pivot in canvas px and the full-body height, roles doc
// item 6); a loaded rig may give its own head proportions. Safe zones come from render/safeZones.ts only.
// Generic core: no project, brand or character names; ids come from the pack.
import { z } from 'zod';
import { PostmakerError } from '../errors';
import type { ScriptDoc } from '../graph/adapters';
import { DEFAULT_PRESET, TEMPLATE_SEGMENT_IDS, type TemplateSegmentId } from '../pack/template';
import { boxOf, checkBox, intersects, REEL_BANDS, SAFE_ZONES, type Box, type CanvasId } from '../render/safeZones';
import type { AssetKind, AssetUse, Contract, ContextBundle, Shape, StepCheck } from '../types';
import { agentEstimate, callAgent, type AgentCall } from './agent';
import type { Executor, ExecInput, ExecResult } from './types';
import { issueText, SEGMENTS, SHOTS } from './vocab';

// ---- vocabularies (roles doc) ---------------------------------------------------------------------

export const PRESET_IDS = ['hook', 'story', 'interrupt', 'demo-chant', 'reveal', 'endcard'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const VIEWS = ['front', 'three-quarter-L', 'three-quarter-R', 'profile-L', 'profile-R'] as const;
export type View = (typeof VIEWS)[number];
export const POSES = ['neutral', 'happy', 'laugh', 'surprised', 'shocked', 'sulk', 'bored', 'point-screen', 'hold-phone', 'look-phone', 'cheer', 'shrug', 'facepalm', 'hands-hips', 'dance-A', 'dance-B'] as const;
export type Pose = (typeof POSES)[number];
export const PROP_SLOTS = ['prop_hand_L', 'prop_hand_R', 'accessory_head', 'accessory_body'] as const;
export const TEXT_ZONES = ['headline', 'lower'] as const;
export type TextZone = (typeof TEXT_ZONES)[number];
export type Shot = (typeof SHOTS)[number];
export const NEW_ASSET_KINDS = ['background', 'prop', 'sticker', 'ui'] as const;
export type NewAssetKind = (typeof NEW_ASSET_KINDS)[number];

/** Image prompts are at most 600 characters (roles doc). */
export const PROMPT_MAX = 600;

// ---- ScenePlan (roles doc) ----------------------------------------------------------------------------------

const assetId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use a library asset id.');
const px = z.number().int().min(-4000).max(8000);
const anchorSchema = z.strictObject({ x: px, y: px, h: z.number().int().min(1).max(8000) });

export const scenePlanBeatSchema = z.strictObject({
  beatId: z.string().regex(/^b\d{2,3}$/),
  preset: z.enum(PRESET_IDS),
  background: assetId,
  cast: z.array(z.strictObject({ charId: assetId, view: z.enum(VIEWS), pose: z.enum(POSES), anchor: anchorSchema })).max(8),
  props: z.array(z.strictObject({ assetId, slot: z.enum(PROP_SLOTS), charId: assetId })).max(8),
  ui: z.strictObject({ phoneFrame: assetId, screens: z.array(assetId).max(8) }).nullable(),
  stickers: z.array(z.strictObject({ assetId, x: px, y: px, enterOffsetFrames: z.number().int().min(0).max(600) })).max(12),
  camera: z.strictObject({ x: px, y: px, w: z.number().int().min(1).max(8000), h: z.number().int().min(1).max(8000) }),
  textZone: z.enum(TEXT_ZONES),
  shot: z.enum(SHOTS),
});
export const newAssetSchema = z.strictObject({
  kind: z.enum(NEW_ASSET_KINDS),
  prompt: z.string().trim().min(1).max(PROMPT_MAX),
  targetLicence: z.literal('ai-generated'),
  reason: z.string().trim().min(1).max(200),
});
export const scenePlanSchema = z.strictObject({
  beats: z.array(scenePlanBeatSchema).min(1).max(60),
  newAssets: z.array(newAssetSchema).max(8),
  contractNotes: z.array(z.string().max(300)).max(20),
});
export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type ScenePlanBeat = ScenePlan['beats'][number];
export type NewAssetRequest = ScenePlan['newAssets'][number];

// ---- what the plan is checked against ------------------------------------------------------------------------------

/** One library asset as the art step sees it (pack and project assets merged; metadata only). */
export interface ArtAsset {
  id: string;
  kind: AssetKind;
  tags: string[];
  dims?: { w: number; h: number };
  status: 'draft' | 'approved' | 'retired';
  licence: { allowedUses?: AssetUse[]; expiresAt: string | null; aiGenerated: boolean; type: string };
  origin?: 'pack' | 'project';
}

/** What a character's rig can perform. `face` overrides the default head proportions (fractions of `h`). */
export interface RigCaps {
  tier?: 'A' | 'B' | 'C';
  views: View[];
  poses: Pose[];
  face?: FaceProportions;
}

export interface FaceProportions {
  /** Head top above the hip pivot, as a fraction of the full-body height. */
  top: number;
  height: number;
  width: number;
}
/** Default head box of a cut-out character: the head top sits half a body above the hip (quality bar proposal). */
export const DEFAULT_FACE: FaceProportions = { top: 0.5, height: 0.16, width: 0.18 };

export interface ArtTemplate {
  /** `cut`: the background may change between beats of this segment (roles doc rule 6, "unless the template says cut"). */
  segments: { id: TemplateSegmentId; shot: Shot; preset?: PresetId; require: string[]; cut?: boolean }[];
  cast: { lead: string; foil?: string; crowd?: string[] };
}

/** Everything the art step reads besides its upstream: the library, the rigs, the template and the names to refuse. */
export interface ArtWorld {
  library: ArtAsset[];
  /** Character id → what its rig can do; a character without an entry cannot be cast. */
  rigs: Record<string, RigCaps>;
  template: ArtTemplate | null;
  /** Brand and character names from the pack: image prompts may not name them (art-assets.ts prompt lint). */
  names: string[];
  /** Image prompts a person rejected (art-assets.ts): final, so the art director must not ask for them again. */
  rejectedPrompts?: string[];
}

export interface PlanBeat {
  id: string;
  segment: string;
}

export interface ArtContext {
  canvas: CanvasId;
  final: boolean;
  use: AssetUse;
  now: number;
  library: Map<string, ArtAsset>;
  rigs: Record<string, RigCaps>;
  template: ArtTemplate | null;
  beats: PlanBeat[];
  /** Segments where the background may change between beats (the template or the node says cut). */
  cutSegments: string[];
  rejectedPrompts: string[];
}

export const canvasOfShape = (s: Shape): CanvasId => (s === '4:5' ? 'feed-portrait' : s === '1:1' ? 'feed-square' : 'reel');

// ---- geometry -----------------------------------------------------------------------------------------------------

/** The face box of a cast member: the head above the hip pivot, centred on x. */
export function faceBox(a: { x: number; y: number; h: number }, f: FaceProportions = DEFAULT_FACE): Box {
  const width = Math.max(1, Math.round(a.h * f.width));
  const height = Math.max(1, Math.round(a.h * f.height));
  return { x: Math.round(a.x - width / 2), y: Math.round(a.y - a.h * f.top), width, height };
}

/** The text zone as a box: the reel bands (quality bar) on 9:16 canvases; on feed canvases the top 30 % or the
 *  last 72 rows of the text area. The lower band under the right rail ends at the rail's x. */
export function textZoneBox(canvas: CanvasId, zone: TextZone): Box {
  const t = SAFE_ZONES[canvas].text;
  const tall = canvas === 'reel' || canvas === 'story' || canvas === 'reel-cover';
  const y: [number, number] = tall ? (zone === 'headline' ? [...REEL_BANDS.headline] : [...REEL_BANDS.lower]) : zone === 'headline' ? [t.y[0], t.y[0] + Math.round((t.y[1] - t.y[0]) * 0.3)] : [t.y[1] - 72, t.y[1]];
  const x1 = t.rail && y[1] >= t.rail.fromY ? t.rail.x1 : t.x[1];
  return boxOf([t.x[0], x1], y);
}

const STICKER_MAX = 280;
/** A sticker's box: centred on (x, y), its library size scaled to at most 280 px (240 px square when unknown). */
export function stickerBox(s: { x: number; y: number }, dims?: { w: number; h: number }): Box {
  const k = dims ? Math.min(1, STICKER_MAX / Math.max(dims.w, dims.h)) : 1;
  const w = dims ? Math.max(1, Math.round(dims.w * k)) : 240;
  const h = dims ? Math.max(1, Math.round(dims.h * k)) : 240;
  return { x: Math.round(s.x - w / 2), y: Math.round(s.y - h / 2), width: w, height: h };
}

// ---- Rejects ------------------------------------------------------------------------------------------------------

/** One code per Rejects rule of roles doc, plus the structural ones. */
export const ART_REJECTS = {
  unapproved: 'art.asset-unapproved',
  safeZone: 'art.safe-zone',
  faceOverText: 'art.face-over-text',
  shot: 'art.shot-mismatch',
  rig: 'art.rig-lacks',
  background: 'art.background-change',
} as const;
export type ArtRejectCode = (typeof ART_REJECTS)[keyof typeof ART_REJECTS] | 'art.asset-unknown' | 'art.asset-kind' | 'art.asset-licence' | 'art.preset-mismatch' | 'art.beats' | 'art.prop-owner';

export interface ArtIssue {
  code: ArtRejectCode;
  beatId: string | null;
  text: string;
}

/** A plan that breaks a Rejects rule. `code` is the first issue's code; `issues` lists them all. */
export class ArtPlanRejected extends PostmakerError {
  constructor(public issues: ArtIssue[]) {
    super(422, issues[0]!.code, issues.length > 1 ? `${issues[0]!.text} (+${issues.length - 1} more)` : issues[0]!.text);
    this.name = 'ArtPlanRejected';
  }
}

const SEGMENT_SET = new Set<string>(TEMPLATE_SEGMENT_IDS);
const templateSegment = (ctx: Pick<ArtContext, 'template'>, segment: string) => (SEGMENT_SET.has(segment) ? (ctx.template?.segments.find((s) => s.id === segment) ?? null) : null);
/** The preset that must drive a segment: the template's own, else the core default; `other` takes any. */
const presetFor = (ctx: Pick<ArtContext, 'template'>, segment: string): PresetId | null => templateSegment(ctx, segment)?.preset ?? (SEGMENT_SET.has(segment) ? DEFAULT_PRESET[segment as TemplateSegmentId] : null);

/** Mirrors the resolver's licence rules (pack/resolve.ts) on metadata, so a plan fails before any render. */
function assetIssue(ctx: ArtContext, id: string, kind: AssetKind, beatId: string, what: string): ArtIssue | null {
  const a = ctx.library.get(id);
  if (!a) return { code: 'art.asset-unknown', beatId, text: `${beatId}: ${what} ${id} is not in the library.` };
  if (a.kind !== kind) return { code: 'art.asset-kind', beatId, text: `${beatId}: ${what} ${id} is a ${a.kind}, not a ${kind}.` };
  if (a.status === 'retired') return { code: ART_REJECTS.unapproved, beatId, text: `${beatId}: asset ${id} is retired.` };
  if (!ctx.final) return null;
  if (a.status !== 'approved') return { code: ART_REJECTS.unapproved, beatId, text: `${beatId}: asset ${id} is a draft. Approve it before the final render.` };
  const uses = a.licence.allowedUses ?? [];
  if (!uses.includes(ctx.use)) return { code: 'art.asset-licence', beatId, text: `${beatId}: asset ${id} is not licensed for ${ctx.use}.` };
  if (a.licence.expiresAt && Date.parse(a.licence.expiresAt) <= ctx.now) return { code: 'art.asset-licence', beatId, text: `${beatId}: the licence of asset ${id} has expired.` };
  return null;
}

/** Applies every Rejects rule to a parsed plan; returns the issues (empty = the plan passes). Pure. */
export function scenePlanIssues(plan: ScenePlan, ctx: ArtContext): ArtIssue[] {
  const out: ArtIssue[] = [];
  const got = plan.beats.map((b) => b.beatId);
  const want = ctx.beats.map((b) => b.id);
  if (got.join(',') !== want.join(',')) out.push({ code: 'art.beats', beatId: null, text: `The plan must cover the beats ${want.join(', ')} in order.` });
  const segOf = new Map(ctx.beats.map((b) => [b.id, b.segment]));
  const push = (i: ArtIssue | null) => void (i && out.push(i));
  let prev: { segment: string; background: string } | null = null;
  for (const b of plan.beats) {
    const segment = segOf.get(b.beatId) ?? 'other';
    const tpl = templateSegment(ctx, segment);
    // the template beat: shot and preset
    if (tpl && tpl.shot !== b.shot) out.push({ code: ART_REJECTS.shot, beatId: b.beatId, text: `${b.beatId}: the template asks for a ${tpl.shot} shot here, not ${b.shot}.` });
    const preset = presetFor(ctx, segment);
    if (preset && preset !== b.preset) out.push({ code: 'art.preset-mismatch', beatId: b.beatId, text: `${b.beatId}: ${segment} beats use the ${preset} motion.` });
    // assets: kind, status and licence
    push(assetIssue(ctx, b.background, 'background', b.beatId, 'background'));
    for (const c of b.cast) push(assetIssue(ctx, c.charId, 'character', b.beatId, 'character'));
    for (const p of b.props) {
      push(assetIssue(ctx, p.assetId, 'prop', b.beatId, 'prop'));
      if (!b.cast.some((c) => c.charId === p.charId)) out.push({ code: 'art.prop-owner', beatId: b.beatId, text: `${b.beatId}: prop ${p.assetId} is held by ${p.charId}, who is not in this beat.` });
    }
    if (b.ui) for (const u of [b.ui.phoneFrame, ...b.ui.screens]) push(assetIssue(ctx, u, 'ui', b.beatId, 'UI image'));
    for (const s of b.stickers) push(assetIssue(ctx, s.assetId, 'sticker', b.beatId, 'sticker'));
    // rigs: views and poses
    for (const c of b.cast) {
      const rig = ctx.rigs[c.charId];
      if (!rig) out.push({ code: ART_REJECTS.rig, beatId: b.beatId, text: `${b.beatId}: no rig is loaded for ${c.charId}.` });
      else if (!rig.views.includes(c.view)) out.push({ code: ART_REJECTS.rig, beatId: b.beatId, text: `${b.beatId}: ${c.charId} has no ${c.view} view.` });
      else if (!rig.poses.includes(c.pose)) out.push({ code: ART_REJECTS.rig, beatId: b.beatId, text: `${b.beatId}: ${c.charId} cannot do the ${c.pose} pose.` });
    }
    // safe zones: faces and text stickers avoid every reserve and the right rail; faces stay off the text zone
    const zone = textZoneBox(ctx.canvas, b.textZone);
    for (const c of b.cast) {
      const face = faceBox(c.anchor, ctx.rigs[c.charId]?.face);
      const bad = checkBox(ctx.canvas, face, { text: false, critical: true });
      if (bad.length) out.push({ code: ART_REJECTS.safeZone, beatId: b.beatId, text: `${b.beatId}: the face of ${c.charId} is inside the ${bad[0]!.zone} ${bad[0]!.rule === 'crop' ? 'crop edge' : 'reserve'}.` });
      if (intersects(face, zone)) out.push({ code: ART_REJECTS.faceOverText, beatId: b.beatId, text: `${b.beatId}: the face of ${c.charId} covers the ${b.textZone} text zone.` });
    }
    for (const s of b.stickers) {
      const a = ctx.library.get(s.assetId);
      if (!a?.tags.includes('text')) continue;
      const bad = checkBox(ctx.canvas, stickerBox(s, a.dims), { text: true });
      if (bad.length) out.push({ code: ART_REJECTS.safeZone, beatId: b.beatId, text: `${b.beatId}: text sticker ${s.assetId} is outside the text area (${bad[0]!.zone}).` });
    }
    // continuity: one background per segment unless it cuts
    if (prev && prev.segment === segment && prev.background !== b.background && !ctx.cutSegments.includes(segment)) out.push({ code: ART_REJECTS.background, beatId: b.beatId, text: `${b.beatId}: the background changes inside the ${segment} segment.` });
    prev = { segment, background: b.background };
  }
  return out;
}

/** Parses and checks an answer; throws `invalid-answer` (422) for a shape error and `ArtPlanRejected` for a rule. */
export function validateScenePlan(raw: unknown, ctx: ArtContext): ScenePlan {
  const parsed = scenePlanSchema.safeParse(raw);
  if (!parsed.success) throw new PostmakerError(422, 'invalid-answer', issueText(parsed.error));
  const issues = scenePlanIssues(parsed.data, ctx);
  if (issues.length) throw new ArtPlanRejected(issues);
  return parsed.data;
}

// ---- the deterministic plan (mock, and live without the art director) ---------------------------------------------

/** The shot of a segment when no template names one (template shots win). */
const DEFAULT_SHOT: Record<string, Shot> = { hook: 'wide', story: 'medium', interrupt: 'card', demo: 'insert', chant: 'card', escalation: 'wide', reveal: 'card', endcard: 'card', other: 'medium' };
/** Poses tried first per segment, before `neutral`. */
const SEGMENT_POSES: Record<string, Pose[]> = { hook: ['surprised', 'look-phone'], story: ['look-phone', 'hands-hips'], escalation: ['cheer', 'dance-A'], other: ['happy'] };
/** Sticker spots inside the action band, clear of the right rail (x < 960 at y ≥ 1100). */
const STICKER_SPOTS = [
  { x: 250, y: 820 },
  { x: 830, y: 860 },
  { x: 300, y: 1240 },
  { x: 780, y: 1260 },
];
/** Generic motifs for requested stickers: shapes only, never words or letters. */
const STICKER_MOTIFS = ['star burst', 'sparkle', 'heart', 'lightning bolt', 'thumbs-up hand'];

const usable = (ctx: ArtContext, a: ArtAsset) => a.status === 'approved' || (!ctx.final && a.status === 'draft');
const byId = (a: ArtAsset, b: ArtAsset) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const minCount = (require: string[], token: string) => {
  for (const r of require) {
    const m = new RegExp(`^${token}>=(\\d+)$`).exec(r);
    if (m) return Number(m[1]);
  }
  return 0;
};

/** The anchors of a shot's cast on a 1080-wide canvas (canvas px; `h` = full-body height). */
function castAnchors(shot: Shot, n: number, height: number): { x: number; y: number; h: number }[] {
  const s = height / 1920;
  if (shot === 'close') return [{ x: 540, y: Math.round(2260 * s), h: Math.round(3000 * s) }];
  if (shot === 'medium') return n > 1 ? [{ x: 380, y: Math.round(1450 * s), h: Math.round(1300 * s) }, { x: 720, y: Math.round(1450 * s), h: Math.round(1300 * s) }] : [{ x: 540, y: Math.round(1450 * s), h: Math.round(1300 * s) }];
  return n > 1 ? [{ x: 360, y: Math.round(1180 * s), h: Math.round(806 * s) }, { x: 720, y: Math.round(1180 * s), h: Math.round(806 * s) }] : [{ x: 540, y: Math.round(1180 * s), h: Math.round(806 * s) }];
}

/**
 * A plan from the template and the library alone: one usable background per segment, the template cast with a view
 * and pose its rig has, the phone frame on insert shots, stickers the template asks for, and a `newAssets` request
 * for each missing kind. Deterministic for a given library (`seed` only rotates the background choice).
 */
export function planScenes(ctx: ArtContext, seed = 1): ScenePlan {
  const lib = [...ctx.library.values()].filter((a) => usable(ctx, a)).sort(byId);
  // Approved assets first; a draft (draft runs only) stands in only where nothing of its kind is approved yet.
  const pick = (f: (a: ArtAsset) => boolean) => {
    const all = lib.filter(f);
    const approved = all.filter((a) => a.status === 'approved');
    return approved.length ? approved : all;
  };
  const backgrounds = pick((a) => a.kind === 'background');
  const stickers = pick((a) => a.kind === 'sticker' && !a.tags.includes('text'));
  const phone = pick((a) => a.kind === 'ui' && a.tags.includes('phone-frame'))[0] ?? null;
  const screens = pick((a) => a.kind === 'ui' && a.tags.includes('screen')).map((a) => a.id);
  const height = SAFE_ZONES[ctx.canvas].height;
  const castable = (id: string | undefined) => (id && ctx.rigs[id] && ctx.library.get(id) && usable(ctx, ctx.library.get(id)!) ? id : null);
  const lead = castable(ctx.template?.cast.lead) ?? castable(lib.find((a) => a.kind === 'character' && ctx.rigs[a.id])?.id);
  const foil = castable(ctx.template?.cast.foil);
  const newAssets: NewAssetRequest[] = [];
  const ask = (r: NewAssetRequest) => {
    if (!newAssets.some((x) => x.kind === r.kind && x.prompt === r.prompt) && newAssets.length < 8) newAssets.push(r);
  };
  if (!backgrounds.length) ask({ kind: 'background', prompt: 'a calm, softly lit indoor room as a vertical background plate, flat illustrated style, no people, no words, letters or logos', targetLicence: 'ai-generated', reason: 'The library has no usable background.' });
  const segments: string[] = [];
  for (const b of ctx.beats) if (!segments.includes(b.segment)) segments.push(b.segment);
  const bgOf = (segment: string) => (backgrounds.length ? backgrounds[(segments.indexOf(segment) + seed - 1) % backgrounds.length]!.id : null);
  const beats: ScenePlanBeat[] = [];
  for (const b of ctx.beats) {
    const tpl = templateSegment(ctx, b.segment);
    const shot: Shot = tpl?.shot ?? DEFAULT_SHOT[b.segment] ?? 'medium';
    const preset: PresetId = presetFor(ctx, b.segment) ?? 'story';
    const require = tpl?.require ?? [];
    const ids = shot === 'card' || shot === 'insert' || !lead ? [] : require.includes('newCharacter') && foil && foil !== lead ? [lead, foil] : [lead];
    const anchors = castAnchors(shot, ids.length, height);
    const cast = ids.map((charId, n) => {
      const rig = ctx.rigs[charId]!;
      const view: View = rig.views.includes('front') ? 'front' : rig.views[0]!;
      const pose: Pose = [...(SEGMENT_POSES[b.segment] ?? []), 'neutral' as Pose].find((p) => rig.poses.includes(p)) ?? rig.poses[0]!;
      return { charId, view, pose, anchor: anchors[n]! };
    });
    const want = Math.max(minCount(require, 'stickers'), minCount(require, 'feedbackStickers'));
    const placed = stickers.slice(0, Math.min(want, STICKER_SPOTS.length)).map((s, n) => ({ assetId: s.id, ...STICKER_SPOTS[n]!, enterOffsetFrames: 6 + n * 6 }));
    for (let n = placed.length; n < Math.min(want, STICKER_MOTIFS.length); n++) ask({ kind: 'sticker', prompt: `a bold flat sticker of a ${STICKER_MOTIFS[n]} with a thick white outline on a plain transparent background, no words, letters or logos`, targetLicence: 'ai-generated', reason: `The template asks for ${want} stickers; the library has ${stickers.length}.` });
    const needsPhone = shot === 'insert' || require.includes('phoneInsert') || require.includes('giantPhone');
    if (needsPhone && !phone) ask({ kind: 'ui', prompt: 'a modern smartphone seen straight from the front with a blank screen, flat vector style, no words, letters or logos', targetLicence: 'ai-generated', reason: 'The template asks for a phone insert; the library has no phone frame.' });
    const textZone: TextZone = cast.some((c) => intersects(faceBox(c.anchor, ctx.rigs[c.charId]?.face), textZoneBox(ctx.canvas, 'headline'))) ? 'lower' : 'headline';
    const background = bgOf(b.segment);
    if (!background) continue;
    beats.push({ beatId: b.id, preset, background, cast, props: [], ui: needsPhone && phone ? { phoneFrame: phone.id, screens } : null, stickers: placed, camera: { x: 0, y: 0, w: 1080, h: height }, textZone, shot });
  }
  return { beats, newAssets, contractNotes: [] };
}

// ---- the stored document and its contract --------------------------------------------------------------------------

/** A pending asset request as stored (art-assets.ts) and echoed in scenes.json. */
export interface AssetRequestRef extends NewAssetRequest {
  id: string;
  status: 'pending' | 'made' | 'refused' | 'rejected';
  waiting: string | null;
  lint: { code: string; text: string }[];
  assetId: string | null;
}

/** `scenes.json`: the plan, the canvas, the assets used (with the AI flag from their licence) and the requests. */
export interface ScenesDoc {
  schema: 'signal.pm.scenes/1';
  canvas: CanvasId;
  final: boolean;
  /** Who planned: the art director's answer, or the deterministic library plan. */
  source: 'art-director' | 'library';
  beats: (ScenePlanBeat & { id: string; anchors: { x: number; y: number; h: number } })[];
  assets: { id: string; kind: AssetKind; status: string; licence: string; aiGenerated: boolean }[];
  /** True when any asset on screen was AI-generated (it drives the AI label). */
  aiGenerated: boolean;
  requests: AssetRequestRef[];
  contractNotes: string[];
}

/** The anchor a beat promises downstream: its first cast member, else the canvas centre with no body. */
const beatAnchor = (b: ScenePlanBeat, height: number) => b.cast[0]?.anchor ?? { x: 540, y: Math.round(height / 2), h: 0 };

export function usedAssetIds(plan: Pick<ScenePlan, 'beats'>): string[] {
  const ids = new Set<string>();
  for (const b of plan.beats) {
    ids.add(b.background);
    for (const c of b.cast) ids.add(c.charId);
    for (const p of b.props) ids.add(p.assetId);
    if (b.ui) for (const u of [b.ui.phoneFrame, ...b.ui.screens]) ids.add(u);
    for (const s of b.stickers) ids.add(s.assetId);
  }
  return [...ids];
}

export function scenesDoc(plan: ScenePlan, ctx: ArtContext, source: ScenesDoc['source'], requests: AssetRequestRef[]): ScenesDoc {
  const height = SAFE_ZONES[ctx.canvas].height;
  const assets = usedAssetIds(plan).map((id) => {
    const a = ctx.library.get(id)!;
    return { id, kind: a.kind, status: a.status, licence: a.licence.type, aiGenerated: a.licence.aiGenerated === true };
  });
  return {
    schema: 'signal.pm.scenes/1',
    canvas: ctx.canvas,
    final: ctx.final,
    source,
    beats: plan.beats.map((b) => ({ ...b, id: b.beatId, anchors: beatAnchor(b, height) })),
    assets,
    aiGenerated: assets.some((a) => a.aiGenerated),
    requests,
    contractNotes: plan.contractNotes,
  };
}

export function scenesContract(d: Pick<ScenesDoc, 'beats'>): Contract {
  return {
    assetIds: usedAssetIds({ beats: d.beats }),
    anchors: Object.fromEntries(d.beats.map((b) => [b.beatId, b.anchors])),
    textZones: Object.fromEntries(d.beats.map((b) => [b.beatId, b.textZone])),
  };
}

/**
 * The planned layout as safe-zone frames (checks/safeZoneReport.ts shape, half-open boxes): one frame per beat at
 * its index, with each face, the text zone and each sticker (text stickers as text, others as decoration). Lets the
 * plan be checked before any render; the render's own measurements replace it later.
 */
export function plannedLayout(doc: Pick<ScenesDoc, 'beats' | 'canvas'>, ctx: Pick<ArtContext, 'rigs' | 'library'>): { frame: number; layers: { id: string; kind: 'text' | 'face' | 'decoration'; box: { x: number; y: number; w: number; h: number } }[] }[] {
  const half = (b: Box) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
  return doc.beats.map((b, n) => ({
    frame: n,
    layers: [
      { id: `${b.beatId}:text`, kind: 'text' as const, box: half(textZoneBox(doc.canvas, b.textZone)) },
      ...b.cast.map((c) => ({ id: `${b.beatId}:face:${c.charId}`, kind: 'face' as const, box: half(faceBox(c.anchor, ctx.rigs[c.charId]?.face)) })),
      ...b.stickers.map((s) => {
        const a = ctx.library.get(s.assetId);
        return { id: `${b.beatId}:sticker:${s.assetId}`, kind: a?.tags.includes('text') ? ('text' as const) : ('decoration' as const), box: half(stickerBox(s, a?.dims)) };
      }),
    ],
  }));
}

// ---- the executor -------------------------------------------------------------------------------------------------

export const ART_TASK =
  'Write the ScenePlan for every beat in the input, in order: the motion preset that drives its segment, one background, the cast with a view and pose their rig has and anchors (hip pivot in canvas px, full-body height in px), props, the phone frame and screens on insert shots, stickers, the camera and the text zone. Use only library ids you are given and assets whose status the input allows. Keep faces and text out of every safe-zone reserve and the right rail and keep faces off the chosen text zone. Ask for a missing asset only through newAssets.';
export const ART_OUTPUT_SPEC =
  'One JSON object: { "beats": [{ "beatId": "b01", "preset": "hook|story|interrupt|demo-chant|reveal|endcard", "background": "<asset id>", "cast": [{ "charId": "<id>", "view": "front|three-quarter-L|three-quarter-R|profile-L|profile-R", "pose": "<pose id>", "anchor": { "x": 540, "y": 1450, "h": 1300 } }], "props": [{ "assetId": "<id>", "slot": "prop_hand_L|prop_hand_R|accessory_head|accessory_body", "charId": "<id>" }], "ui": null, "stickers": [{ "assetId": "<id>", "x": 700, "y": 760, "enterOffsetFrames": 12 }], "camera": { "x": 0, "y": 0, "w": 1080, "h": 1920 }, "textZone": "headline|lower", "shot": "wide|medium|close|insert|card" }], "newAssets": [{ "kind": "background|prop|sticker|ui", "prompt": "≤ 600 characters, no text in the image, no names", "targetLicence": "ai-generated", "reason": "why" }], "contractNotes": [] }';

export interface ArtDeps {
  call?: AgentCall | null;
  billing?: 'subscription' | 'api-key';
  /** The library, rigs, template and names for this run; null = no project pack, so the step keeps its fake. */
  world: (i: ExecInput) => Promise<ArtWorld | null>;
  /** Records the plan's `newAssets` as pending requests (art-assets.ts); never runs a generator. */
  onRequests?: (requests: NewAssetRequest[], i: ExecInput, world: ArtWorld) => Promise<AssetRequestRef[]>;
  /** The step without a pack (the fake). */
  fallback?: Executor;
}

/** Codes of an agent call that cannot run now (switch off, not approved, not attended, not connected). */
const AGENT_UNAVAILABLE = new Set(['forbidden', 'needs_you', 'not_configured']);

export function artContext(i: Pick<ExecInput, 'recipe' | 'params' | 'byPort' | 'now'>, world: ArtWorld): ArtContext {
  const script = i.byPort.script as ScriptDoc | null | undefined;
  const beats: PlanBeat[] = script?.beats?.length ? script.beats.map((b) => ({ id: b.id, segment: (SEGMENTS as readonly string[]).includes(b.segment) ? b.segment : 'other' })) : i.recipe.beats.map((b) => ({ id: b.id, segment: b.segment }));
  const use = i.params.use === 'paid-ads' || i.params.use === 'store-listing' ? i.params.use : 'organic';
  const cut = new Set(Array.isArray(i.params.cutSegments) ? i.params.cutSegments.filter((s): s is string => typeof s === 'string') : []);
  for (const s of world.template?.segments ?? []) if (s.cut === true) cut.add(s.id);
  return { canvas: canvasOfShape(i.recipe.shape), final: i.params.final === true, use, now: i.now(), library: new Map(world.library.map((a) => [a.id, a])), rigs: world.rigs, template: world.template, beats, cutSegments: [...cut], rejectedPrompts: world.rejectedPrompts ?? [] };
}

/** The input the art director reads: beats with their template shot and preset, the library and the rigs (trusted). */
function agentParams(ctx: ArtContext) {
  return {
    canvas: ctx.canvas,
    finalRun: ctx.final,
    use: ctx.use,
    beats: ctx.beats.map((b) => {
      const t = templateSegment(ctx, b.segment);
      return { beatId: b.id, segment: b.segment, shot: t?.shot ?? DEFAULT_SHOT[b.segment] ?? 'medium', preset: presetFor(ctx, b.segment), require: t?.require ?? [] };
    }),
    library: [...ctx.library.values()].filter((a) => a.status !== 'retired' && (!ctx.final || a.status === 'approved')).map((a) => ({ id: a.id, kind: a.kind, tags: a.tags, dims: a.dims ?? null, status: a.status })),
    characters: Object.entries(ctx.rigs).map(([id, r]) => ({ id, tier: r.tier ?? null, views: r.views, poses: r.poses })),
    textZones: { headline: textZoneBox(ctx.canvas, 'headline'), lower: textZoneBox(ctx.canvas, 'lower') },
    reserves: SAFE_ZONES[ctx.canvas].reserves,
    cutSegments: ctx.cutSegments,
    rejectedPrompts: ctx.rejectedPrompts,
  };
}

const requestRefs = (reqs: NewAssetRequest[]): AssetRequestRef[] => reqs.map((r, n) => ({ ...r, id: `new-${n + 1}`, status: 'pending', waiting: null, lint: [], assetId: null }));

export function artExecutor(deps: ArtDeps): Executor {
  return {
    kind: 'art',
    implVersion: 'art@1',
    deterministic: false,
    estimate: (e) => agentEstimate(e.mode, deps.billing, 0.6, 90),
    async run(i): Promise<ExecResult> {
      const world = await deps.world(i);
      if (!world) {
        if (deps.fallback) return deps.fallback.run(i);
        throw new PostmakerError(409, 'needs_you', 'Scenes need a project pack.');
      }
      const ctx = artContext(i, world);
      let raw: unknown;
      let costUsd: number | null = 0;
      let model: string | null = i.mode === 'mock' ? 'mock' : null;
      let source: ScenesDoc['source'] = 'library';
      const checks: StepCheck[] = [];
      if (i.mode === 'live') {
        const base: ContextBundle = i.context ?? { task: '', node: { id: i.node.id, kind: 'art', lang: null, params: {} }, upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {}, outputSpec: '' };
        const bundle: ContextBundle = { ...base, task: [ART_TASK, base.task].filter(Boolean).join('\n\n'), node: { ...base.node, params: { ...base.node.params, ...agentParams(ctx) } }, outputSpec: ART_OUTPUT_SPEC };
        try {
          const r = await callAgent({ agent: 'art-director', kind: 'art', bundle, call: deps.call ?? null, signal: i.signal, validate: (v) => v });
          raw = r.value;
          costUsd = r.costUsd;
          model = r.model;
          source = 'art-director';
        } catch (e) {
          if (!(e instanceof PostmakerError) || !AGENT_UNAVAILABLE.has(e.code)) throw e;
          checks.push({ id: 'art.director', ok: true, required: false, text: 'Planned from the library. The art director is not available now.' });
        }
      }
      if (source === 'library') {
        const planned = planScenes(ctx, i.seed);
        if (!planned.beats.length) {
          // Nothing to stand on: record the background request (pending, never run) and wait for a person.
          if (deps.onRequests) await deps.onRequests(planned.newAssets, i, world);
          throw new PostmakerError(409, 'needs_you', 'The library has no background for these scenes. Make one with Codex or add one to the pack.');
        }
        raw = planned;
      }
      let plan: ScenePlan;
      try {
        plan = validateScenePlan(raw, ctx);
      } catch (e) {
        if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = costUsd;
        throw e;
      }
      // Requests are recorded, never run: a generator needs a person's button press in an open app.
      const requests = plan.newAssets.length ? (deps.onRequests ? await deps.onRequests(plan.newAssets, i, world) : requestRefs(plan.newAssets)) : [];
      const doc = scenesDoc(plan, ctx, source, requests);
      const pending = requests.filter((r) => r.status === 'pending').length;
      checks.push({ id: 'art.plan', ok: true, required: true, text: 'Every beat uses library assets inside the safe zones.' });
      if (pending) checks.push({ id: 'art.missing-assets', ok: false, required: false, text: `${pending} missing ${pending === 1 ? 'asset waits' : 'assets wait'} for you: Make with Codex.` });
      return { outputs: [{ port: 'scenes', name: 'scenes.json', kind: 'json', mime: 'application/json', data: doc }], provides: scenesContract(doc), checks, status: 'ok', costUsd, model };
    },
    contractOf: (data) => scenesContract(data as unknown as ScenesDoc),
  };
}
