// Server-only: posting through Instagram's own API and Signal's own scheduler.
//
// Same rules as the Upload-Post path (dispatch.ts):
// - Only an approved package whose bytes still match the approval; dispatch.json is claimed once ('wx').
// - Media go to the owner's R2 bucket for Meta to download, then are deleted.
// - Creating containers never publishes. Only media_publish does; an unclear answer there is
//   "uncertain" and is never retried. Status checks read Instagram and never re-send.
// - The AI label is always set (is_ai_generated=true); the owner still confirms it after posting.
// - Signal schedules (provider 'signal') are sent by the scheduler tick while the dashboard runs.
//   A time that passed while Signal was off becomes "missed": the owner decides.
//   A Signal schedule is only accepted when this process registered the minute timer (instrumentation.ts).
// - The AI-label canary (assertNoUnlabelled) applies to Post now, scheduling and the tick: a due post
//   becomes "missed" with the reason instead of being sent.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  ContentError,
  assertDayCapacity,
  assertNoUnlabelled,
  currentLimits,
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
import { MetaError, containerStatus, createContainer, errorText, getAccount, getMedia, igFeature, instagramApiAllowed, listMedia, publishContainer, publishingQuota, schedulerAllowed, shortcode } from './meta';
import { MediaHostError, hostFiles, r2Config, removeFiles } from './r2';
import { currentProject, listProjects, withProject } from './projects';
import { publishingPaused } from './safety';
import { notePackageChange } from './memory/hooks';

type Fetch = typeof fetch;
export interface MetaDeps { fetch?: Fetch; now?: number; sleep?: (ms: number) => Promise<void>; pollMs?: number; pollTries?: number }
interface MetaState { ig_user_id: string; container_id: string; children: string[]; hosted: string[]; created_at: string; media_id?: string }

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

/** True when instrumentation.ts registered the minute scheduler in this process. */
export function schedulerTimerRegistered(): boolean {
  return (globalThis as typeof globalThis & { __signalSchedulerRegistered?: boolean }).__signalSchedulerRegistered === true;
}

/** Instagram API posting is ready for the current project. */
export async function metaLive(now = Date.now()): Promise<{ enabled: boolean; reason: string }> {
  const lim = await currentLimits(now);
  if (!lim.open) return { enabled: false, reason: lim.reason };
  if (!lim.dispatch) return { enabled: false, reason: `Automatic posting is off for ${currentProject().handle}. Post by hand.` };
  const pause = publishingPaused();
  if (pause.paused) return { enabled: false, reason: pause.reason };
  const api = await igFeature('publish');
  if (!api.enabled) return api;
  const r2 = r2Config();
  if (!r2.ok) return { enabled: false, reason: r2.reason };
  return { enabled: true, reason: `Posting through Instagram's own API to ${currentProject().handle}.` };
}

async function setOutcome(id: string, o: Outcome): Promise<void> {
  await writeJsonReplace(pkgPath(id, 'outcome.json'), o);
}
async function readState(id: string): Promise<MetaState | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ pkgPath(id, 'meta.json'), 'utf8')) as MetaState;
  } catch {
    return null;
  }
}
async function release(id: string, now: number, files = ['dispatch.json', 'outcome.json', 'meta.json']): Promise<void> {
  const stamp = iso(now).replace(/[:.]/g, '-');
  for (const f of files) await fs.rename(pkgPath(id, f), pkgPath(id, `${f.replace('.json', '')}-released-${stamp}.json`)).catch(() => undefined);
}

/** Sends an approved package now through Instagram's API. */
export async function publishViaMeta(id: string, by: string, deps: MetaDeps = {}): Promise<PackageView> {
  const now = deps.now ?? Date.now();
  const f = deps.fetch ?? fetch;
  const live = await metaLive(now);
  if (!live.enabled) throw new ContentError(403, live.reason);
  const pkg = await loadPackage(id);
  if (!['approved', 'scheduled'].includes(pkg.status) || !pkg.approval || pkg.dispatch) throw new ContentError(409, pkg.problems[0] ?? `Post ${id} must be approved (and unchanged) before it can be sent.`);
  if (pkg.status === 'scheduled' && pkg.scheduled?.provider !== 'signal') throw new ContentError(409, `Post ${id} is scheduled on Upload-Post. Cancel that first.`);
  const all = await listPackages();
  const unclear = all.find((p) => p.id !== id && p.status === 'uncertain');
  if (unclear) throw new ContentError(409, `Post ${unclear.id} has an unclear result. Resolve it first.`);
  assertNoUnlabelled(all, id);
  assertDayCapacity(all, now, await currentLimits(now), id);

  const media = pkg.files.filter((x) => x.role === 'slide' || x.role === 'video');
  const isReel = pkg.format === 'reel';
  if (isReel ? media.length !== 1 || media[0]!.role !== 'video' : media.length < 1 || media.length > 10) throw new ContentError(400, 'This package format is not supported for automatic posting.');
  const caption = pkg.caption.trim();
  if (!caption || caption.length > 2200) throw new ContentError(400, 'The caption must be 1–2200 characters.');
  const bodies: { name: string; body: Buffer; type: string; role: string }[] = [];
  for (const file of pkg.files) {
    const body = await fs.readFile(/* turbopackIgnore: true */ pkgPath(id, file.name));
    if (createHash('sha256').update(body).digest('hex') !== pkg.approval.hashes[file.name]) throw new ContentError(409, `${file.name} changed after approval. Make a new package.`);
    if (file.role === 'slide' || file.role === 'video') bodies.push({ name: file.name, body, type: MIME[file.name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream', role: file.role });
  }

  let account;
  try {
    account = await getAccount(f);
  } catch (e) {
    throw new ContentError(e instanceof MetaError ? e.status : 502, (e as Error).message);
  }
  const want = currentProject().handle.replace(/^@/, '').toLowerCase();
  if (account.username.toLowerCase() !== want) throw new ContentError(409, `The Instagram token belongs to @${account.username}, not @${want}. Nothing was sent.`);
  const quota = await publishingQuota(account.userId, f).catch(() => null);
  if (quota && quota.used >= quota.total) throw new ContentError(429, `Instagram's daily API limit is used up (${quota.used}/${quota.total}). Try again tomorrow.`);

  const requestId = `signal-${id}-${randomUUID()}`;
  const claim: Dispatch = { request_id: requestId, idempotency_key: requestId, claimed_at: iso(now), claimed_by: by, provider: 'meta', hashes: pkg.approval.hashes };
  await writeJsonExclusive(pkgPath(id, 'dispatch.json'), claim); // single use
  // A Signal schedule is consumed by the claim.
  if (pkg.scheduled?.provider === 'signal') await fs.rename(pkgPath(id, 'scheduled.json'), pkgPath(id, `scheduled-sent-${iso(now).replace(/[:.]/g, '-')}.json`)).catch(() => undefined);

  // Up to here nothing is on Instagram. Hosting or container errors release the claim.
  let hosted: { key: string; url: string }[] = [];
  let state: MetaState;
  try {
    hosted = await hostFiles(`${currentProject().id}/${id}`, bodies, f);
    let containerId: string;
    const children: string[] = [];
    if (isReel) containerId = await createContainer(account.userId, { kind: 'reel', url: hosted[0]!.url, caption, aiLabel: true }, f);
    else if (hosted.length === 1) containerId = await createContainer(account.userId, { kind: 'image', url: hosted[0]!.url, caption, aiLabel: true }, f);
    else {
      for (const [i, h] of hosted.entries()) children.push(await createContainer(account.userId, { kind: bodies[i]!.role === 'video' ? 'video' : 'image', url: h.url, carouselItem: true }, f));
      containerId = await createContainer(account.userId, { kind: 'carousel', children, caption, aiLabel: true }, f);
    }
    state = { ig_user_id: account.userId, container_id: containerId, children, hosted: hosted.map((h) => h.key), created_at: iso(now) };
    await writeJsonReplace(pkgPath(id, 'meta.json'), state);
  } catch (e) {
    await removeFiles(hosted.map((h) => h.key), f);
    await release(id, now);
    if (e instanceof MetaError || e instanceof MediaHostError) throw new ContentError(e.status >= 400 && e.status < 600 ? e.status : 502, `Nothing was posted. ${e.message}`);
    throw e;
  }
  await setOutcome(id, { state: 'submitted', at: iso(Date.now()), message: 'Instagram is processing the media.' });
  return finishPublish(id, by, deps);
}

/** Waits for the container, then publishes it once. Used right after sending and by Check status / the scheduler. */
async function finishPublish(id: string, by: string, deps: MetaDeps): Promise<PackageView> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? wait;
  const st = await readState(id);
  if (!st) throw new ContentError(409, `Post ${id} has no Instagram container.`);
  let status = { state: 'IN_PROGRESS' as string, detail: '' };
  for (let i = 0; i < (deps.pollTries ?? 10); i++) {
    try {
      status = await containerStatus(st.container_id, f);
    } catch {
      status = { state: 'UNKNOWN', detail: 'no answer' };
    }
    if (status.state !== 'IN_PROGRESS' && status.state !== 'UNKNOWN') break;
    await sleep(deps.pollMs ?? 2000);
  }
  if (status.state === 'PUBLISHED') return reconcile(id, by, deps); // published earlier: find the post
  if (status.state === 'ERROR' || status.state === 'EXPIRED') {
    // Nothing was posted: free the approval so the owner can decide (send again or make a new package).
    await removeFiles(st.hosted, f);
    await release(id, deps.now ?? Date.now());
    throw new ContentError(502, `Nothing was posted. Instagram could not process the media (${status.state}${status.detail ? `: ${status.detail}` : ''}).`);
  }
  if (status.state !== 'FINISHED') {
    await setOutcome(id, { state: 'submitted', at: iso(Date.now()), message: 'Instagram is still processing the media. Press Check status in a minute.' });
    return loadPackage(id);
  }
  // The one publishing call. Only a clear answer is acted on. Never while publishing is paused.
  if (publishingPaused().paused) {
    await setOutcome(id, { state: 'submitted', at: iso(Date.now()), message: 'Ready to publish, but publishing is paused (SIGNAL_PUBLISH_PAUSED). Unpause, then press Check status.' });
    return loadPackage(id);
  }
  let res;
  try {
    res = await publishContainer(st.ig_user_id, st.container_id, f);
  } catch {
    await setOutcome(id, { state: 'uncertain', at: iso(Date.now()), message: 'No answer from Instagram while publishing. It may be live. Do not re-send; press Check status.' });
    return loadPackage(id);
  }
  const mediaId = res.json && !res.json.error && res.json.id ? String(res.json.id) : null;
  if (res.status >= 200 && res.status < 300 && mediaId) return recordLive(id, by, st, mediaId, deps);
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 409 && res.status !== 429) {
    // A definite refusal: nothing is live, so the approval can be used again.
    await removeFiles(st.hosted, f);
    await release(id, deps.now ?? Date.now());
    throw new ContentError(res.status, `Nothing was posted. Instagram refused to publish it: ${errorText(res)}`);
  }
  await setOutcome(id, { state: 'uncertain', at: iso(Date.now()), message: `Instagram answered unclearly (${errorText(res)}). Do not re-send; press Check status.` });
  return loadPackage(id);
}

async function recordLive(id: string, by: string, st: MetaState, mediaId: string, deps: MetaDeps): Promise<PackageView> {
  const f = deps.fetch ?? fetch;
  const recordedAt = deps.now ?? Date.now();
  let url: string | null = null;
  let liveAt: string | null = null;
  try {
    const m = await getMedia(mediaId, f);
    url = m.permalink;
    // Instagram's own timestamp is when it went live; a later check must not move it to another day.
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    liveAt = Number.isFinite(t) && t <= recordedAt + 10 * 60_000 ? iso(t) : null;
  } catch {
    url = null;
  }
  await writeJsonReplace(pkgPath(id, 'meta.json'), { ...st, media_id: mediaId });
  const posted: Posted & { recorded_at: string } = { url, posted_at: liveAt ?? iso(recordedAt), recorded_at: iso(recordedAt), ai_label_confirmed: false, recorded_by: by, via: 'meta', media_id: mediaId };
  await writeJsonExclusive(pkgPath(id, 'posted.json'), posted);
  await removeFiles(st.hosted, f);
  return loadPackage(id);
}

/** After an unclear publish: looks for the post on Instagram (caption match after the claim). */
async function reconcile(id: string, by: string, deps: MetaDeps): Promise<PackageView> {
  const f = deps.fetch ?? fetch;
  const pkg = await loadPackage(id);
  const st = await readState(id);
  if (!st || !pkg.dispatch) return pkg;
  const since = Date.parse(pkg.dispatch.claimed_at) - 60_000;
  const list = await listMedia(st.ig_user_id, 15, f);
  const cap = pkg.caption.trim().slice(0, 120);
  const hit = list.find((m) => m.caption.trim().startsWith(cap) && (!m.timestamp || Date.parse(m.timestamp) >= since));
  if (hit) return recordLive(id, by, st, hit.id, deps);
  return pkg;
}

/** Check status for a package sent through Instagram's API. Never re-sends. */
export async function checkMeta(id: string, by: string, deps: MetaDeps = {}): Promise<PackageView> {
  const pkg = await loadPackage(id);
  const st = await readState(id);
  if (!pkg.dispatch || pkg.dispatch.provider !== 'meta' || !st) throw new ContentError(409, `Post ${id} has nothing to check.`);
  if (pkg.status === 'posted') return pkg;
  const api = await instagramApiAllowed();
  if (!api.enabled) throw new ContentError(403, api.reason);
  if (pkg.status === 'submitted' || pkg.status === 'sending') return finishPublish(id, by, { ...deps, pollTries: deps.pollTries ?? 3 });
  // uncertain or failed: read Instagram only.
  let s;
  try {
    s = await containerStatus(st.container_id, deps.fetch ?? fetch);
  } catch (e) {
    throw new ContentError(502, (e as Error).message);
  }
  if (s.state === 'PUBLISHED') {
    const after = await reconcile(id, by, deps);
    if (after.status === 'posted') return after;
    await setOutcome(id, { state: 'uncertain', at: iso(Date.now()), message: 'Instagram says it is published but the post was not found in the latest posts. Paste the link from Instagram.' });
    return loadPackage(id);
  }
  if (pkg.status === 'uncertain' && (s.state === 'FINISHED' || s.state === 'ERROR' || s.state === 'EXPIRED')) {
    // Instagram confirms it was not published. Free the approval so the owner can send it again by hand.
    await removeFiles(st.hosted, deps.fetch ?? fetch);
    await release(id, deps.now ?? Date.now());
    return loadPackage(id);
  }
  return pkg;
}

// ---- Signal's own schedule ---------------------------------------------------------------------
const GRACE_MS = 10 * 60_000;

export async function scheduleInSignal(id: string, when: string, by: string, now = Date.now()): Promise<PackageView> {
  const sched = await schedulerAllowed();
  if (!sched.enabled) throw new ContentError(403, sched.reason);
  if (!schedulerTimerRegistered())
    throw new ContentError(409, "Signal's minute scheduler is not running in this app process, so nothing would send this post at its time. Nothing was scheduled; post it now instead.");
  const live = await metaLive(now);
  if (!live.enabled) throw new ContentError(403, live.reason);
  const pkg = await loadPackage(id);
  if (pkg.status !== 'approved') throw new ContentError(409, `Post ${id} must be approved to be scheduled.`);
  const at = Date.parse(when);
  if (!(at > now + 2 * 60_000)) throw new ContentError(400, 'Pick a time at least 2 minutes from now.');
  const all = await listPackages();
  assertNoUnlabelled(all, id);
  assertDayCapacity(all, at, await currentLimits(now), id);
  await writeJsonExclusive(pkgPath(id, 'scheduled.json'), { job_id: '', scheduled_for: iso(at), provider: 'signal', scheduled_by: by, scheduled_at: iso(now) });
  await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: iso(at), planned_by: by, planned_at: iso(now) });
  return loadPackage(id);
}

export async function moveSignalSchedule(id: string, when: string, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (pkg.status !== 'scheduled' || pkg.scheduled?.provider !== 'signal') throw new ContentError(409, `Post ${id} is not scheduled in Signal.`);
  const pause = publishingPaused();
  if (pause.paused) throw new ContentError(403, pause.reason);
  const at = Date.parse(when);
  if (!(at > now + 2 * 60_000)) throw new ContentError(400, 'Pick a time at least 2 minutes from now.');
  assertDayCapacity(await listPackages(), at, await currentLimits(now), id);
  await writeJsonReplace(pkgPath(id, 'scheduled.json'), { ...pkg.scheduled, scheduled_for: iso(at), moved_by: by, moved_at: iso(now) });
  await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: iso(at), planned_by: by, planned_at: iso(now) });
  return loadPackage(id);
}

export async function cancelSignalSchedule(id: string, by: string, now = Date.now()): Promise<PackageView> {
  const pkg = await loadPackage(id);
  if (pkg.status !== 'scheduled' || pkg.scheduled?.provider !== 'signal') throw new ContentError(409, `Post ${id} is not scheduled in Signal.`);
  await fs.rename(pkgPath(id, 'scheduled.json'), pkgPath(id, `scheduled-cancelled-${iso(now).replace(/[:.]/g, '-')}.json`));
  await writeJsonReplace(pkgPath(id, 'plan.json'), { planned_for: pkg.scheduled.scheduled_for, planned_by: by, planned_at: iso(now) });
  return loadPackage(id);
}

/** One scheduler pass for the current project: sends due posts, marks missed ones, finishes processing ones. */
export async function tickProject(deps: MetaDeps = {}): Promise<{ sent: string[]; missed: string[]; checked: string[]; errors: string[] }> {
  const now = deps.now ?? Date.now();
  const out = { sent: [] as string[], missed: [] as string[], checked: [] as string[], errors: [] as string[] };
  const all = await listPackages();
  for (const p of all) {
    try {
      if (p.status === 'scheduled' && p.scheduled?.provider === 'signal') {
        const due = Date.parse(p.scheduled.scheduled_for);
        if (due > now) continue;
        if (now - due > GRACE_MS) {
          // Missed while Signal was off: never sent late on its own. The owner decides.
          await fs.rename(pkgPath(p.id, 'scheduled.json'), pkgPath(p.id, `scheduled-missed-${iso(now).replace(/[:.]/g, '-')}.json`));
          await writeJsonReplace(pkgPath(p.id, 'plan.json'), { planned_for: p.scheduled.scheduled_for, planned_by: 'signal-scheduler', planned_at: iso(now), missed_at: iso(now) });
          out.missed.push(p.id);
          continue;
        }
        let unlabelled: string | null = null;
        try {
          assertNoUnlabelled(all, p.id);
        } catch (e) {
          unlabelled = (e as Error).message;
        }
        if (unlabelled) {
          // The AI-label canary: a due post is not sent while an earlier post's label is unconfirmed.
          await fs.rename(pkgPath(p.id, 'scheduled.json'), pkgPath(p.id, `scheduled-missed-${iso(now).replace(/[:.]/g, '-')}.json`));
          await writeJsonReplace(pkgPath(p.id, 'plan.json'), { planned_for: p.scheduled.scheduled_for, planned_by: 'signal-scheduler', planned_at: iso(now), missed_at: iso(now), missed_reason: unlabelled.slice(0, 200) });
          out.missed.push(p.id);
          continue;
        }
        const after = await publishViaMeta(p.id, 'signal-scheduler', deps);
        out.sent.push(p.id);
        await notePackageChange(p, after, 'signal-scheduler').catch(() => undefined); // memory never changes a send's outcome
      } else if (p.status === 'submitted' && p.dispatch?.provider === 'meta') {
        const after = await checkMeta(p.id, 'signal-scheduler', { ...deps, pollTries: 1 });
        out.checked.push(p.id);
        await notePackageChange(p, after, 'signal-scheduler').catch(() => undefined);
      }
    } catch (e) {
      out.errors.push(`Post ${p.id}: ${(e as Error).message}`);
      if (p.status === 'scheduled' && p.scheduled?.provider === 'signal') {
        // A refused send (limit, changed files, token) must not repeat every minute: turn it into "missed".
        await fs.rename(pkgPath(p.id, 'scheduled.json'), pkgPath(p.id, `scheduled-missed-${iso(now).replace(/[:.]/g, '-')}.json`)).catch(() => undefined);
        await writeJsonReplace(pkgPath(p.id, 'plan.json'), { planned_for: p.scheduled.scheduled_for, planned_by: 'signal-scheduler', planned_at: iso(now), missed_at: iso(now), missed_reason: (e as Error).message.slice(0, 200) }).catch(() => undefined);
      }
    }
  }
  return out;
}

let running = false;
/** One pass over every project. Safe to call often; overlapping calls are skipped. */
export async function tickAll(deps: MetaDeps = {}): Promise<void> {
  if (running) return;
  if (publishingPaused().paused) return; // no sends and no state changes while paused
  running = true;
  try {
    if (!(await schedulerAllowed()).enabled) return;
    for (const p of await listProjects()) await withProject(p, () => tickProject(deps)).catch(() => undefined);
  } finally {
    running = false;
  }
}

export { shortcode };
