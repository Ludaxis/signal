// Server-only: user-owned configuration for Signal Studio.
//
// Two layers, both optional:
//   1. signal.config.json (path from SIGNAL_CONFIG_FILE, default ./signal.config.json; git-ignored).
//      { "features": { "<switch>": true } }   — see FEATURES below and signal.config.example.json.
//   2. Environment variables SIGNAL_FEATURE_<SWITCH_IN_UPPER_SNAKE_CASE>=1, which override the file.
//
// Every feature switch is OFF by default. Anything that spends money (agents, Higgsfield), publishes,
// schedules or runs unattended (autopilot) stays off until you turn it on here. The runtime kill
// switches SIGNAL_PUBLISH_PAUSED=1 and SIGNAL_AUTOPILOT_PAUSED=1 win over everything in this file.
//
// Data locations: SIGNAL_DATA_DIR (default ./data, git-ignored) holds projects.json, accounts.json and
// the default content folders. SIGNAL_SECRETS_DIR (default ~/.signal) holds encrypted tokens.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FEATURES = {
  /** Instagram's own API (publishing, insights, comments) for connected accounts. */
  instagramApi: 'Post, read results and manage comments through the Instagram API',
  /** Meta Unified Login (Facebook Login for Business) to connect accounts from the Connections screen. */
  unifiedLogin: 'Connect Instagram accounts with Meta Unified Login',
  /** Signal's own minute scheduler: sends scheduled posts while the app runs. */
  scheduler: "Send scheduled posts from Signal's own scheduler",
  /** Strategy / planner agents on your Claude Code CLI sign-in, on a button press. */
  agents: 'Run the strategist and planner agents (Claude Code CLI)',
  /** Let agent runs bill your own Anthropic API key (SIGNAL_ANTHROPIC_API_KEY). */
  agentsApiKey: 'Bill agent runs to SIGNAL_ANTHROPIC_API_KEY (needed for the agent team and the judge)',
  /** Project memory (timeline, decision map, learnings) and the agent team. */
  memory: 'Project memory and the agent team',
  /** Daily unattended autopilot run while the app is running. */
  autopilot: 'Autopilot: make planned posts once a day without a button press',
  /** Trusted formats may be approved and scheduled by autopilot. */
  trustedPublish: 'Autopilot may approve and schedule posts of trusted formats',
  /** Higgsfield image / video generation (paid per request). */
  higgsfield: 'Higgsfield images and Reels (paid per request)',
  /** Results from Upload-Post analytics. */
  uploadPostResults: 'Read post results from Upload-Post',
  /** Scheduling on Upload-Post (posts while your machine is off). */
  uploadPostScheduling: 'Schedule posts on Upload-Post',
  /** Creating and inspecting Upload-Post profiles from the project wizard. */
  uploadPostProfiles: 'Manage Upload-Post profiles from the project wizard',
} as const;
export type Feature = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as Feature[];

export interface SignalConfig {
  features: Partial<Record<Feature, boolean>>;
}

export const configFile = () => process.env.SIGNAL_CONFIG_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'signal.config.json');
export const dataDir = () => process.env.SIGNAL_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'data');
export const secretsDir = () => process.env.SIGNAL_SECRETS_DIR || path.join(/* turbopackIgnore: true */ os.homedir(), '.signal');

const envName = (f: Feature) => `SIGNAL_FEATURE_${f.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

export async function readConfig(): Promise<SignalConfig> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ configFile(), 'utf8')) as Partial<SignalConfig>;
    const features: SignalConfig['features'] = {};
    const raw = (j && typeof j === 'object' && j.features && typeof j.features === 'object' ? j.features : {}) as Record<string, unknown>;
    for (const f of FEATURE_IDS) if (raw[f] === true) features[f] = true;
    return { features };
  } catch {
    return { features: {} };
  }
}

/** True when the switch is on in signal.config.json or by SIGNAL_FEATURE_<NAME>=1. Off by default. */
export async function featureEnabled(f: Feature): Promise<boolean> {
  const env = (process.env[envName(f)] ?? '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return true;
  if (env === '0' || env === 'false' || env === 'no') return false;
  return (await readConfig()).features[f] === true;
}

/** The standard "turn it on" message for a switch that is off. */
export function featureOffReason(f: Feature): string {
  return `Turn on "${f}" in signal.config.json (features.${f}: true) or set ${envName(f)}=1.`;
}

/** {enabled, reason} for one switch, with the standard reason when it is off. */
export async function featureState(f: Feature, onReason = ''): Promise<{ enabled: boolean; reason: string }> {
  return (await featureEnabled(f)) ? { enabled: true, reason: onReason } : { enabled: false, reason: featureOffReason(f) };
}
