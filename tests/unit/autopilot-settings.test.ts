// Autopilot settings and gates: defaults, clamped patches, gate flags and the pause switch.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoApprovePaused, autopilotAllowed, autopilotPaused, cleanSettings, defaultSettings, higgsfieldAllowed, readSettings, trustedPublishAllowed, updateSettings } from '@/lib/studio/autopilot/settings';
import { writeTestConfig } from './studio-helpers';
import { A, NOW, campaignWithSlots, root, setupAutopilotProject, teardownAutopilotProject } from './autopilot-helpers';

beforeEach(() => setupAutopilotProject());
afterEach(() => teardownAutopilotProject());

describe('settings', () => {
  it('defaults: off, 3 days ahead, review on, never auto-publish, $3 a day', async () => {
    campaignWithSlots([]);
    expect(await readSettings(A)).toMatchObject({ campaign: A, enabled: false, makeAheadDays: 3, autoPlan: false, review: true, autoPublish: 'never', formats: null, dailyBudgetUsd: 3 });
    expect(defaultSettings(A).updatedBy).toBe('');
  });
  it('writes a validated, clamped patch into the campaign folder', async () => {
    campaignWithSlots([]);
    const s = await updateSettings(A, { enabled: true, makeAheadDays: 99, dailyBudgetUsd: 1.239, autoPublish: 'trusted', formats: ['higgsfield-reel', 'nope', 'higgsfield-reel'], review: false, autoPlan: 'yes', ignored: 1 }, 'owner', NOW);
    expect(s).toMatchObject({ enabled: true, makeAheadDays: 7, dailyBudgetUsd: 1.24, autoPublish: 'trusted', formats: ['higgsfield-reel'], review: false, autoPlan: false, updatedBy: 'owner', updatedAt: new Date(NOW).toISOString() });
    expect('ignored' in s).toBe(false);
    const onDisk = JSON.parse(readFileSync(path.join(root, 'campaigns', A, 'autopilot.json'), 'utf8')) as { makeAheadDays: number };
    expect(onDisk.makeAheadDays).toBe(7);
    // A second patch keeps what it does not mention.
    const s2 = await updateSettings(A, { makeAheadDays: 0, dailyBudgetUsd: -4 }, 'owner', NOW + 1);
    expect(s2).toMatchObject({ enabled: true, makeAheadDays: 1, dailyBudgetUsd: 0, autoPublish: 'trusted', formats: ['higgsfield-reel'] });
    expect(await readSettings(A)).toEqual(s2);
  });
  it('turns bad values into defaults and empty format lists into null', () => {
    const s = cleanSettings(A, { makeAheadDays: 'abc', dailyBudgetUsd: 'x', autoPublish: 'always', formats: ['bogus'], updatedAt: 'never' });
    expect(s).toMatchObject({ makeAheadDays: 3, dailyBudgetUsd: 3, autoPublish: 'never', formats: null, updatedAt: new Date(0).toISOString() });
  });
  it('refuses an unknown or malformed campaign id without writing', async () => {
    await expect(updateSettings('c-20261101-zzzz', { enabled: true }, 'owner')).rejects.toMatchObject({ status: 404 });
    await expect(updateSettings('../etc', { enabled: true }, 'owner')).rejects.toMatchObject({ status: 404 });
    expect(existsSync(path.join(root, 'campaigns', 'c-20261101-zzzz'))).toBe(false);
  });
});

describe('gates and pause', () => {
  it('reads the three switches from signal.config.json', async () => {
    writeTestConfig(path.join(root, 'signal.config.json'), {});
    expect((await autopilotAllowed()).enabled).toBe(false);
    expect((await trustedPublishAllowed()).enabled).toBe(false);
    expect((await higgsfieldAllowed()).enabled).toBe(false);
    writeTestConfig(path.join(root, 'signal.config.json'), { trustedPublish: true, higgsfield: true });
    expect((await autopilotAllowed()).enabled).toBe(false);
    expect((await trustedPublishAllowed()).enabled).toBe(false); // needs the autopilot gate too
    expect((await higgsfieldAllowed()).enabled).toBe(true);
    writeTestConfig(path.join(root, 'signal.config.json'), { autopilot: true, trustedPublish: true });
    expect((await autopilotAllowed()).enabled).toBe(true);
    expect((await trustedPublishAllowed()).enabled).toBe(true);
  });
  it('is off without a gates file', async () => {
    process.env.SIGNAL_CONFIG_FILE = path.join(root, 'missing.json');
    expect(await autopilotAllowed()).toMatchObject({ enabled: false, reason: /not found/ });
    expect((await higgsfieldAllowed()).enabled).toBe(false);
  });
  it('SIGNAL_AUTOPILOT_PAUSED pauses autopilot; SIGNAL_PUBLISH_PAUSED pauses automatic approvals only', () => {
    expect(autopilotPaused().paused).toBe(false);
    expect(autoApprovePaused().paused).toBe(false);
    process.env.SIGNAL_PUBLISH_PAUSED = '1';
    expect(autopilotPaused().paused).toBe(false);
    expect(autoApprovePaused()).toMatchObject({ paused: true, reason: /SIGNAL_PUBLISH_PAUSED/ });
    process.env.SIGNAL_AUTOPILOT_PAUSED = 'true';
    expect(autopilotPaused()).toMatchObject({ paused: true, reason: /SIGNAL_AUTOPILOT_PAUSED/ });
    expect(autoApprovePaused().reason).toMatch(/SIGNAL_AUTOPILOT_PAUSED/);
  });
});
