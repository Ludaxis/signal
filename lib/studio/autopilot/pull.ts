// Server-only: the owner pulls a post that autopilot approved before it goes out.
// The schedule is cancelled through the existing functions (Signal or Upload-Post), the package is discarded
// (nothing is deleted) and the format's trust takes a rejection: pulling is the owner saying no.
import { ContentError, discardPackage, isPackageId, loadPackage, type PackageView } from '../content';
import { cancelSchedule } from '../dispatch';
import { notePackageChange } from '../memory/hooks';
import { cancelSignalSchedule } from '../publish-meta';
import { packageFormat, readMark, recordDecision } from './trust';
import type { FormatTrust } from './types';

export interface PullDeps {
  now?: number;
  cancelSignalSchedule?: (id: string, by: string, now: number) => Promise<PackageView>;
  cancelSchedule?: (id: string, by: string, deps: { now?: number }) => Promise<PackageView>;
}

export async function pullPackage(id: string, by: string, deps: PullDeps = {}): Promise<{ package: PackageView; trust: FormatTrust | null }> {
  const now = deps.now ?? Date.now();
  if (!isPackageId(id)) throw new ContentError(404, 'Unknown package.');
  const mark = await readMark(id);
  if (!mark?.autoApproved) throw new ContentError(409, `Post ${id} was not approved by autopilot; use Review or the Calendar instead.`);
  const before = await loadPackage(id);
  if (before.status === 'scheduled') {
    if (before.scheduled?.provider === 'signal') await (deps.cancelSignalSchedule ?? ((i, b, n) => cancelSignalSchedule(i, b, n)))(id, by, now);
    else await (deps.cancelSchedule ?? ((i, b, d) => cancelSchedule(i, b, d)))(id, by, { now });
  } else if (before.status !== 'approved' && before.status !== 'changed') throw new ContentError(409, `Post ${id} is ${before.status} and cannot be pulled.`);
  const after = await discardPackage(id, by, now);
  await notePackageChange(before, after, by).catch(() => undefined);
  const format = await packageFormat(after).catch(() => null);
  const trust = format ? await recordDecision(format, 'rejected', by, now).catch(() => null) : null;
  return { package: after, trust };
}
