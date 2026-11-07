// Shared dependencies of the render-chain executors (compose, mix, render): the renderer (the child process or the
// CI fake), ffmpeg for loudness and frame counts, the object reader for media inputs, a work folder and the faces.
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { Spawn } from '../connectors/base';
import { resolveFonts, type FontFile } from '../render/fonts';
import { fakeRenderChain, type RenderChain } from '../render/renderer';
import type { TimelineFont } from '../render/timeline';
import type { ExecInput, ExecUpstream } from './types';

export interface RenderChainDeps {
  chain: RenderChain;
  /** ffmpeg for loudness and frame counts; null = not measured (CI with the fake renderer). */
  ffmpeg: { bin: string; spawn?: Spawn } | null;
  /** Bytes of a stored object (media inputs); undefined = media inputs are synthesised (mock voices, click track). */
  readObject?: (sha: string) => Promise<Buffer>;
  /** Work folder per run and node. */
  workDir: (runId: string, nodeId: string) => string;
  /** Faces for the render (pack faces when the caller has a pack). */
  fonts: () => FontFile[];
}

export function renderChainDeps(o: Partial<RenderChainDeps> = {}): RenderChainDeps {
  return {
    chain: o.chain ?? fakeRenderChain(),
    ffmpeg: o.ffmpeg === undefined ? (ffmpegPath ? { bin: ffmpegPath } : null) : o.ffmpeg,
    readObject: o.readObject,
    workDir: o.workDir ?? ((runId, nodeId) => path.join(os.tmpdir(), 'signal-pm-render', runId, nodeId.replace(/[^a-z0-9-]/gi, '-'))),
    fonts: o.fonts ?? (() => resolveFonts().fonts),
  };
}

export const workDirOf = (d: RenderChainDeps, i: Pick<ExecInput, 'runId' | 'node'>) => {
  const dir = d.workDir(i.runId, i.node.id);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A mock anywhere in the lineage (the engine makes a node mock when any upstream is): MOCK on every frame. */
export const lineageMock = (i: Pick<ExecInput, 'mode' | 'inputs'>) => i.mode === 'mock' || i.inputs.some((u) => u.version.mode === 'mock');

export const timelineFonts = (fonts: FontFile[]): TimelineFont[] => fonts.map((f) => ({ family: f.family, role: f.role, src: f.src, sha256: f.sha256, weights: f.weights }));
export const fontPublicFiles = (fonts: FontFile[]) => fonts.map((f) => ({ from: f.file, to: f.src }));

export const spawnOf = async (d: RenderChainDeps) => d.ffmpeg?.spawn ?? (await import('node:child_process')).spawn;

/** Media refs of an input port (for example the voice `audio` port: one WAV per line). */
export const mediaRefs = (inputs: ExecUpstream[], port: string) => inputs.filter((u) => u.port === port).flatMap((u) => u.refs.filter((r) => r.kind !== 'json'));

/** Line lengths (ms) from the voice `audio` refs (`voice.<lang>.<lineId>.wav`, meta.durationMs). */
export function lineMsOf(inputs: ExecUpstream[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mediaRefs(inputs, 'audio')) {
    const m = /\.(l\d+)\.wav$/.exec(r.name);
    if (m && r.meta?.durationMs) out[m[1]!] = r.meta.durationMs;
  }
  return out;
}

/** The line id of a voice ref name, or null. */
export const lineIdOf = (name: string) => /\.(l\d+)\.wav$/.exec(name)?.[1] ?? null;
