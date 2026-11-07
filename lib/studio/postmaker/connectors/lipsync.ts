// Lip-sync connectors (lipsync rows; vendor documentation read 2026-11-06; volatile): Sync sync-3 (primary) and Hedra Character-3 (fallback). Both are asynchronous: submit, poll, download at
// once (Hedra keeps outputs 48 h). Inputs reach the vendor as public https links made by the executor through the
// media bucket under an unguessable key and deleted after the job; a live call without
// them is refused. Paid per second on the owner's key. Neither vendor documents a free check: test() never calls.
//
// Mock: the still image held for the audio length with a pulsing mouth box, made with the bundled ffmpeg.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import { estimateCost, httpsUrl, jsonOf, poll, publicHttpsUrl, READ_AT, send, str, type CallShape, type HttpCall, type RegisteredConnector, type Spawn } from './base';
import { defineConnector } from './define';
import { mouthBoxArgs, runFfmpeg, type Box } from './mock/video';

export interface LipsyncRequest {
  /** Local files (the mock reads these; the executor uploads them for a live call). */
  imageFile: string;
  audioFile: string;
  durationMs: number;
  width: number;
  height: number;
  /** Where the mouth is on the still (from the pack rig), for the mock's pulsing box. */
  mouthBox?: Box;
  /** Public https links of the same files, required for a live call. */
  imageUrl?: string;
  audioUrl?: string;
  prompt?: string;
}

export interface LipsyncResult {
  video: Buffer;
  mime: 'video/mp4';
  durationMs: number;
  requestId: string | null;
  mode: 'live' | 'mock';
}

export const SYNC_BASE = 'https://api.sync.so';
export const SYNC_KEY_ENV = 'SYNC_API_KEY';
export const SYNC_MODEL = 'sync-3';
export const SYNC_SHAPE: CallShape = {
  source: 'https://sync.so/docs/models/sync-3',
  readAt: READ_AT,
  unverified: ['api host api.sync.so', 'x-api-key header', 'body shape {model, input:[{type,url}]}', 'answer fields id / status / outputUrl', 'poll path GET /v2/generate/{id}', 'status words', 'result download hosts (CDN) to allow-list', 'whether the result link redirects'],
};

export const HEDRA_BASE = 'https://api.hedra.com';
export const HEDRA_KEY_ENV = 'HEDRA_API_KEY';
export const HEDRA_SHAPE: CallShape = {
  source: 'https://www.hedra.com/docs/api-reference/v3/run-a-model/run-hedra-character-3-hedra-character-3.md',
  readAt: READ_AT,
  unverified: ['x-api-key header', 'start_image and audio passed as links', 'answer fields id / status / url', 'poll path GET /v3/generations/{id}', 'status words', 'terms (page was 404)', 'result download hosts (CDN) to allow-list', 'whether the result link redirects'],
};

const needUrls = (r: LipsyncRequest, title: string) => {
  const image = httpsUrl(r.imageUrl);
  const audio = httpsUrl(r.audioUrl);
  if (!image || !audio) throw new PostmakerError(400, 'needs_public_url', `${title} needs public links for the image and the audio.`);
  if (!(r.durationMs > 0)) throw new PostmakerError(400, 'validation', 'The audio length is missing.');
  return { image, audio };
};

export function buildSyncGenerate(r: LipsyncRequest): HttpCall {
  const u = needUrls(r, 'Sync');
  return {
    method: 'POST',
    url: `${SYNC_BASE}/v2/generate`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: SYNC_MODEL, input: [{ type: 'image', url: u.image }, { type: 'audio', url: u.audio }] }),
  };
}

export interface JobState {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  outputUrl: string | null;
  error: string | null;
}

const DONE = /^(completed|complete|succeeded|success|done|finished)$/i;
const FAILED = /^(failed|error|rejected|cancell?ed|canceled)$/i;
const QUEUED = /^(pending|queued|submitted|waiting)$/i;

/** Reads an async job answer defensively (field names unverified, see the call shapes). */
export function parseJob(j: Record<string, unknown>, title: string): JobState {
  const id = str(j.id ?? j.generation_id ?? j.request_id).trim();
  if (!/^[A-Za-z0-9_.:-]{4,128}$/.test(id)) throw new PostmakerError(502, 'upstream', `${title} did not return a job id.`);
  const s = str(j.status).trim();
  const status: JobState['status'] = DONE.test(s) ? 'done' : FAILED.test(s) ? 'failed' : QUEUED.test(s) ? 'queued' : 'running';
  // Signal downloads this link, so it must be a public https host (the vendor CDN hosts are unverified).
  const outputUrl = publicHttpsUrl(j.outputUrl ?? j.output_url ?? j.url ?? j.download_url);
  return { id, status, outputUrl, error: status === 'failed' ? str(j.error ?? j.error_message ?? j.message).slice(0, 200) || 'failed' : null };
}

export function buildHedraGenerate(r: LipsyncRequest): HttpCall {
  const u = needUrls(r, 'Hedra');
  const ratio = r.width < r.height ? '9:16' : r.width > r.height ? '16:9' : '1:1';
  return {
    method: 'POST',
    url: `${HEDRA_BASE}/v3/models/hedra-character-3`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ start_image: u.image, audio: [u.audio], prompt: r.prompt ?? '', aspect_ratio: ratio, resolution: '720p' }),
  };
}

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

async function download(ctx: InvokeCtx, url: string, title: string, redact: (s: string) => string): Promise<Buffer> {
  const a = await send(ctx.deps.fetch ?? globalThis.fetch, { method: 'GET', url, headers: {} }, {}, { title, redact, signal: ctx.signal, timeoutMs: 180_000 });
  if (a.bytes.length === 0 || a.bytes.length > MAX_VIDEO_BYTES) throw new PostmakerError(502, 'upstream', `${title} sent an unusable video.`);
  return a.bytes;
}

async function runVendor(r: LipsyncRequest, ctx: InvokeCtx, o: { title: string; submit: HttpCall; pollUrl: (id: string) => string; auth: Record<string, string>; redact: (s: string) => string }): Promise<LipsyncResult> {
  const f = ctx.deps.fetch ?? globalThis.fetch;
  const first = parseJob(jsonOf(await send(f, o.submit, o.auth, { title: o.title, redact: o.redact, signal: ctx.signal }), o.title), o.title);
  ctx.onEvent({ kind: 'vendor', text: `${o.title} job ${first.id} started.` });
  const done = await poll<JobState>(
    async () => {
      const s = parseJob(jsonOf(await send(f, { method: 'GET', url: o.pollUrl(first.id), headers: { Accept: 'application/json' } }, o.auth, { title: o.title, redact: o.redact, signal: ctx.signal }), o.title), o.title);
      return { done: s.status === 'done' && Boolean(s.outputUrl), value: s, failed: s.status === 'failed' ? (s.error ?? 'failed') : undefined };
    },
    { ctx, title: o.title, everyMs: 5_000, maxTries: 240 },
  );
  return { video: await download(ctx, done.outputUrl!, o.title, o.redact), mime: 'video/mp4', durationMs: r.durationMs, requestId: first.id, mode: 'live' };
}

/** The mock clip, written into the run's work folder. Exported for the ffmpeg integration test. */
export async function mockLipsync(r: LipsyncRequest, ctx: InvokeCtx, spawn?: Spawn): Promise<LipsyncResult> {
  const bin = ffmpegPath;
  if (!bin) throw new PostmakerError(500, 'ffmpeg', 'The bundled ffmpeg is missing.');
  const out = path.join(ctx.workDir, `mock-lipsync-${ctx.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'clip'}.mp4`);
  await fs.mkdir(ctx.workDir, { recursive: true });
  const box = r.mouthBox ?? { x: r.width * 0.4, y: r.height * 0.55, w: r.width * 0.2, h: r.height * 0.05 };
  const sp = spawn ?? ctx.deps.spawn ?? (await import('node:child_process')).spawn;
  await runFfmpeg(sp, bin, mouthBoxArgs({ image: r.imageFile, durationMs: r.durationMs, out, w: r.width, h: r.height, box }), { signal: ctx.signal });
  return { video: await fs.readFile(out), mime: 'video/mp4', durationMs: r.durationMs, requestId: null, mode: 'mock' };
}

const SYNC_COST = { unit: 'second', usdPerUnit: 0.13325, minimumUsd: 0, perCallCeilingUsd: 10, billing: 'vendor-key', verified: false, source: 'https://sync.so/pricing', readAt: READ_AT } as const;
const HEDRA_COST = { unit: 'second', usdPerUnit: null, minimumUsd: 0, perCallCeilingUsd: 5, billing: 'vendor-key', verified: false, source: 'https://www.hedra.com/video-models/hedra-character-3 (credits; memo)', readAt: READ_AT } as const;
const seconds = (r: LipsyncRequest) => Math.max(1, Math.ceil(r.durationMs / 1000));

export const sync: RegisteredConnector<LipsyncRequest, LipsyncResult> = defineConnector<LipsyncRequest, LipsyncResult>({
  id: 'sync',
  title: 'Sync',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'lipsync', models: [SYNC_MODEL], limits: { maxMinutesCreator: 5 }, source: SYNC_SHAPE.source, readAt: READ_AT }],
  costModel: { ...SYNC_COST },
  attendance: 'any',
  settingsGroup: 'sync',
  feature: 'postmakerSync',
  gates: ['vendor:sync'],
  estimate: (r) => estimateCost(SYNC_COST, seconds(r), seconds(r) * 6, `${seconds(r)} s of video`),
  invoke: (r, ctx) => runVendor(r, ctx, { title: 'Sync', submit: buildSyncGenerate(r), pollUrl: (id) => `${SYNC_BASE}/v2/generate/${encodeURIComponent(id)}`, auth: { 'x-api-key': (process.env[SYNC_KEY_ENV] ?? '').trim() }, redact: sync.redact }),
  mock: (r, ctx) => mockLipsync(r, ctx),
});

export const hedra: RegisteredConnector<LipsyncRequest, LipsyncResult> = defineConnector<LipsyncRequest, LipsyncResult>({
  id: 'hedra',
  title: 'Hedra',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'lipsync', models: ['hedra-character-3'], limits: { outputsKeptHours: 48, maxAudioSeconds: 600 }, source: HEDRA_SHAPE.source, readAt: READ_AT }],
  costModel: { ...HEDRA_COST },
  attendance: 'any',
  settingsGroup: 'hedra',
  feature: 'postmakerHedra',
  gates: ['vendor:hedra'],
  estimate: (r) => estimateCost(HEDRA_COST, seconds(r), seconds(r) * 6, `${seconds(r)} s of video`),
  invoke: (r, ctx) => runVendor(r, ctx, { title: 'Hedra', submit: buildHedraGenerate(r), pollUrl: (id) => `${HEDRA_BASE}/v3/generations/${encodeURIComponent(id)}`, auth: { 'x-api-key': (process.env[HEDRA_KEY_ENV] ?? '').trim() }, redact: hedra.redact }),
  mock: (r, ctx) => mockLipsync(r, ctx),
});
