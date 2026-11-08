// The parent side of the render chain: writes a job file, starts `node render/child.ts <job>` with a minimal
// environment, waits and reads the result. `fakeRenderChain` is the CI double (a 2-frame
// MP4 per video task, silent WAV per audio task, a flat PNG/JPEG per still), so tests never start Chrome.
// `remotionRenderer` adapts a chain to remotion connector (`makeRemotion({ render })`).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import type { Renderer, RenderRequest } from '../connectors/local';
import { sineWav } from '../connectors/mock/audio';
import type { ChildJob, ChildResult, MediaTask, StillTask } from './child';
import { fakeMp4 } from './fakeMp4';
import { appDir, renderServiceDir } from './fonts';

export const RENDER_IMPL_VERSION = 'postmaker-render@1';

/**
 * The child's default render concurrency, for the render log. Same rule as render/child.ts's own copy: the server
 * must not import values from child.ts, which would bundle the child process (and its createRequire) into a route.
 */
export const defaultConcurrency = () => Math.max(1, Math.floor(os.cpus().length / 2));

export type RenderTask = MediaTask | StillTask;

export interface RenderChain {
  /** 'remotion' for the real child process, 'fake' for the CI double. */
  id: 'remotion' | 'fake';
  run(tasks: RenderTask[], o: { publicFiles: { from: string; to: string }[]; workDir: string; signal?: AbortSignal }): Promise<ChildResult & { jobId: string }>;
}

export interface ChildRendererOptions {
  /** Chrome Headless Shell to use (Remotion `browserExecutable`); null = Remotion's own download. */
  browserExecutable?: string | null;
  cacheDir: string;
  nodeBin?: string;
  renderServiceDir?: string;
  spawn?: typeof import('node:child_process').spawn;
  concurrency?: number | null;
  timeoutMs?: number;
  implVersion?: string;
}

/**
 * The bundle cache key's source part: a hash of every file the bundle is built from (the render folder), so a code
 * change never renders with a stale cached bundle even when `implVersion` was not bumped. The anim/ folder (the
 * cut-out solver CutoutCharacter imports) is hashed with it.
 */
export function renderSourceHash(dir = path.join(appDir(), 'lib/studio/postmaker/render'), extra: string[] = [path.join(appDir(), 'lib/studio/postmaker/anim')]): string {
  const h = createHash('sha256');
  const walk = (root: string, d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(root, p);
      else if (/\.(ts|tsx)$/.test(name)) h.update(`${path.relative(root, p)}\n`).update(readFileSync(p));
    }
  };
  walk(dir, dir);
  // the cut-out character system (anim/) is bundled with the compositions, so its sources key the bundle too
  for (const d of extra) if (existsSync(d)) walk(path.dirname(d), d);
  return h.digest('hex').slice(0, 12);
}

export const childEntry = () => path.join(appDir(), 'lib/studio/postmaker/render/child.ts');
export const compositionsEntry = () => path.join(appDir(), 'lib/studio/postmaker/render/compositions/index.ts');

/** Whether Remotion is installed for the render child (the render workspace's node_modules). */
export function renderInstalled(dir = renderServiceDir()): boolean {
  return existsSync(path.join(dir, 'node_modules/@remotion/renderer/package.json')) && existsSync(path.join(dir, 'node_modules/@remotion/bundler/package.json'));
}

/** The environment the child gets: PATH, HOME and TMPDIR only (no keys, CLI_ENV_ALLOW style). */
export const childEnv = (): Record<string, string> => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const k of ['HOME', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
};

/** Whether a configured browserExecutable is an existing regular file (a folder or a missing path is refused). */
export function browserFileOk(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function makeChildRenderChain(o: ChildRendererOptions): RenderChain {
  return {
    id: 'remotion',
    async run(tasks, r) {
      const service = o.renderServiceDir ?? renderServiceDir();
      // Never let Remotion download a browser on its own: a configured Chrome Headless Shell, or one installed by
      // a person with `npm run browser:ensure` in the render workspace.
      if (!o.browserExecutable && !existsSync(path.join(service, 'node_modules/.remotion'))) {
        throw new PostmakerError(503, 'not_installed', 'The render browser is not installed on this computer.');
      }
      // A folder (or a missing path) here made Remotion wait silently after bundling; fail fast instead.
      if (o.browserExecutable && !browserFileOk(o.browserExecutable)) {
        throw new PostmakerError(503, 'not_installed', 'The render browser setting must name the Chrome Headless Shell program file, not a folder.');
      }
      const jobId = randomUUID().slice(0, 8);
      mkdirSync(r.workDir, { recursive: true });
      const jobFile = path.join(r.workDir, `render-job-${jobId}.json`);
      const job: ChildJob = {
        schema: 'signal.pm.render-job/1',
        jobId,
        renderServiceDir: service,
        entryPoint: compositionsEntry(),
        implVersion: `${o.implVersion ?? RENDER_IMPL_VERSION}+${renderSourceHash()}`,
        cacheDir: o.cacheDir,
        publicFiles: r.publicFiles,
        browserExecutable: o.browserExecutable ?? null,
        concurrency: o.concurrency ?? null,
        tasks,
      };
      writeFileSync(jobFile, JSON.stringify(job));
      const spawn = o.spawn ?? (await import('node:child_process')).spawn;
      const code = await new Promise<number | null>((resolve, reject) => {
        const p = spawn(o.nodeBin ?? process.execPath, ['--no-warnings', childEntry(), jobFile], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() as NodeJS.ProcessEnv, signal: r.signal });
        const timer = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 30 * 60_000);
        p.stdout?.resume();
        p.stderr?.resume();
        p.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        p.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      const resultFile = jobFile.replace(/\.json$/, '') + '.result.json';
      if (!existsSync(resultFile)) throw new PostmakerError(500, 'render', `The renderer stopped (exit ${code}).`);
      const result = JSON.parse(readFileSync(resultFile, 'utf8')) as ChildResult;
      if (!result.ok) throw new PostmakerError(500, 'render', `The renderer failed: ${(result.error ?? '').slice(0, 300)}`);
      return { ...result, jobId };
    },
  };
}

const silentWav = (frames: number) => sineWav(Math.max(1, Math.round((frames * 1000) / 30)), { amplitude: 0 });

/** The CI double: no Chrome, no child process. Frames are reported as the composition length the task asked for. */
export function fakeRenderChain(): RenderChain {
  return {
    id: 'fake',
    async run(tasks) {
      const out: ChildResult['tasks'] = [];
      for (const t of tasks) {
        mkdirSync(path.dirname(t.out), { recursive: true });
        const frames = framesOf(t);
        if (t.kind === 'still') {
          const img = sharp({ create: { width: Math.round(1080 * (t.scale ?? 1)), height: Math.round(1920 * (t.scale ?? 1)), channels: 3, background: { r: 128, g: 128, b: 128 } } });
          writeFileSync(t.out, await (t.imageFormat === 'png' ? img.png() : img.jpeg()).toBuffer());
        } else if (t.codec === 'wav') writeFileSync(t.out, silentWav(frames ?? 30));
        else writeFileSync(t.out, fakeMp4());
        out.push({ out: t.out, ms: 0, frames: t.kind === 'media' && t.codec === 'h264' ? 2 : frames });
      }
      return { ok: true, bundleMs: 0, bundleCached: true, tasks: out, log: ['fake renderer (2-frame MP4)'], error: null, jobId: 'fake' };
    },
  };
}

function framesOf(t: RenderTask): number | null {
  const p = t.props as { timeline?: { durationInFrames?: number }; plan?: { durationFrames?: number } };
  if (t.kind === 'still') return 1;
  if (t.frameRange) return t.frameRange[1] - t.frameRange[0] + 1;
  return p.timeline?.durationInFrames ?? p.plan?.durationFrames ?? null;
}

/** connector renderer: one media task per request (composition + props → file). */
export function remotionRenderer(chain: RenderChain): Renderer {
  return async (r: RenderRequest, ctx: InvokeCtx) => {
    const codec = r.composition === 'AudioMaster' ? 'wav' : 'h264';
    const res = await chain.run([{ kind: 'media', composition: r.composition as MediaTask['composition'], props: r.props, out: r.out, codec }], { publicFiles: [], workDir: ctx.workDir, signal: ctx.signal });
    return { file: r.out, frames: res.tasks[0]?.frames ?? r.frames };
  };
}

/** The registry's renderer for the remotion connector: the child process, when Remotion is installed. */
export function defaultRenderChain(env: NodeJS.ProcessEnv = process.env): RenderChain | null {
  if (!renderInstalled()) return null;
  return makeChildRenderChain({
    browserExecutable: env.SIGNAL_RENDER_BROWSER || null,
    cacheDir: env.SIGNAL_RENDER_CACHE_DIR || path.join(os.tmpdir(), 'signal-postmaker-cache'),
  });
}
