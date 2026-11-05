// Server-only: context packs (design section 3.4). Each agent role gets a compact pack built from the
// decision map, the learnings, the campaigns and the timeline, newest and most confident first, cut
// to a token budget (tokensApprox = chars / 4). Packs are cached by a hash of their source material,
// so repeated runs reuse them. Privacy: no usernames and no raw comment text ever enter a pack; only
// comment themes and anonymised questions (events of type comments.theme / comment.question).
import { createHash } from 'node:crypto';
import { todayInZone } from '@/lib/time';
import { loadBrand, type BrandKit } from '../brand';
import { getPlan, listCampaigns, type Campaign, type Slot } from '../campaigns';
import { listPackages, type PackageView } from '../content';
import { currentProject } from '../projects';
import { isVariant, toObservation } from './graph';
import { METRIC_LABEL, MIN_NEFF, formatValue, hookFromCaption, metricValue, metricsFor, predictNext, recencyWeight, type PostObservation } from './stats';
import { listEvents, readGraph, readLearnings, readPack, writePack } from './store';
import type { ContextPack, Graph, GraphNode, Learning, MemEvent, Role } from './types';

export const PACK_BUDGET: Record<Role, number> = {
  lead: 3500,
  researcher: 1500,
  strategist: 3000,
  planner: 2000,
  'creative-producer': 1500,
  'motion-designer': 1200,
  reviewer: 1500,
  analyst: 2500,
  'community-manager': 1000,
};

export interface Section { title: string; text: string }
export const tokensApprox = (s: Section[]): number => Math.ceil(s.reduce((a, x) => a + x.title.length + x.text.length, 0) / 4);

const DAY = 86_400_000;
const GENERAL_RULES = ["Every post carries Instagram's AI label.", 'Original visuals only: no real people or third-party brands.', 'One post per day for this account, shared between campaigns.', 'Nothing is published without the owner’s approval.'];

// ---- privacy -------------------------------------------------------------------------------------
/** Removes @handles (except the project's own) and e-mail addresses from any text that goes into a pack. */
export function scrub(text: string, keepHandle: string | null = null): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/@[A-Za-z0-9._]{2,30}/g, (h) => (keepHandle && h.toLowerCase() === keepHandle.toLowerCase() ? h : '@…'));
}

// ---- budget --------------------------------------------------------------------------------------
/** Keeps sections in priority order until the budget is spent; the last one that fits partially is cut at a line break. */
export function fitToBudget(sections: Section[], budgetTokens: number): Section[] {
  let left = budgetTokens * 4;
  const out: Section[] = [];
  for (const s of sections) {
    if (!s.text.trim()) continue;
    const cost = s.title.length + s.text.length;
    if (cost <= left) {
      out.push(s);
      left -= cost;
      continue;
    }
    const room = left - s.title.length - 8;
    if (room < 80) break;
    const cutAt = s.text.lastIndexOf('\n', room);
    const text = `${s.text.slice(0, cutAt > room / 2 ? cutAt : room).trimEnd()}\n… (cut)`;
    out.push({ title: s.title, text });
    break;
  }
  return out;
}

// ---- source material -----------------------------------------------------------------------------
interface Sources {
  now: number;
  handle: string;
  campaigns: Campaign[]; // in scope (one when a campaign is given, else all but 'done')
  slots: Map<string, Slot[]>;
  packages: PackageView[];
  observations: PostObservation[];
  graph: Graph;
  learnings: Learning[]; // in scope, not retired
  events: MemEvent[];
  brand: BrandKit | null;
}

async function gather(campaignId: string | null, now: number): Promise<Sources> {
  const all = await listCampaigns();
  const campaigns = campaignId ? all.filter((c) => c.id === campaignId) : all.filter((c) => c.status !== 'done');
  const slots = new Map<string, Slot[]>();
  for (const c of all) slots.set(c.id, (await getPlan(c.id)).slots);
  const packages = (await listPackages()).filter(isVariant);
  const slotOf = (p: PackageView) => (p.campaign ? (slots.get(p.campaign.id)?.find((s) => s.id === p.campaign!.slot || s.packageId === p.id) ?? null) : null);
  const observations = packages.map((p) => toObservation(p, slotOf(p))).filter((o): o is PostObservation => o != null);
  const graph = await readGraph();
  const learnings = (await readLearnings()).learnings.filter((l) => l.status !== 'retired' && (!campaignId || !l.scope.campaign || l.scope.campaign === campaignId));
  const events = await listEvents({ since: new Date(now - 90 * DAY).toISOString() });
  return { now, handle: currentProject().handle, campaigns, slots, packages, observations, graph, learnings, events, brand: await loadBrand().catch(() => null) };
}

// ---- section builders ----------------------------------------------------------------------------
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '?');
const lines = (xs: string[]) => xs.join('\n');
const bullet = (xs: string[]) => lines(xs.map((x) => `- ${x}`));

function goalsSection(s: Sources): Section {
  return {
    title: 'Goal and campaigns',
    text: bullet(s.campaigns.map((c) => {
      const m = metricsFor(c.goal);
      return `${c.name} (${c.id}): goal ${c.goal}, primary metric ${METRIC_LABEL[m.primary]}${m.secondary ? `, secondary ${METRIC_LABEL[m.secondary]}` : ''}; status ${c.status}; ${c.perWeek}/week from ${c.startDate}${c.endDate ? ` to ${c.endDate}` : ''}.${c.brief ? ` Brief: ${c.brief}` : ''}`;
    })),
  };
}

function strategySection(s: Sources, full: boolean): Section {
  const parts: string[] = [];
  for (const c of s.campaigns) {
    const st = c.strategy;
    if (!st) {
      parts.push(`${c.name}: no approved strategy yet.`);
      continue;
    }
    parts.push(`${c.name} (approved ${day(st.approvedAt)}): ${st.summary}`);
    if (st.positioning) parts.push(`Positioning: ${st.positioning}`);
    parts.push(`Pillars: ${st.pillars.map((p) => `${p.name} ${p.weight}%${full && p.why ? ` (${p.why})` : ''}`).join('; ')}`);
    if (full) for (const pt of st.postTypes) parts.push(`${pt.format}: ${pt.role}${pt.bestTimes.length ? ` Best times ${pt.bestTimes.join(', ')}.` : ''}${pt.hooks.length ? ` Hook examples: ${pt.hooks.slice(0, 3).map((h) => `"${h}"`).join(', ')}.` : ''}${pt.donts.length ? ` Don't: ${pt.donts.slice(0, 3).join('; ')}.` : ''}`);
    if (full && st.kpis.length) parts.push(`KPIs: ${st.kpis.map((k) => `${k.metric} → ${k.target}`).join('; ')}`);
  }
  return { title: 'Current strategy', text: lines(parts) };
}

/** Learnings ranked by confidence × recency of their last evidence; "too little data" ones sink. */
export function rankLearnings(ls: Learning[], now: number): Learning[] {
  const score = (l: Learning) => {
    const age = l.lastEvidence ? (now - Date.parse(l.lastEvidence)) / DAY : 365;
    return l.confidence * recencyWeight(age, l.halfLifeDays) * (l.status === 'too-little-data' ? 0.5 : 1);
  };
  return [...ls].filter((l) => Object.keys(l.scope).length > 0 && l.n > 0).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

const learningLine = (l: Learning) => `${l.text} [${METRIC_LABEL[l.metric]}; confidence ${l.confidence.toFixed(2)}; nEff ${l.nEff.toFixed(1)}${l.interval ? `; 90% interval ${l.interval[0].toFixed(2)}–${l.interval[1].toFixed(2)}` : ''}${l.status === 'too-little-data' ? '; too little data' : ''}]`;

function learningsSection(s: Sources, n: number, title = `Top ${n} learnings`, filter: (l: Learning) => boolean = () => true): Section {
  return { title, text: bullet(rankLearnings(s.learnings.filter(filter), s.now).slice(0, n).map(learningLine)) };
}

function baselinesSection(s: Sources): Section {
  return { title: 'Baselines', text: bullet(s.learnings.filter((l) => Object.keys(l.scope).length === 0).map((l) => l.text)) };
}

const isBranch = (n: GraphNode) => (n.type === 'pillar' || n.type === 'hypothesis') && n.status != null;
/** "Question hooks in Guess the link" for a hypothesis; the pillar's own label otherwise. */
const branchName = (n: GraphNode) => (n.type === 'hypothesis' && typeof n.meta.pillar === 'string' ? `${n.label} in ${n.meta.pillar}` : n.label);
const branchLine = (n: GraphNode) => {
  const st = n.meta.stats as { n?: number; nEff?: number; effect?: number | null; confidence?: number } | undefined;
  return `${branchName(n)} [${n.type}; ${n.status}${st && st.n ? `; effect ${st.effect == null ? '?' : `×${st.effect.toFixed(2)}`}, nEff ${(st.nEff ?? 0).toFixed(1)}, confidence ${(st.confidence ?? 0).toFixed(2)}` : '; no results yet'}]`;
};

function branchesSection(s: Sources): Section {
  const ids = new Set(s.campaigns.map((c) => c.id));
  const nodes = s.graph.nodes.filter((n) => isBranch(n) && n.campaign && ids.has(n.campaign));
  const active = nodes.filter((n) => n.status !== 'pruned');
  const pruned = nodes.filter((n) => n.status === 'pruned');
  return { title: 'Branches', text: lines([bullet(active.map(branchLine)), pruned.length ? `Pruned: ${pruned.map((n) => n.label).join('; ')}` : '']) };
}

/** Planner view: what each open branch is expected to do next (shrunk toward the baseline) and whether to explore it. */
function branchWeightsSection(s: Sources): Section {
  const ids = new Set(s.campaigns.map((c) => c.id));
  const byId = new Map(s.learnings.map((l) => [l.id, l]));
  const rows = s.graph.nodes
    .filter((n) => isBranch(n) && n.status !== 'pruned' && n.campaign && ids.has(n.campaign))
    .map((n) => {
      const l = n.learning ? byId.get(n.learning) ?? null : null;
      const pred = l ? predictNext(l, l.baseline) : null;
      const mode = !l || l.nEff < MIN_NEFF ? 'explore (too little data)' : l.effect != null && l.effect > 1 ? 'exploit' : 'test again';
      return `${branchName(n)}: ${n.status}; expected next ${l && pred != null ? `${formatValue(l.metric, pred)} ${METRIC_LABEL[l.metric]}` : 'unknown'}; ${mode}`;
    });
  return { title: 'Branch weights (explore / exploit)', text: lines([bullet(rows), 'Slots are allocated by Thompson sampling with a 20% exploration floor; branches without data are always worth one test.']) };
}

function recentHooksSection(s: Sources): Section {
  const hooks: { at: string; hook: string }[] = [];
  for (const [, slots] of s.slots) for (const sl of slots) if (sl.hook && sl.status !== 'skipped') hooks.push({ at: sl.at, hook: sl.hook });
  for (const p of s.packages) {
    const h = hookFromCaption(p.caption);
    if (h && !p.campaign) hooks.push({ at: p.posted?.posted_at ?? p.plannedFor ?? '0000', hook: h });
  }
  const seen = new Set<string>();
  const last = hooks.sort((a, b) => b.at.localeCompare(a.at)).filter((h) => !seen.has(h.hook) && seen.add(h.hook)).slice(0, 20);
  return { title: 'Recent hooks (do not repeat)', text: bullet(last.map((h) => `${day(h.at)}: "${h.hook}"`)) };
}

function upcomingSlotsSection(s: Sources): Section {
  const today = todayInZone(s.now);
  const rows: string[] = [];
  for (const [cid, slots] of s.slots) for (const sl of slots) if (sl.date >= today && sl.status !== 'skipped') rows.push(`${sl.date} ${sl.time}: ${sl.format} / ${sl.pillar || '?'} (${cid}, ${sl.status})`);
  for (const p of s.packages) if (!p.campaign && (p.plannedFor ?? p.scheduled?.scheduled_for ?? '') >= today) rows.push(`${day(p.plannedFor ?? p.scheduled?.scheduled_for)}: post ${p.id} (${p.format}, ${p.status})`);
  return { title: 'Days already taken', text: bullet(rows.sort()) };
}

function rejectionsSection(s: Sources): Section {
  const rows = s.events
    .filter((e) => e.type === 'post.rejected')
    .slice(-20)
    .reverse()
    .map((e) => `${day(e.at)} post ${e.refs.package ?? '?'}: ${typeof e.data.reason === 'string' && e.data.reason.trim() ? e.data.reason : 'no reason given'}`);
  return { title: 'Past rejections (most recent 20)', text: bullet(rows) };
}

function fmtMetrics(p: PackageView): string {
  const m = p.metrics?.metrics;
  if (!m) return 'no results yet';
  const v = (x: number | null) => (x == null ? '–' : x.toLocaleString('en-GB'));
  return `views ${v(m.views)}, reach ${v(m.reach)}, likes ${v(m.likes)}, comments ${v(m.comments)}, saves ${v(m.saves)}, shares ${v(m.shares)}`;
}

function recentPostsSection(s: Sources, days: number, title: string): Section {
  const since = s.now - days * DAY;
  const posts = s.packages.filter((p) => p.posted && Date.parse(p.posted.posted_at) >= since).sort((a, b) => b.posted!.posted_at.localeCompare(a.posted!.posted_at));
  const byFormat = new Map<string, number>();
  for (const p of posts) byFormat.set(p.source?.format ?? p.format, (byFormat.get(p.source?.format ?? p.format) ?? 0) + 1);
  const head = posts.length ? `${posts.length} posts in the last ${days} days: ${[...byFormat].map(([f, n]) => `${n} ${f}`).join(', ')}.` : `No posts in the last ${days} days.`;
  return { title, text: lines([head, bullet(posts.slice(0, 15).map((p) => `${day(p.posted!.posted_at)} post ${p.id} (${p.source?.format ?? p.format}${p.campaign ? `, ${p.campaign.name}` : ''}) "${hookFromCaption(p.caption) ?? p.title}": ${fmtMetrics(p)}`))]) };
}

function visualWinnersSection(s: Sources): Section {
  const goal = s.campaigns[0]?.goal ?? 'engagement';
  const metric = metricsFor(goal).primary;
  const rows = s.observations
    .map((o) => ({ o, v: metricValue(o.metrics, metric) }))
    .filter((x): x is { o: PostObservation; v: number } => x.v != null)
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
    .map(({ o, v }) => `post ${o.id} (${o.format ?? '?'}${o.pillar ? `, ${o.pillar}` : ''}) "${o.hook ?? ''}": ${formatValue(metric, v)} ${METRIC_LABEL[metric]}`);
  return { title: 'Past winners', text: bullet(rows) };
}

function changedSection(s: Sources): Section {
  const since = new Date(s.now - 7 * DAY).toISOString();
  const rows: string[] = [];
  for (const n of s.graph.nodes) {
    if (!isBranch(n)) continue;
    const hist = (n.meta.statusHistory as { at: string; status: string }[] | undefined) ?? [];
    const last = hist.at(-1);
    if (last && last.at >= since && hist.length > 1) rows.push(`${branchName(n)}: ${hist.at(-2)!.status} → ${last.status} on ${day(last.at)}`);
  }
  for (const l of rankLearnings(s.learnings, s.now)) if (l.lastEvidence && l.lastEvidence >= since) rows.push(learningLine(l));
  return { title: 'What changed in the last 7 days', text: bullet(rows.slice(0, 20)) };
}

function experimentsDueSection(s: Sources): Section {
  const ids = new Set(s.campaigns.map((c) => c.id));
  const rows = s.graph.nodes.filter((n) => isBranch(n) && n.status !== 'pruned' && n.campaign && ids.has(n.campaign) && ((n.meta.stats as { nEff?: number } | undefined)?.nEff ?? 0) < MIN_NEFF).map(branchName);
  for (const c of s.campaigns) for (const e of c.strategy?.experiments ?? []) rows.push(`${e.hypothesis} (measure: ${e.measure})`);
  return { title: 'Experiments that still need data', text: bullet(rows) };
}

function openQuestionsSection(s: Sources): Section {
  const rows: string[] = [];
  for (const c of s.campaigns) for (const e of c.strategy?.experiments ?? []) rows.push(`${e.hypothesis} — measure: ${e.measure}`);
  for (const l of s.learnings) if (l.status === 'too-little-data' && l.n > 0 && Object.keys(l.scope).length) rows.push(`${l.text}`);
  return { title: 'Open questions', text: bullet([...new Set(rows)].slice(0, 12)) };
}

function pivotsSection(s: Sources): Section {
  const ids = new Set(s.campaigns.map((c) => c.id));
  const rows = s.graph.nodes.filter((n) => n.type === 'pivot' && (!n.campaign || ids.has(n.campaign))).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 10).map((n) => `${day(String(n.meta.decidedAt ?? n.updated))} ${String(n.meta.decision ?? n.status)}: ${n.label}${typeof n.meta.reason === 'string' && n.meta.reason ? ` (${n.meta.reason})` : ''}`);
  return { title: 'Pivots', text: bullet(rows) };
}

function researchSection(s: Sources): Section {
  const rows: string[] = [];
  for (const c of s.campaigns) for (const r of c.strategy?.research ?? []) rows.push(`${r.finding} (${r.source})`);
  for (const e of s.events) if (e.type === 'research.finding' && typeof e.data.finding === 'string') rows.push(`${e.data.finding}${typeof e.data.source === 'string' ? ` (${e.data.source})` : ''}`);
  return { title: 'Known research', text: bullet(rows.slice(-12)) };
}

function brandSection(s: Sources, what: 'kit' | 'voice' | 'rules'): Section {
  const b = s.brand;
  const rows: string[] = [];
  if (b) {
    if (what !== 'voice') rows.push(`${b.name}${b.tagline ? ` — ${b.tagline}` : ''}${b.website ? ` (${b.website})` : ''}`);
    if (what === 'kit') rows.push(`Colours: primary ${b.colors.primary}, background ${b.colors.background}, text ${b.colors.text}, accent ${b.colors.accent}.`, `Fonts: ${b.fonts.join(', ') || 'default'}.`);
    if (b.voice.length) rows.push(`Voice: ${b.voice.join('; ')}`);
  } else rows.push('No brand kit yet.');
  if (what === 'rules') {
    rows.push(...GENERAL_RULES);
    for (const c of s.campaigns) for (const pt of c.strategy?.postTypes ?? []) for (const d of pt.donts) rows.push(`${pt.format}: don't ${d}`);
  }
  return { title: what === 'rules' ? 'Brand rules and claims policy' : what === 'voice' ? 'Brand voice' : 'Brand kit', text: bullet([...new Set(rows)]) };
}

/** Comment themes and anonymised questions only: event data written by the router, never raw comments. */
function commentsSection(s: Sources): Section {
  const since = new Date(s.now - 30 * DAY).toISOString();
  const themes = new Map<string, number>();
  const questions: string[] = [];
  for (const e of s.events) {
    if (e.at < since) continue;
    if (e.type === 'comments.theme' && typeof e.data.theme === 'string') themes.set(e.data.theme, (themes.get(e.data.theme) ?? 0) + (typeof e.data.count === 'number' ? e.data.count : 1));
    if (e.type === 'comment.question' && typeof e.data.question === 'string') questions.push(e.data.question);
  }
  const rows = [...themes].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`);
  return { title: 'Comment themes and questions (last 30 days, anonymised)', text: lines([rows.length ? `Themes: ${rows.join(', ')}` : 'No comment themes yet.', questions.length ? `Questions:\n${bullet(questions.slice(-10))}` : '']) };
}

const visual = (l: Learning) => l.scope.format != null;

function sectionsFor(role: Role, s: Sources, extra: Section[]): Section[] {
  switch (role) {
    case 'lead':
      return [goalsSection(s), strategySection(s, false), learningsSection(s, 10), branchesSection(s), pivotsSection(s), recentPostsSection(s, 28, 'Last 4 weeks'), openQuestionsSection(s), ...extra];
    case 'researcher':
      return [goalsSection(s), strategySection(s, false), openQuestionsSection(s), researchSection(s), ...extra];
    case 'strategist':
      return [goalsSection(s), strategySection(s, true), learningsSection(s, 10), branchesSection(s), recentPostsSection(s, 28, 'Last 4 weeks'), openQuestionsSection(s), ...extra];
    case 'planner':
      return [strategySection(s, true), branchWeightsSection(s), upcomingSlotsSection(s), recentHooksSection(s), learningsSection(s, 6, 'Format, hook and timing learnings', (l) => l.scope.format != null || l.scope.hookStyle != null || l.scope.hour != null), ...extra];
    case 'creative-producer':
      return [...extra, brandSection(s, 'kit'), learningsSection(s, 6, 'Visual learnings', visual), visualWinnersSection(s), rejectionsSection(s)];
    case 'motion-designer':
      return [...extra, learningsSection(s, 5, 'Format learnings', visual), rejectionsSection(s), brandSection(s, 'kit')];
    case 'reviewer':
      return [brandSection(s, 'rules'), rejectionsSection(s), learningsSection(s, 5), ...extra];
    case 'analyst':
      return [recentPostsSection(s, 7, 'Results since the last report (7 days)'), baselinesSection(s), changedSection(s), experimentsDueSection(s), learningsSection(s, 10), ...extra];
    case 'community-manager':
      return [commentsSection(s), brandSection(s, 'voice'), goalsSection(s), ...extra];
  }
}

// ---- public API ----------------------------------------------------------------------------------
/**
 * Builds (or returns the cached) context pack for a role. `extra` sections (a brief, the package under
 * review, …) come first for production roles and last for planning roles. Does not check the gate.
 */
export async function buildPack(role: Role, opts: { campaign?: string | null; now?: number; extra?: { title: string; text: string }[] }): Promise<ContextPack> {
  const now = opts.now ?? Date.now();
  const campaign = opts.campaign ?? null;
  const s = await gather(campaign, now);
  const extra = (opts.extra ?? []).map((e) => ({ title: e.title, text: e.text }));
  const full = sectionsFor(role, s, extra).map((x) => ({ title: scrub(x.title, s.handle), text: scrub(x.text, s.handle) }));
  const budgetTokens = PACK_BUDGET[role];
  const inputsHash = createHash('sha256').update(JSON.stringify({ role, campaign, budgetTokens, sections: full })).digest('hex');
  const cached = await readPack(role, campaign);
  if (cached && cached.inputsHash === inputsHash) return cached;
  const sections = fitToBudget(full, budgetTokens);
  const pack: ContextPack = { role, project: currentProject().id, campaign, builtAt: new Date(now).toISOString(), inputsHash, budgetTokens, tokensApprox: tokensApprox(sections), sections };
  await writePack(pack);
  return pack;
}
