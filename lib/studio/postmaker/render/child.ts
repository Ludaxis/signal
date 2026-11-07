// The render child process: `node child.ts <job.json>`. It runs outside the Next.js server
// so a Chrome crash never takes the server down and the desktop app can kill it on quit. It bundles the
// compositions once per implVersion (cached under <cacheDir>/remotion-bundle/<hash>/), copies the job's files (fonts,
// audio) into the bundle's public folder, renders each task (renderMedia / renderStill) and writes <job>.result.json
// with timings and the render log. Remotion comes from the optional render workspace's install.
// Only node builtins are imported here (Node runs this file with type stripping); no licence key is ever passed (a
// key makes Remotion send a usage event).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export interface MediaTask {
  kind: 'media';
  composition: 'StorySpine' | 'AudioMaster';
  props: Record<string, unknown>;
  out: string;
  codec: 'h264' | 'wav';
  crf?: number;
  frameRange?: [number, number] | null;
  scale?: number;
  muted?: boolean;
}

export interface StillTask {
  kind: 'still';
  /** CharacterTest: the cut-out character test composition (goldens and pivot checks only). */
  composition: 'StorySpine' | 'CharacterTest';
  props: Record<string, unknown>;
  out: string;
  frame: number;
  scale?: number;
  imageFormat: 'png' | 'jpeg';
}

export interface ChildJob {
  schema: 'signal.pm.render-job/1';
  jobId: string;
  renderServiceDir: string;
  entryPoint: string;
  implVersion: string;
  cacheDir: string;
  publicFiles: { from: string; to: string }[];
  browserExecutable: string | null;
  concurrency: number | null;
  tasks: (MediaTask | StillTask)[];
}

export interface ChildResult {
  ok: boolean;
  bundleMs: number;
  bundleCached: boolean;
  tasks: { out: string; ms: number; frames: number | null }[];
  log: string[];
  error: string | null;
}

type WebpackConfig = { resolve?: { alias?: unknown; modules?: string[] } & Record<string, unknown> } & Record<string, unknown>;
interface RemotionRenderer {
  selectComposition(o: Record<string, unknown>): Promise<{ durationInFrames: number } & Record<string, unknown>>;
  renderStill(o: Record<string, unknown>): Promise<unknown>;
  renderMedia(o: Record<string, unknown>): Promise<unknown>;
}

export const defaultConcurrency = () => Math.max(1, Math.floor(os.cpus().length / 2));

export const bundleKey = (implVersion: string, entryPoint: string) => createHash('sha256').update(`${implVersion}\n${path.resolve(entryPoint)}`).digest('hex').slice(0, 16);

async function main(jobFile: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobFile, 'utf8')) as ChildJob;
  const resultFile = jobFile.replace(/\.json$/, '') + '.result.json';
  const log: string[] = [];
  const result: ChildResult = { ok: false, bundleMs: 0, bundleCached: false, tasks: [], log, error: null };
  try {
    const req = createRequire(path.join(job.renderServiceDir, 'package.json'));
    const nm = path.join(job.renderServiceDir, 'node_modules');
    const { bundle } = req('@remotion/bundler') as { bundle: (o: Record<string, unknown> & { webpackOverride: (c: WebpackConfig) => WebpackConfig }) => Promise<string> };
    const renderer = req('@remotion/renderer') as RemotionRenderer;
    const outDir = path.join(job.cacheDir, 'remotion-bundle', bundleKey(job.implVersion, job.entryPoint));
    const t0 = Date.now();
    if (existsSync(path.join(outDir, 'index.html'))) result.bundleCached = true;
    else {
      mkdirSync(path.dirname(outDir), { recursive: true });
      const empty = path.join(job.cacheDir, 'remotion-public-empty');
      mkdirSync(empty, { recursive: true });
      await bundle({
        entryPoint: job.entryPoint,
        outDir,
        publicDir: empty,
        enableCaching: true,
        webpackOverride: (c) => ({
          ...c,
          resolve: {
            ...c.resolve,
            modules: [nm, 'node_modules'],
            alias: { ...((c.resolve?.alias as Record<string, string>) ?? {}), remotion: path.join(nm, 'remotion'), react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom') },
          },
        }),
      });
    }
    result.bundleMs = Date.now() - t0;
    log.push(`bundle ${result.bundleCached ? 'cached' : 'built'} ${outDir} in ${result.bundleMs} ms`);
    const publicJob = path.join(outDir, 'public');
    for (const f of job.publicFiles) {
      const to = path.join(publicJob, f.to);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(f.from, to);
    }
    const common = { serveUrl: outDir, browserExecutable: job.browserExecutable, chromeMode: 'headless-shell' as const, logLevel: 'error' as const };
    for (const t of job.tasks) {
      const s = Date.now();
      const composition = await renderer.selectComposition({ ...common, id: t.composition, inputProps: t.props });
      mkdirSync(path.dirname(t.out), { recursive: true });
      if (t.kind === 'still') {
        await renderer.renderStill({ ...common, composition, inputProps: t.props, output: t.out, frame: t.frame, imageFormat: t.imageFormat, scale: t.scale ?? 1, overwrite: true });
        result.tasks.push({ out: t.out, ms: Date.now() - s, frames: 1 });
      } else {
        const video = t.codec === 'h264';
        await renderer.renderMedia({
          ...common,
          composition,
          inputProps: t.props,
          codec: t.codec,
          outputLocation: t.out,
          overwrite: true,
          concurrency: job.concurrency ?? defaultConcurrency(),
          frameRange: t.frameRange ?? null,
          scale: t.scale ?? 1,
          muted: t.muted ?? false,
          ...(video ? { crf: t.crf ?? 18, pixelFormat: 'yuv420p' as const, colorSpace: 'bt709' as const, imageFormat: 'jpeg' as const, jpegQuality: 95, audioCodec: 'aac' as const, audioBitrate: '192k', enforceAudioTrack: !t.muted } : {}),
        });
        const frames = t.frameRange ? t.frameRange[1] - t.frameRange[0] + 1 : composition.durationInFrames;
        result.tasks.push({ out: t.out, ms: Date.now() - s, frames });
      }
      log.push(`${t.kind} ${t.composition} → ${path.basename(t.out)} in ${Date.now() - s} ms`);
    }
    for (const f of job.publicFiles) if (f.to.startsWith('jobs/')) rmSync(path.join(publicJob, f.to), { force: true });
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? `${e.message}` : String(e);
  }
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

const self = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (self.endsWith(`${path.sep}child.ts`) && process.argv[2]) void main(process.argv[2]);
