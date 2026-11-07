// "A connection blocks a post within 24 h" (Today › Needs you): a post that is meant to go out automatically within
// the next 24 hours, while the connection that would send it is not ready. Pure: the content route passes the posts,
// the posting path it found and the time; Today shows one row per blocking connection (Needs you keeps ≤ 5 rows).
// Nothing here sends, schedules or checks anything with a provider.

/** How far ahead a planned post counts as blocked. */
export const BLOCK_WINDOW_MS = 24 * 3600_000;

/** The connection automatic posting would use for this project, and whether it is ready. Null: nothing posts automatically. */
export interface PostingPath {
  /** The Connections service id (the deep link `?tab=connections&service=<id>`). */
  service: string;
  ready: boolean;
}

/** One blocking connection, with the first post it blocks and how many it blocks within the window. */
export interface ConnectionBlock {
  service: string;
  postId: string;
  plannedFor: string;
  count: number;
}

/** Posts still waiting to go out: to approve or approved, planned, not scheduled, sent or posted. */
const WAITING = new Set(['ready', 'approved']);

export function connectionBlocks(
  posts: { id: string; status: string; plannedFor: string | null; scheduled?: unknown; posted?: unknown; dispatch?: unknown }[],
  path: PostingPath | null,
  now = Date.now(),
): ConnectionBlock[] {
  if (!path || path.ready) return [];
  const due = posts
    .filter((p) => WAITING.has(p.status) && p.plannedFor && !p.scheduled && !p.posted && !p.dispatch)
    .map((p) => ({ p, at: Date.parse(p.plannedFor!) }))
    .filter(({ at }) => Number.isFinite(at) && at > now && at <= now + BLOCK_WINDOW_MS)
    .sort((a, b) => a.at - b.at || a.p.id.localeCompare(b.p.id));
  if (!due.length) return [];
  const first = due[0]!.p;
  return [{ service: path.service, postId: first.id, plannedFor: first.plannedFor!, count: due.length }];
}

/**
 * The posting path of a project from what the content route already knows: Instagram's own API when it is live
 * (then nothing is blocked by Upload-Post); otherwise Upload-Post, but only while the account's posting settings allow
 * automatic posting (posting off or "post by hand" needs no connection, so nothing is blocked).
 */
export function postingPath(o: { metaLive: boolean; automatic: boolean; uploadPostKey: boolean; uploadPostProfile: boolean }): PostingPath | null {
  if (o.metaLive || !o.automatic) return null;
  return { service: 'upload-post', ready: o.uploadPostKey && o.uploadPostProfile };
}
