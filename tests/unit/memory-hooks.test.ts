import { describe, expect, it } from 'vitest';
import { eventForChange } from '@/lib/studio/memory/hooks';
import type { PackageView } from '@/lib/studio/content';

const pkg = (status: PackageView['status'], labelConfirmed = false) => ({ id: 'p1', status, labelConfirmed, campaign: null }) as unknown as PackageView;
const was = (status: PackageView['status'], labelConfirmed = false) => ({ status, labelConfirmed });

describe('eventForChange', () => {
  it('maps status moves to timeline events', () => {
    expect(eventForChange(was('ready'), pkg('approved'))).toBe('post.approved');
    expect(eventForChange(was('approved'), pkg('scheduled'))).toBe('post.scheduled');
    expect(eventForChange(was('scheduled'), pkg('posted'))).toBe('post.published');
    expect(eventForChange(was('sending'), pkg('failed'))).toBe('post.failed');
  });
  it('treats a discard in Review as a rejection and a discard after approval as a change of plan', () => {
    expect(eventForChange(was('ready'), pkg('discarded'))).toBe('post.rejected');
    expect(eventForChange(was('approved'), pkg('discarded'))).toBe('post.discarded');
  });
  it('records the AI label confirmation and ignores no-op or in-between states', () => {
    expect(eventForChange(was('posted'), pkg('posted', true))).toBe('post.label-confirmed');
    expect(eventForChange(was('approved'), pkg('approved'))).toBeNull();
    expect(eventForChange(was('approved'), pkg('submitted'))).toBeNull();
    expect(eventForChange(was('submitted'), pkg('uncertain'))).toBeNull();
  });
});

describe('store guards', () => {
  it('accepts only real campaign ids for file names', async () => {
    const { isCampaignId, newId } = await import('@/lib/studio/memory/store');
    expect(isCampaignId('c-20261104-ab12')).toBe(true);
    expect(isCampaignId('/../../x')).toBe(false);
    expect(isCampaignId('c-20261104-ab12/../x')).toBe(false);
    expect(newId('ev', Number.NaN)).toMatch(/^ev_[0-9a-z]{9}[0-9a-f]{6}$/);
  });
});
