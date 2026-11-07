// Accept fixtures: a content folder, posting settings and the postmaker switch for the Posts side, a check executor
// that writes a fixture verdict sheet (the real one owns its shape), and a clean live stub run with named sign-offs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import type { FakeConfig } from '@/lib/studio/postmaker/executors/fakes';
import type { ExecutorRegistry } from '@/lib/studio/postmaker/executors/types';
import { recordSignOff, signoffsDep } from '@/lib/studio/postmaker/signoffs';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import type { Lang, Run } from '@/lib/studio/postmaker/types';
import type { Verdict } from '@/lib/studio/postmaker/verdict';
import { TEST_PROJECT, setTestProjectEnv, writeTestConfig, type TestConfig } from '../studio-helpers';
import { runAll, setup, type Setup } from './engine-fixtures';
import { tmp } from './guard';

const KEYS = ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_ACCOUNTS_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_PROJECT_ID', 'SIGNAL_PROJECT_NAME', 'SIGNAL_PROJECT_HANDLE', 'UPLOAD_POST_PROFILE', 'SIGNAL_DATA_DIR', 'SIGNAL_SECRETS_DIR', 'SIGNAL_TOKEN_KEY', 'CLAUDE_BIN', 'CODEX_BIN'];
const saved: Record<string, string | undefined> = {};

/** Writes signal.config.json (postmaker on unless said otherwise) and the test account's posting settings. */
export function writePostsConfig(o: TestConfig = {}): void {
  writeTestConfig(process.env.SIGNAL_CONFIG_FILE!, { postmaker: true, expires: null, maxPosts: 100, maxPerDay: 10, ...o });
}

/** Per test: the env project's content folder is tmp.contentDir (beside tmp.root), with Post maker switched on. */
export function withPostsProject(): void {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of Object.keys(process.env)) if (/^SIGNAL_FEATURE_/.test(k)) delete process.env[k];
    mkdirSync(tmp.contentDir, { recursive: true });
    setTestProjectEnv(tmp.contentDir);
    process.env.SIGNAL_CONFIG_FILE = path.join(tmp.dir, 'config', 'signal.config.json');
    process.env.SIGNAL_PROJECTS_FILE = path.join(tmp.dir, 'no-projects.json');
    process.env.SIGNAL_DATA_DIR = path.join(tmp.dir, 'data');
    process.env.SIGNAL_SECRETS_DIR = path.join(tmp.dir, 'secrets');
    process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.CLAUDE_BIN = path.join(tmp.dir, 'no-such-claude');
    process.env.CODEX_BIN = path.join(tmp.dir, 'no-such-codex');
    writePostsConfig();
  });
  afterEach(() => {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
}

/** The Posts-side project the tests accept into (the env project). */
export const postsProject = () => ({ id: TEST_PROJECT.id, handle: TEST_PROJECT.handle, contentDir: tmp.contentDir, timeZone: 'Europe/Berlin' });

/** A fixture score sheet in the shape with the given verdict. */
export const sheet = (verdict: Verdict | 'Unscored') => ({ runId: 'fixture', medium: 'video', scores: [], mean: verdict === 'premium' ? 4.6 : 3.8, verdict, rubricVersion: 'qr-1.0' });

/** The default registry with `check` writing the fixture sheet instead of the fake's 'Unscored'. */
export function withVerdict(verdict: Verdict | 'Unscored', fakes: FakeConfig = {}): ExecutorRegistry {
  const ex = defaultExecutors({ fakes });
  const base = ex.check;
  return {
    ...ex,
    check: {
      ...base,
      run: async (i) => {
        const r = await base.run(i);
        return { ...r, outputs: r.outputs.map((o) => (o.port === 'score' ? { ...o, data: sheet(verdict) } : o)) };
      },
    },
  };
}

export const EDITOR = { by: 'editor@example.test', name: 'Editor A' };

/** Signs the current version of a gated node as a named person through the store. */
export async function signCurrent(recipeId: string, nodeId: string, gate: 'fa-native-editor' | 'fa-native-listener'): Promise<void> {
  const h = await readHead(tmp.root, recipeId, nodeId);
  await recordSignOff(tmp.root, { recipeId, nodeId, version: h.current!, gate, verdict: 'pass', ...EDITOR });
}

/**
 * A clean stub run (every connector flagged live, fakes): the fa text gate pauses the paid voice call, a person signs
 * it, Continue finishes the run, then the listener signs. Returns the finished run.
 */
export async function cleanRun(o: { verdict?: Verdict | 'Unscored'; langs?: Lang[]; signListener?: boolean; id?: string; executors?: ExecutorRegistry } = {}): Promise<Setup & { run: Run }> {
  const s = await setup({ id: o.id, langs: o.langs, build: {}, deps: { allowed: () => true, signoffs: signoffsDep(tmp.root), executors: o.executors ?? withVerdict(o.verdict ?? 'premium') } });
  let run = await runAll(s.engine, s.recipeId, { capUsd: 5 });
  if ((o.langs ?? ['fa', 'en']).includes('fa')) {
    if (run.pausedFor !== 'gate') throw new Error(`expected a gate pause, got ${run.status}/${run.pausedFor}`);
    await signCurrent(s.recipeId, 'narration-text:fa', 'fa-native-editor');
    run = await (await s.engine.continueRun(run.id)).done;
    if (o.signListener !== false) await signCurrent(s.recipeId, 'voice:fa', 'fa-native-listener');
  }
  if (run.status !== 'done') throw new Error(`expected done, got ${run.status}/${run.pausedFor}`);
  return { ...s, run };
}
