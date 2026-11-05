import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The test project: single-project mode through the environment (see lib/studio/projects.ts envProject). */
export const TEST_PROJECT = { id: 'demo', name: 'Demo', handle: '@signal.demo', profile: 'demo-profile' } as const;

/** Points the env project at a posts folder. Call before anything reads currentProject(). */
export function setTestProjectEnv(contentDir: string, o: { profile?: string } = {}): void {
  process.env.SIGNAL_CONTENT_DIR = contentDir;
  process.env.SIGNAL_PROJECT_ID = TEST_PROJECT.id;
  process.env.SIGNAL_PROJECT_NAME = TEST_PROJECT.name;
  process.env.SIGNAL_PROJECT_HANDLE = TEST_PROJECT.handle;
  process.env.UPLOAD_POST_PROFILE = o.profile ?? TEST_PROJECT.profile;
}

export const PROJECT_ENV = ['SIGNAL_CONTENT_DIR', 'SIGNAL_PROJECT_ID', 'SIGNAL_PROJECT_NAME', 'SIGNAL_PROJECT_HANDLE', 'UPLOAD_POST_PROFILE', 'SIGNAL_CONFIG_FILE', 'SIGNAL_ACCOUNTS_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_DATA_DIR', 'SIGNAL_PROMPTS_DIR'] as const;
export function clearTestEnv(): void {
  for (const k of PROJECT_ENV) delete process.env[k];
}

export interface TestConfig {
  /** Account posting settings for the test project. */
  dispatch?: boolean;
  codex?: boolean;
  expires?: string | null;
  maxPerDay?: number;
  maxPosts?: number;
  /** No account settings at all. */
  noAccount?: boolean;
  /** Feature switches. */
  analytics?: boolean;
  scheduling?: boolean;
  instagramApi?: boolean;
  signalScheduler?: boolean;
  claudeAgents?: boolean;
  claudeApiKey?: boolean;
  unifiedLogin?: boolean;
  memoryTeam?: boolean;
  autopilot?: boolean;
  trustedPublish?: boolean;
  higgsfield?: boolean;
  uploadPostProfiles?: boolean;
}

/**
 * Writes signal.config.json at `file` (feature switches) and accounts.json next to it (posting settings
 * for the test project), and points SIGNAL_CONFIG_FILE / SIGNAL_ACCOUNTS_FILE at them.
 */
export function writeTestConfig(file: string, o: TestConfig = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // The env project identity (the posts folder is set by each test).
  process.env.SIGNAL_PROJECT_ID = TEST_PROJECT.id;
  process.env.SIGNAL_PROJECT_NAME = TEST_PROJECT.name;
  process.env.SIGNAL_PROJECT_HANDLE = TEST_PROJECT.handle;
  process.env.UPLOAD_POST_PROFILE ??= TEST_PROJECT.profile;
  const features = {
    uploadPostResults: o.analytics ?? false,
    uploadPostScheduling: o.scheduling ?? false,
    instagramApi: o.instagramApi ?? false,
    scheduler: o.signalScheduler ?? false,
    agents: o.claudeAgents ?? false,
    agentsApiKey: o.claudeApiKey ?? false,
    unifiedLogin: o.unifiedLogin ?? false,
    memory: o.memoryTeam ?? false,
    autopilot: o.autopilot ?? false,
    trustedPublish: o.trustedPublish ?? false,
    higgsfield: o.higgsfield ?? false,
    uploadPostProfiles: o.uploadPostProfiles ?? false,
  };
  writeFileSync(file, JSON.stringify({ features }, null, 2));
  const accounts = o.noAccount
    ? []
    : [
        {
          project: TEST_PROJECT.id,
          handle: TEST_PROJECT.handle,
          profile: TEST_PROJECT.profile,
          enabled_at: '2026-11-03T00:00:00Z',
          enabled_by: 'test',
          ends_at: o.expires === undefined ? '2026-11-17T23:59:00+01:00' : o.expires,
          max_posts: o.maxPosts ?? 14,
          max_per_day: o.maxPerDay ?? 1,
          posting: o.dispatch ?? false,
          codex_images: o.codex ?? false,
        },
      ];
  const accountsFile = path.join(path.dirname(file), 'accounts.json');
  writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2));
  process.env.SIGNAL_CONFIG_FILE = file;
  process.env.SIGNAL_ACCOUNTS_FILE = accountsFile;
}
