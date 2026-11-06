// Server-only: Higgsfield API client (feature switch `higgsfield`): Soul text-to-image and
// Wan 2.6 image-to-video, used by the 'higgsfield-image' and 'higgsfield-reel' formats.
//
// - Paid per request. Keys live in .env.local as HF_API_KEY_ID / HF_API_KEY_SECRET and
//   are sent only as the Authorization header; they are never logged and are stripped from errors.
// - Allowed only when the "higgsfield" switch is on in signal.config.json AND both keys are set.
// - Submit → poll the status URL → download the result at once (outputs are kept ~7 days).
// Endpoints (docs.higgsfield.ai, checked 2026-11-05):
//   POST /higgsfield-ai/soul/v2/standard   {prompt, aspect_ratio, resolution, batch_size, seed?}
//   POST /wan/v2.6/image-to-video          {prompt, image_url, duration 5|10|15, resolution}
//   → {status:'queued', request_id, status_url, cancel_url, expires_after}
//   GET  <status_url>  (or /requests/{id}/status) → status queued|in_progress|completed|failed|nsfw|canceled
//   POST /requests/{id}/cancel (only while queued)
import { randomUUID } from 'node:crypto';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';

type Fetch = typeof fetch;

export const HF_BASE = 'https://api.higgsfield.ai';
export const HF_ENV = { id: 'HF_API_KEY_ID', secret: 'HF_API_KEY_SECRET' } as const;
export const HF_IMAGE_MODEL = 'higgsfield-ai/soul/v2/standard';
export const HF_VIDEO_MODEL = 'wan/v2.6/image-to-video';

/** Published list price per Soul standard image (docs.higgsfield.ai, 2026-11). */
export const HF_IMAGE_COST_USD = 0.0032;
/** ESTIMATE: Wan 2.6 image-to-video price is not in the reference; a deliberately high placeholder per second of video. */
export const HF_VIDEO_COST_USD_PER_SECOND_ESTIMATE = 0.1;
export const estimateImageCostUsd = (images = 1) => Math.round(images * HF_IMAGE_COST_USD * 10_000) / 10_000;
export const estimateVideoCostUsd = (seconds: number) => Math.round(seconds * HF_VIDEO_COST_USD_PER_SECOND_ESTIMATE * 10_000) / 10_000;

export const HF_IMAGE_TIMEOUT_MS = 6 * 60_000;
export const HF_VIDEO_TIMEOUT_MS = 12 * 60_000;
export const HF_CALL_TIMEOUT_MS = 30_000;
export const HF_DOWNLOAD_TIMEOUT_MS = 120_000;
export const HF_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const POLL: Record<'image' | 'video', { first: number; max: number }> = { image: { first: 2_000, max: 10_000 }, video: { first: 5_000, max: 15_000 } };

export type HfAspect = '9:16' | '16:9' | '4:3' | '3:4' | '1:1' | '2:3' | '3:2';
export type HfImageResolution = '720p' | '1080p';
export type HfVideoResolution = '480p' | '720p' | '1080p';
export type HfDuration = 5 | 10 | 15;
export type HfStatusName = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
export type HfErrorKind = 'gate' | 'auth' | 'http' | 'network' | 'timeout' | 'failed' | 'nsfw' | 'canceled' | 'download' | 'response';

export class HiggsfieldError extends Error {
  constructor(public status: number, message: string, public kind: HfErrorKind = 'http') {
    super(message);
  }
}

export interface HfRequest { requestId: string; statusUrl: string; cancelUrl: string | null; model: string; kind: 'image' | 'video' }
export interface HfStatus { status: HfStatusName | 'unknown'; imageUrls: string[]; videoUrl: string | null; error: string | null }
export interface HfResult { requestId: string; url: string; seconds: number }
export interface HfImageInput { prompt: string; aspectRatio: HfAspect; resolution?: HfImageResolution; enhancePrompt?: boolean; seed?: number }
export interface HfVideoInput { prompt: string; imageUrl: string; duration?: HfDuration; resolution?: HfVideoResolution; promptExtend?: boolean; negativePrompt?: string; seed?: number }

export interface HfClient {
  submitImage(input: HfImageInput): Promise<HfRequest>;
  submitVideo(input: HfVideoInput): Promise<HfRequest>;
  status(req: HfRequest): Promise<HfStatus>;
  /** Polls until the request completes; throws HiggsfieldError on failed / nsfw / canceled / timeout. */
  waitFor(req: HfRequest, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HfResult>;
  cancel(req: HfRequest): Promise<boolean>;
  /** Downloads a result to memory (https only, content-type and size checked). */
  download(url: string, expect: 'image' | 'video'): Promise<Buffer>;
}

const keys = () => ({ id: (process.env[HF_ENV.id] ?? '').trim(), secret: (process.env[HF_ENV.secret] ?? '').trim() });

/** Removes the API key id/secret (and any `Key id:secret` header value) from text that may be shown or stored. */
export function redactHiggsfield(text: string, extra: readonly string[] = []): string {
  let t = String(text ?? '');
  const k = keys();
  for (const v of [k.id, k.secret, ...extra].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) t = t.split(encodeURIComponent(v)).join('[key]').split(v).join('[key]');
  return t.replace(/\bKey\s+[^\s:"']{2,}:[^\s"']{2,}/g, 'Key [key]').replace(/\s+/g, ' ').trim();
}

/** Higgsfield may be used for the current project: the switch is on and both keys present. Never reveals key values. */
export async function higgsfieldAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('higgsfield'))) return { enabled: false, reason: featureOffReason('higgsfield') };
  const k = keys();
  if (!k.id || !k.secret) return { enabled: false, reason: 'Higgsfield API keys are missing. Add them in Connections → Keys.' };
  return { enabled: true, reason: 'Paid per request on your Higgsfield account; used only when you press Generate.' };
}

const sleepDefault = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new HiggsfieldError(499, 'Cancelled.', 'canceled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  try {
    return s && new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};
const sameApi = (u: string) => {
  try {
    return new URL(u).host === new URL(HF_BASE).host;
  } catch {
    return false;
  }
};

/** Reads the result URLs out of a status body; the documented shape is images[].url / video.url, nested shapes are tolerated. */
export function parseStatus(j: Record<string, unknown> | null): HfStatus {
  const nest = (j?.result ?? j?.results ?? j?.data ?? j ?? {}) as Record<string, unknown>;
  const pick = (o: Record<string, unknown>) => ({
    images: (Array.isArray(o.images) ? o.images : []).map((i) => httpsUrl((i as { url?: unknown })?.url)).filter((u): u is string => Boolean(u)),
    video: httpsUrl((o.video as { url?: unknown } | undefined)?.url),
  });
  const a = pick((j ?? {}) as Record<string, unknown>);
  const b = pick(nest);
  const raw = str(j?.status).toLowerCase();
  const status: HfStatus['status'] = (['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'] as const).find((s) => s === raw) ?? (raw === 'cancelled' ? 'canceled' : 'unknown');
  const err = j?.error ?? j?.detail ?? null;
  return { status, imageUrls: a.images.length ? a.images : b.images, videoUrl: a.video ?? b.video, error: err == null ? null : redactHiggsfield(typeof err === 'string' ? err : JSON.stringify(err)).slice(0, 300) };
}

/** A client bound to the keys in the environment. `fetch`, `sleep` and `now` are injectable for tests. */
export function higgsfieldClient(deps: { fetch?: Fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } = {}): HfClient {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;

  function auth(): Record<string, string> {
    const k = keys();
    if (!k.id || !k.secret) throw new HiggsfieldError(403, `Higgsfield API keys are missing (${HF_ENV.id}, ${HF_ENV.secret}).`, 'gate');
    return { Authorization: `Key ${k.id}:${k.secret}` };
  }

  async function call(method: 'GET' | 'POST', url: string, body?: unknown, idempotent = false): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let r: Response;
    try {
      r = await f(url, {
        method,
        headers: { Accept: 'application/json', ...auth(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(idempotent ? { 'Idempotency-Key': randomUUID() } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HF_CALL_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (e) {
      if (e instanceof HiggsfieldError) throw e;
      throw new HiggsfieldError(502, `Higgsfield did not answer (${redactHiggsfield((e as Error)?.name === 'TimeoutError' ? 'timeout' : String((e as Error)?.message ?? e)).slice(0, 120)}).`, 'network');
    }
    const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (r.status === 401 || r.status === 403) throw new HiggsfieldError(r.status, `Higgsfield rejected the API key (${r.status}). Check ${HF_ENV.id} and ${HF_ENV.secret}.`, 'auth');
    if (r.status >= 400) throw new HiggsfieldError(r.status, `Higgsfield answered ${r.status}: ${redactHiggsfield(str(json?.detail) || str(json?.error) || str(json?.message) || 'no detail').slice(0, 200)}`, 'http');
    return { status: r.status, json };
  }

  function toRequest(j: Record<string, unknown> | null, model: string, kind: 'image' | 'video'): HfRequest {
    const requestId = str(j?.request_id).trim();
    if (!/^[A-Za-z0-9_.:-]{4,128}$/.test(requestId)) throw new HiggsfieldError(502, 'Higgsfield did not return a request id.', 'response');
    const statusUrl = httpsUrl(j?.status_url);
    const cancelUrl = httpsUrl(j?.cancel_url);
    return {
      requestId,
      statusUrl: statusUrl && sameApi(statusUrl) ? statusUrl : `${HF_BASE}/requests/${encodeURIComponent(requestId)}/status`,
      cancelUrl: cancelUrl && sameApi(cancelUrl) ? cancelUrl : `${HF_BASE}/requests/${encodeURIComponent(requestId)}/cancel`,
      model,
      kind,
    };
  }

  const client: HfClient = {
    async submitImage(input) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new HiggsfieldError(400, 'The image prompt is empty.', 'http');
      const body = { prompt, aspect_ratio: input.aspectRatio, resolution: input.resolution ?? '1080p', batch_size: 1, ...(input.enhancePrompt !== undefined ? { enhance_prompt: input.enhancePrompt } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}) };
      const { json } = await call('POST', `${HF_BASE}/${HF_IMAGE_MODEL}`, body, true);
      return toRequest(json, HF_IMAGE_MODEL, 'image');
    },
    async submitVideo(input) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new HiggsfieldError(400, 'The video prompt is empty.', 'http');
      if (!httpsUrl(input.imageUrl)) throw new HiggsfieldError(400, 'The start image must be a public https URL.', 'http');
      const body = {
        prompt,
        image_url: input.imageUrl,
        duration: input.duration ?? 5,
        resolution: input.resolution ?? '720p',
        ...(input.promptExtend !== undefined ? { prompt_extend: input.promptExtend } : {}),
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      };
      const { json } = await call('POST', `${HF_BASE}/${HF_VIDEO_MODEL}`, body, true);
      return toRequest(json, HF_VIDEO_MODEL, 'video');
    },
    async status(req) {
      const { json } = await call('GET', req.statusUrl);
      return parseStatus(json);
    },
    async waitFor(req, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? (req.kind === 'video' ? HF_VIDEO_TIMEOUT_MS : HF_IMAGE_TIMEOUT_MS);
      const poll = POLL[req.kind];
      const started = now();
      let wait = poll.first;
      let transient = 0;
      for (;;) {
        if (opts.signal?.aborted) throw new HiggsfieldError(499, 'Cancelled.', 'canceled');
        let s: HfStatus;
        try {
          s = await client.status(req);
          transient = 0;
        } catch (e) {
          // A few network blips while polling are tolerated; auth and client errors are not.
          if (!(e instanceof HiggsfieldError) || e.kind !== 'network' || ++transient > 3) throw e;
          s = { status: 'unknown', imageUrls: [], videoUrl: null, error: null };
        }
        if (s.status === 'completed') {
          const url = req.kind === 'video' ? s.videoUrl : s.imageUrls[0] ?? null;
          if (!url) throw new HiggsfieldError(502, 'Higgsfield finished but returned no result URL.', 'response');
          return { requestId: req.requestId, url, seconds: Math.round((now() - started) / 1000) };
        }
        if (s.status === 'failed') throw new HiggsfieldError(502, `Higgsfield could not make the ${req.kind}${s.error ? `: ${s.error}` : '.'} (not charged)`, 'failed');
        if (s.status === 'nsfw') throw new HiggsfieldError(422, `Higgsfield refused the ${req.kind} prompt as unsafe content. Change the brief.`, 'nsfw');
        if (s.status === 'canceled') throw new HiggsfieldError(409, `The Higgsfield ${req.kind} request was cancelled.`, 'canceled');
        const elapsed = now() - started;
        if (elapsed >= timeoutMs) {
          await client.cancel(req).catch(() => false);
          throw new HiggsfieldError(504, `Higgsfield took longer than ${Math.round(timeoutMs / 60_000)} minutes for the ${req.kind} (request ${req.requestId}).`, 'timeout');
        }
        await sleep(Math.min(wait, timeoutMs - elapsed), opts.signal);
        wait = Math.min(poll.max, Math.round(wait * 1.5));
      }
    },
    async cancel(req) {
      if (!req.cancelUrl) return false;
      try {
        const { status } = await call('POST', req.cancelUrl);
        return status >= 200 && status < 300;
      } catch {
        return false; // only queued requests can be cancelled; anything else is not an error for the caller
      }
    },
    async download(url, expect) {
      if (!httpsUrl(url)) throw new HiggsfieldError(400, 'Result URL is not https.', 'download');
      let r: Response;
      try {
        r = await f(url, { method: 'GET', signal: AbortSignal.timeout(HF_DOWNLOAD_TIMEOUT_MS), cache: 'no-store' });
      } catch (e) {
        throw new HiggsfieldError(502, `Could not download the Higgsfield ${expect} (${redactHiggsfield(String((e as Error)?.message ?? e)).slice(0, 120)}).`, 'download');
      }
      if (!r.ok) throw new HiggsfieldError(502, `Could not download the Higgsfield ${expect} (HTTP ${r.status}).`, 'download');
      const type = (r.headers.get('content-type') ?? '').toLowerCase();
      const okType = expect === 'image' ? /^image\//.test(type) : /^video\/|^application\/octet-stream/.test(type);
      if (!okType) throw new HiggsfieldError(502, `Higgsfield returned ${type || 'an unknown type'} instead of the ${expect}.`, 'download');
      const len = Number(r.headers.get('content-length') ?? 0);
      if (len > HF_DOWNLOAD_MAX_BYTES) throw new HiggsfieldError(502, `The Higgsfield ${expect} is too large (${Math.round(len / 1e6)} MB).`, 'download');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > HF_DOWNLOAD_MAX_BYTES) throw new HiggsfieldError(502, `The Higgsfield ${expect} is too large.`, 'download');
      if (buf.length < 100) throw new HiggsfieldError(502, `The Higgsfield ${expect} is empty.`, 'download');
      return buf;
    },
  };
  return client;
}
