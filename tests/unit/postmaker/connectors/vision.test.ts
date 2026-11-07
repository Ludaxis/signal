// @vitest-environment node
// on the claude-cli connector: vision requests are refused by default; with the explicit allowVision
// option the temp cwd holds only the request's files and the argv is the vision argv. The non-vision argv is pinned
// byte for byte. Fake spawn only (no CLI process).
import '../guard';
import { readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { claudeCliArgs, makeCliConnectors } from '@/lib/studio/postmaker/connectors/cli';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { ctxOf } from './fakes';

const BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'];
const DENIED = 'Bash,Edit,Write,MultiEdit,NotebookEdit,Task,Agent,TodoWrite,Read,Glob,Grep,LS,NotebookRead,Skill,WebSearch,WebFetch';

function cwdSpawn() {
  const seen: { args: string[]; cwd: string; files: string[] }[] = [];
  const spawn = ((_bin: string, args: string[], opts: { cwd: string }) => {
    seen.push({ args, cwd: opts.cwd, files: readdirSync(opts.cwd).sort() });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ type: 'result', result: '```json\n{}\n```' }) + '\n');
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as Spawn;
  return { spawn, seen };
}

describe('claude-cli connector, vision mode', () => {
  it('pins the non-vision argv', () => {
    expect(claudeCliArgs({ maxTurns: 6, budgetUsd: 1.2, billing: 'api-key', model: 'opus' })).toEqual([...BASE, '--max-turns', '6', '--tools', '', '--disallowedTools', DENIED, '--max-budget-usd', '1.20', '--model', 'opus']);
    expect(claudeCliArgs({ maxTurns: 6, budgetUsd: 1.2, billing: 'subscription', vision: false })).toEqual([...BASE, '--max-turns', '6', '--tools', '', '--disallowedTools', DENIED]);
  });

  it('the vision argv allows Read only and keeps every other denial', () => {
    const a = claudeCliArgs({ maxTurns: 12, budgetUsd: 2, billing: 'subscription', vision: true });
    expect(a).toEqual([...BASE, '--max-turns', '12', '--tools', 'Read', '--disallowedTools', DENIED.replace('Read,', ''), '--allowedTools', 'Read']);
  });

  it('is refused by default, and files without vision are refused', async () => {
    const { spawn, seen } = cwdSpawn();
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude' });
    const req = { prompt: 'x', kind: 'analyse', maxTurns: 12, budgetUsd: 2, vision: true, files: [{ name: 'timeline.txt', data: 't' }] };
    await expect(claudeCli.invoke(req, ctxOf({ deps: { spawn } }))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
    await expect(claudeCli.invoke({ ...req, vision: false }, ctxOf({ deps: { spawn } }))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'validation'));
    expect(seen).toEqual([]);
  });

  it('with allowVision the cwd holds exactly the request files, and the temp folder is removed after', async () => {
    const { spawn, seen } = cwdSpawn();
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude', allowVision: true });
    const files = [{ name: 'sheet-1.jpg', data: new Uint8Array([1, 2, 3]) }, { name: 'timeline.txt', data: 'cuts 2.5 5 7.5' }];
    const r = await claudeCli.invoke({ prompt: 'x', kind: 'analyse', maxTurns: 12, budgetUsd: 2, vision: true, files }, ctxOf({ deps: { spawn } }));
    expect(r.mode).toBe('live');
    expect(seen[0]!.files).toEqual(['sheet-1.jpg', 'timeline.txt']);
    expect(seen[0]!.args).toEqual(claudeCliArgs({ maxTurns: 12, budgetUsd: 2, billing: 'subscription', vision: true }));
    expect(() => readdirSync(seen[0]!.cwd)).toThrow();
    await expect(claudeCli.invoke({ prompt: 'x', kind: 'analyse', maxTurns: 12, budgetUsd: 2, vision: true, files: [{ name: '../escape.txt', data: 'x' }] }, ctxOf({ deps: { spawn } }))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'validation'));
  });
});
