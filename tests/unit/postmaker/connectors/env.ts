// Per-test environment for the connector suite: temp secrets, data folder and signal.config.json, every Post maker
// switch and vendor key cleared; restored afterwards. Import after ../guard.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { FEATURES, featureEnvName, POSTMAKER_PAUSED_ENV, type FeatureId } from '@/lib/studio/postmaker/connectors/features';
import { tmp } from '../guard';
import { FAKE_KEYS } from './fakes';

const saved = { ...process.env };
const g = globalThis as { __signalEnvOriginal?: unknown; __signalSettingsApplied?: unknown };

export const env = { config: '', secrets: '' };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (/^(SIGNAL_FEATURE_|ELEVENLABS_|AZURE_SPEECH_|SYNC_|HEDRA_|HF_API_|SIGNAL_ANTHROPIC|ANTHROPIC_|CLAUDE_CODE_OAUTH|UPLOAD_POST|R2_|META_)/.test(k)) delete process.env[k];
  delete process.env[POSTMAKER_PAUSED_ENV];
  env.secrets = path.join(tmp.dir, 'secrets');
  env.config = path.join(tmp.dir, 'signal.config.json');
  mkdirSync(env.secrets, { recursive: true });
  process.env.SIGNAL_SECRETS_DIR = env.secrets;
  process.env.SIGNAL_DATA_DIR = path.join(tmp.dir, 'data');
  process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.SIGNAL_CONFIG_FILE = env.config;
  process.env.CLAUDE_BIN = path.join(tmp.dir, 'no-such-claude');
  process.env.CODEX_BIN = path.join(tmp.dir, 'no-such-codex');
  writeFileSync(env.config, JSON.stringify({ features: {} }));
  delete g.__signalEnvOriginal;
  delete g.__signalSettingsApplied;
});
afterEach(() => {
  process.env = { ...saved };
  delete g.__signalEnvOriginal;
  delete g.__signalSettingsApplied;
});

export function switchOn(...ids: FeatureId[]) {
  for (const f of ids) process.env[featureEnvName(f)] = '1';
}
export const allSwitchesOn = () => switchOn(...FEATURES);

export function setKeys(names: (keyof typeof FAKE_KEYS)[] = Object.keys(FAKE_KEYS) as (keyof typeof FAKE_KEYS)[]) {
  for (const n of names) process.env[n] = FAKE_KEYS[n];
}

/** Writes the Post maker settings of signal.config.json: accepted terms (gate refs) and day caps. */
export function writePostmakerConfig(o: { acceptedTerms?: string[]; dayCapUsd?: Record<string, number> } = {}) {
  const acceptedTerms = Object.fromEntries((o.acceptedTerms ?? []).map((r) => [r, '2026-11-06T10:00:00.000Z']));
  writeFileSync(env.config, JSON.stringify({ features: {}, postmaker: { acceptedTerms, dayCapUsd: o.dayCapUsd ?? {} } }));
}
