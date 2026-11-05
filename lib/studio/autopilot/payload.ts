// Server-only: the GET /api/studio/autopilot answer for the current project.
import { TIMEZONE } from '@/lib/time';
import { listCampaigns } from '../campaigns';
import { RUN_WINDOW, listAutopilotRuns, nextRunAt, spendToday } from './runner';
import { autopilotAllowed, autopilotPaused, higgsfieldAllowed, readSettings, trustedPublishAllowed } from './settings';
import { readTrust } from './trust';
import type { AutopilotPayload } from './types';

/** The instrumentation hook keeps its minute-tick handle here while it is registered. */
export const schedulerRunning = () => Boolean((globalThis as typeof globalThis & { __signalAutopilotScheduler?: unknown }).__signalAutopilotScheduler);

export async function autopilotPayload(now = Date.now()): Promise<AutopilotPayload> {
  const [autopilot, trustedPublish, higgsfield, campaigns, trust, runs, spend] = await Promise.all([autopilotAllowed(), trustedPublishAllowed(), higgsfieldAllowed(), listCampaigns(), readTrust(), listAutopilotRuns(20), spendToday(now)]);
  const paused = autopilotPaused();
  return {
    switches: { autopilot, trustedPublish, higgsfield },
    paused,
    schedule: { time: RUN_WINDOW.from, timeZone: TIMEZONE, window: `${RUN_WINDOW.from}–${RUN_WINDOW.to}`, nextRunAt: autopilot.enabled && !paused.paused ? nextRunAt(now, runs) : null, schedulerRunning: schedulerRunning() },
    campaigns: await Promise.all(campaigns.map(async (c) => ({ id: c.id, name: c.name, status: c.status, formats: c.formats, settings: await readSettings(c.id) }))),
    trust,
    runs,
    spendToday: spend,
  };
}
