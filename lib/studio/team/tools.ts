// Server-only: the in-process MCP tools the agent team may call (design §7, "Signal tools").
//
// Safety by construction:
//   - There is NO tool that publishes, schedules, approves, sends a reply or talks to Meta / Upload-Post.
//     Every write here produces a proposal file or a timeline event the owner reads in the dashboard.
//   - Every handler is a closure over the calling role and checks the role's allow-list before doing
//     anything (the SDK's allowedTools and the PreToolUse hook check it as well; three layers).
//   - Tool output is compact JSON text: no file paths outside the package, no hashes, no request ids,
//     no credentials. Only the reviewer receives images (downscaled slides / cover), never the video.
//   - IDs are validated with the same rules the Studio uses; nothing is read or written outside the
//     project's posts, campaigns and memory folders.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { campaignsDir, getPlan } from '../campaigns';
import { ContentError, isPackageId, listPackages, loadPackage, pkgPath, writeJsonReplace, type PackageStatus, type PackageView } from '../content';
import { buildPack } from '../memory/packs';
import { memoryDir, newId, recordEvent } from '../memory/store';
import type { Role } from '../memory/types';
import { todayInZone } from '@/lib/time';
import { MCP_SERVER_NAME, ROLES, SIGNAL_TOOL_NAMES, type SignalToolName } from './roles';
import { reportSchema, reviewSchema, specSchema, type Report, type Review, type Spec, type StoredReport, type StoredReview } from './schemas';

// The SDK types each tool by its zod shape; a list of differently-shaped tools has to use the element
// type createSdkMcpServer itself accepts (the SDK's `SdkMcpToolDefinition<any>`), taken from its signature
// so no `any` is written here.
export type AnyTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];
type ToolResult = Awaited<ReturnType<AnyTool['handler']>>;

export interface ToolAudit { at: string; tool: string; allowed: boolean; note: string }
export interface ToolContext {
  role: Role;
  campaign: string | null;
  now: number;
  /** Called on every invocation, allowed or denied, so the run keeps an audit trail. */
  audit?: (entry: ToolAudit) => void;
}

const MAX_IMAGE_PX = 768;
const MAX_IMAGES = 10;
const CAMPAIGN_RE = /^c-[0-9]{8}-[a-z0-9]{4}$/;
const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const THEME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
/** Decision 25 (cheap rule): a draft with a handle, an email or a link is not stored. */
const PERSONAL_RE = /(^|[^A-Za-z0-9])@[A-Za-z0-9_.]{2,}|[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\//i;

const text = (o: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
const redact = (s: string) => s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]').slice(0, 300);

// ---- storage helpers (also used by reviewer.ts / analyst.ts) ---------------------------------------
/** memory/reports/<date>.json next to the project's posts folder (design §3: memory lives beside posts). */
export const reportsDir = (): string => path.join(path.dirname(memoryDir()), 'memory', 'reports');
export const reportFile = (date: string): string => path.join(reportsDir(), `${date}.json`);

/** `event: false` for the in-run tool write: the run's final store records the one timeline event. */
export async function storeReport(r: StoredReport, opts: { event?: boolean } = {}): Promise<string> {
  const f = reportFile(r.date);
  await fs.mkdir(/* turbopackIgnore: true */ reportsDir(), { recursive: true, mode: 0o700 });
  await writeJsonReplace(f, r);
  if (opts.event !== false) await recordEvent({ type: 'note.added', by: r.by, data: { kind: 'weekly-report', date: r.date, headline: r.narrative.headline, run: r.run } });
  return f;
}

export async function readReport(date: string): Promise<StoredReport | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ reportFile(date), 'utf8')) as StoredReport;
  } catch {
    return null;
  }
}

/** Writes <package>/review.json (replace) and records post.reviewed. Never touches approval or status. */
export async function storeReview(r: StoredReview, opts: { event?: boolean } = {}): Promise<void> {
  await writeJsonReplace(pkgPath(r.packageId, 'review.json'), r);
  if (opts.event === false) return;
  await recordEvent({
    type: 'post.reviewed',
    by: r.by,
    refs: { package: r.packageId, run: r.run ?? undefined },
    data: { verdict: r.verdict, briefMatch: r.briefMatch, answerUnambiguous: r.answerUnambiguous, visualQuality: r.visualQuality, aiLabel: r.aiLabel.pass, brandFails: r.brandRules.filter((b) => !b.pass).length, fixes: r.fixes.length },
  });
}

export async function readReview(id: string): Promise<StoredReview | null> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ pkgPath(id, 'review.json'), 'utf8')) as StoredReview;
  } catch {
    return null;
  }
}

/** Stores a spec next to the package (spec.json) or next to the campaign plan (specs/<slot>.json). */
export async function storeSpec(target: { package?: string; campaign?: string; slot?: string }, spec: Spec, by: string): Promise<string> {
  let file: string;
  if (target.package) {
    if (!isPackageId(target.package)) throw new ContentError(400, 'Unknown package.');
    await loadPackage(target.package); // throws when the folder is not a package
    file = pkgPath(target.package, 'spec.json');
  } else if (target.campaign && target.slot) {
    if (!CAMPAIGN_RE.test(target.campaign) || !SLOT_RE.test(target.slot)) throw new ContentError(400, 'Unknown campaign or slot.');
    const dir = path.join(campaignsDir(), target.campaign, 'specs');
    await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, `${target.slot}.json`);
  } else throw new ContentError(400, 'Give a package id, or a campaign and slot.');
  await writeJsonReplace(file, { ...spec, by, at: new Date().toISOString() });
  await recordEvent({ type: 'brief.created', by, campaign: target.campaign ?? null, refs: { package: target.package, slot: target.slot }, data: { kind: spec.kind, title: spec.title } });
  return file;
}

/** Reply drafts: appended to memory/drafts/replies.jsonl; nothing here sends anything. */
export const draftsFile = (): string => path.join(memoryDir(), 'drafts', 'replies.jsonl');
export async function storeDraft(d: { themeId: string; text: string; by: string; campaign: string | null; now: number }): Promise<{ id: string }> {
  const id = newId('dr', d.now);
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(draftsFile()), { recursive: true, mode: 0o700 });
  await fs.appendFile(/* turbopackIgnore: true */ draftsFile(), JSON.stringify({ id, at: new Date(d.now).toISOString(), by: d.by, campaign: d.campaign, themeId: d.themeId, text: d.text, status: 'draft' }) + '\n', { mode: 0o600 });
  await recordEvent({ type: 'note.added', by: d.by, campaign: d.campaign, data: { kind: 'reply-draft', themeId: d.themeId, draft: id } });
  return { id };
}

// ---- compact views (no secrets) --------------------------------------------------------------------
const metricsOf = (p: PackageView) => (p.metrics?.metrics ? { views: p.metrics.metrics.views, reach: p.metrics.metrics.reach, likes: p.metrics.metrics.likes, comments: p.metrics.metrics.comments, saves: p.metrics.metrics.saves, shares: p.metrics.metrics.shares, fetchedAt: p.metrics.fetched_at } : null);

async function postSummary(p: PackageView) {
  const review = await readReview(p.id);
  return {
    id: p.id,
    title: p.title,
    format: p.format,
    status: p.status,
    plannedFor: p.plannedFor,
    postedAt: p.posted?.posted_at ?? null,
    campaign: p.campaign ? { id: p.campaign.id, slot: p.campaign.slot } : null,
    source: p.source ? { format: p.source.format, category: p.source.category, items: p.source.items } : null,
    metrics: metricsOf(p),
    review: review ? { verdict: review.verdict, briefMatch: review.briefMatch, visualQuality: review.visualQuality, at: review.reviewedAt } : null,
  };
}

async function slotBrief(p: PackageView): Promise<Record<string, unknown> | null> {
  if (!p.campaign) return null;
  try {
    const s = (await getPlan(p.campaign.id)).slots.find((x) => x.id === p.campaign!.slot);
    return s ? { date: s.date, format: s.format, pillar: s.pillar, hook: s.hook, angle: s.angle, captionLead: s.captionLead, headline: s.headline } : null;
  } catch {
    return null;
  }
}

/** Downscaled PNG for the model (longest side ≤ 768 px); the original file is never sent. */
async function imageBlock(file: string): Promise<{ type: 'image'; data: string; mimeType: 'image/png' }> {
  const buf = await sharp(file).resize({ width: MAX_IMAGE_PX, height: MAX_IMAGE_PX, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' };
}

/** Which files of a package the reviewer may look at: slides and cover; for a reel the cover only. */
export function reviewableFiles(p: PackageView): PackageView['files'] {
  return p.files.filter((f) => f.ok && (f.role === 'cover' || (p.format !== 'reel' && f.role === 'slide')) && /\.(png|jpe?g)$/i.test(f.name)).slice(0, MAX_IMAGES);
}

// ---- the tools -------------------------------------------------------------------------------------
/**
 * All Signal tools, each bound to the calling role. A handler refuses (isError) when the role's
 * allow-list does not include it, so even a mis-registered server cannot widen a role.
 */
export function signalTools(ctx: ToolContext): AnyTool[] {
  const by = `agent:${ctx.role}`;
  const allowed = new Set<SignalToolName>(ROLES[ctx.role].tools);
  const note = (name: SignalToolName, allowedNow: boolean, msg: string) => ctx.audit?.({ at: new Date().toISOString(), tool: name, allowed: allowedNow, note: msg });

  /** Wraps a handler with the role check, the audit entry and error mapping (never leaks a key or a path). */
  const guarded = <A>(name: SignalToolName, run: (args: A) => Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
    if (!allowed.has(name)) {
      note(name, false, `denied: ${ctx.role} may not use ${name}`);
      return fail(`The ${ctx.role} role may not use ${name}.`);
    }
    try {
      const r = await run(args);
      note(name, true, r.isError ? 'error' : 'ok');
      return r;
    } catch (e) {
      const msg = e instanceof ContentError ? e.message : `${name} failed: ${redact(String((e as Error)?.message ?? e))}`;
      note(name, true, `error: ${msg.slice(0, 120)}`);
      return fail(msg);
    }
  };

  const readPack = tool(
    'read_pack',
    'Your context pack from Signal memory: goal, strategy, branches, learnings and recent results relevant to your role (compact, trusted summary).',
    { campaign: z.string().regex(CAMPAIGN_RE).optional().describe('Campaign id; defaults to the run campaign'), role: z.enum(Object.keys(ROLES) as [Role, ...Role[]]).optional().describe('Lead only: read another role’s pack') },
    guarded('read_pack', async (a) => {
      // Each role sees only its own pack (design §10); the lead orchestrates and may read any.
      const role: Role = ctx.role === 'lead' && a.role ? a.role : ctx.role;
      const pack = await buildPack(role, { campaign: a.campaign ?? ctx.campaign, now: ctx.now });
      return text({ role: pack.role, campaign: pack.campaign, builtAt: pack.builtAt, tokensApprox: pack.tokensApprox, sections: pack.sections });
    }),
  );

  const listPosts = tool(
    'list_posts',
    'Posts of this project as compact summaries (status, dates, campaign slot, metrics, review verdict). No files.',
    {
      status: z.array(z.enum(['ready', 'changed', 'approved', 'scheduled', 'sending', 'submitted', 'uncertain', 'failed', 'posted', 'discarded', 'invalid'])).max(11).optional(),
      campaign: z.string().regex(CAMPAIGN_RE).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Newest first; default 30'),
    },
    guarded('list_posts', async (a) => {
      const status = a.status ? new Set<PackageStatus>(a.status) : null;
      const all = (await listPackages()).filter((p) => (!status || status.has(p.status)) && (!a.campaign || p.campaign?.id === a.campaign));
      const rows = await Promise.all(all.slice(-(a.limit ?? 30)).reverse().map(postSummary));
      return text({ count: all.length, posts: rows });
    }),
  );

  const getPost = tool(
    'get_post',
    'One post: caption, files (names and roles), source items, campaign brief, metrics and any existing review. The reviewer also receives the slides (or the reel cover) as images.',
    { id: z.string().regex(/^\d{2}$/) },
    guarded('get_post', async (a) => {
      const p = await loadPackage(a.id);
      const body = {
        ...(await postSummary(p)),
        caption: p.caption,
        problems: p.problems,
        files: p.files.map((f) => ({ name: f.name, role: f.role, ok: f.ok })),
        brief: await slotBrief(p),
        labelConfirmed: p.labelConfirmed,
        postUrl: p.posted?.url ?? null,
        review: await readReview(p.id),
      };
      const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(body) }];
      // Vision costs tokens and the images are the point of a review; other roles get metadata only.
      if (ctx.role === 'reviewer') {
        for (const f of reviewableFiles(p)) {
          content.push({ type: 'text', text: `Image: ${f.name} (${f.role})` });
          content.push(await imageBlock(pkgPath(p.id, f.name)));
        }
      }
      return { content };
    }),
  );

  const writeReview = tool(
    'write_review',
    'Store your review of a post (review.json next to the package). It informs the owner; it never approves or changes the post.',
    { id: z.string().regex(/^\d{2}$/), review: reviewSchema },
    guarded('write_review', async (a) => {
      const p = await loadPackage(a.id);
      const review: Review = reviewSchema.parse(a.review);
      const stored: StoredReview = { ...review, packageId: p.id, reviewedAt: new Date(ctx.now).toISOString(), by, run: null, model: null, costUsd: null, hashes: Object.fromEntries(reviewableFiles(p).map((f) => [f.name, f.sha256])) };
      await storeReview(stored, { event: ctx.role !== 'reviewer' });
      return text({ ok: true, id: p.id, verdict: review.verdict, status: p.status, note: 'Stored. The owner decides whether to approve the post.' });
    }),
  );

  const writeReport = tool(
    'write_report',
    'Store a weekly report narrative (memory/reports/<date>.json). Numbers must come from your pack or list_posts; never estimate.',
    { report: reportSchema },
    guarded('write_report', async (a) => {
      const narrative: Report = reportSchema.parse(a.report);
      const date = todayInZone(ctx.now);
      const existing = await readReport(date);
      await storeReport({ date, period: existing?.period ?? { from: new Date(ctx.now - 7 * 86_400_000).toISOString(), to: new Date(ctx.now).toISOString() }, by, run: null, model: null, costUsd: null, stats: existing?.stats ?? {}, narrative }, { event: ctx.role !== 'analyst' });
      return text({ ok: true, date });
    }),
  );

  const writeSpec = tool(
    'write_spec',
    'Store a brief / production / motion spec next to a package (spec.json) or next to a campaign plan (specs/<slot>.json). A spec is a proposal; nothing is rendered or posted by this call.',
    { package: z.string().regex(/^\d{2}$/).optional(), campaign: z.string().regex(CAMPAIGN_RE).optional(), slot: z.string().regex(SLOT_RE).optional(), spec: specSchema },
    guarded('write_spec', async (a) => {
      const file = await storeSpec({ package: a.package, campaign: a.campaign ?? ctx.campaign ?? undefined, slot: a.slot }, specSchema.parse(a.spec), by);
      return text({ ok: true, stored: path.basename(file), kind: a.spec.kind });
    }),
  );

  const draftReply = tool(
    'draft_reply',
    'Store a reply draft for a comment theme or anonymised question. Drafts are never sent; the owner reads and sends them.',
    { themeId: z.string().regex(THEME_RE), text: z.string().trim().min(1).max(600) },
    guarded('draft_reply', async (a) => {
      if (PERSONAL_RE.test(a.text)) return fail('The draft contains a handle, an email or a link; it was not stored. Write it without them.');
      const { id } = await storeDraft({ themeId: a.themeId, text: a.text, by, campaign: ctx.campaign, now: ctx.now });
      return text({ ok: true, draft: id, note: 'Stored as a draft. The owner sends replies.' });
    }),
  );

  const proposePivot = tool(
    'propose_pivot',
    'Propose a change of direction with evidence (branch, learning or event ids). This only records a proposal the owner can approve or reject.',
    { text: z.string().trim().min(1).max(800), evidence: z.array(z.string().max(80)).max(10) },
    guarded('propose_pivot', async (a) => {
      const ev = await recordEvent({ type: 'pivot.proposed', by, campaign: ctx.campaign, data: { text: a.text, evidence: a.evidence } });
      return ev ? text({ ok: true, event: ev.id, note: 'Recorded as a proposal; it changes nothing until the owner approves it.' }) : fail('Memory is not enabled; the proposal was not recorded.');
    }),
  );

  const addFinding = tool(
    'add_finding',
    'Record one research finding with its source URL in project memory.',
    { finding: z.string().trim().min(1).max(600), source: z.string().url().max(500) },
    guarded('add_finding', async (a) => {
      if (!/^https?:\/\//i.test(a.source)) return fail('The source must be an http(s) URL.');
      const ev = await recordEvent({ type: 'research.finding', by, campaign: ctx.campaign, data: { finding: a.finding, source: a.source } });
      return ev ? text({ ok: true, event: ev.id }) : fail('Memory is not enabled; the finding was not recorded.');
    }),
  );

  const all: AnyTool[] = [readPack, listPosts, getPost, writeReview, writeReport, writeSpec, draftReply, proposePivot, addFinding];
  // Keep the registry and the name list in sync (a tool that is not in SIGNAL_TOOL_NAMES could never be allowed).
  for (const t of all) if (!(SIGNAL_TOOL_NAMES as readonly string[]).includes(t.name)) throw new Error(`Signal tool ${t.name} is not declared in SIGNAL_TOOL_NAMES.`);
  return all;
}

/** The in-process MCP server for one run: only the role's tools are registered, and each still checks the role. */
export function signalMcpServer(ctx: ToolContext): McpSdkServerConfigWithInstance {
  const allowed = new Set<string>(ROLES[ctx.role].tools);
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    instructions: `Signal tools for the ${ROLES[ctx.role].title}. They read project memory and store proposals; none of them publishes, schedules, approves or sends anything.`,
    tools: signalTools(ctx).filter((t) => allowed.has(t.name)),
    alwaysLoad: true,
  });
}
