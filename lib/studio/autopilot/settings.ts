// Server-only: per-campaign autopilot settings (campaign folder: autopilot.json) and the feature switches.
// Everything stays off until the switches in signal.config.json are on (AUTOPILOT_SWITCHES) and you
// switch a campaign on. SIGNAL_AUTOPILOT_PAUSED=1 stops every run and every automatic approval.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { campaignsDir, getCampaign } from '../campaigns';
import { ContentError, writeJsonReplace } from '../content';
import { FORMATS, type Format } from '../generate';
import { publishingPaused } from '../safety';
import { AUTOPILOT_PAUSE_ENV, AUTOPILOT_SWITCHES, type AutopilotSettings } from './types';

export const SETTINGS_FILE = 'autopilot.json';
export const MAKE_AHEAD_DAYS = { min: 1, max: 7, default: 3 } as const;
export const DAILY_BUDGET_USD = { min: 0, max: 20, default: 3 } as const;
const CAMPAIGN_ID = /^c-\d{8}-[a-z0-9]{4}$/;

export function defaultSettings(campaign: string): AutopilotSettings {
  return { campaign, enabled: false, makeAheadDays: MAKE_AHEAD_DAYS.default, autoPlan: false, review: true, autoPublish: 'never', formats: null, dailyBudgetUsd: DAILY_BUDGET_USD.default, updatedAt: new Date(0).toISOString(), updatedBy: '' };
}

const settingsFile = (campaign: string) => {
  if (!CAMPAIGN_ID.test(campaign)) throw new ContentError(404, 'Unknown campaign.');
  return path.join(campaignsDir(), campaign, SETTINGS_FILE);
};

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const clampUsd = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);

/** Turns any stored or patched object into valid settings (unknown keys dropped, numbers clamped). */
export function cleanSettings(campaign: string, raw: unknown): AutopilotSettings {
  const d = defaultSettings(campaign);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const formats = Array.isArray(o.formats) ? [...new Set(o.formats.filter(isFormat))] : null;
  return {
    campaign,
    enabled: o.enabled === true,
    makeAheadDays: clampInt(o.makeAheadDays, MAKE_AHEAD_DAYS.min, MAKE_AHEAD_DAYS.max, d.makeAheadDays),
    autoPlan: o.autoPlan === true,
    review: o.review !== false,
    autoPublish: o.autoPublish === 'trusted' ? 'trusted' : 'never',
    formats: formats && formats.length ? formats : null,
    dailyBudgetUsd: clampUsd(o.dailyBudgetUsd, DAILY_BUDGET_USD.min, DAILY_BUDGET_USD.max, d.dailyBudgetUsd),
    updatedAt: typeof o.updatedAt === 'string' && Number.isFinite(Date.parse(o.updatedAt)) ? new Date(o.updatedAt).toISOString() : d.updatedAt,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy.slice(0, 120) : '',
  };
}

export async function readSettings(campaign: string): Promise<AutopilotSettings> {
  try {
    return cleanSettings(campaign, JSON.parse(await fs.readFile(/* turbopackIgnore: true */ settingsFile(campaign), 'utf8')));
  } catch (e) {
    if (e instanceof ContentError) throw e;
    return defaultSettings(campaign);
  }
}

/** Applies a settings patch: only known keys, validated and clamped; the campaign must exist. */
export async function updateSettings(campaign: string, patch: unknown, by: string, now = Date.now()): Promise<AutopilotSettings> {
  await getCampaign(campaign); // throws 404 for an unknown or malformed id
  const cur = await readSettings(campaign);
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const allowed = ['enabled', 'makeAheadDays', 'autoPlan', 'review', 'autoPublish', 'formats', 'dailyBudgetUsd'] as const;
  const merged: Record<string, unknown> = { ...cur };
  for (const k of allowed) if (k in p) merged[k] = p[k];
  const next = cleanSettings(campaign, { ...merged, updatedAt: new Date(now).toISOString(), updatedBy: by });
  await writeJsonReplace(settingsFile(campaign), next);
  return next;
}

// ---- switches and pause ----------------------------------------------------------------------------
const off = (reason: string) => ({ enabled: false, reason });

/** Daily automatic making is switched on (feature switch "autopilot"). */
export async function autopilotAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled(AUTOPILOT_SWITCHES.autopilot))) return off(featureOffReason(AUTOPILOT_SWITCHES.autopilot));
  return { enabled: true, reason: 'Autopilot makes planned posts once a day while Signal runs; every post still stops in Review unless a format earned trust.' };
}

/** Trusted formats may be approved and scheduled by Signal (switch "trustedPublish"; needs "autopilot" too). */
export async function trustedPublishAllowed(): Promise<{ enabled: boolean; reason: string }> {
  const base = await autopilotAllowed();
  if (!base.enabled) return base;
  if (!(await featureEnabled(AUTOPILOT_SWITCHES.trustedPublish))) return off(featureOffReason(AUTOPILOT_SWITCHES.trustedPublish));
  return { enabled: true, reason: 'Formats that earned trust may be approved and scheduled by Signal; you can pull any post before it goes out.' };
}

/** Higgsfield API (paid per request) for images and Reels (switch "higgsfield"). */
export async function higgsfieldAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled(AUTOPILOT_SWITCHES.higgsfield))) return off(featureOffReason(AUTOPILOT_SWITCHES.higgsfield));
  return { enabled: true, reason: 'Higgsfield may be used for images and Reels within the campaign budget.' };
}

/** Kill switch for autopilot: SIGNAL_AUTOPILOT_PAUSED=1 in .env.local. */
export function autopilotPaused(): { paused: boolean; reason: string } {
  const v = (process.env[AUTOPILOT_PAUSE_ENV] ?? '').trim().toLowerCase();
  const paused = v === '1' || v === 'true' || v === 'yes';
  return { paused, reason: paused ? `Autopilot is paused (${AUTOPILOT_PAUSE_ENV}=1). Nothing is made, approved or scheduled automatically.` : '' };
}

/** Anything that approves or schedules automatically also respects the publishing pause. */
export function autoApprovePaused(): { paused: boolean; reason: string } {
  const a = autopilotPaused();
  if (a.paused) return a;
  return publishingPaused();
}
