// Request checks for the session and Studio API route handlers.
import { loginMode } from './auth';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  method: string;
  url: string;
  headers: Headers;
  /** SIGNAL_WEB_ORIGIN, when set, is the only accepted origin. */
  allowedOrigin?: string | null;
  /**
   * Without SIGNAL_WEB_ORIGIN the accepted origin comes from the request's own Host, which a
   * DNS-rebinding page controls. With this on, only loopback origins (localhost, 127.0.0.0/8, [::1])
   * and SIGNAL_DEV_HOST are accepted. Defaults to on in the password-less
   * local mode (SIGNAL_LOCAL_ONLY_NO_PASSWORD=1 without SIGNAL_OWNER_PASSWORD).
   */
  loopbackOnly?: boolean;
}

/** localhost, *.localhost, 127.0.0.0/8, [::1], or the local HTTPS alias in SIGNAL_DEV_HOST. Exported for tests. */
export function isLoopbackOrigin(origin: string, devHost = process.env.SIGNAL_DEV_HOST): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const alias = (devHost ?? '').trim().toLowerCase();
  return Boolean(alias) && host === alias;
}

export type OriginCheckResult = { ok: true } | { ok: false; reason: string };

function forwardedOrigin(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host') || headers.get('host');
  if (!host) return null;
  const proto = (headers.get('x-forwarded-proto') || '').split(',')[0]?.trim() || 'http';
  return `${proto}://${host.split(',')[0]!.trim()}`;
}

/**
 * Rejects cross-site mutating requests (CSRF defence in depth on top of SameSite=Lax).
 * A mutating request must come from our own origin: Sec-Fetch-Site must be
 * same-origin when present, and Origin must match when present. If neither
 * header is present the request is rejected (browsers always send one of them).
 */
export function checkSameOrigin(input: OriginCheckInput): OriginCheckResult {
  const method = input.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };
  const site = input.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return { ok: false, reason: `Sec-Fetch-Site is ${site}` };
  const origin = input.headers.get('origin');
  if (!origin) {
    return site === 'same-origin' ? { ok: true } : { ok: false, reason: 'Missing Origin header' };
  }
  const allowed = new Set<string>();
  if (input.allowedOrigin) {
    allowed.add(input.allowedOrigin.replace(/\/+$/, ''));
  } else {
    try {
      allowed.add(new URL(input.url).origin);
    } catch {
      /* ignore */
    }
    const fwd = forwardedOrigin(input.headers);
    if (fwd) allowed.add(fwd);
    if (input.loopbackOnly ?? loginMode().mode === 'open') {
      for (const o of [...allowed]) if (!isLoopbackOrigin(o)) allowed.delete(o);
    }
  }
  if (allowed.has(origin)) return { ok: true };
  return { ok: false, reason: `Origin ${origin} is not allowed` };
}

/** A file or package name used in a path must be plain and non-traversing. */
export function isSafeSegment(seg: string): boolean {
  return seg.length > 0 && seg.length <= 256 && seg !== '.' && seg !== '..' && !/[\\/\u0000-\u001f]/.test(seg);
}

export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, details: {} } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
