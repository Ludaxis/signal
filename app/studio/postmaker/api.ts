'use client';
// Client for the Post maker routes: home, recipe view, run view (polling), every action through one
// POST, reference uploads (video goes as the raw body, streamed; never a form) and media URLs. The server is the
// authority for every rule; errors keep its short message and machine reason.
import type { PostmakerHome } from '@/lib/studio/postmaker/service';
import type { PostmakerAction, Recipe, RecipeOnlyView, RecipeView, Reference, RunView } from '@/lib/studio/postmaker/types';
import type { PlannedSlot } from './model';

export class PmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly reason: string | null,
  ) {
    super(message);
  }
}

type ErrorBody = { error?: { code?: string; message?: string; details?: { reason?: string } } };

async function read<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => ({}))) as T & ErrorBody;
  if (!r.ok) throw new PmError(j.error?.message ?? 'Something went wrong. Try again.', r.status, j.error?.code ?? 'error', j.error?.details?.reason ?? null);
  return j;
}

const q = (pid: string) => `project=${encodeURIComponent(pid)}`;
const get = async <T>(url: string): Promise<T> => read<T>(await fetch(url, { cache: 'no-store' }));

export type { PostmakerHome };
/** The distributive Omit, so each action keeps its own fields. */
export type ActionBody = PostmakerAction extends infer A ? (A extends PostmakerAction ? A : never) : never;

export const pmApi = {
  home: (pid: string) => get<PostmakerHome>(`/api/studio/postmaker?${q(pid)}`),
  recipe: (pid: string, id: string) => get<RecipeView>(`/api/studio/postmaker/recipes/${encodeURIComponent(id)}?${q(pid)}`),
  recipeOnly: (pid: string, id: string) => get<RecipeOnlyView>(`/api/studio/postmaker/recipes/${encodeURIComponent(id)}?${q(pid)}&only=recipe`),
  run: (pid: string, id: string, since = 0) => get<RunView>(`/api/studio/postmaker/runs/${encodeURIComponent(id)}?${q(pid)}&since=${since}`),
  async action<T = Record<string, unknown>>(pid: string, body: ActionBody): Promise<T> {
    return read<T>(await fetch('/api/studio/postmaker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: pid, ...body }) }));
  },
  /** A dropped file: the file itself is the body (the route streams it to disk and reads its type from its bytes). */
  async upload(pid: string, file: Blob): Promise<Reference> {
    const r = await fetch(`/api/studio/postmaker/references?${q(pid)}&rights=third-party-structure-only`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    return (await read<{ reference: Reference }>(r)).reference;
  },
  async link(pid: string, url: string): Promise<Reference> {
    const r = await fetch('/api/studio/postmaker/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: pid, url }) });
    return (await read<{ reference: Reference }>(r)).reference;
  },
  mediaUrl: (pid: string, recipeId: string, sha: string) => `/api/studio/postmaker/media/${encodeURIComponent(recipeId)}/${encodeURIComponent(sha)}?${q(pid)}`,
  async json<T = unknown>(pid: string, recipeId: string, sha: string): Promise<T> {
    return read<T>(await fetch(pmApi.mediaUrl(pid, recipeId, sha), { cache: 'no-store' }));
  },
};

export type MakeItAnswer = { runId?: string; recipeId: string; recipe?: Recipe; status?: string };

// ---- what the Proven screen reads from the other tabs (read-only GETs; the server is the authority) --------

/** The campaigns list as Make a post and the campaign selectors read it: names, status and planned slots. */
export interface CampaignList {
  campaigns: { id: string; name: string; status: string }[];
  plans: Record<string, { slots: PlannedSlot[] } | undefined>;
}

export const studioApi = {
  campaigns: (pid: string) => get<CampaignList>(`/api/studio/campaigns?${q(pid)}`),
  /** Results › By template rows (`template:<id>` keys). */
  results: (pid: string) => get<{ byTemplate?: { key: string; name: string | null; posts: number; avgViews: number | null }[] }>(`/api/studio/results?${q(pid)}`),
  /** Whether repeating by itself (Autopilot and Repeat) and trusted posting are switched on. */
  async automation(pid: string): Promise<{ repeat: boolean; trusted: boolean }> {
    const j = await get<{ switches?: { autopilot?: { enabled?: boolean }; repeat?: { enabled?: boolean }; trustedPublish?: { enabled?: boolean } } }>(`/api/studio/autopilot?${q(pid)}`);
    return { repeat: j.switches?.autopilot?.enabled === true && j.switches?.repeat?.enabled === true, trusted: j.switches?.trustedPublish?.enabled === true };
  },
};
