// `analyse`: a reference video becomes a validated recipe proposal.
//
// 1. Pre-processing, local and deterministic ($0): probe (ffprobe JSON when an ffprobe binary is given, else the
//    bundled ffmpeg's stream header), scene cuts at `scene > 0.30`, frames at 1 fps plus every cut (+2 frames, to skip
//    the transition) scaled to 270×480, capped at 96 (evenly spaced 1 fps frames are dropped first, cut frames never),
//    up to 6 contact sheets of 4×4 tiles at 1080×1920 with a timestamp band on each tile, EBU R128 integrated loudness,
//    `silencedetect=n=-35dB:d=0.25`, a 16 kHz mono WAV for a later transcription connector, and a text timeline.
//    Tempo stays null unless the template declares a BPM.
// 2. The agent call: the `deconstructor` in vision mode reads only the sheets and the timeline, which are the
//    only files in its temp cwd, and answers a RecipeProposal plus the text it read on screen.
// 3. Validation (zod, closed vocabularies): ordered, non-overlapping beats covering 0…duration within 0.5 s, boundaries
//    snapped to cuts within ±0.25 s, techniques and segments from the vocabulary, on-screen text only in the recipe's
//    languages and never matching the deny-list (the reference's own detected text plus the pack's `claims.denied`),
//    `have` assets only with a pack asset id.
// Mock mode makes the proposal from the pre-processing alone (beats at the cuts), through the same validator.
// The reference's detected text is handed to the caller to store under `postmaker/refs/<id>/` (outside the
// repository); it is the similarity guard's corpus and a deny-list, and never seeds a script.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { VisionFile } from '../../claude-agent';
import { editSimilarity, SIMILARITY_LIMIT } from '../../lang/fa/bilingual';
import { stripMarks } from '../../lang/fa/chars';
import { normalizeFa } from '../../lang/fa/normalize';
import type { Spawn } from '../connectors/base';
import { PostmakerError } from '../errors';
import { putBytes, sha256Hex } from '../store/objects';
import type { ContextBundle, Lang, Recipe, RecipeBeat, Shape } from '../types';
import { agentEstimate, callAgent, type AgentCall } from './agent';
import type { Executor } from './types';
import { issueText, segmentSchema, techniqueSchema } from './vocab';

export const SCENE_THRESHOLD = 0.3;
export const MAX_FRAMES = 96;
export const MAX_SHEETS = 6;
export const TILE = { w: 270, h: 480 } as const;
export const SHEET = { w: 1080, h: 1920, cols: 4, rows: 4 } as const;
export const MAX_REFERENCE_MS = 300_000; //
export const SNAP_SEC = 0.25;
export const COVER_SEC = 0.5;

export interface AnalyseTools {
  ffmpeg: string;
  /** null: probe with the ffmpeg stream header (the bundled ffmpeg-static ships no ffprobe). */
  ffprobe: string | null;
  spawn: Spawn;
}

export async function defaultTools(): Promise<AnalyseTools> {
  const ffmpeg = (await import('ffmpeg-static')).default;
  if (!ffmpeg) throw new PostmakerError(503, 'not-installed', 'ffmpeg is not available on this machine.');
  return { ffmpeg, ffprobe: null, spawn: (await import('node:child_process')).spawn };
}

function exec(t: AnalyseTools, bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = t.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-2_000_000)));
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2_000_000)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const fail = (what: string, r: { code: number | null; err: string }) => new PostmakerError(422, 'unreadable', `${what} failed (exit ${r.code}): ${r.err.replace(/\s+/g, ' ').trim().slice(-200)}`);

// ---- 1. probe -------------------------------------------------------------------------------------------------

export interface Probe {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
}

/** Parses `ffprobe -show_streams -show_format -of json`. */
export function parseFfprobe(json: string): Probe {
  const j = JSON.parse(json) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[]; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new PostmakerError(422, 'unreadable', 'The reference has no video stream.');
  const rate = (r?: string) => {
    const [a, b] = String(r ?? '0/1').split('/').map(Number);
    return b ? a! / b : a!;
  };
  return { durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000), width: v.width ?? 0, height: v.height ?? 0, fps: Math.round((rate(v.avg_frame_rate) || rate(v.r_frame_rate)) * 1000) / 1000, hasAudio: Boolean(j.streams?.some((s) => s.codec_type === 'audio')), codec: v.codec_name ?? 'unknown' };
}

/** Parses the stream header `ffmpeg -i` prints. */
export function parseFfmpegHeader(err: string): Probe {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})[^\n]*?(\d+(?:\.\d+)?)\s*fps/.exec(err);
  if (!d || !v) throw new PostmakerError(422, 'unreadable', 'The reference could not be read as a video.');
  return { durationMs: Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000), width: Number(v[2]), height: Number(v[3]), fps: Number(v[4]), hasAudio: /Stream #[^\n]*Audio:/.test(err), codec: v[1]! };
}

/**
 * ffmpeg and ffprobe open URLs (http, rtmp, concat, …) as readily as files, and a child process is outside the Node
 * network guard (social video links are never downloaded). The reference must be an absolute local path.
 */
export function assertLocalSource(src: string): void {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || !path.isAbsolute(src) || src.includes('\0')) {
    throw new PostmakerError(400, 'validation', 'The reference must be a file on this computer.');
  }
}

export async function probeReference(t: AnalyseTools, src: string, signal?: AbortSignal): Promise<Probe> {
  assertLocalSource(src);
  if (t.ffprobe) {
    const r = await exec(t, t.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', src], signal);
    if (r.code !== 0) throw fail('ffprobe', r);
    return parseFfprobe(r.out);
  }
  const r = await exec(t, t.ffmpeg, ['-hide_banner', '-i', src], signal); // exits 1 (no output file); the header is on stderr
  return parseFfmpegHeader(r.err);
}

// ---- 2. cuts ---------------------------------------------------------------------------------------------------

/** Cut times (seconds) from `showinfo` lines of the scene-change select. */
export function parseCuts(err: string): number[] {
  const out: number[] = [];
  for (const m of err.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*(\d+(?:\.\d+)?)/g)) out.push(Math.round(Number(m[1]) * 1000) / 1000);
  return [...new Set(out)].sort((a, b) => a - b);
}

export async function detectCuts(t: AnalyseTools, src: string, signal?: AbortSignal, threshold = SCENE_THRESHOLD): Promise<number[]> {
  const r = await exec(t, t.ffmpeg, ['-hide_banner', '-nostats', '-i', src, '-an', '-vf', `select='gt(scene,${threshold.toFixed(2)})',showinfo`, '-f', 'null', '-'], signal);
  if (r.code !== 0) throw fail('Scene detection', r);
  return parseCuts(r.err);
}

// ---- 3. frames -------------------------------------------------------------------------------------------------

export interface PlannedFrame {
  t: number; // seconds
  cut: boolean;
}

/**
 * 1 fps frames plus every cut frame (+2 frames), at most `cap`. Over the cap, evenly spaced 1 fps frames are dropped
 * first and cut frames are kept; only when the cuts alone exceed the cap are they thinned evenly.
 */
export function planFrames(durationSec: number, cuts: number[], fps: number, cap = MAX_FRAMES): PlannedFrame[] {
  const f = fps > 0 ? fps : 30;
  const last = Math.max(0, durationSec - 1 / f);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  let cutFrames = cuts.filter((c) => c > 0 && c < durationSec).map((c) => ({ t: r3(Math.min(last, c + 2 / f)), cut: true }));
  if (cutFrames.length > cap) cutFrames = evenly(cutFrames, cap);
  const near = (t: number) => cutFrames.some((c) => Math.abs(c.t - t) < 1 / f);
  const seconds: PlannedFrame[] = [];
  for (let s = 0; s < durationSec; s += 1) if (!near(s)) seconds.push({ t: r3(Math.min(s, last)), cut: false });
  const room = Math.max(0, cap - cutFrames.length);
  const kept = seconds.length > room ? evenly(seconds, room) : seconds;
  return [...kept, ...cutFrames].sort((a, b) => a.t - b.t);
}

function evenly<T>(xs: T[], n: number): T[] {
  if (n <= 0) return [];
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]!);
  return out;
}

export interface FrameFile extends PlannedFrame {
  file: string;
}

export async function extractFrames(t: AnalyseTools, src: string, plan: PlannedFrame[], dir: string, signal?: AbortSignal): Promise<FrameFile[]> {
  await fs.mkdir(dir, { recursive: true });
  const out: FrameFile[] = [];
  const vf = `scale=${TILE.w}:${TILE.h}:force_original_aspect_ratio=decrease,pad=${TILE.w}:${TILE.h}:(ow-iw)/2:(oh-ih)/2`;
  for (const p of plan) {
    const file = path.join(dir, `f-${String(Math.round(p.t * 1000)).padStart(6, '0')}.jpg`);
    const r = await exec(t, t.ffmpeg, ['-v', 'error', '-y', '-ss', p.t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', file], signal);
    if (r.code !== 0) throw fail('Frame extraction', r);
    out.push({ ...p, file });
  }
  return out;
}

// ---- 4. contact sheets ------------------------------------------------------------------------------------------

export const stamp = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

/** 4×4 tiles per 1080×1920 sheet, each with its timestamp in a band at the tile's lower edge; at most 6 sheets. */
export async function contactSheets(frames: FrameFile[], dir: string): Promise<{ name: string; file: string; frames: number[] }[]> {
  const per = SHEET.cols * SHEET.rows;
  const groups: FrameFile[][] = [];
  for (let i = 0; i < frames.length && groups.length < MAX_SHEETS; i += per) groups.push(frames.slice(i, i + per));
  const out: { name: string; file: string; frames: number[] }[] = [];
  for (const [k, g] of groups.entries()) {
    const tiles = g.map((f, i) => ({ input: f.file, left: (i % SHEET.cols) * TILE.w, top: Math.floor(i / SHEET.cols) * TILE.h }));
    const bands = g
      .map((f, i) => {
        const x = (i % SHEET.cols) * TILE.w;
        const y = Math.floor(i / SHEET.cols) * TILE.h + TILE.h - 40;
        return `<rect x="${x}" y="${y}" width="${TILE.w}" height="40" fill="#000" fill-opacity="0.7"/><text x="${x + 10}" y="${y + 29}" font-size="26" font-family="monospace" fill="#fff">${stamp(f.t)}${f.cut ? ' cut' : ''}</text>`;
      })
      .join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}" height="${SHEET.h}">${bands}</svg>`);
    const name = `sheet-${k + 1}.jpg`;
    const file = path.join(dir, name);
    await sharp({ create: { width: SHEET.w, height: SHEET.h, channels: 3, background: '#111111' } })
      .composite([...tiles, { input: svg, left: 0, top: 0 }])
      .jpeg({ quality: 85 })
      .toFile(file);
    out.push({ name, file, frames: g.map((f) => f.t) });
  }
  return out;
}

// ---- 5. audio --------------------------------------------------------------------------------------------------

export function parseLoudness(err: string): number | null {
  const m = /Integrated loudness:[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(err);
  return m ? Number(m[1]) : null;
}

export function parseSilences(err: string, durationSec: number): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const m of err.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const v = Math.max(0, Math.round(Number(m[2]) * 1000) / 1000);
    if (m[1] === 'start') start = v;
    else if (start !== null) {
      out.push([start, v]);
      start = null;
    }
  }
  if (start !== null) out.push([start, Math.round(durationSec * 1000) / 1000]);
  return out;
}

export async function audioStats(t: AnalyseTools, src: string, dir: string, durationSec: number, signal?: AbortSignal): Promise<{ loudnessLufs: number | null; silences: [number, number][]; wav: string }> {
  const r = await exec(t, t.ffmpeg, ['-hide_banner', '-nostats', '-i', src, '-vn', '-af', 'silencedetect=n=-35dB:d=0.25,ebur128=framelog=quiet', '-f', 'null', '-'], signal);
  if (r.code !== 0) throw fail('Audio analysis', r);
  const wav = path.join(dir, 'audio-16k.wav');
  const w = await exec(t, t.ffmpeg, ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav], signal);
  if (w.code !== 0) throw fail('Audio export', w);
  return { loudnessLufs: parseLoudness(r.err), silences: parseSilences(r.err, durationSec), wav };
}

// ---- 6. the whole pre-processing ---------------------------------------------------------------------------------

export interface Preprocessed {
  probe: Probe;
  cuts: number[];
  frames: FrameFile[];
  sheets: { name: string; file: string; frames: number[] }[];
  loudnessLufs: number | null;
  silences: [number, number][];
  wav: string | null;
  timeline: string;
}

export function timelineText(p: Omit<Preprocessed, 'timeline'>): string {
  const s = (x: number) => x.toFixed(2);
  return [
    'Reference timeline (seconds)',
    `duration: ${s(p.probe.durationMs / 1000)}`,
    `picture: ${p.probe.width}x${p.probe.height}, ${p.probe.fps} fps; audio: ${p.probe.hasAudio ? 'yes' : 'no'}`,
    `cuts: ${p.cuts.length ? p.cuts.map(s).join(', ') : 'none'}`,
    `silences: ${p.silences.length ? p.silences.map(([a, b]) => `${s(a)}-${s(b)}`).join(', ') : 'none'}`,
    `loudness: ${p.loudnessLufs === null ? 'unknown' : `${p.loudnessLufs} LUFS integrated`}`,
    'sheets (4x4 tiles, left to right, top to bottom; each tile shows its time):',
    ...p.sheets.map((sh) => `  ${sh.name}: ${sh.frames.map(s).join(', ')}`),
    '',
  ].join('\n');
}

export async function preprocess(src: string, workDir: string, o: { tools?: AnalyseTools; signal?: AbortSignal } = {}): Promise<Preprocessed> {
  assertLocalSource(src);
  const t = o.tools ?? (await defaultTools());
  const probe = await probeReference(t, src, o.signal);
  if (probe.durationMs <= 0) throw new PostmakerError(422, 'unreadable', 'The reference has no length.');
  if (probe.durationMs > MAX_REFERENCE_MS) throw new PostmakerError(422, 'too-long', 'Use a reference of 5 minutes or less.');
  const dur = probe.durationMs / 1000;
  const cuts = await detectCuts(t, src, o.signal);
  const frames = await extractFrames(t, src, planFrames(dur, cuts, probe.fps), path.join(workDir, 'frames'), o.signal);
  const sheets = await contactSheets(frames, workDir);
  const audio = probe.hasAudio ? await audioStats(t, src, workDir, dur, o.signal) : { loudnessLufs: null, silences: [] as [number, number][], wav: null };
  const base = { probe, cuts, frames, sheets, loudnessLufs: audio.loudnessLufs, silences: audio.silences, wav: audio.wav };
  const timeline = timelineText(base);
  await fs.writeFile(path.join(workDir, 'timeline.txt'), timeline);
  return { ...base, timeline };
}

// ---- 7. validation ---------------------------------------------------------------------------------------------

/** A comparable form: Persian normalised, marks stripped, lower case, punctuation as spaces. */
export function denyForm(s: string): string {
  return stripMarks(normalizeFa(s).text)
    .toLowerCase()
    .replace(/[\u200C]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The deny-list: the reference's own detected text (each whole line, plus the tokens that look like names: Latin words
 * capitalised mid-line, #tags and @handles) and the pack's `claims.denied`, in the comparable form.
 */
export function buildDenyList(detected: string[], claimsDenied: string[] = []): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const f = denyForm(s);
    if ([...f].length >= 2) out.add(f);
  };
  for (const line of detected) {
    add(line);
    const words = line.split(/\s+/).filter(Boolean);
    words.forEach((w, k) => {
      if (/^[#@]\S{2,}/.test(w) || (k > 0 && /^[A-Z][A-Za-z]{2,}/.test(w))) add(w.replace(/^[#@]/, ''));
    });
  }
  for (const c of claimsDenied) add(c);
  return [...out];
}

/** The deny-list entry a text matches (a phrase it contains, or a line over the similarity limit), or null. */
export function denyHit(text: string, deny: string[]): string | null {
  const f = denyForm(text);
  if (!f) return null;
  const padded = ` ${f} `;
  for (const d of deny) {
    if (padded.includes(` ${d} `)) return d;
    if (d.includes(' ') && editSimilarity(f, d) > SIMILARITY_LIMIT) return d;
  }
  return null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const short = (n: number) => z.string().max(n);

const beatSchema = z.strictObject({
  id: z.string().regex(/^b\d{2}$/, 'Beat ids are b01, b02, …'),
  start: z.number().min(0),
  end: z.number().positive(),
  segment: segmentSchema,
  name: short(40),
  purpose: short(140),
  visual: short(200),
  techniques: z.array(techniqueSchema).min(1).max(6),
  onScreenText: z.partialRecord(z.enum(['fa', 'en']), short(120)),
  audio: short(140),
  motion: short(140),
});

const proposalSchema = z.strictObject({
  beats: z.array(beatSchema).min(3).max(24),
  style: z.strictObject({
    captions: z.enum(['word-pop', 'line', 'karaoke']),
    pace: z.enum(['calm', 'fast', 'very-fast']),
    palette: z.array(z.string().regex(HEX)).max(6),
    type: short(80),
    voice: short(80),
    music: short(80),
  }),
  assets: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), label: short(80), kind: z.enum(['image', 'video', 'audio', 'font', 'logo']), state: z.enum(['have', 'make', 'missing']), source: z.string().max(120).nullable() })).max(40),
  tempo: z.strictObject({ bpm: z.number(), downbeatMs: z.number() }).nullable(),
  /** The text the agent read on screen in the reference (data for the deny-list and the similarity corpus). */
  detectedText: z.array(short(200)).max(60).default([]),
});

export type RecipeProposal = z.infer<typeof proposalSchema>;

export interface ProposalContext {
  durationSec: number;
  languages: Lang[];
  cuts: number[];
  deny: string[];
  packAssetIds: string[];
  templateBpm: number | null;
}

/** Validates an agent's (or the mock's) answer and normalises it: boundaries snapped to cuts, tempo from the template. */
export function validateRecipeProposal(raw: unknown, ctx: ProposalContext): RecipeProposal {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) throw new PostmakerError(422, 'invalid-answer', issueText(parsed.error));
  const p = parsed.data;
  const bad = (m: string) => new PostmakerError(422, 'invalid-answer', m);
  const snap = (x: number) => {
    const c = ctx.cuts.find((k) => Math.abs(k - x) <= SNAP_SEC);
    return c === undefined ? x : c;
  };
  const beats = p.beats.map((b, i) => ({ ...b, start: i === 0 ? b.start : snap(b.start), end: i === p.beats.length - 1 ? b.end : snap(b.end) }));
  beats.forEach((b, i) => {
    if (b.id !== `b${String(i + 1).padStart(2, '0')}`) throw bad(`beats.${i}.id: beats are numbered in order (b01, b02, …).`);
    if (!(b.end > b.start)) throw bad(`${b.id}: a beat ends after it starts.`);
    if (i > 0) {
      const prev = beats[i - 1]!;
      if (b.start < prev.end - 1e-6) throw bad(`${b.id}: beats may not overlap.`);
      if (b.start - prev.end > COVER_SEC) throw bad(`${b.id}: the beats must cover the reference without gaps.`);
    }
    for (const lang of Object.keys(b.onScreenText) as Lang[]) {
      if (!ctx.languages.includes(lang)) throw bad(`${b.id}: on-screen text only in the recipe's languages.`);
      const hit = denyHit(b.onScreenText[lang] ?? '', ctx.deny);
      if (hit) throw bad(`${b.id}: on-screen text copies the reference or a denied claim.`);
    }
  });
  if (beats[0]!.start > COVER_SEC) throw bad('The first beat starts at the beginning.');
  if (Math.abs(beats.at(-1)!.end - ctx.durationSec) > COVER_SEC) throw bad('The last beat ends at the end of the reference.');
  const ids = new Set(ctx.packAssetIds);
  for (const a of p.assets) if (a.state === 'have' && !ids.has(a.id)) throw bad(`assets.${a.id}: "have" only for a pack asset.`);
  return { ...p, beats, tempo: ctx.templateBpm ? { bpm: ctx.templateBpm, downbeatMs: 0 } : null };
}

// ---- 7b. length -------------------------------------------------------------------------------------

/** Below this difference (seconds) the requested length counts as the reference's own length. */
export const RESCALE_EPSILON_SEC = 0.05;

/**
 * Rescales beat times proportionally from the reference's length to the requested one: every boundary × to/from,
 * rounded to the millisecond, contiguous, the first beat at 0 and the last ending exactly at `toSec`. Order is never
 * changed; pinned beats keep their ids and their order (a pinned id that is missing, or out of order, is refused).
 * The evidence (cuts, silences, sheets) stays in reference time.
 */
export function rescaleBeats<B extends { id: string; start: number; end: number }>(beats: B[], fromSec: number, toSec: number, pinned: readonly string[] = []): B[] {
  if (!(fromSec > 0) || !(toSec > 0)) throw new PostmakerError(400, 'validation', 'A length must be more than 0 seconds.');
  const ids = beats.map((b) => b.id);
  const at = pinned.map((p) => ids.indexOf(p));
  if (at.some((i) => i < 0)) throw new PostmakerError(409, 'conflict', 'A pinned beat is missing from the recipe.');
  if (Math.abs(toSec - fromSec) <= RESCALE_EPSILON_SEC) return beats.map((b) => ({ ...b }));
  const k = toSec / fromSec;
  const ms = (s: number) => Math.round(s * 1000);
  const bounds = [0, ...beats.slice(0, -1).map((b) => ms(b.end * k)), ms(toSec)];
  // Keep every beat at least 1 ms long after rounding (boundaries strictly increase, so the order holds).
  for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i]!, bounds[i - 1]! + 1);
  if (bounds.at(-1)! !== ms(toSec)) throw new PostmakerError(422, 'invalid-answer', 'Too many beats for this length.');
  const out = beats.map((b, i) => ({ ...b, start: bounds[i]! / 1000, end: bounds[i + 1]! / 1000 }));
  const order = pinned.map((p) => out.findIndex((b) => b.id === p));
  if (order.some((x, i) => x !== at[i])) throw new PostmakerError(409, 'conflict', 'The pinned beats changed order.');
  return out;
}

// ---- 8. mock and assembly ----------------------------------------------------------------------------------------

/** A mock proposal from the pre-processing alone: one beat per shot (at least 3), generic words, no text. */
export function mockRecipeProposal(durationSec: number, cuts: number[], languages: Lang[]): unknown {
  let bounds = [0, ...cuts.filter((c) => c > 0.5 && c < durationSec - 0.5), durationSec];
  while (bounds.length - 1 < 3) bounds = Array.from({ length: 4 }, (_, i) => Math.round(((durationSec * i) / 3) * 1000) / 1000);
  // At most 24 beats (25 bounds): keep the first 24 starts and end on the reference's end.
  if (bounds.length > 25) bounds = [...bounds.slice(0, 24), durationSec];
  const n = bounds.length - 1;
  const beats = Array.from({ length: n }, (_, i) => {
    const segment: RecipeBeat['segment'] = i === 0 ? 'hook' : i === n - 1 ? 'endcard' : 'story';
    const techniques = segment === 'hook' ? ['pov-hook', 'word-kinetic-caption'] : segment === 'endcard' ? ['end-card-cta'] : ['word-kinetic-caption'];
    return { id: `b${String(i + 1).padStart(2, '0')}`, start: bounds[i]!, end: bounds[i + 1]!, segment, name: `Beat ${i + 1}`, purpose: 'mock', visual: 'mock', techniques, onScreenText: Object.fromEntries(languages.map((l) => [l, ''])), audio: 'mock', motion: 'mock' };
  });
  return { beats, style: { captions: 'word-pop', pace: 'fast', palette: [], type: 'mock', voice: 'mock', music: 'mock' }, assets: [], tempo: null, detectedText: [] };
}

export const DECONSTRUCTOR_TASK = [
  'Read the reference from the files in your working folder: the contact sheets (sheet-<n>.jpg; each tile shows its time) and timeline.txt (cuts, silences, loudness).',
  'Describe its structure as a recipe: beats with start and end in seconds (snap boundaries to the listed cuts), segment, name, purpose, visual, techniques, on-screen text, audio and motion notes; the style; the assets a remake needs.',
  'Structure only: never copy the reference text, characters, brand or names into the recipe. List the text you read on screen in detectedText.',
].join('\n');

export const RECIPE_OUTPUT_SPEC = `One JSON object: { "beats": [{ "id": "b01", "start": 0, "end": 2.5, "segment": one of hook|story|interrupt|demo|chant|escalation|reveal|endcard|other, "name": "≤ 40 chars", "purpose": "≤ 140", "visual": "≤ 200, generic", "techniques": [1-6 ids from the technique list], "onScreenText": { "<lang>": "≤ 120, new words, never the reference's" }, "audio": "≤ 140", "motion": "≤ 140" }] (3-24 beats, ordered, covering the whole reference), "style": { "captions": "word-pop"|"line"|"karaoke", "pace": "calm"|"fast"|"very-fast", "palette": ["#rrggbb", ≤ 6], "type": "", "voice": "", "music": "" }, "assets": [{ "id": "slug", "label": "", "kind": "image"|"video"|"audio"|"font"|"logo", "state": "have"|"make"|"missing", "source": null }] ("have" only with a pack asset id you were given), "tempo": null, "detectedText": ["each line of text you read on screen"] }`;

export interface AnalyseInput {
  src: string;
  workDir: string;
  languages: Lang[];
  lengthSec: number;
  shape: Shape;
  mode: 'live' | 'mock';
  call: AgentCall | null;
  packAssetIds?: string[];
  claimsDenied?: string[];
  templateBpm?: number | null;
  /** Object store root: the sheets are stored and the evidence names their hashes. */
  root?: string;
  /** Beat ids pinned by the person (kept, in their order, when the times are rescaled to `lengthSec`). */
  pinnedBeats?: string[];
  tools?: AnalyseTools;
  signal?: AbortSignal;
  userNotes?: string[];
}

export interface AnalyseResult {
  proposal: Omit<RecipeProposal, 'detectedText'>;
  /** The reference's detected text: store under postmaker/refs/<id>/ only. */
  detectedText: string[];
  probe: Probe;
  evidence: Recipe['evidence'];
  pre: Preprocessed;
  costUsd: number | null;
  model: string | null;
  promptHash: string | null;
}

/** The bundle the deconstructor reads: no upstream; pack asset ids only; the user's notes as untrusted. */
export function deconstructorBundle(o: { languages: Lang[]; lengthSec: number; shape: Shape; files: string[]; packAssetIds: string[]; userNotes?: string[] }): ContextBundle {
  return {
    task: DECONSTRUCTOR_TASK,
    node: { id: 'analyse', kind: 'analyse', lang: null, params: { languages: o.languages, lengthSec: o.lengthSec, shape: o.shape, files: o.files } },
    upstream: [],
    downstream: [],
    neighbours: null,
    pinned: [],
    history: [],
    rubric: [],
    pack: { glossary: { assetIds: o.packAssetIds } },
    untrusted: o.userNotes?.length ? { userNotes: o.userNotes } : {},
    outputSpec: RECIPE_OUTPUT_SPEC,
  };
}

export async function analyseReference(i: AnalyseInput): Promise<AnalyseResult> {
  const pre = await preprocess(i.src, i.workDir, { tools: i.tools, signal: i.signal });
  const dur = pre.probe.durationMs / 1000;
  const packAssetIds = i.packAssetIds ?? [];
  const ctx0 = { durationSec: dur, languages: i.languages, cuts: pre.cuts, packAssetIds, templateBpm: i.templateBpm ?? null };
  let raw: unknown;
  let costUsd: number | null = 0;
  let model: string | null = 'mock';
  let promptHash: string | null = null;
  if (i.mode === 'mock') raw = mockRecipeProposal(dur, pre.cuts, i.languages);
  else {
    const files: VisionFile[] = [...(await Promise.all(pre.sheets.map(async (s) => ({ name: s.name, data: await fs.readFile(s.file) })))), { name: 'timeline.txt', data: pre.timeline }];
    const bundle = deconstructorBundle({ languages: i.languages, lengthSec: i.lengthSec, shape: i.shape, files: files.map((f) => f.name), packAssetIds, userNotes: i.userNotes });
    const r = await callAgent({ agent: 'deconstructor', kind: 'analyse', bundle, call: i.call, signal: i.signal ?? new AbortController().signal, files, validate: (v) => v });
    raw = r.value;
    costUsd = r.costUsd;
    model = r.model;
    promptHash = r.promptHash;
  }
  // The deny-list needs the agent's own detected text first, then the full validation runs against it.
  const detected = z.object({ detectedText: z.array(z.string().max(200)).max(60).default([]) }).safeParse(raw);
  const detectedText = detected.success ? detected.data.detectedText : [];
  let proposal: RecipeProposal;
  try {
    proposal = validateRecipeProposal(raw, { ...ctx0, deny: buildDenyList(detectedText, i.claimsDenied) });
  } catch (e) {
    if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = costUsd;
    throw e;
  }
  const sheets: string[] = [];
  for (const s of pre.sheets) {
    const bytes = await fs.readFile(s.file);
    sheets.push(i.root ? (await putBytes(i.root, bytes)).sha256 : sha256Hex(bytes));
  }
  // Ruling: a requested length that differs from the reference rescales the beat times proportionally.
  proposal = { ...proposal, beats: rescaleBeats(proposal.beats, dur, i.lengthSec, i.pinnedBeats ?? []) };
  const { detectedText: _d, ...rest } = proposal;
  void _d;
  return { proposal: rest, detectedText, probe: pre.probe, evidence: { sheets, cuts: pre.cuts, silences: pre.silences, loudnessLufs: pre.loudnessLufs }, pre, costUsd, model, promptHash };
}

/** The recipe fields `analyse` fills (code fills ids, version and the rest). */
export function recipeFields(r: AnalyseResult): Pick<Recipe, 'beats' | 'style' | 'assets' | 'tempo' | 'evidence'> {
  return { beats: r.proposal.beats, style: r.proposal.style, assets: r.proposal.assets.map((a) => ({ ...a, madeBy: null })), tempo: r.proposal.tempo, evidence: r.evidence };
}

export interface AnalyseDeps {
  call?: AgentCall | null;
  billing?: 'subscription' | 'api-key';
  tools?: AnalyseTools;
  /** Where the reference file and the work folder are for this run (the API resolves them; refs/, runs/). */
  source: (i: { runId: string; params: Record<string, unknown> }) => Promise<{ src: string; workDir: string; packAssetIds?: string[]; claimsDenied?: string[]; templateBpm?: number | null }>;
  /** Stores the detected reference text under postmaker/refs/<id>/ (outside the repository). */
  saveDetectedText?: (lines: string[]) => Promise<void>;
  root?: string;
}

/** The executor wrapper (kind `analyse`): output port `recipe` = the recipe fields with their evidence. */
export function analyseExecutor(deps: AnalyseDeps): Executor {
  return {
    kind: 'analyse',
    implVersion: 'analyse@1',
    deterministic: false,
    estimate: (e) => agentEstimate(e.mode, deps.billing, 2.0, 120),
    async run(i) {
      const s = await deps.source({ runId: i.runId, params: i.params });
      const r = await analyseReference({ ...s, languages: i.recipe.languages, lengthSec: i.recipe.lengthSec, shape: i.recipe.shape, mode: i.mode, call: deps.call ?? null, tools: deps.tools, signal: i.signal, root: deps.root, userNotes: i.note ? [i.note] : [], pinnedBeats: i.pinnedBeats });
      await deps.saveDetectedText?.(r.detectedText);
      const recipe = recipeFields(r);
      return { outputs: [{ port: 'recipe', name: 'recipe.json', kind: 'json', mime: 'application/json', data: recipe }], provides: { beatIds: recipe.beats.map((b) => b.id) }, costUsd: i.mode === 'mock' ? 0 : r.costUsd, model: r.model };
    },
  };
}
