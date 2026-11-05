// Server-only: on-disk storage for project memory. Files live next to the project's posts
// folder (<contentDir>/../memory/), never in Git, never on a server. Append-only where it matters:
//   timeline/YYYY-MM.jsonl  events (never edited; corrections are new events)
//   decisions.jsonl         routing decisions
//   runs.jsonl              agent runs (a run is written at start and again at the end; last line wins)
//   graph.json              decision map (replaced atomically)
//   learnings.json          beliefs (replaced atomically)
//   packs/<role>[@campaign].json  cached context packs
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { featureEnabled, featureOffReason } from '@/lib/server/signalConfig';
import { currentProject } from '../projects';
import type { AgentRunRecord, ContextPack, DecisionRecord, EventType, Graph, LearningsFile, MemEvent, Role } from './types';

/** Time-sortable id: prefix + base36 ms (9 chars) + 6 random hex. */
export function newId(prefix: string, now = Date.now()): string {
  if (!Number.isFinite(now)) now = Date.now();
  return `${prefix}_${now.toString(36).padStart(9, '0')}${randomBytes(3).toString('hex')}`;
}

export async function memoryAllowed(): Promise<{ enabled: boolean; reason: string }> {
  if (!(await featureEnabled('memory'))) return { enabled: false, reason: featureOffReason('memory') };
  return { enabled: true, reason: '' };
}

export const memoryDir = (contentDir: string = currentProject().contentDir) => path.join(path.dirname(contentDir), 'memory');
const file = (...p: string[]) => path.join(memoryDir(), ...p);

async function ensureDir(d: string) {
  await fs.mkdir(/* turbopackIgnore: true */ d, { recursive: true, mode: 0o700 });
  // Memory sits inside the project's folder, which may be a Git repository: keep it out of Git.
  await fs.writeFile(/* turbopackIgnore: true */ path.join(memoryDir(), '.gitignore'), '# Signal project memory: local only, never committed.\n*\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined);
}
async function appendLine(f: string, obj: unknown) {
  await ensureDir(path.dirname(f));
  await fs.appendFile(/* turbopackIgnore: true */ f, JSON.stringify(obj) + '\n', { mode: 0o600 });
}
async function readLines<T>(f: string): Promise<T[]> {
  let raw = '';
  try {
    raw = await fs.readFile(/* turbopackIgnore: true */ f, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}
async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ f, 'utf8')) as T;
  } catch {
    return null;
  }
}
async function writeJson(f: string, obj: unknown) {
  await ensureDir(path.dirname(f));
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, f);
}

// ---- timeline ------------------------------------------------------------------------------------
export async function appendEvent(e: Omit<MemEvent, 'id' | 'at' | 'project'> & { at?: string; project?: string }): Promise<MemEvent> {
  const at = e.at && Number.isFinite(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
  const ev: MemEvent = { id: newId('ev', Date.parse(at)), at, project: e.project ?? currentProject().id, campaign: e.campaign ?? null, type: e.type, by: e.by, refs: e.refs ?? {}, data: e.data ?? {} };
  await appendLine(file('timeline', `${at.slice(0, 7)}.jsonl`), ev);
  return ev;
}

/** Best effort: records an event only when memory is switched on; never throws into the caller. */
export async function recordEvent(e: { type: EventType; by: string; campaign?: string | null; refs?: MemEvent['refs']; data?: Record<string, unknown>; at?: string }): Promise<MemEvent | null> {
  try {
    if (!(await memoryAllowed()).enabled) return null;
    return await appendEvent({ type: e.type, by: e.by, campaign: e.campaign ?? null, refs: e.refs ?? {}, data: e.data ?? {}, at: e.at });
  } catch {
    return null;
  }
}

export async function listEvents(q: { since?: string; until?: string; types?: EventType[]; campaign?: string | null; limit?: number } = {}): Promise<MemEvent[]> {
  let months: string[] = [];
  try {
    months = (await fs.readdir(/* turbopackIgnore: true */ file('timeline'))).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    return [];
  }
  if (q.since) months = months.filter((m) => m.slice(0, 7) >= q.since!.slice(0, 7));
  if (q.until) months = months.filter((m) => m.slice(0, 7) <= q.until!.slice(0, 7));
  let all: MemEvent[] = [];
  for (const m of months) all = all.concat(await readLines<MemEvent>(file('timeline', m)));
  const types = q.types ? new Set(q.types) : null;
  all = all.filter((e) => (!q.since || e.at >= q.since) && (!q.until || e.at <= q.until) && (!types || types.has(e.type)) && (q.campaign === undefined || q.campaign === null || e.campaign === q.campaign));
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return q.limit ? all.slice(-q.limit) : all;
}

// ---- graph and learnings -------------------------------------------------------------------------
export async function readGraph(): Promise<Graph> {
  return (await readJson<Graph>(file('graph.json'))) ?? { version: 1, project: currentProject().id, nodes: [], updatedAt: new Date(0).toISOString() };
}
export async function writeGraph(g: Graph): Promise<void> {
  await writeJson(file('graph.json'), { ...g, updatedAt: new Date().toISOString() });
}
export async function readLearnings(): Promise<LearningsFile> {
  return (await readJson<LearningsFile>(file('learnings.json'))) ?? { version: 1, project: currentProject().id, learnings: [], updatedAt: new Date(0).toISOString() };
}
export async function writeLearnings(l: LearningsFile): Promise<void> {
  await writeJson(file('learnings.json'), { ...l, updatedAt: new Date().toISOString() });
}

// ---- decisions -----------------------------------------------------------------------------------
export async function appendDecision(d: Omit<DecisionRecord, 'id' | 'at' | 'project'> & { at?: string }): Promise<DecisionRecord> {
  const at = d.at ?? new Date().toISOString();
  const rec: DecisionRecord = { ...d, id: newId('dc', Date.parse(at)), at, project: currentProject().id };
  await appendLine(file('decisions.jsonl'), rec);
  return rec;
}
export async function listDecisions(limit = 200): Promise<DecisionRecord[]> {
  const all = await readLines<DecisionRecord>(file('decisions.jsonl'));
  return all.slice(-limit);
}
/** Cache lookup: the newest confident decision for the same question and inputs. An answer later
 *  marked wrong is not reused: the question goes back through the judge (or to you). */
export async function findCachedDecision(decision: DecisionRecord['decision'], inputsHash: string): Promise<DecisionRecord | null> {
  const all = await readLines<DecisionRecord>(file('decisions.jsonl'));
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i]!;
    if (d.decision !== decision || d.inputsHash !== inputsHash) continue;
    if (d.outcome === 'wrong') return null;
    if (d.via !== 'escalated') return d;
  }
  return null;
}

// ---- agent runs ----------------------------------------------------------------------------------
export async function writeRun(r: AgentRunRecord): Promise<void> {
  await appendLine(file('runs.jsonl'), r);
}
export async function listRuns(limit = 100): Promise<AgentRunRecord[]> {
  const lines = await readLines<AgentRunRecord>(file('runs.jsonl'));
  const byId = new Map<string, AgentRunRecord>();
  for (const r of lines) byId.set(r.id, r); // last line wins
  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(-limit);
}

// ---- packs ---------------------------------------------------------------------------------------
/** Campaign ids are `c-YYYYMMDD-xxxx`; anything else (e.g. a hand-edited campaign.json) never reaches a file name. */
export const isCampaignId = (c: unknown): c is string => typeof c === 'string' && /^c-\d{8}-[a-z0-9]{4}$/.test(c);
const ROLE_RE = /^[a-z-]{2,40}$/;
const packFile = (role: Role, campaign: string | null) => {
  if (!ROLE_RE.test(role)) throw new Error('Unknown role.');
  return file('packs', `${role}${isCampaignId(campaign) ? `@${campaign}` : ''}.json`);
};
export async function readPack(role: Role, campaign: string | null): Promise<ContextPack | null> {
  return readJson<ContextPack>(packFile(role, campaign));
}
export async function writePack(p: ContextPack): Promise<void> {
  await writeJson(packFile(p.role, p.campaign), p);
}
