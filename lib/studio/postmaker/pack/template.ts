// Pack templates (`templates/<id>.json`, project-): the zod schema of, the
// cross-field checks of and the core scaling rule of that turns a template and a total length into
// segment lengths and frame boundaries. Pure module (no file access besides `loadPackTemplates`); generic core: the
// template names come from the pack, never from here.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PostmakerError } from '../errors';
import type { Lang } from '../types';
import type { LoadedPack } from './load';
import { insideDir } from './load';
import { firstIssue, langSchema } from './schema';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TEMPLATE_SEGMENT_IDS = ['hook', 'story', 'interrupt', 'demo', 'chant', 'escalation', 'reveal', 'endcard'] as const;
export type TemplateSegmentId = (typeof TEMPLATE_SEGMENT_IDS)[number];
const SEGMENT_ID = z.enum(TEMPLATE_SEGMENT_IDS);
const PALETTE_ROLE = z.enum(['primary', 'accent', 'secondary', 'background', 'background-dark', 'text']);
const PRESET_ID = z.enum(['hook', 'story', 'interrupt', 'demo-chant', 'reveal', 'endcard']);
const TOKEN = /^(povLabel|kineticCaptions|idles|newCharacter|speechBubble|speakerTags|darkCard|questionBubble|phoneInsert|swipePath|brandWord|onDownbeats|fullCast|giantPhone|crowdLoop|brandRevealLetters|confetti|appIcon|tagline|cta|(stickers|feedbackStickers|colourCards)>=([1-9]|1[0-2]))$/;

/** The preset that drives each segment by default (`preset`). */
export const DEFAULT_PRESET: Record<TemplateSegmentId, z.infer<typeof PRESET_ID>> = {
  hook: 'hook',
  story: 'story',
  escalation: 'story',
  interrupt: 'interrupt',
  demo: 'demo-chant',
  chant: 'demo-chant',
  reveal: 'reveal',
  endcard: 'endcard',
};

export const templateSegmentSchema = z.object({
  id: SEGMENT_ID,
  share: z.number().min(0).max(1),
  minSec: z.number().min(0),
  maxSec: z.number().positive().optional(),
  shot: z.enum(['wide', 'medium', 'close', 'insert', 'card']),
  require: z.array(z.string().regex(TOKEN, 'Use a requirement token from the roles guide.')),
  music: z.enum(['bed-low', 'drop', 'build', 'full', 'hit', 'resolve']),
  optional: z.boolean().default(false),
  preset: PRESET_ID.optional(),
});

export const packTemplateSchema = z.object({
  schema: z.literal('signal.pack-template/1'),
  id: z.string().regex(SLUG),
  version: z.number().int().min(1),
  name: z.string().min(1).max(60),
  builder: z.literal('story-spine@1'),
  media: z.literal('video'),
  canvases: z.array(z.object({ shape: z.enum(['9:16', '4:5', '1:1']), w: z.number().int().positive(), h: z.number().int().positive() })).min(1),
  fps: z.literal(30),
  durationSec: z.object({ min: z.number().min(15), max: z.number().max(90) }),
  languages: z.array(langSchema).min(1),
  tempo: z.object({ bpmRange: z.tuple([z.number().min(90), z.number().max(128)]), chantBeatsPerCard: z.union([z.literal(2), z.literal(4)]), beatsPerBar: z.union([z.literal(3), z.literal(4)]).default(4) }),
  segments: z.array(templateSegmentSchema).min(1),
  cast: z.object({ lead: z.string().regex(SLUG), foil: z.string().regex(SLUG).optional(), crowd: z.array(z.string().regex(SLUG)).optional() }),
  styles: z.object({
    caption: z.enum(['plate-highlight', 'plate', 'outline', 'scrim']),
    palette: z.literal('pack'),
    cardPalette: z.array(PALETTE_ROLE).min(2).max(6),
    backgroundDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
  options: z.object({ storyboard: z.boolean(), draftPreview: z.boolean() }).default({ storyboard: false, draftPreview: false }),
  variants: z
    .array(z.object({ id: z.string().regex(SLUG), label: z.string().min(1).max(40), lengthSec: z.number().positive(), lang: langSchema.optional(), bpm: z.number().min(60).max(200).optional(), segmentSec: z.partialRecord(SEGMENT_ID, z.number().positive()).optional() }))
    .optional(),
});

export type PackTemplate = z.infer<typeof packTemplateSchema>;
export type TemplateSegment = PackTemplate['segments'][number];
export type TemplateVariant = NonNullable<PackTemplate['variants']>[number];

const err = (code: string, message: string, status = 422) => new PostmakerError(status, code, message);

export interface TemplateContext {
  /** The file name without `.json` (`template.id-mismatch`). */
  fileId?: string;
  /** The pack's languages (the template's must be a subset). */
  packLanguages?: Lang[];
  /** Character asset ids of the pack library (`template.cast-unknown`). */
  characterIds?: string[];
}

/** Parses a template and runs the cross-field checks; throws with the code. */
export function parseTemplate(raw: unknown, ctx: TemplateContext = {}): PackTemplate {
  const parsed = packTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    const tokenIssue = parsed.error.issues.find((i) => i.path.includes('require'));
    if (tokenIssue) throw err('template.token-unknown', `Template requirement ${tokenIssue.path.join('.')} is not a known token.`);
    throw err('template.invalid', `The template is not valid (${firstIssue(parsed.error)}).`);
  }
  const t = parsed.data;
  if (ctx.fileId !== undefined && ctx.fileId !== t.id) throw err('template.id-mismatch', `Template ${t.id} must be saved as templates/${t.id}.json.`);
  const ids = t.segments.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw err('template.invalid', 'Each segment appears once.');
  const order = ids.map((id) => TEMPLATE_SEGMENT_IDS.indexOf(id));
  if (order.some((o, i) => i > 0 && o < order[i - 1]!)) throw err('template.invalid', 'Segments are listed in playback order.');
  const shares = t.segments.reduce((s, x) => s + x.share, 0);
  if (Math.abs(shares - 1) > 0.01) throw err('template.shares', `Segment shares add up to ${shares.toFixed(2)}; they must add up to 1.00.`);
  for (const s of t.segments) {
    if (s.maxSec !== undefined && s.maxSec < s.minSec) throw err('template.invalid', `${s.id}: the longest length is shorter than the shortest.`);
    if (s.preset && s.preset !== DEFAULT_PRESET[s.id]) throw err('template.preset-mismatch', `${s.id} cannot use the ${s.preset} motion.`);
  }
  if (t.durationSec.min > t.durationSec.max) throw err('template.invalid', 'The shortest length is longer than the longest.');
  if (t.tempo.bpmRange[0] > t.tempo.bpmRange[1]) throw err('template.invalid', 'The tempo range is upside down.');
  // A variant's declared BPM must sit inside the template's tempo range.
  const [lo, hi] = t.tempo.bpmRange;
  const offTempo = (t.variants ?? []).find((v) => v.bpm !== undefined && (v.bpm < lo || v.bpm > hi));
  if (offTempo) throw err('template.invalid', `Variant ${offTempo.id} is set to ${offTempo.bpm} BPM; this template allows ${lo} to ${hi} BPM.`);
  const required = t.segments.filter((s) => !s.optional).reduce((s, x) => s + x.minSec, 0);
  if (required > t.durationSec.min + 1e-9) throw err('template.too-short', `The segments need ${required} s; the template allows ${t.durationSec.min} s.`);
  if (ctx.packLanguages && t.languages.some((l) => !ctx.packLanguages!.includes(l))) throw err('template.invalid', 'The template uses a language the pack does not have.');
  if (ctx.characterIds) {
    const cast = [t.cast.lead, ...(t.cast.foil ? [t.cast.foil] : []), ...(t.cast.crowd ?? [])];
    const missing = cast.find((c) => !ctx.characterIds!.includes(c));
    if (missing) throw err('template.cast-unknown', `Cast ${missing} is not a character in the pack.`);
  }
  return t;
}

// ---- scaling -------------------------------------------------------------------------------------------

export interface ScaledSegment {
  id: TemplateSegmentId;
  sec: number;
  /** Frame boundaries [from, to) at 30 fps. */
  from: number;
  to: number;
  preset: z.infer<typeof PRESET_ID>;
}

export interface ScaledTemplate {
  totalSec: number;
  bpm: number;
  barSec: number;
  segments: ScaledSegment[];
  /** Cumulative boundaries in frames, first 0, last totalSec × 30. */
  boundaries: number[];
}

const FPS = 30;
const EPS = 1e-9;
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** The middle of the template's BPM range, rounded (the tempo before a script exists). */
export const defaultBpm = (t: Pick<PackTemplate, 'tempo'>) => Math.round((t.tempo.bpmRange[0] + t.tempo.bpmRange[1]) / 2);

function within(s: TemplateSegment, sec: number): boolean {
  return sec >= s.minSec - EPS && (s.maxSec === undefined || sec <= s.maxSec + EPS);
}

function frames(kept: TemplateSegment[], secs: number[], totalSec: number, bpm: number, barSec: number): ScaledTemplate {
  const boundaries = [0];
  let acc = 0;
  for (let i = 0; i < secs.length; i++) {
    acc += secs[i]!;
    boundaries.push(i === secs.length - 1 ? Math.round(totalSec * FPS) : Math.round(round(acc) * FPS));
  }
  return {
    totalSec,
    bpm,
    barSec: round(barSec),
    segments: kept.map((s, i) => ({ id: s.id, sec: round(secs[i]!), from: boundaries[i]!, to: boundaries[i + 1]!, preset: s.preset ?? DEFAULT_PRESET[s.id] })),
    boundaries,
  };
}

/**
 * Scales a template to `totalSec`: keep (optional segments drop under 40 s), share, clamp, whole bars for
 * chant and reveal, absorb the difference in hook and story by share, frames. `segmentSec` overrides replace steps
 * 2-5 and must name every kept segment within its limits and sum to the total within one frame.
 */
export function scaleTemplate(t: PackTemplate, o: { totalSec: number; bpm?: number; segmentSec?: Partial<Record<TemplateSegmentId, number>> }): ScaledTemplate {
  const T = o.totalSec;
  if (T < t.durationSec.min - EPS || T > t.durationSec.max + EPS) throw err('template.cannot-scale', `This template makes ${t.durationSec.min}-${t.durationSec.max} s videos.`, 409);
  const bpm = o.bpm ?? defaultBpm(t);
  const barSec = (t.tempo.beatsPerBar * 60) / bpm;
  const kept = t.segments.filter((s) => !(T < 40 && s.optional));

  if (o.segmentSec) {
    const ov = o.segmentSec;
    const extra = Object.keys(ov).find((k) => !kept.some((s) => s.id === k));
    if (extra) throw err('template.override-invalid', `${extra} is not a segment of this cut.`);
    for (const s of kept) {
      const sec = ov[s.id];
      const range = s.maxSec !== undefined ? `${s.minSec}-${s.maxSec} s` : `at least ${s.minSec} s`;
      if (sec === undefined || !within(s, sec)) throw err('template.override-invalid', `${s.id} must be ${range}.`);
    }
    const secs = kept.map((s) => ov[s.id]!);
    const sum = secs.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - T) * FPS > 1 + EPS) throw err('template.override-invalid', `The segments add up to ${round(sum, 2)} s; the video is ${T} s.`);
    return frames(kept, secs, T, bpm, barSec);
  }

  const secs = kept.map((s) => {
    let sec = s.share * T;
    sec = Math.max(sec, s.minSec);
    if (s.maxSec !== undefined) sec = Math.min(sec, s.maxSec);
    if (s.id === 'chant' || s.id === 'reveal') {
      // nearest whole bar (halves round up), at least one bar, then the fewest whole bars that satisfy minSec
      let bars = Math.max(1, Math.floor(round(sec / barSec) + 0.5));
      while (bars * barSec < s.minSec - EPS) bars += 1;
      sec = bars * barSec;
      if (s.maxSec !== undefined && sec > s.maxSec + EPS) throw err('template.cannot-scale', `No whole number of bars fits ${s.id} at ${bpm} BPM.`, 409);
    }
    return sec;
  });
  const diff = T - secs.reduce((a, b) => a + b, 0);
  const hi = kept.findIndex((s) => s.id === 'hook');
  const si = kept.findIndex((s) => s.id === 'story');
  const absorb = [hi, si].filter((i) => i >= 0);
  const shareSum = absorb.reduce((a, i) => a + kept[i]!.share, 0);
  if (Math.abs(diff) > EPS) {
    if (!absorb.length || shareSum <= 0) throw err('template.cannot-scale', 'This template has no hook or story to absorb the length.', 409);
    for (const i of absorb) {
      secs[i] = secs[i]! + (diff * kept[i]!.share) / shareSum;
      if (!within(kept[i]!, secs[i]!)) throw err('template.cannot-scale', `${kept[i]!.id} cannot fit ${T} s at ${bpm} BPM.`, 409);
    }
  }
  return frames(kept, secs, T, bpm, barSec);
}

/**
 * ("template default BPM from the variant"): the BPM a variant scales at, before a script exists: the
 * variant's own declared `bpm` when it has one, else the template's default (the middle of `bpmRange`, rounded).
 */
export const variantBpm = (t: Pick<PackTemplate, 'tempo'>, v?: Pick<TemplateVariant, 'bpm'> | null): number => v?.bpm ?? defaultBpm(t);

/* * Scales a template for one of its variants: the variant's length, its BPM (`variantBpm`) and its overrides. */
export function scaleVariant(t: PackTemplate, variantId: string): ScaledTemplate {
  const v = t.variants?.find((x) => x.id === variantId);
  if (!v) throw err('template.variant-unknown', `This template has no variant ${variantId}.`, 404);
  return scaleTemplate(t, { totalSec: v.lengthSec, bpm: variantBpm(t, v), ...(v.segmentSec ? { segmentSec: v.segmentSec } : {}) });
}

/** Every template of a loaded pack, parsed and checked against the pack (languages, cast). */
export async function loadPackTemplates(pack: LoadedPack): Promise<PackTemplate[]> {
  const characterIds = pack.library.filter((a) => a.kind === 'character').map((a) => a.id);
  const out: PackTemplate[] = [];
  for (const rel of pack.manifest.templates) {
    const file = await insideDir(pack.dir, rel);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
    } catch {
      throw err('template.invalid', `The template ${rel} could not be read.`);
    }
    out.push(parseTemplate(raw, { fileId: path.basename(rel, '.json'), packLanguages: pack.manifest.languages, characterIds }));
  }
  return out;
}
