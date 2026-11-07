// Higgsfield image and b-roll video (broll row; vendor documentation read 2026-11-06; volatile). Reuses the existing client in lib/studio/higgsfield.ts for status polling and downloads (and for Soul
// images); the b-roll submit is Seedance 2.0 image-to-video, whose input image must be a public link and which takes
// an Idempotency-Key (the run's key, so a resume never pays twice). Both need the Studio's `higgsfield` switch;
// b-roll also needs its own switch and accepted terms (it uploads art to a third party). No free endpoint was verified: test() never calls.
import { promises as fs } from 'node:fs';
import { HF_BASE, HF_ENV, higgsfieldClient, HiggsfieldError, type HfAspect, type HfRequest } from '../../higgsfield';
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import { estimateCost, httpsUrl, jsonOf, READ_AT, send, str, type CallShape, type HttpCall, type RegisteredConnector } from './base';
import { defineConnector } from './define';
import { mockCardPng } from './mock/image';
import { kenBurnsArgs, runFfmpeg } from './mock/video';
import ffmpegPath from 'ffmpeg-static';
import path from 'node:path';

export const HF_BROLL_MODEL = 'bytedance/seedance-2.0/image-to-video';
export const HF_BROLL_SHAPE: CallShape = {
  source: 'https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video.md',
  readAt: READ_AT,
  unverified: ['per-model price (estimate endpoint needs a login)', 'the documented "starting" price is Kling 2.6, not Seedance'],
};

export interface HfImageReq {
  prompt: string;
  aspectRatio: HfAspect;
  width: number;
  height: number;
  seed?: number;
}
export interface HfImageRes {
  image: Buffer;
  requestId: string | null;
  mode: 'live' | 'mock';
}

export interface BrollRequest {
  prompt: string;
  /** Local still (the mock pans it); the executor uploads it for a live call. */
  imageFile: string;
  imageUrl?: string;
  durationSec: number;
  resolution?: '480p' | '720p' | '1080p';
  width: number;
  height: number;
}
export interface BrollResult {
  video: Buffer;
  mime: 'video/mp4';
  durationMs: number;
  requestId: string | null;
  mode: 'live' | 'mock';
}

export function buildBrollSubmit(r: BrollRequest, idempotencyKey: string): HttpCall {
  const image = httpsUrl(r.imageUrl);
  if (!image) throw new PostmakerError(400, 'needs_public_url', 'Higgsfield needs a public link for the image.');
  if (!(Number.isInteger(r.durationSec) && r.durationSec >= 4 && r.durationSec <= 15)) throw new PostmakerError(400, 'validation', 'B-roll length must be 4 to 15 seconds.');
  const prompt = r.prompt.trim();
  if (!prompt) throw new PostmakerError(400, 'validation', 'The b-roll prompt is empty.');
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) throw new PostmakerError(400, 'validation', 'Bad idempotency key.');
  return {
    method: 'POST',
    url: `${HF_BASE}/${HF_BROLL_MODEL}`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ image_url: image, prompt, duration: r.durationSec, resolution: r.resolution ?? '720p', generate_audio: false }),
  };
}

/** The documented submit answer `{request_id, status_url, cancel_url, expires_after}`. */
export function parseSubmit(j: Record<string, unknown>): HfRequest {
  const requestId = str(j.request_id).trim();
  if (!/^[A-Za-z0-9_.:-]{4,128}$/.test(requestId)) throw new PostmakerError(502, 'upstream', 'Higgsfield did not return a request id.');
  const sameHost = (u: string | null) => (u && new URL(u).host === new URL(HF_BASE).host ? u : null);
  return {
    requestId,
    statusUrl: sameHost(httpsUrl(j.status_url)) ?? `${HF_BASE}/requests/${encodeURIComponent(requestId)}/status`,
    cancelUrl: sameHost(httpsUrl(j.cancel_url)) ?? `${HF_BASE}/requests/${encodeURIComponent(requestId)}/cancel`,
    model: HF_BROLL_MODEL,
    kind: 'video',
  };
}

const keys = () => ({ id: (process.env[HF_ENV.id] ?? '').trim(), secret: (process.env[HF_ENV.secret] ?? '').trim() });
const asPm = (e: unknown) => (e instanceof HiggsfieldError ? new PostmakerError(e.status >= 400 && e.status < 600 ? e.status : 502, e.kind === 'auth' ? 'vendor_auth' : 'upstream', e.message) : e);

const IMG_COST = { unit: 'image', usdPerUnit: 0.0032, minimumUsd: 0, perCallCeilingUsd: 0.5, billing: 'vendor-key', verified: false, source: 'https://higgsfield.ai/blog/higgsfield-api', readAt: READ_AT, estimateEndpoint: true } as const;
const VID_COST = { unit: 'second', usdPerUnit: 0.07, minimumUsd: 0, perCallCeilingUsd: 3, billing: 'vendor-key', verified: false, source: 'https://higgsfield.ai/blog/higgsfield-api (starting rate; estimate endpoint wins)', readAt: READ_AT, estimateEndpoint: true } as const;

export const higgsfieldImage: RegisteredConnector<HfImageReq, HfImageRes> = defineConnector<HfImageReq, HfImageRes>({
  id: 'higgsfield-image',
  title: 'Higgsfield',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'image.generate', models: ['higgsfield-ai/soul/v2/standard'], source: 'https://docs.higgsfield.ai/docs/models/image-generation.md', readAt: READ_AT }],
  costModel: { ...IMG_COST },
  attendance: 'any',
  settingsGroup: 'higgsfield',
  feature: 'higgsfield',
  gates: ['approval:higgsfield-api'],
  estimate: () => estimateCost(IMG_COST, 1, 60, '1 image'),
  async invoke(r, ctx) {
    try {
      const c = higgsfieldClient({ fetch: ctx.deps.fetch ?? globalThis.fetch, sleep: ctx.deps.sleep });
      const req = await c.submitImage({ prompt: r.prompt, aspectRatio: r.aspectRatio, seed: r.seed });
      const done = await c.waitFor(req, { signal: ctx.signal });
      return { image: await c.download(done.url, 'image'), requestId: req.requestId, mode: 'live' };
    } catch (e) {
      throw asPm(e);
    }
  },
  mock: async (r) => ({ image: await mockCardPng(r.prompt, r.width, r.height), requestId: null, mode: 'mock' }),
});

async function mockBroll(r: BrollRequest, ctx: InvokeCtx): Promise<BrollResult> {
  if (!ffmpegPath) throw new PostmakerError(500, 'ffmpeg', 'The bundled ffmpeg is missing.');
  await fs.mkdir(ctx.workDir, { recursive: true });
  const out = path.join(ctx.workDir, `mock-broll-${ctx.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'clip'}.mp4`);
  const durationMs = Math.max(1, r.durationSec) * 1000;
  const sp = ctx.deps.spawn ?? (await import('node:child_process')).spawn;
  await runFfmpeg(sp, ffmpegPath, kenBurnsArgs({ image: r.imageFile, durationMs, out, w: r.width, h: r.height }), { signal: ctx.signal });
  return { video: await fs.readFile(out), mime: 'video/mp4', durationMs, requestId: null, mode: 'mock' };
}

export const higgsfieldVideo: RegisteredConnector<BrollRequest, BrollResult> = defineConnector<BrollRequest, BrollResult>({
  id: 'higgsfield-video',
  title: 'Higgsfield video',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'video.i2v', models: [HF_BROLL_MODEL], limits: { minSec: 4, maxSec: 15, outputsKeptDays: 7 }, source: HF_BROLL_SHAPE.source, readAt: READ_AT }],
  costModel: { ...VID_COST },
  attendance: 'any',
  settingsGroup: 'higgsfield',
  feature: 'postmakerHiggsfieldVideo',
  gates: ['approval:higgsfield-api', 'vendor:higgsfield-video'],
  estimate: (r) => estimateCost(VID_COST, r.durationSec, 180, `${r.durationSec} s of b-roll`),
  async invoke(r, ctx) {
    const call = buildBrollSubmit(r, ctx.idempotencyKey);
    const k = keys();
    const a = await send(ctx.deps.fetch ?? globalThis.fetch, call, { Authorization: `Key ${k.id}:${k.secret}` }, { title: 'Higgsfield', redact: higgsfieldVideo.redact, signal: ctx.signal });
    const req = parseSubmit(jsonOf(a, 'Higgsfield'));
    ctx.onEvent({ kind: 'vendor', text: `Higgsfield job ${req.requestId} started.` });
    try {
      const c = higgsfieldClient({ fetch: ctx.deps.fetch ?? globalThis.fetch, sleep: ctx.deps.sleep });
      const done = await c.waitFor(req, { signal: ctx.signal });
      return { video: await c.download(done.url, 'video'), mime: 'video/mp4', durationMs: r.durationSec * 1000, requestId: req.requestId, mode: 'live' };
    } catch (e) {
      throw asPm(e);
    }
  },
  mock: (r, ctx) => mockBroll(r, ctx),
});
