// Fixtures for the agent-team tests: a temp project root with every approval on, a fake Agent SDK
// query() that records the options it was given, and a tiny post package with real PNG slides.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Options, Query, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import type { QueryFn } from '@/lib/studio/team/runtime';

export const TEST_KEY = 'sk-ant-api03-signal-test-key-0000000000';
export const DECOYS: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-decoy', ANTHROPIC_AUTH_TOKEN: 'auth-decoy', ANTHROPIC_API_KEY: 'sk-ant-other-key-should-not-leak', ANTHROPIC_BASE_URL: 'https://proxy.example', GITHUB_TOKEN: 'gh-decoy', AWS_SECRET_ACCESS_KEY: 'aws-decoy' };
const ENV_KEYS = ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_PROMPTS_DIR', 'SIGNAL_ANTHROPIC_API_KEY', ...Object.keys(DECOYS)];

/** Temp root with posts/, switches (memory + agents + API key on) and the key; returns the root path. */
export function setupTeamRoot(o: { memoryTeam?: boolean; claudeAgents?: boolean; claudeApiKey?: boolean; key?: boolean } = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'signal-team-test-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_PROMPTS_DIR = path.join(root, 'agents');
  if (o.key !== false) process.env.SIGNAL_ANTHROPIC_API_KEY = TEST_KEY;
  for (const [k, v] of Object.entries(DECOYS)) process.env[k] = v;
  mkdirSync(path.join(root, 'posts'));
  writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: o.memoryTeam ?? true, claudeAgents: o.claudeAgents ?? true, claudeApiKey: o.claudeApiKey ?? true });
  return root;
}

export function cleanupTeamEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

export interface FakeCall { prompt: string; options: Options }
export type FakeResult = Partial<SDKResultMessage> & { structured_output?: unknown };

/** A fake query(): records every call and yields an init message followed by one result message. */
export function fakeQuery(result: FakeResult | ((call: FakeCall) => FakeResult), model = 'claude-sonnet-4-5-test'): { queryFn: QueryFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const call: FakeCall = { prompt: typeof params.prompt === 'string' ? params.prompt : '[stream]', options: params.options ?? {} };
    calls.push(call);
    const r = typeof result === 'function' ? result(call) : result;
    const base = { type: 'result', subtype: 'success', duration_ms: 1200, duration_api_ms: 1000, is_error: false, num_turns: 3, result: '', stop_reason: 'end_turn', total_cost_usd: 0.12, usage: {}, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-0000-0000-000000000001', session_id: 'sess-test' };
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      yield { type: 'system', subtype: 'init', model, cwd: call.options.cwd, tools: [], mcp_servers: [], apiKeySource: 'ANTHROPIC_API_KEY', permissionMode: 'dontAsk', claude_code_version: 'test', slash_commands: [], output_style: 'default', skills: [], plugins: [], uuid: '00000000-0000-0000-0000-000000000000', session_id: 'sess-test' } as unknown as SDKMessage;
      yield { ...base, ...r } as unknown as SDKMessage;
    }
    return gen() as unknown as Query;
  }) as unknown as QueryFn;
  return { queryFn, calls };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Writes a valid package (slides or reel cover) into <root>/posts/<id>. */
export async function makePackage(root: string, id: string, o: { format?: 'carousel' | 'image' | 'reel'; slides?: number; caption?: string; width?: number; height?: number } = {}): Promise<string> {
  const format = o.format ?? 'carousel';
  const dir = path.join(root, 'posts', id);
  mkdirSync(dir, { recursive: true });
  const files: { name: string; role: string; sha256: string }[] = [];
  const png = (c: { r: number; g: number; b: number }) => sharp({ create: { width: o.width ?? 1080, height: o.height ?? 1350, channels: 3, background: c } }).png().toBuffer();
  if (format === 'reel') {
    const cover = await png({ r: 20, g: 40, b: 200 });
    writeFileSync(path.join(dir, 'cover.png'), cover);
    files.push({ name: 'cover.png', role: 'cover', sha256: sha(cover) });
    const video = Buffer.from('not really a video');
    writeFileSync(path.join(dir, 'reel.mp4'), video);
    files.push({ name: 'reel.mp4', role: 'video', sha256: sha(video) });
  } else {
    for (let i = 1; i <= (o.slides ?? 2); i++) {
      const b = await png({ r: 200, g: 60 * i, b: 40 });
      writeFileSync(path.join(dir, `slide-${i}.png`), b);
      files.push({ name: `slide-${i}.png`, role: 'slide', sha256: sha(b) });
    }
  }
  const caption = Buffer.from(o.caption ?? 'Which 3 belong together? Answer in the comments.\n\nVisuals made with AI. #DemoBrand');
  writeFileSync(path.join(dir, 'caption.txt'), caption);
  files.push({ name: 'caption.txt', role: 'caption', sha256: sha(caption) });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ id, title: `Post ${id}`, format, destination: '@signal.demo', files, source: { generator: 'signal-template-v1', format: 'website-card', category: 'Fruit', items: ['apple', 'pear', 'plum'], distractors: [{ category: 'Tools', itemId: 'hammer' }], levels: [1], seed: 'x' } }, null, 2),
  );
  return dir;
}

/** A complete review the fake reviewer returns. */
export const SAMPLE_REVIEW = {
  briefMatch: 4,
  briefNotes: 'Hook and items match the brief.',
  answerUnambiguous: 0.92,
  answerNotes: 'Only the three fruits fit.',
  brandRules: [{ rule: 'Original visuals only', pass: true, note: 'Original artwork only.' }],
  visualQuality: 4,
  visualNotes: { firstFrame: 'Clear question in large type.', contrast: 'White on deep blue, fine.', legibility: 'Safe margins respected.', motion: 'n/a' },
  aiLabel: { pass: true, note: 'Label on slide 2 and in the caption.' },
  verdict: 'ready',
  fixes: ['Raise the headline 40 px.'],
  summary: 'A solid puzzle post; one small layout fix.',
};

export const SAMPLE_REPORT = { headline: 'Saves doubled on question hooks.', whatWorked: ['Question hooks: 1.6× saves (nEff 4.8).'], whatDidnt: ['Seasonal post reached more but saved less.'], recommendations: ['Plan two more question-hook reels this week.'], learningsChanged: ['Question hooks raise saves: confidence 0.71 (nEff 4.8).'] };
