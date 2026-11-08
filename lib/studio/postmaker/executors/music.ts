// The `music` step (roles doc, quality bar S6, pack): the sound designer writes the
// `MusicBrief` for the source the pack allows, and code picks and conforms a real, licensed bed, all offline.
//
// - Sources, in the pack's `musicPolicy.sources` order, each only when Connections allows it now: `library` (a pack or
//   project track with a complete licence record and a declared grid), `owner-upload` (a track the owner made
//   elsewhere under their own plan and dropped with its BPM, first downbeat, plan and date), `elevenlabs-music` (a
//   click-track mock unless its gate opens; live only through an injected, gated `generate`), `none` (silence).
//   `browser-agent` is always rejected (the Suno binding stays 403 whatever any switch says).
// - The answer is a proposal (zod) and code applies the Rejects as named codes (`MUSIC_REJECTS`): a source the pack or
//   Connections does not allow, `browser-agent`, a library track with no declared BPM or downbeat, a stretch beyond
//   ±4 %, a prompt naming an artist or a song, plus the shape rules.
// - Conform (render/conform.ts): stretch to the script's tempo contract (±4 %), offset so a downbeat of the track meets
//   the first chant cut, loop whole bars to length, set the bed to the mix's reference level; the `beatGrid` port keeps
//   the declared grid, the conform record and the licence summary for the mix and the check.
// - Mock mode: the brief is planned in code (no agent), a library or upload track is still conformed (local and free),
//   ElevenLabs Music is the click track. Live mode asks the sound designer and plans in code when the agent cannot run
//   now (switch off, not approved, not attended, not connected), like the art step.
// Generic core: no project, brand, artist or song names.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { z } from 'zod';
import type { Spawn } from '../connectors/base';
import { clickTrackWav } from '../connectors/mock/audio';
import { licenceComplete, type ElevenlabsMusicRequest, type MusicResult } from '../connectors/music';
import { PostmakerError } from '../errors';
import type { ScriptDoc } from '../graph/adapters';
import { conformAudio, conformedOnsetsMs, firstChantCutMs, lengthUnknown, measureTrackMs, planConform, silentWav, type ConformPlan, type ConformRefusal } from '../render/conform';
import type { Asset, AssetUse, Contract, ContextBundle, MusicMeta, MusicSource, StepCheck } from '../types';
import { agentEstimate, callAgent, type AgentCall } from './agent';
import type { Executor, ExecInput, ExecResult } from './types';
import { issueText, SEGMENTS, segmentSchema, SFX_CUES } from './vocab';

// ---- vocabularies (roles doc) ----------------------------------------------------------------------------------

export const MUSIC_CUES = ['bed-low', 'drop', 'build', 'full', 'hit', 'resolve'] as const;
export type MusicCue = (typeof MUSIC_CUES)[number];
export const MUSIC_SOURCES = ['library', 'owner-upload', 'elevenlabs-music', 'browser-agent', 'none'] as const satisfies readonly MusicSource[];
export type SfxCue = (typeof SFX_CUES)[number];

/** The cue under each segment when the template does not say (roles: build under demo, full under chant). */
export const DEFAULT_SEGMENT_CUE: Record<(typeof SEGMENTS)[number], MusicCue> = {
  hook: 'bed-low',
  story: 'bed-low',
  interrupt: 'drop',
  demo: 'build',
  chant: 'full',
  escalation: 'full',
  reveal: 'hit',
  endcard: 'resolve',
  other: 'bed-low',
};

export const PROMPT_MAX = 600;
export const MOOD_MAX = 60;

// ---- MusicBrief (roles doc) -----------------------------------------------------------------------------------

const assetId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use a library asset id.');
export const musicBriefSchema = z.strictObject({
  source: z.enum(MUSIC_SOURCES),
  libraryAssetId: assetId.nullable(),
  bpm: z.number().min(60).max(200),
  sections: z.array(z.strictObject({ segment: segmentSchema, cue: z.enum(MUSIC_CUES), startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) })).max(60),
  prompt: z.string().trim().max(PROMPT_MAX).nullable(),
  mood: z.string().trim().max(MOOD_MAX),
});
export type MusicBrief = z.infer<typeof musicBriefSchema>;

export const MUSIC_REJECTS = {
  answer: 'music.answer',
  browserAgent: 'music.browser-agent',
  notAllowed: 'music.source-not-allowed',
  assetUnknown: 'music.asset-unknown',
  assetKind: 'music.asset-kind',
  licence: 'music.asset-licence',
  gridMissing: 'music.grid-missing',
  tempo: 'music.tempo-out-of-range',
  tooShort: 'music.too-short',
  bpm: 'music.bpm-contract',
  sections: 'music.sections',
  libraryId: 'music.library-id',
  promptSource: 'music.prompt-source',
  promptNames: 'music.prompt-names',
} as const;
export type MusicRejectCode = (typeof MUSIC_REJECTS)[keyof typeof MUSIC_REJECTS];

export class MusicBriefRejected extends PostmakerError {
  constructor(code: MusicRejectCode | ConformRefusal['code'], message: string) {
    super(422, code, message);
    this.name = 'MusicBriefRejected';
  }
}

// ---- what the brief is checked against -----------------------------------------------------------------------------

export interface MusicTrack {
  asset: Asset;
  origin: 'pack' | 'project';
  /** Absolute path of the file (resolved inside its library folder by the caller). */
  file: string;
}

export interface MusicWorld {
  policy: { sources: MusicSource[] };
  /** Music assets of the pack library and the project's own assets (uploads are project assets tagged `owner-upload`). */
  tracks: MusicTrack[];
  /** The music cue per segment from the pack template (absent: the core defaults). */
  cues?: Partial<Record<string, MusicCue>>;
  /** Pack names a prompt may never carry (brand, characters, title). */
  names?: string[];
}

export interface MusicContext {
  contract: { bpm: number; downbeatMs: number; chantBeatsPerCard: 2 | 4 };
  beats: { id: string; segment: (typeof SEGMENTS)[number]; targetMs: number; sfx: { cue: SfxCue; atToken: number | null }[] }[];
  totalMs: number;
  /** The conformed bed's length: longer than the script so the composed video (voice-driven) never outruns it. */
  lengthMs: number;
  final: boolean;
  use: AssetUse;
  policy: MusicSource[];
  /** Sources Connections allows now. */
  allowed: Set<MusicSource>;
  tracks: Map<string, MusicTrack>;
  cues: Partial<Record<string, MusicCue>>;
  names: string[];
  uploadId: string | null;
}

const FPS = 30;
const framesOf = (ms: number) => Math.round((ms * FPS) / 1000);

/** The declared grid of a track (null when it declares none). */
export const declaredGrid = (a: Pick<Asset, 'music' | 'durationMs'>): (MusicMeta & { durationMs: number | null }) | null =>
  a.music && typeof a.music.bpm === 'number' && typeof a.music.firstDownbeatMs === 'number' ? { ...a.music, durationMs: a.durationMs ?? null } : null;

export const isUpload = (t: MusicTrack) => t.origin === 'project' && t.asset.tags.includes('owner-upload');

/** A licence record complete enough for the mix (and, for an upload, with the plan tier and the download date). */
export function trackLicenceOk(t: MusicTrack): boolean {
  const l = t.asset.licence;
  if (!licenceComplete(l)) return false;
  if (isUpload(t)) return Boolean(l.plan?.trim() || /plan:/.test(l.proof ?? '')) && Number.isFinite(Date.parse(l.acquiredAt));
  return true;
}

/** Why a track cannot be used in this run (null = usable). */
function trackProblem(t: MusicTrack, ctx: Pick<MusicContext, 'final' | 'use' | 'contract'>): { code: MusicRejectCode | ConformRefusal['code']; text: string } | null {
  const a = t.asset;
  if (a.kind !== 'music') return { code: MUSIC_REJECTS.assetKind, text: `${a.id} is not a music asset.` };
  if (a.status === 'retired') return { code: MUSIC_REJECTS.licence, text: `${a.id} is retired.` };
  if (ctx.final && a.status !== 'approved') return { code: MUSIC_REJECTS.licence, text: `${a.id} is a draft. Approve it before the final render.` };
  if (!trackLicenceOk(t)) return { code: MUSIC_REJECTS.licence, text: `The licence record of ${a.id} is incomplete.` };
  if (ctx.final && !(a.licence.allowedUses ?? []).includes(ctx.use)) return { code: MUSIC_REJECTS.licence, text: `${a.id} is not licensed for ${ctx.use}.` };
  if (a.licence.expiresAt && Date.parse(a.licence.expiresAt) <= Date.now()) return { code: MUSIC_REJECTS.licence, text: `The licence of ${a.id} has expired.` };
  const g = declaredGrid(a);
  if (!g) return { code: MUSIC_REJECTS.gridMissing, text: `${a.id} has no declared BPM and first downbeat.` };
  const pct = (Math.abs(g.bpm - ctx.contract.bpm) / ctx.contract.bpm) * 100;
  if (pct > 4 + 1e-9) return { code: MUSIC_REJECTS.tempo, text: `Tempo outside ±4 %: ${a.id} is ${g.bpm} BPM; this video needs ${ctx.contract.bpm} ± 4 %.` };
  return null;
}

export function musicContext(i: Pick<ExecInput, 'recipe' | 'params' | 'byPort'>, world: MusicWorld, allowed: Set<MusicSource>): MusicContext {
  const script = i.byPort.script as ScriptDoc | null | undefined;
  const cuesOf = (b: object) => ((b as { sfx?: { cue: SfxCue; atToken: number | null }[] }).sfx ?? []).filter((x) => (SFX_CUES as readonly string[]).includes(x.cue));
  const seg = (s: string) => ((SEGMENTS as readonly string[]).includes(s) ? (s as (typeof SEGMENTS)[number]) : 'other');
  const beats = script?.beats?.length
    ? script.beats.map((b) => ({ id: b.id, segment: seg(b.segment), targetMs: b.targetMs, sfx: cuesOf(b) }))
    : i.recipe.beats.map((b) => ({ id: b.id, segment: seg(b.segment), targetMs: Math.round((b.end - b.start) * 1000), sfx: [] }));
  const totalMs = beats.reduce((s, b) => s + b.targetMs, 0);
  const tempo = script?.tempo ?? { bpm: i.recipe.tempo?.bpm ?? 100, downbeatMs: i.recipe.tempo?.downbeatMs ?? 0, chantBeatsPerCard: 2 as const };
  const use = i.params.use === 'paid-ads' || i.params.use === 'store-listing' ? i.params.use : 'organic';
  return {
    contract: { bpm: tempo.bpm, downbeatMs: tempo.downbeatMs ?? 0, chantBeatsPerCard: tempo.chantBeatsPerCard === 4 ? 4 : 2 },
    beats,
    totalMs,
    lengthMs: Math.min(180_000, Math.max(Math.ceil(totalMs * 1.5), totalMs + 10_000)),
    final: i.params.final === true,
    use,
    policy: [...world.policy.sources],
    allowed,
    tracks: new Map(world.tracks.map((t) => [t.asset.id, t])),
    cues: world.cues ?? {},
    names: world.names ?? [],
    uploadId: typeof i.params.uploadId === 'string' ? i.params.uploadId : null,
  };
}

/** The sections of the brief: one per beat, sized from the script's targets, with the template's (or core) cue. */
export function plannedSections(ctx: Pick<MusicContext, 'beats' | 'cues'>): MusicBrief['sections'] {
  let at = 0;
  return ctx.beats.map((b) => {
    const s = { segment: b.segment, cue: ctx.cues[b.segment] ?? DEFAULT_SEGMENT_CUE[b.segment], startFrame: framesOf(at), endFrame: Math.max(framesOf(at) + 1, framesOf(at + b.targetMs)) };
    at += b.targetMs;
    return s;
  });
}

/** The upload a owner-upload brief plays: the one the node names, else the latest usable upload. */
export function pickUpload(ctx: Pick<MusicContext, 'tracks' | 'uploadId' | 'final' | 'use' | 'contract'>): MusicTrack | null {
  const ups = [...ctx.tracks.values()].filter(isUpload);
  if (ctx.uploadId) return ups.find((t) => t.asset.id === ctx.uploadId) ?? null;
  return ups.filter((t) => !trackProblem(t, ctx)).sort((a, b) => Date.parse(b.asset.licence.acquiredAt) - Date.parse(a.asset.licence.acquiredAt) || (a.asset.id < b.asset.id ? -1 : 1))[0] ?? null;
}

/** The library track closest to the contract tempo that can be used (ties by id). */
export function pickLibraryTrack(ctx: Pick<MusicContext, 'tracks' | 'final' | 'use' | 'contract'>): MusicTrack | null {
  const ok = [...ctx.tracks.values()].filter((t) => !isUpload(t) && !trackProblem(t, ctx));
  return ok.sort((a, b) => Math.abs(a.asset.music!.bpm - ctx.contract.bpm) - Math.abs(b.asset.music!.bpm - ctx.contract.bpm) || (a.asset.id < b.asset.id ? -1 : 1))[0] ?? null;
}

const DEFAULT_MOOD = 'warm, playful, light';

/** The deterministic brief (mock mode, or the agent cannot run): the first source the pack and Connections allow that can be used. */
export function planBrief(ctx: MusicContext, mood = DEFAULT_MOOD): MusicBrief {
  const skipped: string[] = [];
  const base = { bpm: ctx.contract.bpm, sections: plannedSections(ctx), mood: mood.slice(0, MOOD_MAX) };
  for (const s of ctx.policy) {
    if (s === 'browser-agent') {
      skipped.push('the browser agent is not allowed');
      continue;
    }
    if (!ctx.allowed.has(s)) {
      skipped.push(`${s} is off in Connections`);
      continue;
    }
    if (s === 'library') {
      const t = pickLibraryTrack(ctx);
      if (t) return { ...base, source: 'library', libraryAssetId: t.asset.id, prompt: null };
      skipped.push('no library track fits');
      continue;
    }
    if (s === 'owner-upload') {
      if (pickUpload(ctx)) return { ...base, source: 'owner-upload', libraryAssetId: null, prompt: null };
      skipped.push('no track was dropped');
      continue;
    }
    if (s === 'elevenlabs-music') return { ...base, source: 'elevenlabs-music', libraryAssetId: null, prompt: `Instrumental only, ${base.mood}, steady ${ctx.contract.bpm} BPM groove for a short vertical video, clear downbeats, no vocals.` };
    if (s === 'none') return { ...base, source: 'none', libraryAssetId: null, prompt: null };
  }
  throw new MusicBriefRejected(MUSIC_REJECTS.notAllowed, `No music source can be used now: ${skipped.join('; ') || 'the pack lists none'}.`);
}

/** Words that make a prompt name an artist or a song (a heuristic; pack names are checked too). */
const NAMING = [/\bin the style of\b/i, /\bstyle of\b/i, /\bsounds? like\b/i, /\bcover of\b/i, /\bremix of\b/i, /\b(feat\.|ft\.|featuring)\s/i, /\bby\s+[A-Z][\w'-]+/, /["“”«»]/];

export function promptNamesSomething(prompt: string, names: readonly string[] = []): boolean {
  if (NAMING.some((re) => re.test(prompt))) return true;
  const low = prompt.toLowerCase();
  return names.some((n) => n.trim().length >= 3 && low.includes(n.trim().toLowerCase()));
}

/** zod, then the Rejects (roles doc) as named codes. */
export function validateBrief(raw: unknown, ctx: MusicContext): MusicBrief {
  const p = musicBriefSchema.safeParse(raw);
  if (!p.success) throw new MusicBriefRejected(MUSIC_REJECTS.answer, `The music brief is not valid (${issueText(p.error)}).`);
  const b = p.data;
  if (b.source === 'browser-agent') throw new MusicBriefRejected(MUSIC_REJECTS.browserAgent, 'The browser agent cannot make music: it is not allowed (terms).');
  if (!ctx.policy.includes(b.source)) throw new MusicBriefRejected(MUSIC_REJECTS.notAllowed, `This pack does not allow ${b.source} music.`);
  if (!ctx.allowed.has(b.source)) throw new MusicBriefRejected(MUSIC_REJECTS.notAllowed, `${b.source} music is off in Connections.`);
  if (b.bpm !== ctx.contract.bpm) throw new MusicBriefRejected(MUSIC_REJECTS.bpm, `The brief says ${b.bpm} BPM; the script's tempo is ${ctx.contract.bpm} BPM.`);
  if (b.source === 'library') {
    if (!b.libraryAssetId) throw new MusicBriefRejected(MUSIC_REJECTS.libraryId, 'Name the library track.');
    const t = ctx.tracks.get(b.libraryAssetId);
    if (!t || isUpload(t)) throw new MusicBriefRejected(MUSIC_REJECTS.assetUnknown, `${b.libraryAssetId} is not a library track.`);
    const problem = trackProblem(t, ctx);
    if (problem) throw new MusicBriefRejected(problem.code, problem.text);
  } else if (b.libraryAssetId) throw new MusicBriefRejected(MUSIC_REJECTS.libraryId, `A ${b.source} brief names no library track.`);
  if (b.source === 'elevenlabs-music') {
    if (!b.prompt) throw new MusicBriefRejected(MUSIC_REJECTS.promptSource, 'A generated track needs a prompt.');
    if (promptNamesSomething(b.prompt, ctx.names)) throw new MusicBriefRejected(MUSIC_REJECTS.promptNames, 'The prompt names an artist, a song or a name from the pack. Describe the sound instead.');
  } else if (b.prompt) throw new MusicBriefRejected(MUSIC_REJECTS.promptSource, `A ${b.source} brief has no prompt.`);
  const limit = framesOf(ctx.lengthMs);
  let prev = 0;
  for (const s of b.sections) {
    if (s.endFrame <= s.startFrame || s.startFrame < prev || s.endFrame > limit) throw new MusicBriefRejected(MUSIC_REJECTS.sections, `Music sections must be in order, not overlap and end by frame ${limit} (${s.segment} ${s.startFrame}-${s.endFrame}).`);
    prev = s.endFrame;
  }
  return b;
}

// ---- the document ---------------------------------------------------------------------------------------------------

export interface MusicDoc {
  schema: 'signal.pm.music/1';
  /** The conformed grid = the contract grid (motion and the check read these two). */
  bpm: number;
  downbeatMs: number;
  beatsPerBar: 3 | 4;
  chantBeatsPerCard: 2 | 4;
  /** Beat onsets of the conformed track: firstOnsetMs + k × beatMs (k ≥ 0) within the track. */
  grid: { firstOnsetMs: number; beatMs: number; lengthMs: number };
  source: Exclude<MusicSource, 'browser-agent'>;
  briefBy: 'sound-designer' | 'plan';
  brief: MusicBrief;
  mock: boolean;
  track: {
    assetId: string | null;
    origin: 'pack' | 'project' | 'vendor' | 'mock' | null;
    sha256: string | null;
    declared: MusicMeta | null;
    durationMs: number | null;
    licence: { type: string; holder: string; source: string; acquiredAt: string; plan: string | null; allowedUses: AssetUse[]; attribution: string | null; aiGenerated: boolean } | null;
    licenceComplete: boolean;
  };
  conform: (Omit<ConformPlan, 'ok'> & { method: 'ffmpeg' | 'resample'; lufs: number | null; truePeakDbtp: number | null; gainDb: number }) | null;
  /** Script SFX cues (resolved to frames and pack assets by the mix, per language). */
  sfxRequests: { beatId: string; cue: SfxCue; atToken: number | null }[];
}

export const isMusicDoc = (d: unknown): d is MusicDoc => Boolean(d && typeof d === 'object' && (d as { schema?: string }).schema === 'signal.pm.music/1');

export const musicContract = (d: Pick<MusicDoc, 'bpm' | 'downbeatMs' | 'chantBeatsPerCard'>): Contract => ({ tempo: { bpm: d.bpm, downbeatMs: d.downbeatMs, chantBeatsPerCard: d.chantBeatsPerCard } });

// ---- the executor ---------------------------------------------------------------------------------------------------

export const MUSIC_TASK =
  'Write the MusicBrief for this video: the first source in the pack order that the input marks as allowed and usable, the library track (only for the library source, from the tracks you are given; its declared BPM must be within 4 % of the contract), the contract BPM, one section per beat with its music cue and frames, a mood of at most 60 characters and, only for a generated track, an instrumental prompt that states the BPM and names no artist, song, band or brand.';
export const MUSIC_OUTPUT_SPEC =
  'One JSON object: { "source": "library|owner-upload|elevenlabs-music|none", "libraryAssetId": "<track id>" | null, "bpm": 100, "sections": [{ "segment": "hook|story|interrupt|demo|chant|escalation|reveal|endcard|other", "cue": "bed-low|drop|build|full|hit|resolve", "startFrame": 0, "endFrame": 180 }], "prompt": null, "mood": "≤ 60 characters" }';

/** Codes of an agent call that cannot run now (switch off, not approved, not attended, not connected). */
const AGENT_UNAVAILABLE = new Set(['forbidden', 'needs_you', 'not_configured']);

export interface MusicDeps {
  call?: AgentCall | null;
  billing?: 'subscription' | 'api-key';
  /** The pack policy, the tracks and the template cues for this run; null = no pack, so the step keeps its fake. */
  world: (i: ExecInput) => Promise<MusicWorld | null>;
  /** Whether Connections allows a source now. Default: library, owner-upload and none; never the gated vendors. */
  allowed?: (source: MusicSource) => Promise<boolean>;
  /** ElevenLabs Music in live mode, through the gated connector (absent = refused; nothing here wires it). */
  generate?: (req: ElevenlabsMusicRequest, i: ExecInput) => Promise<MusicResult>;
  ffmpeg?: { bin: string; spawn?: Spawn } | null;
  workDir?: (runId: string, nodeId: string) => string;
  fallback?: Executor;
}

const defaultAllowed = async (s: MusicSource) => s === 'library' || s === 'owner-upload' || s === 'none';

/** The input the sound designer reads (trusted data). */
function agentParams(ctx: MusicContext) {
  return {
    contract: ctx.contract,
    lengthFrames: framesOf(ctx.lengthMs),
    finalRun: ctx.final,
    sources: ctx.policy.map((s) => ({ source: s, allowed: s !== 'browser-agent' && ctx.allowed.has(s) })),
    beats: plannedSections(ctx).map((s, k) => ({ beatId: ctx.beats[k]!.id, ...s })),
    tracks: [...ctx.tracks.values()]
      .filter((t) => !isUpload(t))
      .map((t) => ({ id: t.asset.id, bpm: t.asset.music?.bpm ?? null, firstDownbeatMs: t.asset.music?.firstDownbeatMs ?? null, loopable: t.asset.music?.loopable ?? null, durationMs: t.asset.durationMs ?? null, tags: t.asset.tags, status: t.asset.status, usable: !trackProblem(t, ctx) })),
    uploads: [...ctx.tracks.values()].filter(isUpload).map((t) => ({ id: t.asset.id, bpm: t.asset.music?.bpm ?? null, usable: !trackProblem(t, ctx) })),
  };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function licenceSummary(a: Asset): MusicDoc['track']['licence'] {
  const l = a.licence;
  return { type: l.type, holder: l.holder, source: l.source, acquiredAt: l.acquiredAt, plan: l.plan ?? (/plan: ([^;]+)/.exec(l.proof ?? '')?.[1]?.trim() ?? null), allowedUses: l.allowedUses ?? [], attribution: l.attribution, aiGenerated: l.aiGenerated };
}

export function musicExecutor(deps: MusicDeps): Executor {
  const ffmpeg = deps.ffmpeg === undefined ? (ffmpegPath ? { bin: ffmpegPath as string } : null) : deps.ffmpeg;
  const workDir = deps.workDir ?? ((runId, nodeId) => path.join(os.tmpdir(), 'signal-pm-music', runId, nodeId.replace(/[^a-z0-9-]/gi, '-')));
  return {
    kind: 'music',
    implVersion: 'music@1',
    deterministic: false,
    estimate: (e) => agentEstimate(e.mode, deps.billing, 0.4, 60),
    async run(i): Promise<ExecResult> {
      const world = await deps.world(i);
      if (!world) {
        if (deps.fallback) return deps.fallback.run(i);
        throw new PostmakerError(409, 'needs_you', 'Music needs a project pack.');
      }
      const isAllowed = deps.allowed ?? defaultAllowed;
      const allowed = new Set<MusicSource>();
      for (const s of MUSIC_SOURCES) if (s !== 'browser-agent' && (await isAllowed(s))) allowed.add(s);
      const ctx = musicContext(i, world, allowed);
      const mood = typeof i.params.mood === 'string' ? i.params.mood : DEFAULT_MOOD;
      const checks: StepCheck[] = [];
      let raw: unknown = null;
      let costUsd: number | null = 0;
      let model: string | null = i.mode === 'mock' ? 'mock' : null;
      let briefBy: MusicDoc['briefBy'] = 'plan';
      if (i.mode === 'live') {
        const base: ContextBundle = i.context ?? { task: '', node: { id: i.node.id, kind: 'music', lang: null, params: {} }, upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {}, outputSpec: '' };
        const bundle: ContextBundle = { ...base, task: [MUSIC_TASK, base.task].filter(Boolean).join('\n\n'), node: { ...base.node, params: { ...base.node.params, ...agentParams(ctx) } }, outputSpec: MUSIC_OUTPUT_SPEC };
        try {
          const r = await callAgent({ agent: 'sound-designer', kind: 'music', bundle, call: deps.call ?? null, signal: i.signal, validate: (v) => v });
          raw = r.value;
          costUsd = r.costUsd;
          model = r.model;
          briefBy = 'sound-designer';
        } catch (e) {
          if (!(e instanceof PostmakerError) || !AGENT_UNAVAILABLE.has(e.code)) throw e;
          checks.push({ id: 'music.designer', ok: true, required: false, text: 'Planned from the pack. The sound designer is not available now.' });
        }
      }
      if (briefBy === 'plan') raw = planBrief(ctx, mood);
      let brief: MusicBrief;
      try {
        brief = validateBrief(raw, ctx);
      } catch (e) {
        if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = costUsd;
        throw e;
      }
      const out = await resolveAudio(brief, ctx, i);
      const doc: MusicDoc = {
        schema: 'signal.pm.music/1',
        bpm: ctx.contract.bpm,
        downbeatMs: ctx.contract.downbeatMs,
        beatsPerBar: out.declared?.beatsPerBar ?? 4,
        chantBeatsPerCard: ctx.contract.chantBeatsPerCard,
        grid: out.grid,
        source: brief.source as MusicDoc['source'],
        briefBy,
        brief,
        mock: i.mode === 'mock' || out.mockAudio,
        track: out.track,
        conform: out.conform,
        sfxRequests: ctx.beats.flatMap((b) => b.sfx.map((s) => ({ beatId: b.id, cue: s.cue, atToken: s.atToken }))),
      };
      checks.push(...out.checks);
      return {
        outputs: [
          { port: 'track', name: 'music.wav', kind: 'audio', mime: 'audio/wav', data: null, bytes: out.wav, meta: { durationMs: Math.round(out.durationMs), sampleRate: 48_000, ...(out.conform?.lufs != null ? { lufs: out.conform.lufs } : {}) } },
          { port: 'beatGrid', name: 'beat-grid.json', kind: 'json', mime: 'application/json', data: doc },
        ],
        provides: musicContract(doc),
        checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd,
        model,
      };
    },
    contractOf: (data) => (isMusicDoc(data.beatGrid) ? musicContract(data.beatGrid) : {}),
  };

  /** Picks the audio for a valid brief and conforms it. */
  async function resolveAudio(brief: MusicBrief, ctx: MusicContext, i: ExecInput) {
    const checks: StepCheck[] = [];
    const anchorMs = firstChantCutMs(ctx.beats, ctx.contract) ?? ctx.contract.downbeatMs;
    const beatMs = 60_000 / ctx.contract.bpm;
    const contractGrid = { firstOnsetMs: Math.round(ctx.contract.downbeatMs * 1000) / 1000, beatMs, lengthMs: ctx.lengthMs };
    if (brief.source === 'none') {
      const wav = silentWav(1000);
      checks.push({ id: 'music.source', ok: true, required: false, text: 'No music: this video is silent under the voice.' });
      return { wav, durationMs: 1000, mockAudio: false, declared: null, grid: contractGrid, conform: null, track: { assetId: null, origin: null, sha256: null, declared: null, durationMs: null, licence: null, licenceComplete: true } as MusicDoc['track'], checks };
    }
    if (brief.source === 'elevenlabs-music') {
      if (i.mode === 'mock') {
        const wav = clickTrackWav({ bpm: ctx.contract.bpm, ms: ctx.lengthMs, downbeatMs: ctx.contract.downbeatMs });
        checks.push({ id: 'music.source', ok: true, required: false, text: `Mock music: a click track at ${ctx.contract.bpm} BPM.` });
        return { wav, durationMs: ctx.lengthMs, mockAudio: true, declared: null, grid: contractGrid, conform: null, track: { assetId: null, origin: 'mock', sha256: sha(wav), declared: null, durationMs: ctx.lengthMs, licence: null, licenceComplete: false } as MusicDoc['track'], checks };
      }
      if (!deps.generate) throw new PostmakerError(403, 'forbidden', 'ElevenLabs Music is not open yet.');
      const r = await deps.generate({ prompt: brief.prompt!, lengthMs: ctx.lengthMs, tempo: { bpm: ctx.contract.bpm, downbeatMs: 0 }, instrumental: true }, i);
      const declared: MusicMeta = { bpm: r.tempo.bpm, firstDownbeatMs: r.tempo.downbeatMs, beatsPerBar: 4, declaredBy: 'prompt', loopable: false };
      const asset: Asset = { id: `music-gen-${r.sha256.slice(0, 12)}`, kind: 'music', file: 'generated.wav', sha256: r.sha256, durationMs: r.durationMs ?? undefined, tags: ['generated'], licence: r.licence!, status: 'draft', approvedBy: null, music: declared };
      return conformTrack({ asset, origin: 'project', file: '' }, r.audio, '.mp3', 'vendor', ctx, anchorMs, i, checks);
    }
    const t = brief.source === 'library' ? ctx.tracks.get(brief.libraryAssetId!)! : pickUpload(ctx);
    if (!t) throw new PostmakerError(409, 'needs_you', 'Drop a track on the music step first.');
    const problem = trackProblem(t, ctx);
    if (problem) throw new MusicBriefRejected(problem.code, problem.text);
    const bytes = await fs.readFile(/* turbopackIgnore: true */ t.file).catch(() => {
      throw new PostmakerError(404, 'not_found', `The file of ${t.asset.id} is missing.`);
    });
    if (sha(bytes) !== t.asset.sha256) throw new PostmakerError(409, 'files_changed', `The file of ${t.asset.id} changed since it was recorded.`);
    return conformTrack(t, bytes, path.extname(t.file), t.origin, ctx, anchorMs, i, checks);
  }

  async function conformTrack(t: MusicTrack, bytes: Buffer, ext: string, origin: MusicDoc['track']['origin'], ctx: MusicContext, anchorMs: number, i: ExecInput, checks: StepCheck[]) {
    const declared = t.asset.music!;
    // The real length: the recorded one, else measured (a non-WAV upload has none recorded). Never planned as endless.
    const durationMs = t.asset.durationMs ?? (await measureTrackMs({ bytes, ext, ffmpeg, workDir: workDir(i.runId, i.node.id), signal: i.signal }));
    if (durationMs === null) {
      const r = lengthUnknown();
      throw new MusicBriefRejected(r.code, `${t.asset.id}: ${r.reason}`);
    }
    const plan = planConform(ctx.contract, { ...declared, durationMs }, { anchorMs, lengthMs: ctx.lengthMs, minMusicMs: ctx.totalMs + 2000 });
    if (!plan.ok) throw new MusicBriefRejected(plan.code, plan.reason);
    const audio = await conformAudio({ bytes, ext, plan, ffmpeg, workDir: workDir(i.runId, i.node.id), signal: i.signal });
    const { ok: _ok, ...rest } = plan;
    void _ok;
    const onsets = conformedOnsetsMs(plan, declared);
    const complete = trackLicenceOk(t);
    checks.push({ id: 'music.licence', ok: complete, required: true, text: complete ? `Licence record complete (${t.asset.licence.type}, ${t.asset.licence.holder}).` : 'The track’s licence record is incomplete.' });
    checks.push({
      id: 'music.conform',
      ok: true,
      required: true,
      text: `Track ${declared.bpm} BPM ${plan.stretchPct === 0 ? 'kept at' : `stretched ${plan.stretchPct.toFixed(1)} % to`} ${plan.contractBpm} BPM; a downbeat meets frame ${framesOf(plan.anchorMs)}${plan.loop ? '; looped by whole bars' : ''}.`,
    });
    if (audio.method === 'resample') checks.push({ id: 'music.conform-method', ok: true, required: false, text: 'Conformed without ffmpeg: the pitch follows the tempo change.' });
    if (plan.musicMs < plan.lengthMs) checks.push({ id: 'music.length', ok: true, required: false, text: `The track plays once for ${(plan.musicMs / 1000).toFixed(1)} s, then silence.` });
    return {
      wav: audio.wav,
      durationMs: plan.lengthMs,
      mockAudio: false,
      declared,
      grid: { firstOnsetMs: onsets[0] ?? 0, beatMs: 60_000 / plan.contractBpm, lengthMs: plan.musicMs },
      conform: { ...rest, method: audio.method, lufs: audio.lufs, truePeakDbtp: audio.truePeakDbtp, gainDb: audio.gainDb },
      track: { assetId: t.asset.id, origin, sha256: t.asset.sha256, declared, durationMs, licence: licenceSummary(t.asset), licenceComplete: complete } as MusicDoc['track'],
      checks,
    };
  }
}
