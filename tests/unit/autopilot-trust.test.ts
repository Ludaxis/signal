// Format trust: only the owner's own decisions on autopilot-made posts count; a rejection resets.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvePackage, discardPackage, loadPackage } from '@/lib/studio/content';
import { decisionForChange, formatTrust, isSignalActor, noteTrustDecision, readTrust, recordDecision, setTrust } from '@/lib/studio/autopilot/trust';
import { DEFAULT_TRUST_THRESHOLD } from '@/lib/studio/autopilot/types';
import { A, NOW, campaignWithSlots, markPackage, setupAutopilotProject, teardownAutopilotProject, trustFile, writePackage } from './autopilot-helpers';

beforeEach(() => setupAutopilotProject());
afterEach(() => teardownAutopilotProject());

describe('recordDecision', () => {
  it('earns trust after the threshold of owner approvals in a row and keeps totals', async () => {
    for (let i = 1; i <= DEFAULT_TRUST_THRESHOLD; i++) {
      const t = await recordDecision('higgsfield-reel', 'approved', 'owner@example.com', NOW + i);
      expect(t).toMatchObject({ format: 'higgsfield-reel', approvedInARow: i, approvedTotal: i, rejectedTotal: 0, trusted: i >= DEFAULT_TRUST_THRESHOLD, revoked: false });
    }
    const file = await readTrust();
    expect(file).toMatchObject({ version: 1, project: 'demo', threshold: DEFAULT_TRUST_THRESHOLD });
    expect(file.formats).toHaveLength(1);
    expect(file.formats[0]!.lastDecisionAt).toBe(new Date(NOW + DEFAULT_TRUST_THRESHOLD).toISOString());
    expect(existsSync(trustFile())).toBe(true);
    expect((readFileSync(trustFile(), 'utf8').match(/"trusted": true/g) ?? []).length).toBe(1);
  });
  it('a rejection resets the streak and removes trust; other formats are untouched', async () => {
    for (let i = 0; i < 6; i++) await recordDecision('higgsfield-reel', 'approved', 'owner');
    await recordDecision('website-card', 'approved', 'owner');
    expect((await formatTrust('higgsfield-reel')).trusted).toBe(true);
    const t = await recordDecision('higgsfield-reel', 'rejected', 'owner');
    expect(t).toMatchObject({ approvedInARow: 0, approvedTotal: 6, rejectedTotal: 1, trusted: false });
    expect(await formatTrust('website-card')).toMatchObject({ approvedInARow: 1, trusted: false });
    await recordDecision('higgsfield-reel', 'approved', 'owner');
    expect((await formatTrust('higgsfield-reel')).approvedInARow).toBe(1);
  });
  it('never counts a Signal actor (an automatic approval cannot grow trust)', async () => {
    for (const by of ['signal-autopilot', 'signal-autopilot (trusted format)', 'signal-scheduler', 'agent:reviewer', 'system', '']) expect(await recordDecision('higgsfield-reel', 'approved', by)).toBeNull();
    expect(existsSync(trustFile())).toBe(false);
    expect((await readTrust()).formats).toEqual([]);
    expect(isSignalActor('owner@example.com')).toBe(false);
  });
  it('refuses an unknown format', async () => {
    await expect(recordDecision('tiktok' as never, 'approved', 'owner')).rejects.toMatchObject({ status: 400 });
  });
});

describe('setTrust', () => {
  it('revoking is sticky through further approvals; restoring needs the earned streak', async () => {
    for (let i = 0; i < 5; i++) await recordDecision('higgsfield-reel', 'approved', 'owner');
    expect(await setTrust('higgsfield-reel', false)).toMatchObject({ trusted: false, revoked: true, approvedInARow: 5 });
    expect(await recordDecision('higgsfield-reel', 'approved', 'owner')).toMatchObject({ trusted: false, revoked: true, approvedInARow: 6 });
    expect(await setTrust('higgsfield-reel', true)).toMatchObject({ trusted: true, revoked: false });
    await expect(setTrust('website-card', true)).rejects.toMatchObject({ status: 409 });
    expect(await formatTrust('website-card')).toMatchObject({ trusted: false, revoked: false });
    // Revoking a format that never earned trust is allowed and stays sticky.
    expect(await setTrust('website-card', false)).toMatchObject({ trusted: false, revoked: true });
  });
});

describe('noteTrustDecision (content route hook)', () => {
  it('maps the owner approve and discard of an autopilot-made post to a decision', () => {
    const mark = { run: 'ap_1', campaign: A, slot: 's', madeAt: '', autoApproved: null };
    const auto = { ...mark, autoApproved: { at: '', trustInARow: 5, scheduledFor: null, via: null } };
    expect(decisionForChange({ status: 'ready' }, { status: 'approved' }, mark)).toBe('approved');
    expect(decisionForChange({ status: 'ready' }, { status: 'discarded' }, mark)).toBe('rejected');
    expect(decisionForChange({ status: 'changed' }, { status: 'discarded' }, mark)).toBe('rejected');
    expect(decisionForChange({ status: 'approved' }, { status: 'discarded' }, mark)).toBeNull(); // the owner's own approval, then a change of plan
    expect(decisionForChange({ status: 'approved' }, { status: 'discarded' }, auto)).toBe('rejected'); // pulling an auto-approved post
    expect(decisionForChange({ status: 'scheduled' }, { status: 'approved' }, mark)).toBeNull(); // a cancelled schedule is not an approval
    expect(decisionForChange({ status: 'ready' }, { status: 'ready' }, mark)).toBeNull();
    expect(decisionForChange(null, { status: 'approved' }, mark)).toBeNull();
  });
  it('counts an owner approval and a discard of marked packages only', async () => {
    campaignWithSlots(['2026-11-06']);
    writePackage('01', { caption: 'made by autopilot', format: 'carousel', campaign: { id: A, slot: '2026-11-06-website-card' } });
    markPackage('01', { slot: '2026-11-06-website-card' });
    writePackage('02', { caption: 'made by hand' });
    const b1 = await loadPackage('01');
    const a1 = await approvePackage('01', 'owner', NOW);
    expect(await noteTrustDecision(b1, a1, 'owner', NOW)).toMatchObject({ format: 'website-card', approvedInARow: 1 });
    const b2 = await loadPackage('02');
    const a2 = await approvePackage('02', 'owner', NOW);
    expect(await noteTrustDecision(b2, a2, 'owner', NOW)).toBeNull();
    expect((await formatTrust('website-card')).approvedInARow).toBe(1);
    // A later discard of the owner-approved post is a change of plan, not a rejection.
    const d1 = await discardPackage('01', 'owner', NOW);
    expect(await noteTrustDecision(a1, d1, 'owner', NOW)).toBeNull();
    // Discarding an unapproved autopilot post in Review is a rejection.
    writePackage('03', { caption: 'autopilot again', format: 'carousel', campaign: { id: A, slot: '2026-11-06-website-card' } });
    markPackage('03', { slot: '2026-11-06-website-card' });
    const b3 = await loadPackage('03');
    const d3 = await discardPackage('03', 'owner', NOW);
    expect(await noteTrustDecision(b3, d3, 'owner', NOW)).toMatchObject({ approvedInARow: 0, rejectedTotal: 1 });
    // The autopilot approving its own post never reaches the file.
    writePackage('04', { caption: 'auto', format: 'carousel', campaign: { id: A, slot: '2026-11-06-website-card' } });
    markPackage('04');
    const b4 = await loadPackage('04');
    const a4 = await approvePackage('04', 'signal-autopilot (trusted format)', NOW);
    expect(await noteTrustDecision(b4, a4, 'signal-autopilot (trusted format)', NOW)).toBeNull();
    expect(await formatTrust('website-card')).toMatchObject({ approvedTotal: 1, rejectedTotal: 1 });
  });
});
