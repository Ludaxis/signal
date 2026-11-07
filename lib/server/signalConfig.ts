// Server-only: user-owned configuration for Signal Studio.
//
// Two layers, both optional:
//   1. signal.config.json (path from SIGNAL_CONFIG_FILE, default ./signal.config.json; git-ignored).
//      { "features": { "<switch>": true } }   — see FEATURES below and signal.config.example.json.
//      Optional: "contentGenerators": [...] (which package generators may be approved; absent = all of them) and
//      "postmaker": { "dayCapUsd": { "<connector>": 5 }, "acceptedTerms": { "<ref>": "<ISO time>" } }.
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
  /** Post maker: reference videos, recipes and step-by-step video posts. Mock steps until a service is on. */
  postmaker: 'Post maker: make video posts from a reference',
  /** Post maker voice through ElevenLabs (paid per character). */
  postmakerElevenlabs: 'ElevenLabs voice for Post maker (paid)',
  /** Post maker backup voice through Azure Speech (paid above the free tier). */
  postmakerAzureSpeech: 'Azure Speech voice for Post maker (paid)',
  /** Post maker lip-sync through Sync (paid per second of video). */
  postmakerSync: 'Sync lip-sync for Post maker (paid)',
  /** Post maker backup lip-sync through Hedra (paid from your Hedra wallet). */
  postmakerHedra: 'Hedra lip-sync for Post maker (paid)',
  /** Post maker video clips through the Higgsfield API (paid per request). */
  postmakerHiggsfieldVideo: 'Higgsfield video clips for Post maker (paid)',
  /** Post maker music through ElevenLabs (paid). */
  postmakerElevenlabsMusic: 'ElevenLabs music for Post maker (paid)',
  /** A browser agent that works a music site in your own browser, only while you watch. */
  browserAgent: 'Browser agent for music sites (only while you watch)',
} as const;
export type Feature = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as Feature[];

/** Optional Post maker settings. */
export interface PostmakerConfig {
  /** Per-connector day cap in USD (connector id → cap). Absent: only the run cap and the project day ceiling apply. */
  dayCapUsd: Record<string, number>;
  /** Terms you accepted once, when you turned a paid service on (gate ref such as "vendor:elevenlabs" → ISO time). */
  acceptedTerms: Record<string, string>;
}

export interface SignalConfig {
  features: Partial<Record<Feature, boolean>>;
  /** Package generators that may be approved. null = the key is absent: every generator may be approved. */
  contentGenerators: string[] | null;
  postmaker: PostmakerConfig;
}

export const configFile = () => process.env.SIGNAL_CONFIG_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'signal.config.json');
export const dataDir = () => process.env.SIGNAL_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'data');
export const secretsDir = () => process.env.SIGNAL_SECRETS_DIR || path.join(/* turbopackIgnore: true */ os.homedir(), '.signal');

const envName = (f: Feature) => `SIGNAL_FEATURE_${f.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function readPostmaker(v: unknown): PostmakerConfig {
  const o = obj(v) ?? {};
  const dayCapUsd: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(o.dayCapUsd) ?? {})) if (typeof n === 'number' && Number.isFinite(n) && n >= 0) dayCapUsd[k] = n;
  const acceptedTerms: Record<string, string> = {};
  for (const [k, at] of Object.entries(obj(o.acceptedTerms) ?? {})) if (typeof at === 'string' && Number.isFinite(Date.parse(at))) acceptedTerms[k] = at;
  return { dayCapUsd, acceptedTerms };
}

export async function readConfig(): Promise<SignalConfig> {
  try {
    const j = obj(JSON.parse(await fs.readFile(/* turbopackIgnore: true */ configFile(), 'utf8'))) ?? {};
    const features: SignalConfig['features'] = {};
    const raw = obj(j.features) ?? {};
    for (const f of FEATURE_IDS) if (raw[f] === true) features[f] = true;
    // A present but malformed list allows nothing (strict when present); only an absent key allows everything.
    const contentGenerators = j.contentGenerators === undefined ? null : Array.isArray(j.contentGenerators) ? j.contentGenerators.filter((x): x is string => typeof x === 'string') : [];
    return { features, contentGenerators, postmaker: readPostmaker(j.postmaker) };
  } catch {
    return { features: {}, contentGenerators: null, postmaker: { dayCapUsd: {}, acceptedTerms: {} } };
  }
}

/**
 * True when packages of this generator may be approved: the optional "contentGenerators" list in signal.config.json
 * names it. Without the list every generator may be approved; with it, the check is strict.
 */
export async function contentGeneratorAllowed(generator: string | null | undefined): Promise<boolean> {
  const list = (await readConfig()).contentGenerators;
  if (list === null) return true;
  return Boolean(generator) && list.includes(generator!);
}

/** The message when "contentGenerators" leaves a generator out. */
export const GENERATOR_NOT_ALLOWED = 'This generator is not allowed in signal.config.json (contentGenerators).';

/** True when the switch is on in signal.config.json or by SIGNAL_FEATURE_<NAME>=1. Off by default. */
export async function featureEnabled(f: Feature): Promise<boolean> {
  const env = (process.env[envName(f)] ?? '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return true;
  if (env === '0' || env === 'false' || env === 'no') return false;
  return (await readConfig()).features[f] === true;
}

/** The standard "turn it on" message for a switch that is off. */
export function featureOffReason(f: Feature): string {
  return `Turn on "${f}" in Connections → Features.`;
}

/** Each switch: on/off and whether SIGNAL_FEATURE_<NAME> in the environment decides it. */
export async function featureStates(): Promise<{ id: Feature; label: string; on: boolean; forcedByEnv: boolean }[]> {
  const file = await readConfig();
  return FEATURE_IDS.map((id) => {
    const env = (process.env[envName(id)] ?? '').trim().toLowerCase();
    const forced = ['1', 'true', 'yes', '0', 'false', 'no'].includes(env);
    return { id, label: FEATURES[id], on: forced ? ['1', 'true', 'yes'].includes(env) : file.features[id] === true, forcedByEnv: forced };
  });
}

/** Rewrites signal.config.json through `change`, keeping every other key in the file. */
async function updateConfig(change: (j: Record<string, unknown>) => void): Promise<void> {
  let j: Record<string, unknown> = {};
  try {
    j = obj(JSON.parse(await fs.readFile(/* turbopackIgnore: true */ configFile(), 'utf8'))) ?? {};
  } catch {
    /* new file */
  }
  change(j);
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(configFile()), { recursive: true });
  const tmp = `${configFile()}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(j, null, 2) + '\n');
  await fs.rename(tmp, configFile());
}

/** Turns one switch on or off in signal.config.json (other keys in the file are kept). */
export async function setFeature(f: Feature, on: boolean): Promise<void> {
  if (!FEATURE_IDS.includes(f)) throw new Error('Unknown switch.');
  await updateConfig((j) => {
    const features = { ...(obj(j.features) ?? {}) };
    if (on) features[f] = true;
    else delete features[f];
    j.features = features;
  });
}

/**
 * Records, once, that you accepted the terms behind these gate refs (for example "vendor:elevenlabs"). Connections
 * asks for this when you turn a paid service on; the time stays in signal.config.json under postmaker.acceptedTerms.
 */
export async function acceptTerms(refs: readonly string[], at: string = new Date().toISOString()): Promise<void> {
  const clean = refs.filter((r) => /^(vendor|terms):[a-z0-9][a-z0-9-]{0,63}$/.test(r));
  if (!clean.length) return;
  await updateConfig((j) => {
    const pm = { ...(obj(j.postmaker) ?? {}) };
    const accepted = { ...(obj(pm.acceptedTerms) ?? {}) };
    for (const r of clean) if (typeof accepted[r] !== 'string') accepted[r] = at;
    pm.acceptedTerms = accepted;
    j.postmaker = pm;
  });
}

/** {enabled, reason} for one switch, with the standard reason when it is off. */
export async function featureState(f: Feature, onReason = ''): Promise<{ enabled: boolean; reason: string }> {
  return (await featureEnabled(f)) ? { enabled: true, reason: onReason } : { enabled: false, reason: featureOffReason(f) };
}
