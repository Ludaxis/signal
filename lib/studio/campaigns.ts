// Server-only: campaigns for a project. Several campaigns run in parallel for one Instagram account
// and share its posting days (one post per calendar day). Each campaign has:
//   campaign.json  — the brief, formats, cadence, dates, priority and status (set by the owner)
//   strategy       — proposed by the strategist agent from the brand, past posts, results and web
//                    research; the owner approves it (a proposal never runs on its own)
//   plan.json      — dated slots with briefs from the content planner; each slot becomes a normal
//                    post package that the owner approves in Review like any other post.
// Agents run only when the owner presses a button. Files live next to the posts folder.
// Guards around the agents, all in code: the claims lint (claimProblems) on hooks and plan copy, the
// measurable-metrics check on KPIs and experiments, formats filtered by their switches, the plan horizon
// clamped to the posting period end (account settings), and one agent run per campaign at a time.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ContentError, currentLimits, listPackages, pkgPath, setPlan, writeJsonReplace, type PackageView } from './content';
import { currentProject } from './projects';
import { BRIEF_FORMATS, FORMAT_LABEL, FORMATS, HEADLINE_FORMATS, HIGGSFIELD_FORMATS, generatePackage, type Format } from './generate';
import { loadBrand, discoverArticles } from './brand';
import { insights } from './analytics';
import { AgentError, runAgent, type Runner } from './claude-agent';
import { higgsfieldAllowed } from './higgsfield';
import { igFeature, instagramApiAllowed, getAccount, listMedia } from './meta';
import { addDays, zonedInstant, zonedParts, todayInZone } from '@/lib/time';

export const GOALS = ['awareness', 'engagement', 'installs', 'traffic', 'launch', 'community'] as const;
export type Goal = (typeof GOALS)[number];
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'done';

export interface PostTypeStrategy { format: Format; role: string; hooks: string[]; captionStyle: string; visualDirection: string; hashtags: string[]; bestTimes: string[]; dos: string[]; donts: string[] }
export interface Strategy {
  summary: string;
  audience: string;
  positioning: string;
  pillars: { name: string; weight: number; why: string }[];
  postTypes: PostTypeStrategy[];
  experiments: { hypothesis: string; measure: string }[];
  kpis: { metric: string; target: string }[];
  research: { finding: string; source: string }[];
  risks: string[];
}
export interface AgentMeta { agent: string; cli: string; seconds: number; at: string; billing?: 'subscription' | 'api-key'; costUsd?: number | null }
export interface Campaign {
  id: string;
  name: string;
  goal: Goal;
  brief: string;
  formats: Format[];
  startDate: string;
  endDate: string | null;
  perWeek: number;
  priority: 1 | 2 | 3;
  status: CampaignStatus;
  createdAt: string;
  createdBy: string;
  strategy: (Strategy & { approvedBy: string; approvedAt: string; meta: AgentMeta }) | null;
  proposal: (Strategy & { meta: AgentMeta; notes?: string }) | null;
}
export interface Slot {
  id: string;
  date: string;
  time: string;
  at: string;
  format: Format;
  pillar: string;
  hook: string;
  angle: string;
  captionLead: string;
  prompt: string;
  headline: string;
  articleUrl: string | null;
  packageId: string | null;
  status: 'planned' | 'made' | 'skipped';
  /** The Post maker template chosen for this slot; null or missing = no template yet. */
  templateId?: string | null;
}
export interface CampaignPlan { madeAt: string | null; meta: AgentMeta | null; slots: Slot[] }

const ID_RE = /^c-[0-9]{8}-[a-z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const campaignsDir = () => path.join(path.dirname(currentProject().contentDir), 'campaigns');
const cDir = (id: string) => {
  if (!ID_RE.test(id)) throw new ContentError(404, 'Unknown campaign.');
  return path.join(campaignsDir(), id);
};
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---- validation helpers ------------------------------------------------------------------------
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : []);
const objs = (v: unknown, max: number) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]).slice(0, max) : []);

// ---- claims lint ---------------------------------------------------------------------------------
/** Copy patterns Signal never publishes: unverifiable statistics, timers, "tap to". Each rule names what it caught. */
export const CLAIM_RULES: readonly { id: string; label: string; re: RegExp }[] = [
  { id: 'most-people', label: '"most people" claim', re: /\b(most|few|many|nine out of ten)\s+(people|players|of you|users|gamers|viewers)\b/i },
  { id: 'only-x', label: '"only X% / only X in Y" statistic', re: /\bonly\s+(\d+(?:[.,]\d+)?\s*(%|percent\b)|(\d+|one|two|three|five|ten)\s+(in|out of)\s+\d+)/i },
  // "X in Y" only in the statistic shape (who or how many of an audience): "1 in 3 players miss it", "9 out of 10 get
  // it wrong", "Be the 1 in 100?". Counts such as "Step 12 in 2 moves" or "Rank these 3 in 1 go" are not statistics.
  { id: 'x-in-y', label: '"X in Y" statistic', re: /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(in|out of)\s+(every\s+)?(\d+|two|three|four|five|six|seven|eight|nine|ten|a hundred|a thousand|hundred|thousand)(?=\s*([?!.,;:]|$)|\s+(people|players|of (you|us|them)|users|gamers|viewers|fans|adults|kids|humans|miss(es)?|gets?|got|fail(s|ed)?|spot(s|ted)?|find(s)?|found|solve[sd]?|can(not|'t)?|could(n't)?|will|won't|never|don't|do|get it|are|is)\b)/i },
  { id: 'percent', label: 'percentage', re: /\d\s*(%|percent\b)/i },
  { id: 'statistic', label: 'unverifiable statistic or claim', re: /\b(studies|research|science|data|stats)\s+(shows?|says|proves?)\b|\b(scientifically|clinically|proven)\b|\bstatistically\b|\bguarantee(d|s)?\b|\bnumber one\b|(^|[\s(])#1\b|\b\d+(?:[.,]\d+)?\s*(million|billion|k)\s+(people|players|downloads|users|fans)\b/i },
  { id: 'timer', label: 'timer or countdown', re: /\b(timer|countdown|count-down|beat the clock|against the clock|time runs out|seconds? left)\b|\b(in|under|within)\s+(\d+|one|two|three|four|five|ten|thirty)\s*-?\s*(s|secs?|seconds?)\b|\b(\d+|three|five|ten)\s*-?\s*second\s+(challenge|test|rule|timer)\b/i },
  { id: 'tap-to', label: '"tap to…" call to action', re: /\btap\s+(to|here|now|the|on|this|and|if)\b/i },
];

/** The claims rules a piece of copy breaks (labels), empty when it is clean. */
export function claimProblems(text: string): string[] {
  const t = String(text ?? '');
  return CLAIM_RULES.filter((r) => r.re.test(t)).map((r) => r.label);
}

// ---- measurable metrics --------------------------------------------------------------------------
/** What Signal can measure per post (analytics.ts / meta.ts) and the per-reach rates it computes. */
export const MEASURABLE_METRICS = ['views', 'reach', 'likes', 'comments', 'saves', 'shares', 'saves_per_reach', 'shares_per_reach', 'comments_per_reach'] as const;
/** Follows are only measurable once Instagram insights are enabled for the account. */
export const FOLLOWS_METRIC = 'follows';
const MEASURABLE_RE = /\b(views?|reach|likes?|comments?|saves?|saved|shares?|sends?|engagement)\b/i;
const FOLLOWS_RE = /\b(follows?|followers?|new followers?)\b/i;
const UNMEASURABLE_RE = /\b(watch[\s-]?time|view[\s-]?duration|average\s+watch|hold\s+rate|hold[\s-]?time|retention|retained|completion|completed\s+views|replays?|rewatch\w*|loop\s+rate|profile\s+visits?|link\s+(clicks?|taps?)|website\s+(clicks?|taps?|visits?)|click[\s-]?through|ctr|installs?|downloads?|impressions|dwell|skip\s+rate|drop[\s-]?off)\b|\b(\d+|one|two|three|five)\s*-?\s*(s|secs?|seconds?)\s+(hold|view|mark)\b|\bfirst\s+(\d+|one|two|three|five)\s*-?\s*(s|secs?|seconds?)\b/i;

/** Why a KPI metric or experiment text cannot be measured by Signal, or null when it can. */
export function metricProblem(text: string, o: { follows?: boolean; needMetric?: boolean } = {}): string | null {
  const t = String(text ?? '').replace(/_/g, ' '); // saves_per_reach reads as "saves per reach"
  const bad = t.match(UNMEASURABLE_RE);
  if (bad) return `Signal does not measure "${bad[0]}"`;
  const follows = FOLLOWS_RE.test(t);
  if (follows && !o.follows) return 'Signal measures follows only once Instagram insights are enabled';
  if (o.needMetric !== false && !MEASURABLE_RE.test(t) && !follows) return 'names no metric Signal measures';
  return null;
}

/** Cleans a strategy against the code rules: drops example hooks that break the claims lint, KPIs and
 *  experiments Signal cannot measure. Returns what was dropped as short notes. */
export function screenStrategy(s: Strategy, o: { follows?: boolean } = {}): { strategy: Strategy; notes: string[] } {
  const dropped = { hooks: 0, kpis: [] as string[], experiments: [] as string[] };
  const postTypes = s.postTypes.map((p) => {
    const hooks = p.hooks.filter((h) => !claimProblems(h).length);
    dropped.hooks += p.hooks.length - hooks.length;
    return { ...p, hooks };
  });
  const kpis = s.kpis.filter((k) => {
    const bad = metricProblem(k.metric, o);
    if (bad) dropped.kpis.push(`${k.metric} (${bad})`);
    return !bad;
  });
  const experiments = s.experiments.filter((e) => {
    const bad = metricProblem(e.hypothesis, { ...o, needMetric: false }) ?? metricProblem(e.measure, o);
    if (bad) dropped.experiments.push(`${e.hypothesis.slice(0, 80)} (${bad})`);
    return !bad;
  });
  const notes = [
    ...(dropped.hooks ? [`Signal check: removed ${dropped.hooks} example hook${dropped.hooks === 1 ? '' : 's'} that broke the claims rules.`] : []),
    ...dropped.kpis.slice(0, 3).map((k) => `Signal check: removed KPI ${k}.`),
    ...dropped.experiments.slice(0, 3).map((x) => `Signal check: removed experiment "${x}".`),
  ].map((n) => n.slice(0, 300));
  return { strategy: { ...s, postTypes, kpis, experiments }, notes };
}

// ---- formats the switches allow ------------------------------------------------------------------
const CODEX_FORMATS: readonly Format[] = ['codex-post'];
/** Post types a campaign may use now: every format minus those that are switched off (Higgsfield: the
 *  higgsfield switch plus its keys; Codex: the account settings' codex_images). */
export async function selectableFormats(now = Date.now()): Promise<Format[]> {
  const [hf, lim] = await Promise.all([higgsfieldAllowed().then((a) => a.enabled), currentLimits(now)]);
  return FORMATS.filter((f) => (hf || !HIGGSFIELD_FORMATS.includes(f)) && (lim.codex || !CODEX_FORMATS.includes(f)));
}

export function cleanCampaignInput(b: Record<string, unknown>, o: { selectable?: readonly Format[] } = {}): Omit<Campaign, 'id' | 'createdAt' | 'createdBy' | 'strategy' | 'proposal' | 'status'> {
  const name = str(b.name, 80);
  if (!name) throw new ContentError(400, 'Give the campaign a name.');
  const goal = GOALS.includes(b.goal as Goal) ? (b.goal as Goal) : 'awareness';
  const allowed = FORMATS.filter((f) => !o.selectable || o.selectable.includes(f));
  const asked = Array.isArray(b.formats) ? b.formats : [];
  const formats = asked.filter((f): f is Format => allowed.includes(f as Format));
  if (!formats.length) throw new ContentError(400, asked.length && o.selectable ? 'Pick at least one post type that is switched on for this account.' : 'Pick at least one post type.');
  const startDate = typeof b.startDate === 'string' && DATE_RE.test(b.startDate) ? b.startDate : todayInZone();
  const endDate = typeof b.endDate === 'string' && DATE_RE.test(b.endDate) ? b.endDate : null;
  if (endDate && endDate < startDate) throw new ContentError(400, 'The end date is before the start date.');
  const perWeek = Math.min(7, Math.max(1, Math.round(Number(b.perWeek) || 3)));
  const priority = ([1, 2, 3].includes(Number(b.priority)) ? Number(b.priority) : 2) as 1 | 2 | 3;
  return { name, goal, brief: str(b.brief, 1500), formats: [...new Set(formats)], startDate, endDate, perWeek, priority };
}

/** Shapes the strategist's JSON and applies the code rules (screenStrategy): hooks that break the claims lint
 *  are dropped, KPIs and experiments that name a metric Signal cannot measure are dropped; each drop is noted
 *  in `risks` so the owner sees it before approving. */
export function validateStrategy(v: unknown, formats: Format[], opts: { follows?: boolean } = {}): Strategy {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const postTypes = objs(o.postTypes, 7)
    .map((p) => ({
      format: p.format as Format,
      role: str(p.role, 300),
      hooks: list(p.hooks, 8, 120),
      captionStyle: str(p.captionStyle, 400),
      visualDirection: str(p.visualDirection, 500),
      hashtags: list(p.hashtags, 12, 40).map((h) => (h.startsWith('#') ? h : `#${h}`).replace(/\s+/g, '')),
      bestTimes: list(p.bestTimes, 3, 5).filter((t) => TIME_RE.test(t)),
      dos: list(p.dos, 6, 200),
      donts: list(p.donts, 6, 200),
    }))
    .filter((p) => formats.includes(p.format));
  const pillars = objs(o.pillars, 6).map((p) => ({ name: str(p.name, 60), weight: Math.max(0, Math.min(100, Math.round(Number(p.weight) || 0))), why: str(p.why, 300) })).filter((p) => p.name);
  const s: Strategy = {
    summary: str(o.summary, 800),
    audience: str(o.audience, 500),
    positioning: str(o.positioning, 500),
    pillars,
    postTypes,
    experiments: objs(o.experiments, 4).map((e) => ({ hypothesis: str(e.hypothesis, 300), measure: str(e.measure, 200) })).filter((e) => e.hypothesis),
    kpis: objs(o.kpis, 6).map((k) => ({ metric: str(k.metric, 80), target: str(k.target, 120) })).filter((k) => k.metric),
    research: objs(o.research, 10).map((r) => ({ finding: str(r.finding, 400), source: str(r.source, 300) })).filter((r) => r.finding),
    risks: list(o.risks, 6, 300),
  };
  if (!s.summary || !s.pillars.length || !s.postTypes.length) throw new ContentError(502, 'The strategy came back incomplete (summary, pillars and post types are required). Try again.');
  const screened = screenStrategy(s, opts);
  return { ...screened.strategy, risks: [...screened.strategy.risks, ...screened.notes] };
}

// ---- storage -----------------------------------------------------------------------------------
export async function listCampaigns(): Promise<Campaign[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/* turbopackIgnore: true */ campaignsDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out: Campaign[] = [];
  for (const n of names.sort()) {
    const c = await readJson<Campaign>(path.join(campaignsDir(), n, 'campaign.json'));
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
}
export async function getCampaign(id: string): Promise<Campaign> {
  const c = await readJson<Campaign>(path.join(cDir(id), 'campaign.json'));
  if (!c) throw new ContentError(404, 'Unknown campaign.');
  return c;
}
export async function getPlan(id: string): Promise<CampaignPlan> {
  return (await readJson<CampaignPlan>(path.join(cDir(id), 'plan.json'))) ?? { madeAt: null, meta: null, slots: [] };
}
const save = (c: Campaign) => writeJsonReplace(path.join(cDir(c.id), 'campaign.json'), c);
const savePlan = (id: string, p: CampaignPlan) => writeJsonReplace(path.join(cDir(id), 'plan.json'), p);

export async function createCampaign(input: Record<string, unknown>, by: string, now = Date.now()): Promise<Campaign> {
  const clean = cleanCampaignInput(input, { selectable: await selectableFormats(now) });
  const id = `c-${todayInZone(now).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
  await fs.mkdir(/* turbopackIgnore: true */ path.join(campaignsDir(), id), { recursive: true });
  const c: Campaign = { id, ...clean, status: 'draft', createdAt: new Date(now).toISOString(), createdBy: by, strategy: null, proposal: null };
  await save(c);
  return c;
}

export async function updateCampaign(id: string, patch: Record<string, unknown>): Promise<Campaign> {
  const c = await getCampaign(id);
  // A patch that sets formats may only pick formats that are switched on; a patch without formats keeps the
  // campaign's own (so a campaign can still be paused or renamed after a switch goes off; planning filters them again).
  const selectable = 'formats' in patch ? await selectableFormats() : undefined;
  const merged = cleanCampaignInput({ ...c, ...patch }, { selectable });
  let status = c.status;
  if (typeof patch.status === 'string' && ['draft', 'active', 'paused', 'done'].includes(patch.status)) {
    if (patch.status === 'active' && !c.strategy) throw new ContentError(409, 'Approve a strategy before starting the campaign.');
    status = patch.status as CampaignStatus;
  }
  const next = { ...c, ...merged, status };
  await save(next);
  return next;
}

/** Keeps the last agent failure next to the campaign so it can be read later (no secrets: CLI output only). */
export interface AgentProgress { what: string; status: 'running' | 'done' | 'error'; startedAt: string; endedAt?: string; message?: string; events: { at: string; kind: string; text: string }[] }

// One agent run per campaign at a time (strategy or plan), shared across bundles through globalThis.
type G = typeof globalThis & { __signalCampaignAgentLocks?: Map<string, string> };
const agentLocks = () => ((globalThis as G).__signalCampaignAgentLocks ??= new Map<string, string>());
/** The step ('strategy' | 'plan') an agent is running for this campaign right now, or null. */
export const agentRunInFlight = (id: string): string | null => agentLocks().get(id) ?? null;

/** Runs an agent step for a campaign: streams progress to agent-progress.json (polled by the dashboard)
 *  and keeps the last failure in last-agent-run.json (CLI output only, keys redacted). */
async function logged<T>(id: string, what: string, fn: (onEvent: (e: { at: string; kind: string; text: string }) => void) => Promise<T>): Promise<T> {
  const busy = agentRunInFlight(id);
  if (busy) throw new ContentError(409, `An agent is already working on this campaign (${busy}). Wait for it to finish.`);
  agentLocks().set(id, what);
  try {
    return await loggedRun(id, what, fn);
  } finally {
    agentLocks().delete(id);
  }
}

async function loggedRun<T>(id: string, what: string, fn: (onEvent: (e: { at: string; kind: string; text: string }) => void) => Promise<T>): Promise<T> {
  const file = path.join(cDir(id), 'agent-progress.json');
  const prog: AgentProgress = { what, status: 'running', startedAt: new Date().toISOString(), events: [] };
  let chain = writeJsonReplace(file, prog).catch(() => undefined);
  const flush = () => {
    const snap = { ...prog, events: prog.events.slice(-60) };
    chain = chain.then(() => writeJsonReplace(file, snap)).catch(() => undefined);
  };
  const onEvent = (e: { at: string; kind: string; text: string }) => {
    prog.events.push(e);
    flush();
  };
  try {
    const v = await fn(onEvent);
    prog.status = 'done';
    prog.endedAt = new Date().toISOString();
    flush();
    await chain;
    await writeJsonReplace(path.join(cDir(id), 'last-agent-run.json'), { what, ok: true, at: new Date().toISOString() });
    return v;
  } catch (e) {
    prog.status = 'error';
    prog.endedAt = new Date().toISOString();
    prog.message = (e as Error).message;
    flush();
    await chain;
    await writeJsonReplace(path.join(cDir(id), 'last-agent-run.json'), { what, ok: false, at: new Date().toISOString(), message: (e as Error).message, ...(e instanceof AgentError ? { detail: e.detail ?? null } : {}) }).catch(() => undefined);
    throw e;
  }
}

export async function getProgress(id: string): Promise<AgentProgress | null> {
  const p = await readJson<AgentProgress>(path.join(cDir(id), 'agent-progress.json'));
  // A run that has not written for 10 minutes died with the server.
  if (p?.status === 'running' && Date.now() - Date.parse(p.events.at(-1)?.at ?? p.startedAt) > 10 * 60_000) return { ...p, status: 'error', message: 'The run stopped (Signal was restarted?). Press the button again.' };
  return p;
}

// ---- strategist ----------------------------------------------------------------------------------
/** The strategist's output contract. Exported for tests. */
export function strategySpec(o: { follows?: boolean } = {}): string {
  const metrics = [...MEASURABLE_METRICS, ...(o.follows ? [FOLLOWS_METRIC] : [])].join(', ');
  return `A JSON object:
{
  "summary": "3–5 sentences: the strategy for this campaign",
  "audience": "who we talk to and what they care about",
  "positioning": "the one idea every post supports",
  "pillars": [{"name": "…", "weight": 0-100 (weights sum to 100), "why": "…"}],   // 3–5 pillars
  "postTypes": [{                       // one entry per post type the campaign uses, using only the given format ids
    "format": "<format id>",
    "role": "what this post type does for the goal",
    "hooks": ["5–8 example first lines, each under 90 characters"],
    "captionStyle": "length, tone, structure, call to action",
    "visualDirection": "what the visuals should show (original visuals only; no real people or third-party brands)",
    "hashtags": ["#…"],                   // 3–8
    "bestTimes": ["HH:MM"],               // Studio time zone, 1–3, based on results when available
    "dos": ["…"], "donts": ["…"]
  }],
  "experiments": [{"hypothesis": "…", "measure": "metric and threshold"}],   // 1–3
  "kpis": [{"metric": "…", "target": "…"}],
  "research": [{"finding": "…", "source": "URL"}],   // from your web research, each with a source URL
  "risks": ["…"]
}
Measurable metrics: KPI "metric" and experiment "measure" use only these, which Signal measures per post: ${metrics}. Signal has no watch time, hold rate (e.g. 3-second hold), retention, completion, replays, profile visits, link clicks or installs; a KPI or experiment that names one is removed.
Claims rule for hooks: no "most people…", no "only X%" or "X in Y" statistics or other unverifiable numbers, no timers, countdowns or "in N seconds" challenges, no "tap to…". Hooks that break it are removed.`;
}

async function recentInstagram(): Promise<unknown[]> {
  if (!(await instagramApiAllowed()).enabled) return [];
  try {
    const acct = await getAccount();
    return (await listMedia(acct.userId, 20)).map((m) => ({ when: m.timestamp, type: m.mediaType, caption: m.caption.slice(0, 300), likes: m.likes, comments: m.comments, link: m.permalink }));
  } catch {
    return [];
  }
}

function pastPosts(pkgs: PackageView[]) {
  return pkgs
    .filter((p) => p.posted)
    .slice(-20)
    .map((p) => ({ id: p.id, format: p.source?.format ?? 'other', title: p.title, caption: p.caption.slice(0, 300), postedAt: p.posted!.posted_at, metrics: p.metrics?.metrics ?? null }));
}

export async function proposeStrategy(id: string, by: string, notes = '', runner?: Runner): Promise<Campaign> {
  const c = await getCampaign(id);
  const project = currentProject();
  const pkgs = await listPackages();
  const brand = await loadBrand(project);
  const ins = insights(pkgs);
  const input = {
    project: { name: project.name, instagram: project.handle, kind: brand?.website ? 'website / brand' : 'brand' },
    campaign: { name: c.name, goal: c.goal, brief: c.brief, startDate: c.startDate, endDate: c.endDate, postsPerWeek: c.perWeek, postTypes: c.formats.map((f) => ({ id: f, name: FORMAT_LABEL[f] })) },
    customerNotes: str(notes, 800) || undefined,
    previousStrategy: c.strategy ? { summary: c.strategy.summary, pillars: c.strategy.pillars } : undefined,
    brand: brand ? { name: brand.name, tagline: brand.tagline, website: brand.website, colours: brand.colors, fonts: brand.fonts, voice: brand.voice } : null,
    results: { measured: ins.measured, byFormat: ins.byFormat, bestWeekday: ins.bestWeekday, bestHourLocal: ins.bestHour },
    rules: ['One post per day for this account, shared with other campaigns.', 'Every post carries Instagram\'s AI label.', 'Instagram only for now.'],
  };
  const untrusted = { ourPastPosts: pastPosts(pkgs), instagramLatest: await recentInstagram(), websiteCopy: brand?.copy ?? [] };
  const task = `Write the strategy for one campaign on ${project.handle}. Ground it in the brand, our past posts and their results, and short web research on what works now for this kind of account on Instagram (cite sources). Plan only with the given post types. It is a proposal the owner will review.`;
  const follows = await igFeature('insights').then((f) => f.enabled).catch(() => false);
  const { value, meta } = await logged(id, 'strategy', (onEvent) => runAgent('strategist', { task, input, untrusted, outputSpec: strategySpec({ follows }), web: true, campaign: id, onEvent, validate: (v) => validateStrategy(v, c.formats, { follows }) }, runner));
  const next: Campaign = { ...c, proposal: { ...value, meta, ...(notes ? { notes: str(notes, 800) } : {}) } };
  await writeJsonReplace(path.join(cDir(id), `strategy-proposal-${meta.at.replace(/[:.]/g, '-')}.json`), next.proposal);
  await save(next);
  return next;
}

export async function approveStrategy(id: string, by: string, now = Date.now()): Promise<Campaign> {
  const c = await getCampaign(id);
  if (!c.proposal) throw new ContentError(409, 'There is no strategy proposal to approve.');
  const { notes: _notes, ...s } = c.proposal;
  void _notes;
  const next: Campaign = { ...c, strategy: { ...s, approvedBy: by, approvedAt: new Date(now).toISOString() }, proposal: null };
  await save(next);
  return next;
}

// ---- planning ------------------------------------------------------------------------------------
/** Days that already have a post (posted, scheduled, in flight or planned) or a slot of another campaign. */
async function takenDays(exceptCampaign: string): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const p of await listPackages()) {
    if (p.status === 'discarded') continue;
    const at = p.posted?.posted_at ?? p.scheduled?.scheduled_for ?? p.plannedFor ?? (p.dispatch ? p.dispatch.claimed_at : null);
    if (at) taken.add(zonedParts(at).date);
  }
  for (const c of await listCampaigns()) {
    if (c.id === exceptCampaign || c.status === 'done') continue;
    for (const s of (await getPlan(c.id)).slots) if (s.status !== 'skipped') taken.add(s.date);
  }
  return taken;
}

/** Picks evenly spread free days for a campaign in the next `span` days, never after `until` (the last date, in
 *  the Studio time zone, that the posting period covers). Exported for tests. */
export function pickDays(c: Pick<Campaign, 'startDate' | 'endDate' | 'perWeek'>, taken: Set<string>, today: string, span = 14, until: string | null = null): string[] {
  const from = c.startDate > addDays(today, 1) ? c.startDate : addDays(today, 1);
  const days: string[] = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(from, i);
    if (c.endDate && d > c.endDate) break;
    if (until && d > until) break;
    days.push(d);
  }
  const free = days.filter((d) => !taken.has(d));
  const want = Math.min(free.length, Math.ceil((c.perWeek * days.length) / 7));
  if (want <= 0) return [];
  const step = free.length / want;
  return Array.from({ length: want }, (_, i) => free[Math.floor(i * step)]!);
}

/** The planner's output contract. Exported for tests. */
export const PLAN_SPEC = `A JSON object:
{
  "slots": [{                 // exactly one per given date, same order
    "date": "YYYY-MM-DD",     // one of the given dates
    "format": "<format id>",  // one of the given post types; follow the strategy's mix
    "pillar": "<pillar name from the strategy>",
    "hook": "first line, one line under 90 characters, unique in this plan",
    "angle": "one or two sentences: what the post shows and why it works",
    "captionLead": "one opening caption sentence (under 160 characters) in the brand voice",
    "prompt": "for codex-post, higgsfield-image and higgsfield-reel: an image prompt for an original visual (for higgsfield-reel: the opening frame of a short vertical video), no text in the image; else empty",
    "headline": "for codex-post and higgsfield-image only: on-image headline under 60 characters; else empty",
    "articleUrl": "for website-card only: one URL from websitePages, or empty"
  }]
}
Claims rule for hook, angle, captionLead and headline: no "most people…", no "only X%" or "X in Y" statistics or other unverifiable numbers, no timers, countdowns or "in N seconds" challenges, no "tap to…". A plan that breaks a rule is rejected.`;

/** Code checks on one planned slot: the claims lint on its copy. Exported for tests. */
export function slotProblems(s: Pick<Slot, 'date' | 'hook' | 'angle' | 'captionLead' | 'headline'>): string[] {
  const out: string[] = [];
  for (const field of ['hook', 'angle', 'captionLead', 'headline'] as const) for (const p of claimProblems(s[field])) out.push(`${s.date} ${field}: ${p}`);
  return out;
}

export async function makePlan(id: string, by: string, deps: { runner?: Runner; now?: number } = {}): Promise<CampaignPlan> {
  const now = deps.now ?? Date.now();
  const c = await getCampaign(id);
  if (!c.strategy) throw new ContentError(409, 'Approve a strategy first.');
  if (c.status !== 'active') throw new ContentError(409, 'Start the campaign first.');
  // Posts can only be approved while the posting period runs: plan nothing after it ends.
  const lim = await currentLimits(now);
  if (!lim.open) throw new ContentError(409, lim.reason);
  const until = Number.isFinite(lim.expiresAt) ? zonedParts(lim.expiresAt).date : null;
  // Only post types that are switched on right now (a switch may have gone off since the campaign was made).
  const selectable = await selectableFormats(now);
  const formats = c.formats.filter((f) => selectable.includes(f));
  if (!formats.length) throw new ContentError(409, 'None of this campaign\'s post types is switched on for this account right now.');
  const old = await getPlan(id);
  const today = todayInZone(now);
  // Keep slots that already became posts (or are in the past); replan only open future ones.
  const keep = old.slots.filter((s) => s.status === 'made' || s.date <= today);
  const taken = await takenDays(id);
  for (const s of keep) taken.add(s.date);
  const dates = pickDays(c, taken, today, 14, until);
  if (!dates.length) throw new ContentError(409, until && until < addDays(today, 14) ? `No free days before this account's posting period ends (${until}). Set the account limits again to plan further.` : 'No free days in the next two weeks (one post per day, shared with other campaigns).');
  let pages: string[] = [];
  if (formats.includes('website-card')) pages = await discoverArticles().catch(() => []);
  const used = new Set((await listPackages()).map((p) => p.source?.category).filter(Boolean));
  // The planner sees the strategy through the same code rules: no barred example hooks, no unmeasurable experiments.
  const follows = await igFeature('insights').then((f) => f.enabled).catch(() => false);
  const strategy = screenStrategy(c.strategy, { follows }).strategy;
  const input = {
    campaign: { name: c.name, goal: c.goal, brief: c.brief, postTypes: formats.map((f) => ({ id: f, name: FORMAT_LABEL[f] })) },
    strategy,
    dates,
    websitePages: pages.filter((u) => !used.has(u)).slice(0, 30),
  };
  const task = `Write one post brief for each date in "dates" for this campaign on ${currentProject().handle}, following the approved strategy. Vary pillars and hooks; never repeat a hook.`;
  const { value, meta } = await logged(id, 'plan', (onEvent) => runAgent(
    'content-planner',
    {
      task,
      onEvent,
      input,
      campaign: id,
      outputSpec: PLAN_SPEC,
      validate: (v) => {
        const rows = objs((v as { slots?: unknown } | null)?.slots, dates.length);
        const slots: Slot[] = dates.map((date, i) => {
          const r = rows.find((x) => x.date === date) ?? rows[i] ?? {};
          const format = formats.includes(r.format as Format) ? (r.format as Format) : formats[i % formats.length]!;
          const pt = c.strategy!.postTypes.find((p) => p.format === format);
          const time = pt?.bestTimes[0] ?? '18:00';
          const articleUrl = format === 'website-card' && typeof r.articleUrl === 'string' && pages.includes(r.articleUrl) ? r.articleUrl : null;
          return {
            id: `${date}-${format}`,
            date,
            time,
            at: zonedInstant(date, time),
            format,
            pillar: str(r.pillar, 60),
            hook: str(r.hook, 120),
            angle: str(r.angle, 400),
            captionLead: str(r.captionLead, 200),
            prompt: BRIEF_FORMATS.includes(format) ? str(r.prompt, 800) : '',
            headline: HEADLINE_FORMATS.includes(format) ? str(r.headline, 70) : '',
            articleUrl,
            packageId: null,
            status: 'planned' as const,
          };
        });
        const problems = slots.flatMap(slotProblems);
        if (problems.length) throw new ContentError(502, `The plan broke Signal's content rules (${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; ${problems.length - 3} more` : ''}). Make the plan again.`);
        // A slot later in the day than the posting period's end cannot be approved in time.
        const open = slots.filter((s) => Date.parse(s.at) < lim.expiresAt);
        if (!open.length) {
          const end = zonedParts(lim.expiresAt);
          throw new ContentError(409, `Every planned slot falls after this account's posting period ends (${end.date} ${end.time}). Set the account limits again to plan further.`);
        }
        return open;
      },
    },
    deps.runner,
  ));
  const plan: CampaignPlan = { madeAt: meta.at, meta, slots: [...keep, ...value].sort((a, b) => a.date.localeCompare(b.date)) };
  await savePlan(id, plan);
  void by;
  return plan;
}

/** Turns one planned slot into a post package (Review → approve → schedule as usual). */
export async function makeSlotPost(id: string, slotId: string, by: string, now = Date.now()): Promise<{ plan: CampaignPlan; packageId: string }> {
  const c = await getCampaign(id);
  const plan = await getPlan(id);
  const slot = plan.slots.find((s) => s.id === slotId);
  if (!slot) throw new ContentError(404, 'Unknown slot.');
  if (slot.status !== 'planned') throw new ContentError(409, 'This slot already has a post.');
  if (BRIEF_FORMATS.includes(slot.format) && !slot.prompt) throw new ContentError(400, 'This slot has no image prompt. Make the plan again.');
  const { id: pkgId } = await generatePackage({
    format: slot.format,
    now,
    captionLead: slot.captionLead,
    articleUrl: slot.articleUrl ?? undefined,
    brief: BRIEF_FORMATS.includes(slot.format) ? { prompt: slot.prompt, headline: slot.headline || undefined, caption: [slot.captionLead, slot.angle].filter(Boolean).join('\n\n') } : undefined,
  });
  await writeJsonReplace(pkgPath(pkgId, 'campaign.json'), { campaign: c.id, campaign_name: c.name, slot: slot.id, made_by: by, made_at: new Date(now).toISOString() });
  if (Date.parse(slot.at) > now + 5 * 60_000) await setPlan(pkgId, slot.at, by, now).catch(() => undefined);
  const next: CampaignPlan = { ...plan, slots: plan.slots.map((s) => (s.id === slotId ? { ...s, packageId: pkgId, status: 'made' as const } : s)) };
  await savePlan(id, next);
  return { plan: next, packageId: pkgId };
}

export async function skipSlot(id: string, slotId: string): Promise<CampaignPlan> {
  const plan = await getPlan(id);
  const next: CampaignPlan = { ...plan, slots: plan.slots.map((s) => (s.id === slotId && s.status === 'planned' ? { ...s, status: 'skipped' as const } : s)) };
  await savePlan(id, next);
  return next;
}

/** Template ids as the Post maker store writes them (postmaker/store/paths.ts TEMPLATE_ID_RE). */
const SLOT_TEMPLATE_RE = /^tpl-\d{8}-[0-9a-f]{4}$/;

/**
 * Records which template a planned slot uses, or clears it with null. The caller checks that the template exists
 * and is not retired; this only refuses malformed ids and slots that already have a post.
 */
export async function setSlotTemplate(id: string, slotId: string, templateId: string | null): Promise<CampaignPlan> {
  if (templateId !== null && !SLOT_TEMPLATE_RE.test(templateId)) throw new ContentError(400, 'Unknown template.');
  const plan = await getPlan(id);
  const slot = plan.slots.find((s) => s.id === slotId);
  if (!slot) throw new ContentError(404, 'Unknown slot.');
  if (slot.status !== 'planned') throw new ContentError(409, 'This slot already has a post.');
  const next: CampaignPlan = { ...plan, slots: plan.slots.map((s) => (s.id === slotId ? { ...s, templateId } : s)) };
  await savePlan(id, next);
  return next;
}

/**
 * A Post maker post made for a planned slot was accepted as `packageId`; the slot becomes `made` with it, so
 * it is never made twice. A slot that is no longer planned (made, skipped or gone) is left as it is (returns false).
 */
export async function markSlotMade(id: string, slotId: string, packageId: string): Promise<boolean> {
  const plan = await getPlan(id);
  const slot = plan.slots.find((s) => s.id === slotId);
  if (!slot || slot.status !== 'planned') return false;
  await savePlan(id, { ...plan, slots: plan.slots.map((s) => (s.id === slotId ? { ...s, packageId, status: 'made' as const } : s)) });
  return true;
}

/** Campaign view for the dashboard: campaign, plan and its own results. */
export async function campaignView(id: string) {
  const c = await getCampaign(id);
  const plan = await getPlan(id);
  const pkgs = (await listPackages()).filter((p) => p.campaign?.id === id);
  return { campaign: c, plan, packages: pkgs.map((p) => ({ id: p.id, title: p.title, status: p.status, plannedFor: p.plannedFor, posted: p.posted })), insights: insights(pkgs) };
}
