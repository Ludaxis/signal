// Server-only: per-format trust (memory/autopilot/trust.json, one per project).
// Trust is earned only from the owner's own decisions on posts that autopilot made (<package>/autopilot.json):
// `threshold` approvals in a row make a format trusted; one rejection resets the count and removes trust.
// A Signal actor (the autopilot, the scheduler, an agent) never counts, so an automatic approval can never
// grow the trust that allowed it. The owner can revoke trust (sticky) and restore it once the count allows.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ContentError, isPackageId, pkgPath, type PackageView } from '../content';
import { getPlan } from '../campaigns';
import { FORMATS, type Format } from '../generate';
import { memoryDir } from '../memory/store';
import { currentProject } from '../projects';
import { DEFAULT_TRUST_THRESHOLD, type AutopilotMark, type FormatTrust, type TrustFile } from './types';

export const MARK_FILE = 'autopilot.json';
export const autopilotDir = () => path.join(memoryDir(), 'autopilot');
const trustFile = () => path.join(autopilotDir(), 'trust.json');

/** Actors whose decisions never count toward trust (everything that is not the owner). */
export const isSignalActor = (by: string) => /^(signal-|agent:|system$)/.test(by.trim());

export async function ensureAutopilotDir(): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ autopilotDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(/* turbopackIgnore: true */ path.join(memoryDir(), '.gitignore'), '# Signal project memory: local only, never committed.\n*\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined);
}

export const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);

function emptyTrust(): TrustFile {
  return { version: 1, project: currentProject().id, threshold: DEFAULT_TRUST_THRESHOLD, formats: [], updatedAt: new Date(0).toISOString() };
}

export async function readTrust(): Promise<TrustFile> {
  try {
    const t = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ trustFile(), 'utf8')) as TrustFile;
    if (t?.version !== 1 || !Array.isArray(t.formats)) return emptyTrust();
    const threshold = Number.isFinite(t.threshold) && t.threshold >= 1 ? Math.round(t.threshold) : DEFAULT_TRUST_THRESHOLD;
    return { ...emptyTrust(), ...t, threshold, formats: t.formats.filter((f) => isFormat(f.format)).map((f) => ({ ...f, trusted: f.approvedInARow >= threshold && !f.revoked })) };
  } catch {
    return emptyTrust();
  }
}

async function writeTrust(t: TrustFile, now: number): Promise<void> {
  await ensureAutopilotDir();
  const f = trustFile();
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify({ ...t, updatedAt: new Date(now).toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, f);
}

const blank = (format: Format): FormatTrust => ({ format, approvedInARow: 0, approvedTotal: 0, rejectedTotal: 0, lastDecisionAt: null, trusted: false, revoked: false });

export async function formatTrust(format: Format): Promise<FormatTrust> {
  const t = await readTrust();
  return t.formats.find((f) => f.format === format) ?? blank(format);
}
export async function isTrusted(format: Format): Promise<boolean> {
  return (await formatTrust(format)).trusted;
}

/** One owner decision on an autopilot-made post. Returns null (and writes nothing) for a Signal actor. */
export async function recordDecision(format: Format, decision: 'approved' | 'rejected', by: string, now = Date.now()): Promise<FormatTrust | null> {
  if (!isFormat(format)) throw new ContentError(400, 'Unknown format.');
  if (!by.trim() || isSignalActor(by)) return null;
  const t = await readTrust();
  const cur = t.formats.find((f) => f.format === format) ?? blank(format);
  const next: FormatTrust = { ...cur, lastDecisionAt: new Date(now).toISOString() };
  if (decision === 'approved') {
    next.approvedInARow = cur.approvedInARow + 1;
    next.approvedTotal = cur.approvedTotal + 1;
  } else {
    next.approvedInARow = 0;
    next.rejectedTotal = cur.rejectedTotal + 1;
  }
  next.trusted = next.approvedInARow >= t.threshold && !next.revoked;
  t.formats = [...t.formats.filter((f) => f.format !== format), next].sort((a, b) => a.format.localeCompare(b.format));
  await writeTrust(t, now);
  return next;
}

/** The owner revokes (sticky) or restores trust. Restoring needs the earned count. */
export async function setTrust(format: Format, trusted: boolean, now = Date.now()): Promise<FormatTrust> {
  if (!isFormat(format)) throw new ContentError(400, 'Unknown format.');
  const t = await readTrust();
  const cur = t.formats.find((f) => f.format === format) ?? blank(format);
  if (trusted && cur.approvedInARow < t.threshold) throw new ContentError(409, `${format} has ${cur.approvedInARow} approvals in a row; ${t.threshold} are needed before it can be trusted.`);
  const next: FormatTrust = { ...cur, revoked: !trusted, trusted: trusted && cur.approvedInARow >= t.threshold };
  t.formats = [...t.formats.filter((f) => f.format !== format), next].sort((a, b) => a.format.localeCompare(b.format));
  await writeTrust(t, now);
  return next;
}

// ---- the mark and the owner's decisions -----------------------------------------------------------
export async function readMark(packageId: string): Promise<AutopilotMark | null> {
  if (!isPackageId(packageId)) return null;
  try {
    const m = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ pkgPath(packageId, MARK_FILE), 'utf8')) as AutopilotMark;
    return m && typeof m.run === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** The generate format of a package: from its source, else from the campaign slot it was made for. */
export async function packageFormat(pkg: PackageView): Promise<Format | null> {
  if (isFormat(pkg.source?.format)) return pkg.source!.format as Format;
  if (pkg.campaign) {
    const slot = (await getPlan(pkg.campaign.id).catch(() => null))?.slots.find((s) => s.id === pkg.campaign!.slot);
    if (slot && isFormat(slot.format)) return slot.format;
  }
  return null;
}

/** Which trust decision a owner action on an autopilot-made package means, if any. */
export function decisionForChange(before: Pick<PackageView, 'status'> | null, after: Pick<PackageView, 'status'>, mark: AutopilotMark): 'approved' | 'rejected' | null {
  const b = before?.status ?? null;
  if (b === after.status) return null;
  if (after.status === 'approved' && b === 'ready') return 'approved'; // approvePackage only accepts a ready post; a cancelled schedule also lands on approved
  if (after.status === 'discarded') {
    // Discarding in Review says no to the post. Dropping a post that autopilot approved is pulling it: also no.
    if (b === 'approved' || b === 'scheduled') return mark.autoApproved ? 'rejected' : null;
    return 'rejected';
  }
  return null;
}

/** Best effort, called next to notePackageChange after a owner action: never throws, never changes the result. */
export async function noteTrustDecision(before: PackageView | null, after: PackageView, by: string, now = Date.now()): Promise<FormatTrust | null> {
  try {
    if (isSignalActor(by)) return null;
    const mark = await readMark(after.id);
    if (!mark) return null;
    const decision = decisionForChange(before, after, mark);
    if (!decision) return null;
    const format = await packageFormat(after);
    if (!format) return null;
    return await recordDecision(format, decision, by, now);
  } catch {
    return null;
  }
}
