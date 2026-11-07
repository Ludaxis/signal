// @vitest-environment node
// (connector part): with every fixture key set, the event lines every connector emits on a mock call (and the
// error text of failing live calls) contain no fixture key string, no `sk-ant-` and no `Authorization`. The full
// mock-run grep over events.jsonl needs the runner and is not covered here.
import '../guard';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callConnector } from '@/lib/studio/postmaker/connectors/allowed';
import { buildRegistry } from '@/lib/studio/postmaker/connectors';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { tmp } from '../guard';
import { setKeys } from './env';
import { ctxOf, FAKE_KEYS, FIXTURES, fakeFetch, fakeSpawn } from './fakes';

const REQUESTS: Record<string, unknown> = {
  'claude-cli': { prompt: 'x', kind: 'script', maxTurns: 2, budgetUsd: 1 },
  'agent-sdk': { role: 'reviewer', task: { prompt: 'x', schema: {} } },
  codex: { prompt: 'a card', width: 64, height: 80 },
  figma: { project: {}, fileKey: 'k', frameIds: [] },
  'higgsfield-image': { prompt: 'a card', aspectRatio: '9:16', width: 64, height: 112 },
  'higgsfield-video': { prompt: 'pan', imageFile: '/x.png', durationSec: 4, width: 64, height: 112 },
  elevenlabs: FIXTURES['elevenlabs-tts']!.request,
  'azure-speech': FIXTURES['azure-tts']!.request,
  sync: FIXTURES['sync-generate']!.request,
  hedra: FIXTURES['hedra-generate']!.request,
  'elevenlabs-music': FIXTURES['elevenlabs-music']!.request,
  'pack-music': { lengthMs: 1000, tempo: { bpm: 100, downbeatMs: 0 } },
  'owner-upload': { lengthMs: 1000, tempo: { bpm: 100, downbeatMs: 0 } },
  'browser-agent:suno': { inputs: {}, lengthMs: 1000, tempo: null },
};

/** A spawn that "renders" by writing the output path (the last argument) and exits 0. */
const writingSpawn = (): Spawn => {
  const base = fakeSpawn({ code: 0 }).spawn;
  return ((bin: string, args: string[], o: object) => {
    const out = args.at(-1)!;
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, 'mp4');
    return (base as unknown as (b: string, a: string[], o: object) => unknown)(bin, args, o);
  }) as unknown as Spawn;
};

const leaks = (text: string) => [...Object.values(FAKE_KEYS).filter((v) => v.length > 12 && text.includes(v)), ...(/sk-ant-/.test(text) ? ['sk-ant-'] : []), ...(/Authorization/i.test(text) ? ['Authorization'] : [])];

describe('connector event lines are redacted', () => {
  it('mock calls of every connector emit no key, no sk-ant- and no Authorization', async () => {
    setKeys();
    const lines: string[] = [];
    for (const c of buildRegistry()) {
      if (!(c.id in REQUESTS)) continue; // remotion (not installed) and ffmpeg (real local, no events)
      const ctx = ctxOf({ workDir: path.join(tmp.dir, 'work'), deps: { spawn: writingSpawn() } });
      const r = await callConnector(c, REQUESTS[c.id] as never, ctx);
      expect(r.mode, c.id).toBe('mock');
      lines.push(...ctx.events.map((e) => JSON.stringify(e)));
    }
    expect(lines.length).toBeGreaterThanOrEqual(14);
    expect(leaks(lines.join('\n'))).toEqual([]);
  });

  it('vendor errors that echo the key or the auth header are redacted before they reach an event or an error', async () => {
    setKeys();
    const echo = fakeFetch(() => ({ status: 500, json: { detail: `Authorization: Key ${FAKE_KEYS.HF_API_KEY_ID}:${FAKE_KEYS.HF_API_KEY_SECRET} xi-api-key: ${FAKE_KEYS.ELEVENLABS_API_KEY} ${FAKE_KEYS.SYNC_API_KEY} ${FAKE_KEYS.SIGNAL_ANTHROPIC_API_KEY}` } }));
    const reg = buildRegistry();
    const messages: string[] = [];
    for (const id of ['elevenlabs', 'azure-speech', 'sync', 'hedra', 'elevenlabs-music']) {
      const c = reg.find((x) => x.id === id)!;
      const ctx = ctxOf({ deps: { fetch: echo.fetch } });
      const err = (await c.invoke(REQUESTS[id] as never, ctx).catch((e: Error) => e)) as Error;
      messages.push(err.message, ...ctx.events.map((e) => e.text));
    }
    const all = messages.join('\n');
    expect(all).toMatch(/HTTP 500/);
    for (const v of Object.values(FAKE_KEYS)) if (v.length > 12) expect(all).not.toContain(v);
    expect(all).not.toMatch(/sk-ant-/);
  });
});
