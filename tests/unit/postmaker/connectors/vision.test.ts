// @vitest-environment node
// on the claude-cli connector: vision requests are refused by default; with the explicit allowVision
// option the temp cwd holds only the request's files and the argv is the vision argv. The non-vision argv is pinned
// byte for byte. Fake spawn only (no CLI process).
import '../guard';
import { readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cliArgs, makeClaudeCliRunner, visionStdin, VISION_STDIN_NOTE } from '@/lib/studio/claude-agent';
import { connectorById } from '@/lib/studio/postmaker/connectors';
import { claudeCliArgs, makeCliConnectors } from '@/lib/studio/postmaker/connectors/cli';
import { connectorCanSee } from '@/lib/studio/postmaker/service';
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

describe('the stdin fallback (images as stream-json blocks on stdin)', () => {
  function stdinSpawn() {
    const seen: { args: string[]; files: string[]; stdin: string }[] = [];
    const spawn = ((_bin: string, args: string[], opts: { cwd: string }) => {
      const rec = { args, files: readdirSync(opts.cwd).sort(), stdin: '' };
      seen.push(rec);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('data', (d: Buffer) => (rec.stdin += d.toString()));
      child.kill = () => true;
      child.stdin.on('finish', () =>
        setImmediate(() => {
          child.stdout.end(JSON.stringify({ type: 'result', result: '```json\n{}\n```' }) + '\n');
          child.stderr.end();
          setImmediate(() => child.emit('close', 0));
        }),
      );
      return child;
    }) as unknown as Spawn;
    return { spawn, seen };
  }

  it('args snapshot: --input-format stream-json, no tool at all, Read stays denied; the non-vision argv is unchanged', () => {
    expect(claudeCliArgs({ maxTurns: 12, budgetUsd: 2, billing: 'subscription', vision: true, visionTransport: 'stdin' })).toEqual(['-p', '--input-format', 'stream-json', ...BASE.slice(1), '--max-turns', '12', '--tools', '', '--disallowedTools', DENIED]);
    expect(claudeCliArgs({ maxTurns: 6, budgetUsd: 1.2, billing: 'subscription', visionTransport: 'stdin' })).toEqual([...BASE, '--max-turns', '6', '--tools', '', '--disallowedTools', DENIED]);
    expect(cliArgs({ agent: 'deconstructor', web: false, billing: 'subscription', vision: true, visionTransport: 'stdin', kind: 'analyse' })).toEqual(['-p', '--input-format', 'stream-json', ...BASE.slice(1), '--max-turns', '12', '--tools', '', '--disallowedTools', DENIED]);
    expect(cliArgs({ agent: 'deconstructor', web: false, billing: 'subscription', vision: true, kind: 'analyse' })).toContain('--allowedTools'); // the files transport is unchanged
  });

  it('with a fake CLI: the cwd stays empty and stdin is one user message with the prompt, the image as base64 and the timeline as text', async () => {
    const { spawn, seen } = stdinSpawn();
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude', allowVision: true, visionTransport: 'stdin' });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const r = await claudeCli.invoke({ prompt: 'Read the reference.', kind: 'analyse', maxTurns: 12, budgetUsd: 2, vision: true, files: [{ name: 'sheet-1.jpg', data: jpg }, { name: 'timeline.txt', data: 'cuts: 2.50' }] }, ctxOf({ deps: { spawn } }));
    expect(r.mode).toBe('live');
    expect(seen[0]!.files).toEqual([]);
    expect(seen[0]!.args).toEqual(claudeCliArgs({ maxTurns: 12, budgetUsd: 2, billing: 'subscription', vision: true, visionTransport: 'stdin' }));
    const lines = seen[0]!.stdin.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `Read the reference.\n\n${VISION_STDIN_NOTE}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(jpg).toString('base64') } },
          { type: 'text', text: 'timeline.txt:\ncuts: 2.50' },
        ],
      },
    });
    expect(visionStdin('p', [{ name: 'a.png', data: new Uint8Array([1]) }])).toContain('"media_type":"image/png"');
    expect(() => visionStdin('p', [{ name: '../x.jpg', data: 'x' }])).toThrow();
  });

  it('still refused at runtime while vision is off (403), in the connector and in the Studio runner, before any process starts', async () => {
    const { spawn, seen } = stdinSpawn();
    const { claudeCli } = makeCliConnectors({ billing: async () => 'subscription', cliBin: async () => '/fake/claude', visionTransport: 'stdin' });
    await expect(claudeCli.invoke({ prompt: 'x', kind: 'analyse', maxTurns: 12, budgetUsd: 2, vision: true, files: [{ name: 'timeline.txt', data: 't' }] }, ctxOf({ deps: { spawn } }))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
    expect(seen).toEqual([]);
    const runner = makeClaudeCliRunner({ visionTransport: 'stdin' });
    await expect(runner('x', { web: false, agent: 'deconstructor', kind: 'analyse', vision: { files: [{ name: 'timeline.txt', data: 't' }] } })).rejects.toMatchObject({ status: 403 });
    // the registry's own connector is built without allowVision: the service still reads on this computer only
    expect(connectorCanSee(connectorById('claude-cli') as never)).toBe(false);
  });
});
