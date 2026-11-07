// Connectors that run on this computer only: Figma export (read-only REST with the owner's own token), the
// Remotion renderer and ffmpeg loudness. They cost nothing; Remotion's own licence (a company licence above a size
// threshold) is yours to check; see the render workspace README.
//
// - figma: the existing figma.ts import (frames → PNG in the brand folder); test() is the free GET /v1/me check.
// - remotion: not installed in this checkout yet (brings the render child); status says so and invoke refuses
//   unless a renderer is injected. Its mock is the same local render ("real (local)").
// - ffmpeg: the bundled ffmpeg-static; test() runs `-version`; invoke measures loudness with loudnorm (JSON report).
import { existsSync } from 'node:fs';
// A namespace import on purpose: webpack rewrites calls of a named `createRequire` import and, with a non-literal
// argument, bundles `.resolve(id)` as an empty context that always throws, so Remotion read as not installed.
import * as nodeModule from 'node:module';
import ffmpegPath from 'ffmpeg-static';
import { figmaStatus, figmaWhoAmI, importFrames, type FigmaImport } from '../../figma';
import { t } from '@/app/studio/copy/en';
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import { READ_AT, type Fetch, type RegisteredConnector, type Spawn } from './base';
import { defineConnector } from './define';
import { minimalEnv } from './mock/video';

const FREE = (source: string) => ({ unit: 'none', usdPerUnit: 0, minimumUsd: 0, perCallCeilingUsd: 0, billing: 'none', verified: false, source, readAt: READ_AT }) as const;
const zero = (basis: string, seconds = 5) => ({ usdLow: 0, usdHigh: 0, seconds, basis });

// ---- figma -------------------------------------------------------------------------------------------------------

export interface FigmaExportRequest {
  project: Parameters<typeof importFrames>[0];
  fileKey: string;
  frameIds: string[];
}

export function makeFigma(deps: { fetch?: Fetch } = {}): RegisteredConnector<FigmaExportRequest, { imports: FigmaImport[]; mode: 'live' | 'mock' }> {
  const c: RegisteredConnector<FigmaExportRequest, { imports: FigmaImport[]; mode: 'live' | 'mock' }> = defineConnector<FigmaExportRequest, { imports: FigmaImport[]; mode: 'live' | 'mock' }>({
    id: 'figma',
    title: 'Figma',
    kind: 'api',
    group: 'making',
    capabilities: [{ id: 'image.export', source: 'figma.ts (api.figma.com/v1, read-only)', readAt: READ_AT }],
    costModel: { ...FREE('figma.ts: read-only REST with your own token, no charge') },
    attendance: 'any',
    settingsGroup: null,
    feature: 'postmaker',
    gates: [],
    keyPresent: async () => (await figmaStatus()).connected,
    test: async () => {
      const who = await figmaWhoAmI(deps.fetch ?? globalThis.fetch).catch(() => undefined);
      if (who === null) return { ok: false, text: t('notice.serviceNeedsKey', { service: 'Figma' }), costUsd: 0 };
      if (who === undefined) return { ok: false, text: t('connector.checkFailed', { service: 'Figma' }), costUsd: 0 };
      return { ok: true, text: t('connector.works', { service: 'Figma' }), costUsd: 0 };
    },
    estimate: (r) => zero(`${r.frameIds.length} frames`, 10),
    async invoke(r, ctx) {
      return { imports: await importFrames(r.project, r.fileKey, r.frameIds, ctx.deps.fetch ?? deps.fetch ?? globalThis.fetch), mode: 'live' };
    },
    // Export is free and read-only, but a mock run still makes nothing outside its work folder.
    mock: async () => ({ imports: [], mode: 'mock' }),
  });
  return c;
}

// ---- remotion ----------------------------------------------------------------------------------------------------

export interface RenderRequest {
  composition: string;
  props: Record<string, unknown>;
  out: string;
  frames: number;
}
export type Renderer = (r: RenderRequest, ctx: InvokeCtx) => Promise<{ file: string; frames: number }>;

export function makeRemotion(deps: { render?: Renderer; resolve?: (id: string) => string } = {}): RegisteredConnector<RenderRequest, { file: string; frames: number; mode: 'live' | 'mock' }> {
  const resolve = deps.resolve ?? ((id: string) => nodeModule.createRequire(import.meta.url).resolve(id));
  const installed = () => {
    try {
      resolve('@remotion/renderer');
      return true;
    } catch {
      return false;
    }
  };
  const run = async (r: RenderRequest, ctx: InvokeCtx, mode: 'live' | 'mock') => {
    if (!deps.render) throw new PostmakerError(503, 'not_installed', t('connector.notInstalled', { service: 'Remotion' }));
    return { ...(await deps.render(r, ctx)), mode };
  };
  return defineConnector<RenderRequest, { file: string; frames: number; mode: 'live' | 'mock' }>({
    id: 'remotion',
    title: 'Remotion',
    kind: 'local',
    group: 'making',
    capabilities: [
      { id: 'render.video', source: 'https://www.remotion.dev/docs/ssr-node.md', readAt: READ_AT },
      { id: 'render.audio', source: 'https://www.remotion.dev/docs/media/audio', readAt: READ_AT },
    ],
    costModel: { ...FREE('licence decision pending (memo); evaluation and mock renders are free') },
    attendance: 'any',
    settingsGroup: null,
    feature: 'postmaker',
    gates: [],
    probe: async () => ({ installed: installed() && Boolean(deps.render), signedIn: null, version: null }),
    test: async () => (installed() && deps.render ? { ok: true, text: t('connector.works', { service: 'Remotion' }), costUsd: 0 } : { ok: false, text: t('connector.notInstalled', { service: 'Remotion' }), costUsd: 0 }),
    estimate: (r) => zero(`${r.frames} frames`, Math.ceil(r.frames / 15)),
    invoke: (r, ctx) => run(r, ctx, 'live'),
    mock: (r, ctx) => run(r, ctx, 'mock'),
  });
}

// ---- ffmpeg ------------------------------------------------------------------------------------------------------

export interface Loudness {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

/** Arguments that measure loudness only (no output file). Exported for tests. */
export const loudnormArgs = (file: string, o: { i?: number; tp?: number; lra?: number } = {}) => ['-hide_banner', '-nostats', '-i', file, '-af', `loudnorm=I=${o.i ?? -14}:TP=${o.tp ?? -1}:LRA=${o.lra ?? 11}:print_format=json`, '-f', 'null', '-'];

/** Reads the JSON block loudnorm prints at the end of stderr. */
export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  let j: Record<string, unknown> | null = null;
  try {
    j = start >= 0 && end > start ? (JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>) : null;
  } catch {
    j = null;
  }
  const n = (k: string) => {
    const v = Number(j?.[k]);
    if (!Number.isFinite(v)) throw new PostmakerError(502, 'ffmpeg', 'ffmpeg did not report loudness.');
    return v;
  };
  return { inputI: n('input_i'), inputTp: n('input_tp'), inputLra: n('input_lra'), inputThresh: n('input_thresh'), targetOffset: n('target_offset') };
}

function capture(spawn: Spawn, bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv() as NodeJS.ProcessEnv, signal });
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.stdout?.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-8000)));
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-16000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

export function makeFfmpeg(deps: { bin?: string | null; spawn?: Spawn } = {}): RegisteredConnector<{ file: string }, { loudness: Loudness; mode: 'live' | 'mock' }> {
  const bin = deps.bin === undefined ? ffmpegPath : deps.bin;
  const sp = async (ctx?: InvokeCtx) => ctx?.deps.spawn ?? deps.spawn ?? (await import('node:child_process')).spawn;
  const measure = async (r: { file: string }, ctx: InvokeCtx, mode: 'live' | 'mock') => {
    if (!bin) throw new PostmakerError(503, 'not_installed', t('connector.notInstalled', { service: 'ffmpeg' }));
    const res = await capture(await sp(ctx), bin, loudnormArgs(r.file), ctx.signal);
    if (res.code !== 0) throw new PostmakerError(500, 'ffmpeg', `ffmpeg exited with ${res.code}.`);
    return { loudness: parseLoudnorm(res.err), mode };
  };
  return defineConnector<{ file: string }, { loudness: Loudness; mode: 'live' | 'mock' }>({
    id: 'ffmpeg',
    title: 'ffmpeg',
    kind: 'local',
    group: 'making',
    capabilities: [{ id: 'audio.loudness', source: 'https://ffmpeg.org/ffmpeg-filters.html#loudnorm', readAt: READ_AT }],
    costModel: { ...FREE('ffmpeg-static (bundled, free software)') },
    attendance: 'any',
    settingsGroup: null,
    feature: 'postmaker',
    gates: [],
    probe: async () => ({ installed: Boolean(bin && existsSync(bin)), signedIn: null, version: null }),
    test: async () => {
      if (!bin) return { ok: false, text: t('connector.notInstalled', { service: 'ffmpeg' }), costUsd: 0 };
      const r = await capture(await sp(), bin, ['-hide_banner', '-version']).catch(() => null);
      return r?.code === 0 ? { ok: true, text: t('connector.works', { service: 'ffmpeg' }), costUsd: 0 } : { ok: false, text: t('connector.checkFailed', { service: 'ffmpeg' }), costUsd: 0 };
    },
    estimate: () => zero('local measurement'),
    invoke: (r, ctx) => measure(r, ctx, 'live'),
    mock: (r, ctx) => measure(r, ctx, 'mock'), //: ffmpeg mock is the real bundled ffmpeg
  });
}
