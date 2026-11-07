// Package ids: the folder name of each post package in a project's content folder.
// The one place that knows their shape, used by the server (content, generate, Post maker accept, team tools) and the
// Studio client (Posts, Gallery, Today, Results) alike. Pure: no file system, safe to import in the browser.
//
//   00 … 99        two digits, zero-padded, exactly as every package made before longer ids (unchanged on disk and in URLs)
//   100 … 99999    three to five digits, no leading zero ("100", never "0100")
//
// Anything else ("1", "0100", "123456", "..", "1a", separators) is not a package id, so it can never name a path.

export const PACKAGE_ID_MAX = 99999;
export const PACKAGE_ID_RE = /^(?:\d{2}|[1-9]\d{2,4})$/;
export const PACKAGE_IDS_USED_UP = `Package numbers are used up (${PACKAGE_ID_MAX}).`;

export function packageIdOk(id: unknown): id is string {
  return typeof id === 'string' && PACKAGE_ID_RE.test(id);
}

/** Numeric order ("99" before "100"); anything that is not a package id sorts after the ids, by plain text. */
export function comparePackageIds(a: string, b: string): number {
  const okA = packageIdOk(a);
  const okB = packageIdOk(b);
  if (okA && okB) return Number(a) - Number(b);
  if (okA !== okB) return okA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The id for a package number: at least two digits; null outside 0…99999. */
export function formatPackageId(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > PACKAGE_ID_MAX) return null;
  return String(n).padStart(2, '0');
}

/**
 * The next package id after everything in `names` (folder names; non-ids are ignored) and after `after`: one more
 * than the highest number in use, so a removed package's number is never handed out again. Null when that passes 99999.
 */
export function nextPackageIdAfter(names: Iterable<string>, after = 0): string | null {
  let max = after;
  for (const n of names) if (packageIdOk(n)) max = Math.max(max, Number(n));
  return formatPackageId(max + 1);
}
