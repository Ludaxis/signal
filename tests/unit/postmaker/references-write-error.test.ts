// @vitest-environment node
// review fix: a write error during an upload (disk full, I/O) must end the request with an error, remove the
// temp file and leave no unhandled rejection, whether it comes while the loop waits for 'drain' or for the next chunk.
import './guard';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addReferenceFile } from '@/lib/studio/postmaker/references';
import { tmp } from './guard';
import { mp4 } from './media-fixtures';

/** When set, the next createWriteStream returns a sink that fails on this chunk number (1-based) with ENOSPC. */
const failing = vi.hoisted(() => ({ onChunk: null as number | null, created: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((file: string, opts?: unknown) => {
    if (failing.onChunk === null) return (real.createWriteStream as (f: string, o?: unknown) => unknown)(file, opts);
    const at = failing.onChunk;
    failing.created.push(file);
    real.writeFileSync(file, ''); // the temp file exists, as with a real stream that opened before the disk filled
    let n = 0;
    return new Writable({
      highWaterMark: 16 * 1024,
      write(_chunk, _enc, cb) {
        n += 1;
        if (n >= at) return cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
        setTimeout(cb, 5); // slow enough that the 64 KB chunks fill the buffer and the loop waits for 'drain'
      },
    });
  }) as typeof real.createWriteStream;
  return { ...real, createWriteStream, default: { ...real, createWriteStream } };
});

const PROJECT = { timeZone: 'Europe/Berlin' };
const NOW = Date.parse('2026-11-06T10:00:00Z');
const stream = (buf: Buffer, size = 64 * 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size)));
      c.close();
    },
  });

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
beforeEach(() => {
  unhandled.length = 0;
  failing.onChunk = null;
  failing.created = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  failing.onChunk = null;
});

const incoming = () => path.join(tmp.root, 'refs', '.incoming');
const settle = () => new Promise((r) => setTimeout(r, 30));
const withTimeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('upload hung')), 3_000))]);

describe('reference upload write errors', () => {
  it('a write error on the second chunk ends the upload with that error and removes the temp file', async () => {
    failing.onChunk = 2;
    const body = Buffer.concat([mp4(), Buffer.alloc(1024 * 1024, 1)]);
    const err = await withTimeout(addReferenceFile(tmp.root, PROJECT, stream(body), { by: 'owner@example.test', now: NOW })).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ENOSPC/);
    expect(failing.created).toHaveLength(1);
    expect(existsSync(failing.created[0]!)).toBe(false);
    expect(readdirSync(incoming())).toEqual([]);
    expect(readdirSync(path.join(tmp.root, 'refs')).filter((n) => n !== '.incoming')).toEqual([]);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('a write error on the first chunk (small file, no drain wait) also ends the upload', async () => {
    failing.onChunk = 1;
    const err = await withTimeout(addReferenceFile(tmp.root, PROJECT, stream(mp4()), { by: 'owner@example.test', now: NOW })).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ENOSPC/);
    expect(readdirSync(incoming())).toEqual([]);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('an incoming folder that cannot be written answers with an error instead of hanging', async () => {
    mkdirSync(incoming(), { recursive: true });
    chmodSync(incoming(), 0o500);
    try {
      const body = Buffer.concat([mp4(), Buffer.alloc(512 * 1024, 1)]);
      const err = await withTimeout(addReferenceFile(tmp.root, PROJECT, stream(body), { by: 'owner@example.test', now: NOW })).catch((e: unknown) => e);
      expect((err as NodeJS.ErrnoException).code).toBe('EACCES');
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      chmodSync(incoming(), 0o700);
    }
    expect(readdirSync(incoming())).toEqual([]);
  });
});
