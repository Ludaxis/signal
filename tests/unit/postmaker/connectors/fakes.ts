// Test doubles for the connector suite ("fakes"): a recording fetch, a scripted child process, an InvokeCtx
// and a scripted browser driver. Everything is synthetic; nothing reaches a network or a real binary.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { InvokeCtx } from '@/lib/studio/postmaker/types';
import type { BrowserDriver, BrowserEvent, BrowserSession, BrowserTask, BrowserTaskOutcome } from '@/lib/studio/postmaker/browser-agent/driver';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';

export const FIXTURES = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/vendors.json'), 'utf8')) as Record<string, Record<string, unknown> & { call: { method: string; url: string; headers: Record<string, string>; body: unknown } }>;

/** Synthetic key strings (never real); the redaction tests grep for them. */
export const FAKE_KEYS = {
  ELEVENLABS_API_KEY: 'fixture-elevenlabs-key-0000000000aaaa',
  AZURE_SPEECH_KEY: 'FixtureAzureKey00000000000000000000bbbb',
  AZURE_SPEECH_REGION: 'westeurope',
  SYNC_API_KEY: 'fixture-sync-key-000000cccc',
  HEDRA_API_KEY: 'fixture-hedra-key-00000dddd',
  HF_API_KEY_ID: 'fixture-hf-id-0000eeee',
  HF_API_KEY_SECRET: 'fixture-hf-secret-0000ffff',
  SIGNAL_ANTHROPIC_API_KEY: 'sk-ant-fixture-000000000000000000000000gggg',
  UPLOAD_POST_API_KEY: 'fixture-upload-post-key-hhhh',
  R2_SECRET_ACCESS_KEY: 'FixtureR2Secret000000000000iiii',
  META_APP_SECRET: 'FixtureMetaSecret0000jjjj',
} as const;

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Answer = { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> };

/** A fetch that records every call and answers from `route(url, method)`; an unknown route throws. */
export function fakeFetch(route: (url: string, method: string, n: number) => Answer | undefined) {
  const calls: Recorded[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({ url, method, headers, body: typeof init.body === 'string' ? init.body : undefined });
    const a = route(url, method, calls.length);
    if (!a) throw new Error(`fake fetch: no route for ${method} ${url}`);
    const body = a.bytes ?? Buffer.from(a.json === undefined ? '' : JSON.stringify(a.json));
    return new Response(new Uint8Array(body), { status: a.status ?? 200, headers: { 'content-type': a.bytes ? 'application/octet-stream' : 'application/json', ...(a.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export function ctxOf(o: Partial<InvokeCtx> & { deps?: InvokeCtx['deps'] } = {}): InvokeCtx & { events: { kind: string; text: string }[] } {
  const events: { kind: string; text: string }[] = [];
  return {
    runId: 'run-20261106-101500-ab12',
    nodeId: 'voice:fa',
    signal: new AbortController().signal,
    workDir: '/nonexistent-work',
    onEvent: (e: { kind: string; text: string }) => events.push(e),
    idempotencyKey: 'run-20261106-101500-ab12:voice:fa:v1',
    ...o,
    deps: { sleep: async () => undefined, ...(o.deps ?? {}) },
    events,
  } as InvokeCtx & { events: { kind: string; text: string }[] };
}

export interface SpawnCall {
  bin: string;
  args: string[];
  env: Record<string, string | undefined>;
  stdin: string;
}

/** A spawn that records the call and plays scripted stdout lines, then exits with `code`. */
export function fakeSpawn(script: { stdout?: string[]; stderr?: string; code?: number } = {}) {
  const calls: SpawnCall[] = [];
  const spawn = ((bin: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    const call: SpawnCall = { bin, args, env: { ...(opts?.env ?? {}) }, stdin: '' };
    calls.push(call);
    child.stdin.on('data', (d: Buffer) => (call.stdin += d.toString()));
    setImmediate(() => {
      for (const l of script.stdout ?? []) child.stdout.write(l + '\n');
      if (script.stderr) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', script.code ?? 0));
    });
    return child;
  }) as unknown as Spawn;
  return { spawn, calls };
}

/** A scripted browser driver: each step is an event (plus an optional screenshot label and a file to create). */
export interface FakeStep {
  event: Omit<BrowserEvent, 'seq' | 'at'>;
  /** The page after this step; equal labels mean "nothing changed". */
  page?: string;
  /** Writes this file (inside the download folder) before the event is reported. */
  write?: { file: string; bytes: Buffer };
}

export function fakeDriver(steps: FakeStep[], o: { outcome?: BrowserTaskOutcome; throwAt?: number } = {}) {
  const seen: { task: BrowserTask | null; events: BrowserEvent[]; stopped: boolean; aborted: boolean; started: number } = { task: null, events: [], stopped: false, aborted: false, started: 0 };
  let page = 'start';
  const driver: BrowserDriver = {
    async start() {
      seen.started++;
      const session: BrowserSession = {
        async runTask(task, onEvent, signal) {
          seen.task = task;
          for (let i = 0; i < steps.length; i++) {
            if (signal.aborted) {
              seen.aborted = true;
              return { ok: false, error: 'aborted' };
            }
            if (o.throwAt === i) throw new Error('driver crashed');
            const s = steps[i]!;
            if (s.write) {
              const { mkdirSync, writeFileSync } = await import('node:fs');
              mkdirSync(path.dirname(s.write.file), { recursive: true });
              writeFileSync(s.write.file, s.write.bytes);
            }
            if (s.page) page = s.page;
            const e: BrowserEvent = { seq: i, at: '2026-11-06T10:00:00.000Z', ...s.event };
            seen.events.push(e);
            await onEvent(e);
          }
          if (signal.aborted) seen.aborted = true;
          return o.outcome ?? { ok: !signal.aborted };
        },
        async screenshot() {
          return Buffer.from(`png:${page}`);
        },
        async stop() {
          seen.stopped = true;
        },
      };
      return session;
    },
  };
  return { driver, seen };
}
