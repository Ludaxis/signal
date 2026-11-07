// Shared pieces of every Post maker connector: the registered shape, request descriptions that never hold a
// key, one HTTP helper that maps vendor answers to PostmakerError with redacted text, cost estimates from the cost
// model, and the redactor every connector's redact() is built from.
//
// Requests are described first (`HttpCall`, no credential in it) and authorised only at the moment of the call, so the
// fixtures written from the vendors' documentation can be compared byte for byte and can never contain a key.
import { PostmakerError } from '../errors';
import type { Connector, ConnectorEstimate, ConnectorState, CostModel, InvokeCtx } from '../types';

export type Fetch = typeof fetch;
export type Spawn = typeof import('node:child_process').spawn;

/** A connector as the registry holds it: the interface plus what the single decision point needs. */
export interface RegisteredConnector<Req = unknown, Res = unknown> extends Connector<Req, Res> {
  /** Whether the credential this connector needs is present (settings group, saved token, or none needed). */
  keyPresent(): Promise<boolean>;
  /** The environment variable names of its key (the settings group's fields); Connections lists them. */
  keyEnv?: readonly string[];
  /** A binding that may not run live in this release whatever the switches say. */
  blocked?: { state: Extract<ConnectorState, 'not-allowed'>; line: string; reason: string };
  /** Install and sign-in probe used by status() only (CLI `--version`, renderer present). */
  probe?(): Promise<{ installed: boolean; signedIn: boolean | null; version: string | null }>;
}

/** One HTTP request as the vendor documents it, without any credential. */
export interface HttpCall {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** JSON text, or undefined for a GET. */
  body?: string;
}

/** Where a call shape comes from, so a re-verification edits one constant ("volatile"). */
export interface CallShape {
  source: string;
  readAt: string;
  /** Parts of the shape the vendor documentation did not confirm; re-verify before a live run. */
  unverified: string[];
}

export const READ_AT = '2026-11-06';

// ---- redaction -------------------------------------------------------------------------------------------------

const HEADER_RE = /\b(xi-api-key|x-api-key|ocp-apim-subscription-key|authorization|x-figma-token)(["']?\s*[:=]\s*["']?)(?:(?:Key|Bearer|Basic)\s+)?[^\s"',}]+/gi;
const SK_ANT_RE = /sk-ant-[A-Za-z0-9_-]{4,}/g;
const KEY_PAIR_RE = /\bKey\s+[^\s:"']{2,}:[^\s"']{2,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * Builds a redactor that removes the current values of the named environment variables (and their URL-encoded
 * forms), any auth header value, `sk-ant-` tokens, `Key id:secret` pairs and bearer tokens.
 */
export function redactor(envNames: readonly string[], env?: NodeJS.ProcessEnv): (text: string) => string {
  return (text: string) => {
    let s = String(text ?? '');
    const source = env ?? process.env; // read at each call: keys saved after start are redacted too
    const values = envNames
      .map((n) => (source[n] ?? '').trim())
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const v of values) s = s.split(encodeURIComponent(v)).join('[key]').split(v).join('[key]');
    return s.replace(HEADER_RE, '$1$2[key]').replace(SK_ANT_RE, '[key]').replace(KEY_PAIR_RE, 'Key [key]').replace(BEARER_RE, 'Bearer [key]');
  };
}

// ---- cost ------------------------------------------------------------------------------------------------------

const up4 = (n: number) => Math.ceil(n * 10_000 - 1e-9) / 10_000;

/** An estimate from the cost model: a known price gives one number; an unknown price gives minimum…ceiling ("~$?"). */
export function estimateCost(cm: CostModel, units: number, seconds: number, basis: string): ConnectorEstimate {
  if (cm.unit === 'none' || cm.billing === 'none') return { usdLow: 0, usdHigh: 0, seconds, basis };
  if (cm.usdPerUnit === null) return { usdLow: cm.minimumUsd, usdHigh: cm.perCallCeilingUsd, seconds, basis: `${basis}; price unknown, ceiling per call` };
  const usd = up4(Math.max(cm.minimumUsd, Math.max(0, units) * cm.usdPerUnit));
  return { usdLow: usd, usdHigh: usd, seconds, basis };
}

/** The per-call ceiling is a hard stop: a call whose estimate passes it is refused before any request. */
export function assertWithinCeiling(title: string, cm: CostModel, est: ConnectorEstimate): void {
  if (cm.billing === 'none' || cm.perCallCeilingUsd <= 0) return;
  if (est.usdHigh > cm.perCallCeilingUsd + 1e-9) {
    throw new PostmakerError(409, 'over_ceiling', `${title} would cost more than $${cm.perCallCeilingUsd.toFixed(2)} for one call.`);
  }
}

// ---- HTTP ------------------------------------------------------------------------------------------------------

export interface SendOptions {
  title: string;
  redact: (text: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpAnswer {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

/** Sends one authorised call with the injected fetch; vendor errors become PostmakerError with redacted text. */
export async function send(f: Fetch | undefined, call: HttpCall, auth: Record<string, string>, o: SendOptions): Promise<HttpAnswer> {
  if (!f) throw new PostmakerError(500, 'no_fetch', `${o.title} has no network client.`);
  const signals = [o.signal, AbortSignal.timeout(o.timeoutMs ?? 60_000)].filter(Boolean) as AbortSignal[];
  let r: Response;
  try {
    r = await f(call.url, { method: call.method, headers: { ...call.headers, ...auth }, body: call.body, signal: AbortSignal.any(signals), redirect: 'error', cache: 'no-store' });
  } catch (e) {
    throw new PostmakerError(502, 'upstream', `${o.title} did not answer. ${o.redact((e as Error)?.message ?? '')}`.trim());
  }
  const bytes = Buffer.from(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (r.status === 401 || r.status === 403) throw new PostmakerError(401, 'vendor_auth', `${o.title} refused the key.`);
  if (r.status === 429) throw new PostmakerError(429, 'busy', `${o.title} is busy. Try again later.`);
  if (!r.ok) throw new PostmakerError(502, 'upstream', `${o.title} answered HTTP ${r.status}. ${o.redact(bytes.toString('utf8').slice(0, 200))}`.trim());
  return { status: r.status, headers: r.headers, bytes };
}

export function jsonOf(a: HttpAnswer, title: string): Record<string, unknown> {
  try {
    const j = JSON.parse(a.bytes.toString('utf8')) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new PostmakerError(502, 'upstream', `${title} sent an answer Signal cannot read.`);
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  try {
    return s && new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};

/**
 * A vendor's result link that Signal itself downloads: https, a public host name (no IP literal, no localhost or
 * local-network suffix) and no user:password part. Each vendor's own CDN hosts are not verified yet: until
 * they are recorded in its CallShape, this keeps a vendor answer from pointing Signal at this machine or its network.
 */
export const publicHttpsUrl = (v: unknown): string | null => {
  const s = httpsUrl(v);
  if (!s) return null;
  const u = new URL(s);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.username || u.password) return null;
  if (!host.includes('.') || host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host)) return null;
  return s;
};

/** Polls until `check` says the job finished; `sleep` comes from InvokeCtx.deps so tests never wait. */
export async function poll<T>(check: () => Promise<{ done: boolean; value?: T; failed?: string }>, o: { ctx: InvokeCtx; title: string; everyMs: number; maxTries: number }): Promise<T> {
  const sleep = o.ctx.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < o.maxTries; i++) {
    if (o.ctx.signal.aborted) throw new PostmakerError(499, 'cancelled', 'Stopped.');
    const s = await check();
    if (s.failed) throw new PostmakerError(502, 'vendor_failed', `${o.title}: ${s.failed}`);
    if (s.done) return s.value as T;
    await sleep(o.everyMs);
  }
  throw new PostmakerError(504, 'timeout', `${o.title} took too long.`);
}
