// Server-only: turns a package's status change into a timeline event. Best effort and gated:
// recordEvent() returns null when memory is switched off and never throws into the caller.
import type { PackageStatus, PackageView } from '../content';
import { recordEvent } from './store';
import type { EventType } from './types';

const CAMPAIGN_ID = /^c-\d{8}-[a-z0-9]{4}$/;

/** Which event a move from `before` to the package's current state means, if any. */
export function eventForChange(before: { status: PackageStatus; labelConfirmed: boolean } | null, after: PackageView): EventType | null {
  const b = before?.status ?? null;
  const a = after.status;
  if (before && !before.labelConfirmed && after.labelConfirmed) return 'post.label-confirmed';
  if (a === b) return null;
  if (a === 'approved') return 'post.approved';
  if (a === 'scheduled') return 'post.scheduled';
  if (a === 'posted') return 'post.published';
  if (a === 'failed') return 'post.failed';
  // Discarding in Review is the owner saying no; dropping an already approved post is a change of plan.
  if (a === 'discarded') return b === 'approved' ? 'post.discarded' : 'post.rejected';
  return null;
}

/** Records the event for a package change. `before` is the package as it was before the action. */
export async function notePackageChange(before: PackageView | null, after: PackageView, by: string): Promise<void> {
  try {
    await note(before, after, by);
  } catch {
    /* best effort: memory must never change the result of an action */
  }
}

async function note(before: PackageView | null, after: PackageView, by: string): Promise<void> {
  const type = eventForChange(before, after);
  if (!type) return;
  const data: Record<string, unknown> = { from: before?.status ?? null, to: after.status };
  if (type === 'post.published' && after.posted) data.via = after.posted.via ?? null;
  if (type === 'post.scheduled' && after.scheduled) data.for = after.scheduled.scheduled_for;
  if (type === 'post.failed' && after.outcome) data.reason = String(after.outcome.message ?? '').slice(0, 200) || null;
  await recordEvent({ type, by, campaign: after.campaign && CAMPAIGN_ID.test(after.campaign.id) ? after.campaign.id : null, refs: { package: after.id, ...(after.campaign && CAMPAIGN_ID.test(after.campaign.id) ? { slot: after.campaign.slot } : {}) }, data });
}
