// SFX cues of the mix (roles doc `SfxCueList`, quality bar `clap` on contact, SFX peaks
// ≤ −6 dBFS). The sound designer's cue list for one language, from the script's cue requests (carried by the music
// document) and the composed timeline's events: a `clap` gesture sounds on its contact frame, a `swipe` at its start,
// a sticker pops in with `pop`. Each cue resolves to a pack (or project) `sfx` asset whose `tags` include the cue id;
// a cue with no such asset is dropped with a warning. The stem is mixed here in JavaScript: each cue is set to its
// peak target, and the stem as a whole never peaks above −6 dBFS.
// Mock mode, and live mode when the sound designer cannot run now, derive the list in code; live mode asks the agent
// (validated by zod: an unknown cue id is refused).
// Generic core: no project names; cue ids are the closed vocabulary.
import path from 'node:path';
import { z } from 'zod';
import type { Spawn } from '../connectors/base';
import { licenceComplete } from '../connectors/music';
import { PostmakerError } from '../errors';
import { gestureFrames, type CompiledCharacter } from '../anim/compile';
import { CORE_GESTURES } from '../anim/library/gestures';
import { MIX_TARGETS } from '../render/mixPlan';
import { dbToLinear, decodeWav, encodeWav, MIX_RATE, peakDbfs, toStereo, type Pcm } from '../render/pcm';
import { run } from '../render/loudness';
import type { Timeline } from '../render/timeline';
import type { Asset, AssetUse, ContextBundle, StepCheck } from '../types';
import { callAgent, type AgentCall } from './agent';
import type { MusicDoc, SfxCue } from './music';
import type { ExecInput } from './types';
import { issueText, sfxSchema, SFX_CUES } from './vocab';

/** The default peak of one cue (dBFS), under the −6 dBFS ceiling. */
export const SFX_DEFAULT_PEAK_DB = -9;
const CUE_PEAK: Partial<Record<SfxCue, number>> = { clap: -8, hit: -8, pop: -10, tick: -12, whoosh: -10, swipe: -12, riser: -10 };
/** Two cues of the same id closer than this are one cue. */
export const SFX_MERGE_FRAMES = 4;

export const sfxCueListSchema = z.strictObject({
  cues: z.array(z.strictObject({ cue: sfxSchema, frame: z.number().int().min(0), gainDb: z.number().min(-60).max(MIX_TARGETS.sfxPeakDbfs) })).max(64),
});
export type SfxCueList = z.infer<typeof sfxCueListSchema>;

export class SfxCueListRejected extends PostmakerError {
  constructor(code: 'sfx.answer' | 'sfx.frame', message: string) {
    super(422, code, message);
    this.name = 'SfxCueListRejected';
  }
}

const TEXT_KINDS = new Set(['caption', 'bubble', 'tag']);

/** The frame a beat's token `k` starts on screen (its caption token's onset), or null. */
export function tokenFrame(t: Pick<Timeline, 'elements' | 'segments'>, beatId: string, k: number): number | null {
  const seg = t.segments.find((s) => s.beatId === beatId);
  if (!seg) return null;
  const tokens = t.elements
    .filter((e) => TEXT_KINDS.has(e.kind) && e.from >= seg.from && e.from < seg.to)
    .sort((a, b) => a.from - b.from)
    .flatMap((e) => ('lines' in e ? e.lines.flat() : []));
  const tok = tokens[k];
  return tok ? tok.enter + 2 : null; // pop-in starts 2 frames before the word (render/layout.ts)
}

/**
 * The frames a clap's hands meet, by the solver's own rule (anim/solve.ts emits its `clap` cue where
 * `raw < span && raw % clip === contact`): the span is `gestureFrames` (the clip times the clap count, the same helper
 * the compiler paces with), the clip and contact frame come from the core gesture table (no constant here). A
 * compiled gesture carries no count (the motion spec has none), so one clap gesture is one contact; a clap with no
 * contact frame has nothing to sound on.
 */
export function clapContactFrames(g: Pick<CompiledCharacter['gestures'][number], 'gesture' | 'at' | 'count'>): number[] {
  const def = CORE_GESTURES.clap;
  if (def.contactFrame === undefined || def.frames <= 0) return [];
  const span = gestureFrames({ gesture: 'clap', count: g.count }, (id) => CORE_GESTURES[id].frames);
  const out: number[] = [];
  for (let raw = def.contactFrame; raw < span; raw += def.frames) out.push(g.at + raw);
  return out;
}

/** The deterministic cue list: script requests, gesture contacts, swipes and sticker pops (merged, in frame order). */
export function deriveCues(t: Pick<Timeline, 'durationInFrames' | 'segments' | 'elements' | 'motion'>, requests: readonly MusicDoc['sfxRequests'][number][]): SfxCueList {
  const raw: { cue: SfxCue; frame: number }[] = [];
  for (const r of requests) {
    const seg = t.segments.find((s) => s.beatId === r.beatId);
    if (!seg) continue;
    raw.push({ cue: r.cue, frame: r.atToken === null ? seg.from : (tokenFrame(t, r.beatId, r.atToken) ?? seg.from) });
  }
  for (const c of t.motion?.characters ?? [])
    for (const g of c.gestures) {
      if (g.gesture === 'clap') for (const f of clapContactFrames(g)) raw.push({ cue: 'clap', frame: f });
      else if (g.gesture === 'swipe') raw.push({ cue: 'swipe', frame: g.at });
    }
  for (const e of t.elements) if (e.kind === 'sticker') raw.push({ cue: 'pop', frame: e.from });
  raw.sort((a, b) => a.frame - b.frame || (a.cue < b.cue ? -1 : 1));
  const cues: SfxCueList['cues'] = [];
  for (const r of raw) {
    const frame = Math.max(0, Math.min(t.durationInFrames - 1, Math.round(r.frame)));
    if (cues.some((c) => c.cue === r.cue && Math.abs(c.frame - frame) < SFX_MERGE_FRAMES)) continue;
    cues.push({ cue: r.cue, frame, gainDb: CUE_PEAK[r.cue] ?? SFX_DEFAULT_PEAK_DB });
  }
  return { cues: cues.slice(0, 64) };
}

/** zod (unknown cue ids, a peak over −6 dBFS) and the frame range. */
export function validateCueList(raw: unknown, durationFrames: number): SfxCueList {
  const p = sfxCueListSchema.safeParse(raw);
  if (!p.success) throw new SfxCueListRejected('sfx.answer', `The SFX cue list is not valid (${issueText(p.error)}).`);
  const out = p.data.cues.find((c) => c.frame >= durationFrames);
  if (out) throw new SfxCueListRejected('sfx.frame', `The ${out.cue} cue at frame ${out.frame} is after the end of the video (${durationFrames} frames).`);
  return p.data;
}

export interface SfxAsset {
  asset: Asset;
  /** Absolute file path. */
  file: string;
}

export interface PlacedCue {
  cue: SfxCue;
  frame: number;
  gainDb: number;
  assetId: string;
}

/** Each cue → an `sfx` asset tagged with its id (usable in this run), rotating through the matches; else dropped. */
export function resolveCues(list: SfxCueList, library: readonly SfxAsset[], o: { final: boolean; use: AssetUse }): { placed: PlacedCue[]; dropped: { cue: SfxCue; frame: number }[] } {
  const usable = library.filter((s) => s.asset.kind === 'sfx' && s.asset.status !== 'retired' && (!o.final || (s.asset.status === 'approved' && (s.asset.licence.allowedUses ?? []).includes(o.use))) && licenceComplete(s.asset.licence));
  const byCue = new Map<string, SfxAsset[]>(SFX_CUES.map((c) => [c, usable.filter((s) => s.asset.tags.includes(c)).sort((a, b) => (a.asset.id < b.asset.id ? -1 : 1))]));
  const used = new Map<string, number>();
  const placed: PlacedCue[] = [];
  const dropped: { cue: SfxCue; frame: number }[] = [];
  for (const c of list.cues) {
    const opts = byCue.get(c.cue) ?? [];
    if (!opts.length) {
      dropped.push({ cue: c.cue, frame: c.frame });
      continue;
    }
    const n = used.get(c.cue) ?? 0;
    used.set(c.cue, n + 1);
    placed.push({ ...c, assetId: opts[n % opts.length]!.asset.id });
  }
  return { placed, dropped };
}

/** Decodes an SFX file: WAV in JavaScript, anything else through ffmpeg (null when neither can read it). */
export async function decodeSfx(bytes: Buffer, file: string, o: { ffmpeg: { bin: string; spawn?: Spawn } | null; workDir: string; signal?: AbortSignal }): Promise<Pcm | null> {
  const p = decodeWav(bytes);
  if (p) return p;
  if (!o.ffmpeg) return null;
  const { promises: fs } = await import('node:fs');
  await fs.mkdir(o.workDir, { recursive: true });
  const ext = /^\.[a-z0-9]{1,5}$/i.test(path.extname(file)) ? path.extname(file).toLowerCase() : '.bin';
  const src = path.join(o.workDir, `sfx-src-${Math.random().toString(16).slice(2)}${ext}`);
  const out = `${src}.wav`;
  await fs.writeFile(src, bytes);
  try {
    await run(o.ffmpeg.spawn ?? (await import('node:child_process')).spawn, o.ffmpeg.bin, ['-hide_banner', '-nostats', '-y', '-i', src, '-ar', String(MIX_RATE), '-ac', '2', '-c:a', 'pcm_s16le', out], o.signal);
    return decodeWav(await fs.readFile(out));
  } catch {
    return null;
  }
}

export interface SfxStem {
  wav: Buffer;
  /** Sample peak of the stem in dBFS (≤ −6, or −Infinity when empty). */
  peakDbfs: number;
  clips: (PlacedCue & { samples: number })[];
}

/** Mixes the placed cues into one 48 kHz stereo stem of `durationFrames`; each cue peaks at its gain, the stem at ≤ −6 dBFS. */
export function buildSfxStem(placed: readonly PlacedCue[], audio: ReadonlyMap<string, Pcm>, durationFrames: number): SfxStem {
  const n = Math.round((durationFrames / 30) * MIX_RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const clips: SfxStem['clips'] = [];
  for (const c of placed) {
    const p = audio.get(c.assetId);
    if (!p) continue;
    const s = toStereo(p, MIX_RATE);
    const peak = peakDbfs(s);
    if (!Number.isFinite(peak)) continue;
    const g = dbToLinear(c.gainDb - peak);
    const at = Math.round((c.frame / 30) * MIX_RATE);
    const len = Math.min(s.channels[0]!.length, n - at);
    for (let i = 0; i < len; i++) {
      L[at + i] = L[at + i]! + s.channels[0]![i]! * g;
      R[at + i] = R[at + i]! + s.channels[1]![i]! * g;
    }
    clips.push({ ...c, samples: Math.max(0, len) });
  }
  let peak = peakDbfs({ channels: [L, R] });
  // Overlapping cues can add up: the stem as a whole stays at or under the ceiling (with 16-bit rounding room).
  const ceiling = MIX_TARGETS.sfxPeakDbfs - 0.05;
  if (Number.isFinite(peak) && peak > ceiling) {
    const g = dbToLinear(ceiling - peak);
    for (let i = 0; i < n; i++) {
      L[i] = L[i]! * g;
      R[i] = R[i]! * g;
    }
  }
  const wav = encodeWav({ sampleRate: MIX_RATE, channels: [L, R] });
  peak = peakDbfs(decodeWav(wav)!);
  return { wav, peakDbfs: peak, clips };
}

// ---- the sound designer's cue list ------------------------------------------------------------------------------------

export const SFX_TASK =
  'Write the SfxCueList for this language version: the cue ids from the closed list at the frames the input gives (script requests, gesture contacts, swipes, sticker pops), at most one cue of an id per 4 frames, each with a peak gain of −6 dB or lower. Use only the cue ids the library has assets for; a cue without an asset is dropped.';
export const SFX_OUTPUT_SPEC = `One JSON object: { "cues": [{ "cue": "${SFX_CUES.join('|')}", "frame": 0, "gainDb": -9 }] }`;

const AGENT_UNAVAILABLE = new Set(['forbidden', 'needs_you', 'not_configured']);

export interface SfxDeps {
  call?: AgentCall | null;
  /** The `sfx` assets of the pack and the project (null = no pack: no SFX stem). */
  library: (i: ExecInput) => Promise<SfxAsset[] | null>;
  /** Told about every dropped cue (the step also records it as a warning check). */
  onWarning?: (text: string, i: ExecInput) => void;
}

/** The cue list for one timeline: the sound designer's in live mode when it can run, else the derived list. */
export async function sfxCueList(i: ExecInput, t: Timeline, requests: MusicDoc['sfxRequests'], call: AgentCall | null | undefined, available: readonly string[]): Promise<{ list: SfxCueList; by: 'sound-designer' | 'plan'; costUsd: number | null; model: string | null; note: StepCheck | null }> {
  const derived = deriveCues(t, requests);
  if (i.mode !== 'live') return { list: derived, by: 'plan', costUsd: 0, model: null, note: null };
  const base: ContextBundle = i.context ?? { task: '', node: { id: i.node.id, kind: 'mix', lang: i.lang, params: {} }, upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {}, outputSpec: '' };
  const params = { durationFrames: t.durationInFrames, suggested: derived.cues, segments: t.segments.map((s) => ({ beatId: s.beatId, segment: s.segment, from: s.from, to: s.to })), cuesWithAssets: available };
  const bundle: ContextBundle = { ...base, task: [SFX_TASK, base.task].filter(Boolean).join('\n\n'), node: { ...base.node, params: { ...base.node.params, ...params } }, outputSpec: SFX_OUTPUT_SPEC };
  try {
    const r = await callAgent({ agent: 'sound-designer', kind: 'mix', bundle, call: call ?? null, signal: i.signal, validate: (v) => validateCueList(v, t.durationInFrames) });
    return { list: r.value, by: 'sound-designer', costUsd: r.costUsd, model: r.model, note: null };
  } catch (e) {
    if (!(e instanceof PostmakerError) || !AGENT_UNAVAILABLE.has(e.code)) throw e;
    return { list: derived, by: 'plan', costUsd: 0, model: null, note: { id: `mix:${i.lang}:sfx-designer`, ok: true, required: false, text: 'SFX placed from the timeline. The sound designer is not available now.' } };
  }
}
