// Server-only: single-shot Upload-Post dispatch for an approved package.
//
// Rules:
// - Only when posting is switched on for the account (accounts.json) and its limits allow it;
//   the API key stays in process.env and is never logged or returned.
// - The approved bytes are re-verified, then dispatch.json is claimed with 'wx', so one approval
//   can be sent at most once, even with double clicks or concurrent requests.
// - Timeouts, network errors, 5xx and 409 are 'uncertain': nothing is ever re-sent automatically.
//   You reconcile with the provider status or by checking Instagram.
// - The Instagram AI label is always requested (is_ai_generated=true); you confirm it is
//   visible before the next package can be approved.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  ContentError,
  assertDayCapacity,
  currentLimits,
  isInstagramPostUrl,
  listPackages,
  loadPackage,
  pkgPath,
  writeJsonExclusive,
  writeJsonReplace,
  type Dispatch,
  type Outcome,
  type PackageView,
  type Posted,
} from './content';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { currentProject } from './projects';
import { publishingPaused } from './safety';

export const UPLOAD_POST_BASE = 'https://api.upload-post.com';
type Fetch = typeof fetch;

export interface LiveState { enabled: boolean; reason: string; provider: 'upload-post' | 'meta' }

export async function liveState(now = Date.now()): Promise<LiveState> {
  const off = (reason: string): LiveState => ({ enabled: false, reason, provider: 'upload-post' });
  const lim = await currentLimits(now);
  if (!lim.open) return off(lim.reason);
  if (!lim.dispatch) return off(`Automatic posting is off for ${currentProject().handle}. Post by hand.`);
  const pause = publishingPaused();
  if (pause.paused) return off(pause.reason);
  if (!process.env.UPLOAD_POST_API_KEY) return off('Add your Upload-Post API key in Connections (Upload-Post → Manage).');
  if (!currentProject().uploadPostProfile) return off('This project has no Upload-Post profile.');
  return { enabled: true, reason: `Approve posts here; the dashboard sends each approved package once to ${currentProject().handle}.`, provider: 'upload-post' };
}

/** Removes anything that could carry the key from a provider message. */
export function redact(text: string): string {
  const key = process.env.UPLOAD_POST_API_KEY;
  let t = String(text ?? '');
  if (key) t = t.split(key).join('[redacted]');
  return t.replace(/(Apikey|Bearer)\s+[A-Za-z0-9._\-]+/gi, '$1 [redacted]').replace(/\s+/g, ' ').slice(0, 240);
}

async function setOutcome(id: string, o: Outcome): Promise<void> {
  await writeJsonReplace(pkgPath(id, 'outcome.json'), o);
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };

export async function dispatchPackage(id: string, by: string, deps: { fetch?: Fetch; now?: number; scheduleFor?: string } = {}): Promise<PackageView> {
  const now = deps.now ?? Date.now();
  const doFetch = deps.fetch ?? fetch;
  const live = await liveState(now);
  if (!live.enabled) throw new ContentError(403, live.reason);

  const pkg = await loadPackage(id);
  if (pkg.status !== 'approved' || !pkg.approval) throw new ContentError(409, pkg.problems[0] ?? `Post ${id} must be approved (and unchanged) before it can be sent.`);
  const all = await listPackages();
  const unclear = all.filter((p) => p.id !== id && p.status === 'uncertain');
  if (unclear.length) throw new ContentError(409, `Post ${unclear[0]!.id} has an unclear result. Resolve it first.`);
  const lim = await currentLimits(now);
  const at = deps.scheduleFor ? Date.parse(deps.scheduleFor) : now;
  if (deps.scheduleFor) {
    const sched = await schedulingAllowed();
    if (!sched.enabled) throw new ContentError(403, sched.reason);
    if (!(at > now + 10 * 60_000)) throw new ContentError(400, 'Pick a time at least 10 minutes from now to schedule.');
    if (at > now + 365 * 86_400_000) throw new ContentError(400, 'Upload-Post schedules up to 365 days ahead.');
  }
  assertDayCapacity(all, at, lim, id);

  // Re-read the exact bytes we are about to send and compare with the approval.
  // Sent media: slides or the video. A cover image is for preview only and is not uploaded.
  const media = pkg.files.filter((f) => f.role === 'slide' || f.role === 'video');
  const buffers: { name: string; body: Buffer }[] = [];
  for (const f of pkg.files) {
    const body = await fs.readFile(/* turbopackIgnore: true */ pkgPath(id, f.name));
    if (createHash('sha256').update(body).digest('hex') !== pkg.approval.hashes[f.name]) throw new ContentError(409, `${f.name} changed after approval. Make a new package.`);
    if (f.role === 'slide' || f.role === 'video') buffers.push({ name: f.name, body });
  }
  const caption = pkg.caption.trim();
  if (!caption || caption.length > 2200) throw new ContentError(400, 'The caption must be 1–2200 characters.');
  const isReel = pkg.format === 'reel';
  if (isReel ? media.length !== 1 || media[0]!.role !== 'video' : media.some((f) => f.role === 'video') || media.length < 1 || media.length > 10)
    throw new ContentError(400, 'This package format is not supported for automatic posting.');

  const requestId = `signal-${currentProject().id}-${id}-${randomUUID()}`;
  const claim: Dispatch = { request_id: requestId, idempotency_key: requestId, claimed_at: new Date(now).toISOString(), claimed_by: by, provider: 'upload-post', hashes: pkg.approval.hashes };
  await writeJsonExclusive(pkgPath(id, 'dispatch.json'), claim); // single use: a second click fails here

  const form = new FormData();
  form.append('user', currentProject().uploadPostProfile);
  form.append('platform[]', 'instagram');
  form.append('title', caption);
  form.append('is_ai_generated', 'true');
  form.append('request_id', requestId);
  form.append('external_id', `signal-${currentProject().id}-${id}`);
  if (deps.scheduleFor) form.append('scheduled_date', new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  else form.append('async_upload', 'true');
  for (const b of buffers) {
    const ext = b.name.split('.').pop()!.toLowerCase();
    form.append(isReel ? 'video' : 'photos[]', new Blob([new Uint8Array(b.body)], { type: MIME[ext] ?? 'application/octet-stream' }), b.name);
  }
  if (isReel) form.append('media_type', 'REELS');

  let res: Response;
  try {
    res = await doFetch(`${UPLOAD_POST_BASE}/api/${isReel ? 'upload' : 'upload_photos'}`, {
      method: 'POST',
      headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, 'Idempotency-Key': requestId, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(60_000),
      cache: 'no-store',
    });
  } catch {
    await setOutcome(id, { state: 'uncertain', at: new Date().toISOString(), message: 'No answer from Upload-Post (timeout or network). It may still post. Do not re-send; check status.' });
    return loadPackage(id);
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; error?: string; request_id?: string; job_id?: string } | null;
  if (deps.scheduleFor) {
    if ((res.status === 202 || res.ok) && body?.job_id) {
      await writeJsonExclusive(pkgPath(id, 'scheduled.json'), { job_id: String(body.job_id), scheduled_for: new Date(at).toISOString(), scheduled_by: by });
      await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: new Date(at).toISOString(), planned_by: by, planned_at: new Date(now).toISOString() });
      await setOutcome(id, { state: 'scheduled', at: new Date().toISOString(), message: 'Scheduled on Upload-Post. It posts at the planned time, even if your machine is off.' });
      return loadPackage(id);
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 409) {
      // A definite rejection: nothing was scheduled, so the approval can be used again.
      await releaseClaim(id, now);
      throw new ContentError(res.status, `Upload-Post did not schedule it (HTTP ${res.status}): ${redact(body?.message ?? body?.error ?? '')}`);
    }
    await setOutcome(id, { state: 'uncertain', at: new Date().toISOString(), message: `Upload-Post answered unclearly (HTTP ${res.status}). It may be scheduled; check Upload-Post's schedule before doing anything else.` });
    return loadPackage(id);
  }
  if (res.ok && body?.success) {
    await setOutcome(id, { state: 'submitted', at: new Date().toISOString(), message: 'Upload-Post accepted the post and is publishing it.' });
  } else if (res.status >= 500 || res.status === 409 || res.status === 408 || (res.ok && !body?.success)) {
    await setOutcome(id, { state: 'uncertain', at: new Date().toISOString(), message: `Upload-Post answered unclearly (HTTP ${res.status}). Do not re-send; check status.` });
  } else {
    await setOutcome(id, { state: 'failed', at: new Date().toISOString(), message: `Upload-Post rejected the post (HTTP ${res.status}): ${redact(body?.message ?? body?.error ?? '')}` });
  }
  return loadPackage(id);
}

function findUrl(v: unknown): string | null {
  // Upload-Post returns the post URL in results/history rows (url or post_url). Search defensively.
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = findUrl(x);
      if (u) return u;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  for (const k of ['post_url', 'url']) if (typeof o[k] === 'string' && /instagram\.com\//.test(o[k] as string)) return o[k] as string;
  for (const val of Object.values(o)) {
    const u = findUrl(val);
    if (u) return u;
  }
  return null;
}

async function getJson(doFetch: Fetch, url: string): Promise<{ status: number; body: unknown }> {
  const r = await doFetch(url, { headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Reads the provider status for a sent package. Never re-sends. */
export async function checkDispatch(id: string, by: string, deps: { fetch?: Fetch; now?: number } = {}): Promise<PackageView> {
  const doFetch = deps.fetch ?? fetch;
  const pkg = await loadPackage(id);
  if (!pkg.dispatch || !['sending', 'submitted', 'uncertain', 'failed', 'scheduled'].includes(pkg.status)) throw new ContentError(409, `Post ${id} has nothing to check.`);
  const wasFailed = pkg.status === 'failed';
  if (!process.env.UPLOAD_POST_API_KEY) throw new ContentError(403, 'Add your Upload-Post API key in Connections (Upload-Post → Manage).');
  const rid = encodeURIComponent(pkg.dispatch.request_id);
  let st: { status: number; body: unknown };
  try {
    st = await getJson(doFetch, pkg.scheduled ? `${UPLOAD_POST_BASE}/api/uploadposts/status?job_id=${encodeURIComponent(pkg.scheduled.job_id)}` : `${UPLOAD_POST_BASE}/api/uploadposts/status?request_id=${rid}`);
  } catch {
    throw new ContentError(502, 'Upload-Post did not answer. Try again in a minute.');
  }
  const b = (st.body ?? {}) as { status?: string; results?: { platform?: string; success?: boolean; message?: string; status?: string }[] };
  const seen = redact(`provider status=${b.status ?? st.status}; instagram=${JSON.stringify((b.results ?? []).find((r) => r.platform === 'instagram') ?? null)}`);
  if (pkg.status === 'scheduled' && (b.status === 'pending' || b.status === 'queued')) return pkg; // Not due yet.
  if (st.status === 404 || b.status === 'not_found') {
    if (pkg.status === 'uncertain' || wasFailed || pkg.status === 'scheduled') return pkg; // Unknown to the provider: stays paused until you resolve it.
    await setOutcome(id, { state: 'uncertain', at: new Date().toISOString(), message: 'Upload-Post does not know this request yet. Check again, or check Instagram.' });
    return loadPackage(id);
  }
  const ig = (b.results ?? []).find((r) => r.platform === 'instagram');
  if (b.status === 'completed' && ig?.success) {
    let url = findUrl(b);
    if (!url) {
      try {
        url = findUrl((await getJson(doFetch, `${UPLOAD_POST_BASE}/api/uploadposts/history?request_id=${rid}`)).body);
      } catch {
        url = null;
      }
    }
    const posted: Posted = { url: url && isInstagramPostUrl(url) ? url : null, posted_at: new Date(deps.now ?? Date.now()).toISOString(), ai_label_confirmed: false, recorded_by: by, via: 'upload-post', request_id: pkg.dispatch.request_id };
    await writeJsonExclusive(pkgPath(id, 'posted.json'), posted);
    return loadPackage(id);
  }
  // Only terminal provider states count as failure; success:false alone can mean "still processing".
  if (b.status === 'failed' || ig?.status === 'failed' || ig?.status === 'skipped') {
    if (!wasFailed) await setOutcome(id, { state: 'failed', at: new Date().toISOString(), message: `Instagram did not publish it: ${redact(ig?.message ?? 'no reason given')} (${seen})` });
    return loadPackage(id);
  }
  if (wasFailed) {
    // A status check had marked it failed while it may still be publishing: back to uncertain, never re-sent.
    await setOutcome(id, { state: 'uncertain', at: new Date().toISOString(), message: `Still processing at Upload-Post (${seen}). Check again in a minute, or check Instagram.` });
    return loadPackage(id);
  }
  if (pkg.status === 'sending' || pkg.status === 'scheduled') await setOutcome(id, { state: 'submitted', at: new Date().toISOString(), message: 'Upload-Post is publishing it.' });
  return loadPackage(id);
}

/** You resolve an uncertain package after checking Instagram. */
export async function resolveUncertain(id: string, by: string, answer: { posted: true; url: string } | { posted: false }, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  // A real Instagram link is evidence: it can resolve uncertain, submitted or failed-after-send packages.
  if (!['uncertain', 'submitted', 'failed'].includes(pkg.status) || !pkg.dispatch) throw new ContentError(409, `Post ${id} is not waiting for a decision.`);
  if (!answer.posted && pkg.status === 'failed') throw new ContentError(409, 'Already marked as not posted.');
  if (answer.posted) {
    if (!isInstagramPostUrl(answer.url)) throw new ContentError(400, 'Paste the Instagram post link, like https://www.instagram.com/p/…');
    await writeJsonExclusive(pkgPath(id, 'posted.json'), { url: answer.url.trim(), posted_at: new Date(now).toISOString(), ai_label_confirmed: false, recorded_by: by, via: pkg.dispatch?.provider ?? 'upload-post', request_id: pkg.dispatch?.request_id } satisfies Posted);
  } else {
    if (pkg.status !== 'uncertain') throw new ContentError(409, 'Only an uncertain post can be marked as not posted.');
    await setOutcome(id, { state: 'failed', at: new Date(now).toISOString(), message: 'Checked on Instagram: not posted. A replacement needs a new package and approval.', resolved_by: by });
  }
  return loadPackage(id);
}

// ---- scheduling on Upload-Post ------------------------------------------------------------------
export async function schedulingAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('uploadPostScheduling'))) return { enabled: false, reason: featureOffReason('uploadPostScheduling') };
  return { enabled: true, reason: '' };
}

/** Frees a single-use claim after a definite rejection or a cancelled schedule (files are renamed, never deleted). */
async function releaseClaim(id: string, now: number): Promise<void> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (const f of ['dispatch.json', 'outcome.json', 'scheduled.json']) {
    try {
      await fs.rename(pkgPath(id, f), pkgPath(id, `${f.replace('.json', '')}-released-${stamp}.json`));
    } catch {
      /* not present */
    }
  }
}

async function upSchedule(doFetch: Fetch, method: 'DELETE' | 'PATCH', jobId: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const r = await doFetch(`${UPLOAD_POST_BASE}/api/uploadposts/schedule/${encodeURIComponent(jobId)}`, {
    method,
    headers: { Authorization: `Apikey ${process.env.UPLOAD_POST_API_KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Cancels a scheduled post on Upload-Post; the package goes back to Approved. */
export async function cancelSchedule(id: string, by: string, deps: { fetch?: Fetch; now?: number } = {}): Promise<PackageView> {
  const now = deps.now ?? Date.now();
  const pkg = await loadPackage(id);
  if (pkg.status !== 'scheduled' || !pkg.scheduled) throw new ContentError(409, `Post ${id} is not scheduled.`);
  let r: { status: number; json: Record<string, unknown> | null };
  try {
    r = await upSchedule(deps.fetch ?? fetch, 'DELETE', pkg.scheduled.job_id);
  } catch {
    throw new ContentError(502, 'Upload-Post did not answer. Nothing changed; try again.');
  }
  if (r.status === 404) throw new ContentError(409, 'Upload-Post no longer has this schedule (it may have posted already). Press Check status.');
  if (!(r.status >= 200 && r.status < 300)) throw new ContentError(r.status, `Upload-Post could not cancel it (HTTP ${r.status}): ${redact(String(r.json?.error ?? r.json?.message ?? ''))}`);
  await releaseClaim(id, now);
  await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: pkg.scheduled.scheduled_for, planned_by: by, planned_at: new Date(now).toISOString(), cancelled_schedule: true });
  return loadPackage(id);
}

/** Moves a scheduled post to a new time on Upload-Post. */
export async function reschedule(id: string, iso: string, by: string, deps: { fetch?: Fetch; now?: number } = {}): Promise<PackageView> {
  const now = deps.now ?? Date.now();
  const pkg = await loadPackage(id);
  if (pkg.status !== 'scheduled' || !pkg.scheduled) throw new ContentError(409, `Post ${id} is not scheduled.`);
  const at = Date.parse(iso);
  if (!(at > now + 10 * 60_000)) throw new ContentError(400, 'Pick a time at least 10 minutes from now.');
  const sched = await schedulingAllowed();
  if (!sched.enabled) throw new ContentError(403, sched.reason);
  const lim = await currentLimits(now);
  assertDayCapacity(await listPackages(), at, lim, id);
  const when = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let r: { status: number; json: Record<string, unknown> | null };
  try {
    r = await upSchedule(deps.fetch ?? fetch, 'PATCH', pkg.scheduled.job_id, { scheduled_date: when });
  } catch {
    throw new ContentError(502, 'Upload-Post did not answer. The old time still stands; try again.');
  }
  if (r.status === 409) throw new ContentError(409, 'It is publishing now or due within a minute, so it can’t be moved.');
  if (!(r.status >= 200 && r.status < 300)) throw new ContentError(r.status, `Upload-Post could not move it (HTTP ${r.status}).`);
  await writeJsonReplace(pkgPath(id, 'scheduled.json'), { ...pkg.scheduled, scheduled_for: new Date(at).toISOString(), moved_by: by, moved_at: new Date(now).toISOString() });
  await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: new Date(at).toISOString(), planned_by: by, planned_at: new Date(now).toISOString() });
  return loadPackage(id);
}
