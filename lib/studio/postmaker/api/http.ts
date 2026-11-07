// HTTP helpers for the Post maker routes (error codes). Known errors keep their short, user-facing message and
// map to the code set (validation, forbidden, not_found, conflict, contract_break, busy); `details.reason`
// carries the engine's machine code and, for Accept and graph edits, the blockers or issues (node ids and short texts
// only). Anything unexpected, and every 5xx, answers a generic message: the real one can name files, hosts or keys, so
// it stays on the server, and even there only the error class is logged.
import { ContentError } from '../../content';
import { featureEnabled } from '@/lib/server/signalConfig';
import { PostmakerError } from '../errors';

const CODE: Record<number, string> = { 400: 'validation', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'validation', 416: 'validation', 422: 'contract_break', 429: 'busy' };
export const GENERIC_500 = 'Something went wrong on the server. Try again.';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const POSTMAKER_OFF_TEXT = 'Post maker is switched off. Turn it on in Connections to make or change posts.';

/** Actions that only read (the estimate); every other action changes the store or starts work. */
const READ_ACTIONS = new Set(['estimate']);

/**
 * While the `postmaker` feature switch is off, the API refuses every mutating action (403, reason
 * `feature-off`); reads and polling (GET home, recipe, run, media) and the estimate stay open. Null = allowed.
 */
export async function postmakerOffRefusal(action: unknown): Promise<Response | null> {
  if (await featureEnabled('postmaker')) return null;
  if (typeof action === 'string' && READ_ACTIONS.has(action)) return null;
  return pmError(403, 'forbidden', POSTMAKER_OFF_TEXT, { reason: 'feature-off' });
}

export function pmJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } });
}

export function pmError(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return pmJson({ error: { code, message, details } }, status);
}

/** Maps a thrown value to a response; never leaks an unexpected message. */
export function pmFail(e: unknown, tag: string): Response {
  if (e instanceof PostmakerError && e.status < 500) {
    const extra = e as PostmakerError & { blockers?: unknown; issues?: unknown; diff?: unknown };
    const details: Record<string, unknown> = { reason: e.code };
    if (Array.isArray(extra.blockers)) details.blockers = extra.blockers;
    if (Array.isArray(extra.issues)) details.issues = extra.issues;
    if (Array.isArray(extra.diff)) details.diff = extra.diff;
    return pmError(e.status, CODE[e.status] ?? 'validation', e.message, details);
  }
  if (e instanceof ContentError && e.status < 500) return pmError(e.status, CODE[e.status] ?? 'validation', e.message);
  if (e instanceof PostmakerError && e.status === 502) return pmError(502, 'unreachable', 'A service did not answer. Try again.');
  console.error(`[postmaker:${tag}]`, e instanceof Error ? e.name : typeof e);
  return pmError(500, 'internal', GENERIC_500);
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`; null = serve whole; 'bad' = 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad';
  return { start, end };
}
