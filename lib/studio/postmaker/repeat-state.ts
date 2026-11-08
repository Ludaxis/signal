// Repeat bookkeeping (Repeat templates through the existing runner, with slot de-dup):
// small, file-only helpers the daily run and the backlog count share, with no engine, connector or vendor import.
// - The switch: Repeat runs inside the daily run only when Post maker is on, not paused, and the separate
//   `postmakerRepeat` switch is on (signal.config.json). It is off by default and stays off until you turn it on.
// - The template's own run state: the topic list position, queued ideas and the
//   last result, the same shape a pipeline keeps.
// - The slot ledger (`repeat-slots.json`): every slot a template or a template-making pipeline started a post for,
//   with the fork, its run and its packages. A slot in the ledger is never made again (also after a later migration,
//   which reads it under the old `pl-…` id), whether the post was accepted, is waiting at Proof or was dropped. Only a
//   run that failed or was stopped releases its slot (`releasedAt`), so the next daily run can try it again; the entry
//   stays in the file and the next claim keeps the released fork's id in `earlier`.
// - The backlog: repeat runs waiting at Proof count like posts waiting in Review (BACKLOG_LIMIT).
// Nothing here deletes a file. Generic core: no project names.
import path from 'node:path';
import { featureEnvName, featureOn, postmakerPaused } from './connectors/features';
import { PostmakerError } from './errors';
import { pretty, readJsonFile, writeReplace } from './store/fs';
import { withLock } from './store/mutex';
import { assertTemplateId } from './store/paths';
import { listRunIds, readRun } from './store/runs';

// ---- the switch (off by default) ----------------------------------------------------------------------------------

/** The Repeat switch: `postmakerRepeat` in signal.config.json; this environment variable overrides it. */
export const REPEAT_ENV = featureEnvName('postmakerRepeat');

export const REPEAT_OFF_TEXT = 'Repeat is off. Turn it on in Connections.';

/** Repeat templates make posts in the daily run only when Post maker is on, not paused, and Repeat is switched on. */
export async function repeatAllowed(env: NodeJS.ProcessEnv = process.env): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureOn('postmaker', env))) return { enabled: false, reason: 'Post maker is off.' };
  if (postmakerPaused(env)) return { enabled: false, reason: 'Post maker is paused.' };
  if (!(await featureOn('postmakerRepeat', env))) return { enabled: false, reason: REPEAT_OFF_TEXT };
  return { enabled: true, reason: '' };
}

// ---- the template's own run state -------------------------------------------------------------------------

export interface RepeatIdea {
  topic: string;
  hook?: string;
  prompt?: string;
  headline?: string;
  caption?: string;
  articleUrl?: string;
}
/** The same shape as a pipeline's `<id>.state.json` (PipelineState), so a migration copies it unchanged. */
export interface TemplateRunState {
  listNext: number;
  ideas: RepeatIdea[];
  lastRunAt: string | null;
  lastResult: string | null;
}

export const templateStateFile = (root: string, templateId: string) => path.join(root, 'templates', `${assertTemplateId(templateId)}.state.json`);

export async function readTemplateState(root: string, templateId: string): Promise<TemplateRunState> {
  const s = await readJsonFile<Partial<TemplateRunState>>(templateStateFile(root, templateId)).catch(() => null);
  const ideas = Array.isArray(s?.ideas) ? s.ideas.filter((i): i is RepeatIdea => !!i && typeof i === 'object' && typeof (i as RepeatIdea).topic === 'string').slice(0, 30) : [];
  return {
    listNext: Number.isInteger(s?.listNext) && (s!.listNext as number) >= 0 ? (s!.listNext as number) : 0,
    ideas,
    lastRunAt: typeof s?.lastRunAt === 'string' ? s.lastRunAt : null,
    lastResult: typeof s?.lastResult === 'string' ? s.lastResult.slice(0, 300) : null,
  };
}

export async function writeTemplateState(root: string, templateId: string, s: TemplateRunState): Promise<void> {
  const file = templateStateFile(root, templateId);
  await withLock(`pm-template-state:${file}`, () => writeReplace(file, pretty(s)));
}

// ---- the slot ledger (no slot is made twice) ---------------------------------------------------------------

export interface RepeatSlotEntry {
  /** The slot's time (ISO), the key a pipeline's `madeBy()` uses. */
  slotAt: string;
  slotId: string;
  recipeId: string;
  /** The Post maker run that made it (null until the run exists). */
  runId: string | null;
  packageIds: string[];
  /** The daily run (autopilot run id) that started it. */
  autopilotRun: string;
  at: string;
  /** Set when the fork's run failed or was stopped: the slot is free again (the entry is kept, never deleted). */
  releasedAt?: string;
  /** Forks of this slot whose runs failed earlier (newest last, at most 10). */
  earlier?: string[];
}
interface Ledger {
  schema: 'signal.pm.repeat-slots/1';
  owners: Record<string /* tpl-… or pl-… */, Record<string /* slotAt */, RepeatSlotEntry>>;
}

export const repeatLedgerFile = (root: string) => path.join(root, 'repeat-slots.json');
const OWNER_RE = /^(tpl|pl)-\d{8}-[0-9a-z]{4}$/;

async function readLedger(root: string): Promise<Ledger> {
  const l = await readJsonFile<Ledger>(repeatLedgerFile(root)).catch(() => null);
  return l && l.schema === 'signal.pm.repeat-slots/1' && l.owners && typeof l.owners === 'object' ? l : { schema: 'signal.pm.repeat-slots/1', owners: {} };
}

/** slotAt → recipe id of every slot these owners started a post for (an owner's old `pl-…` id included). */
export async function slotsMadeBy(root: string, owners: (string | null | undefined)[]): Promise<Map<string, RepeatSlotEntry>> {
  const l = await readLedger(root);
  const out = new Map<string, RepeatSlotEntry>();
  for (const o of owners) if (o) for (const [at, e] of Object.entries(l.owners[o] ?? {})) if (!e.releasedAt) out.set(at, e);
  return out;
}

export const SLOT_TAKEN_TEXT = 'This slot already has a post on the way.';

/**
 * Claims `slot.slotAt` for `owner` and starts its post: `start()` (the fork) runs inside the ledger lock, after the
 * check and before the write, so two runs can never make the same slot and a refused claim leaves no fork behind.
 * Refuses (409) a slot already in the ledger for this owner, unless its earlier run released it. When `start()`
 * throws, nothing is written and the error goes to the caller.
 */
export async function claimRepeatSlot<T>(root: string, owner: string, slot: Omit<RepeatSlotEntry, 'recipeId' | 'releasedAt' | 'earlier'>, start: () => Promise<{ recipeId: string; value: T }>): Promise<T> {
  if (!OWNER_RE.test(owner)) throw new PostmakerError(400, 'validation', 'Unknown owner.');
  const file = repeatLedgerFile(root);
  return withLock(`pm-repeat-slots:${file}`, async () => {
    const l = await readLedger(root);
    const before = l.owners[owner]?.[slot.slotAt];
    if (before && !before.releasedAt) throw new PostmakerError(409, 'conflict', SLOT_TAKEN_TEXT);
    const { recipeId, value } = await start();
    const earlier = before ? [...(before.earlier ?? []), before.recipeId].slice(-10) : [];
    const entry: RepeatSlotEntry = { ...slot, recipeId, ...(earlier.length ? { earlier } : {}) };
    (l.owners[owner] ??= {})[slot.slotAt] = entry;
    await writeReplace(file, pretty(l));
    return value;
  });
}

/** Frees a slot whose fork's run failed or was stopped, so a later daily run makes it again (the entry is kept). */
export async function releaseRepeatSlot(root: string, owner: string, slotAt: string, recipeId: string, at: string): Promise<void> {
  const file = repeatLedgerFile(root);
  await withLock(`pm-repeat-slots:${file}`, async () => {
    const l = await readLedger(root);
    const e = l.owners[owner]?.[slotAt];
    if (!e || e.recipeId !== recipeId || e.releasedAt || e.packageIds.length) return;
    l.owners[owner]![slotAt] = { ...e, releasedAt: at };
    await writeReplace(file, pretty(l));
  });
}

/** Updates the run and packages of a claimed slot (never removes it). */
export async function updateRepeatSlot(root: string, owner: string, slotAt: string, patch: Partial<Pick<RepeatSlotEntry, 'runId' | 'packageIds'>>): Promise<void> {
  const file = repeatLedgerFile(root);
  await withLock(`pm-repeat-slots:${file}`, async () => {
    const l = await readLedger(root);
    const e = l.owners[owner]?.[slotAt];
    if (!e) return;
    l.owners[owner]![slotAt] = { ...e, ...patch };
    await writeReplace(file, pretty(l));
  });
}

// ---- the backlog (BACKLOG_LIMIT) ----------------------------------------------------------------------------------

/** Repeat runs that stopped for the person (at Proof, a sign-off or the cap) and made no post yet: the newest 200 runs. */
export async function repeatRunsWaiting(root: string): Promise<number> {
  let n = 0;
  const ids = (await listRunIds(root).catch(() => [] as string[])).slice(-200);
  for (const id of ids) {
    const r = await readRun(root, id).catch(() => null);
    if (r && r.trigger === 'repeat' && r.status === 'needs-you' && r.packageIds.length === 0) n += 1;
  }
  return n;
}

// ---- campaign slots made with "Make a post" (the gap: nothing reserved the slot at fork time) ------------------

const campaignOwner = (campaignId: string) => `campaign:${campaignId}`;

/** The post on its way for a planned campaign slot, or null. */
export async function campaignSlotHolder(root: string, campaignId: string, slotId: string): Promise<RepeatSlotEntry | null> {
  return (await readLedger(root)).owners[campaignOwner(campaignId)]?.[slotId] ?? null;
}

/** True while the recipe's newest run can still become the slot's post (queued, running, waiting, or accepted). */
export async function recipeStillMaking(root: string, recipeId: string): Promise<boolean> {
  let last: Awaited<ReturnType<typeof readRun>> = null;
  for (const id of (await listRunIds(root).catch(() => [] as string[])).reverse()) {
    const r = await readRun(root, id).catch(() => null);
    if (r?.recipeId === recipeId) {
      last = r;
      break;
    }
  }
  if (!last) return false;
  if (last.packageIds.length) return true;
  return last.status === 'queued' || last.status === 'running' || last.status === 'needs-you';
}

/** Records the fork made for a planned campaign slot (replaces an earlier holder that can no longer make it). */
export async function recordCampaignSlot(root: string, campaignId: string, slotId: string, entry: RepeatSlotEntry): Promise<void> {
  const file = repeatLedgerFile(root);
  await withLock(`pm-repeat-slots:${file}`, async () => {
    const l = await readLedger(root);
    (l.owners[campaignOwner(campaignId)] ??= {})[slotId] = entry;
    await writeReplace(file, pretty(l));
  });
}
