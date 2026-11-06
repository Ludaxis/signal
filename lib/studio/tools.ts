// Server-only: where the Claude Code and Codex CLIs live on this machine.
//
// Order: CLAUDE_BIN / CODEX_BIN in the environment, then a path you saved in Connections
// (<SIGNAL_DATA_DIR>/tools.json), then the plain command name looked up on PATH. The Mac app
// passes your login shell's PATH, so CLIs installed with Homebrew, npm or the official installers
// are found even when Signal is opened from Finder. Read-only: nothing here runs a model.
import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './local-data';

export type Cli = 'claude' | 'codex';
export const CLI_LABEL: Record<Cli, string> = { claude: 'Claude Code', codex: 'Codex CLI' };
const ENV: Record<Cli, string> = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN' };

const toolsFile = () => path.join(dataDir(), 'tools.json');
interface ToolsFile { v: 1; bins: Partial<Record<Cli, string>> }

async function readTools(): Promise<ToolsFile> {
  try {
    const j = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ toolsFile(), 'utf8')) as ToolsFile;
    return j?.v === 1 && j.bins && typeof j.bins === 'object' ? j : { v: 1, bins: {} };
  } catch {
    return { v: 1, bins: {} };
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(/* turbopackIgnore: true */ p);
    if (!st.isFile()) return false;
    await fs.access(/* turbopackIgnore: true */ p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command or full path to run for a CLI. */
export async function cliBin(cli: Cli): Promise<string> {
  const env = (process.env[ENV[cli]] ?? '').trim();
  if (env) return env;
  const saved = (await readTools()).bins[cli];
  return saved || cli;
}

/** Where a command resolves on PATH (like `which`), or null. Exported for tests. */
export async function resolveOnPath(bin: string, envPath = process.env.PATH ?? ''): Promise<string | null> {
  if (bin.includes('/')) return (await isExecutable(bin)) ? bin : null;
  for (const dir of envPath.split(':').filter(Boolean)) {
    const p = path.join(dir, bin);
    if (await isExecutable(p)) return p;
  }
  return null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch {
      resolve({ code: null, out: '' });
      return;
    }
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    p.stderr.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    p.on('error', () => {
      clearTimeout(t);
      resolve({ code: null, out: '' });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

export interface CliInfo { cli: Cli; label: string; found: boolean; path: string | null; version: string | null; source: 'env' | 'saved' | 'path'; signedIn: boolean | null }

/** Finds a CLI and reads its version (and, for Codex, `codex login status`). No model call, no usage. */
export async function cliInfo(cli: Cli): Promise<CliInfo> {
  const env = (process.env[ENV[cli]] ?? '').trim();
  const saved = (await readTools()).bins[cli];
  const bin = env || saved || cli;
  const source: CliInfo['source'] = env ? 'env' : saved ? 'saved' : 'path';
  const where = await resolveOnPath(bin);
  if (!where) return { cli, label: CLI_LABEL[cli], found: false, path: null, version: null, source, signedIn: null };
  const v = await run(where, ['--version'], 10_000);
  let signedIn: boolean | null = null;
  if (cli === 'codex' && v.code === 0) {
    const s = await run(where, ['login', 'status'], 10_000);
    signedIn = s.code === null ? null : s.code === 0 && !/not logged in/i.test(s.out);
  }
  return { cli, label: CLI_LABEL[cli], found: v.code === 0, path: where, version: v.code === 0 ? v.out.trim().split('\n')[0]!.slice(0, 80) : null, source, signedIn };
}

/** Saves (or with '' clears) a full path for a CLI. Refuses anything that is not an executable file. */
export async function saveCliPath(cli: Cli, p: string): Promise<void> {
  const t = await readTools();
  const v = p.trim();
  if (!v) delete t.bins[cli];
  else {
    if (!path.isAbsolute(v)) throw new Error('Use the full path, like /opt/homebrew/bin/codex.');
    if (!(await isExecutable(v))) throw new Error('That path is not a program on this machine.');
    t.bins[cli] = v;
  }
  await fs.mkdir(/* turbopackIgnore: true */ dataDir(), { recursive: true });
  const tmp = `${toolsFile()}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(t, null, 2) + '\n');
  await fs.rename(tmp, toolsFile());
}
