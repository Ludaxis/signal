// Post maker switch ids: one feature id per connector switch, off by default. The switches themselves live in
// signal.config.json (lib/server/signalConfig.ts FEATURES); SIGNAL_FEATURE_<NAME> in the environment overrides one.
// Turning a switch on still needs the service's key, and a paid service also needs its terms accepted once.
import { FEATURE_IDS, featureEnabled, type Feature } from '@/lib/server/signalConfig';
import { POSTMAKER_PAUSED_ENV } from '../../app-settings';

export { POSTMAKER_PAUSED_ENV };

/** The feature ids Post maker reads: its own switches plus the existing ones it reuses. */
export const FEATURES = [
  'postmaker',
  'postmakerRepeat',
  'postmakerElevenlabs',
  'postmakerAzureSpeech',
  'postmakerSync',
  'postmakerHedra',
  'postmakerHiggsfieldVideo',
  'postmakerElevenlabsMusic',
  'browserAgent',
  'agents',
  'agentsApiKey',
  'memory',
  'higgsfield',
] as const satisfies readonly Feature[];
export type FeatureId = (typeof FEATURES)[number];

export const isFeature = (v: unknown): v is FeatureId => typeof v === 'string' && (FEATURES as readonly string[]).includes(v) && (FEATURE_IDS as readonly string[]).includes(v);

/** `postmakerElevenlabs` → `SIGNAL_FEATURE_POSTMAKER_ELEVENLABS` (the same name signalConfig reads). */
export const featureEnvName = (f: FeatureId): string => `SIGNAL_FEATURE_${f.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/**
 * Whether a switch is on: the environment (`env`, default process.env) decides when it sets SIGNAL_FEATURE_<NAME>,
 * otherwise signal.config.json does. Read at every call, never cached.
 */
export async function featureOn(f: FeatureId, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env !== process.env) {
    const v = (env[featureEnvName(f)] ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  return featureEnabled(f);
}

/** The Post maker kill switch (Connections → Post maker, or SIGNAL_POSTMAKER_PAUSED=1). */
export const postmakerPaused = (env: NodeJS.ProcessEnv = process.env): boolean => truthy(env[POSTMAKER_PAUSED_ENV]);
