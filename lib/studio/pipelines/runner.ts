// Server-only: pipelines inside an autopilot run.
//
// For every pipeline that is on (or the one you pressed Run now for), the run looks at the upcoming slots of
// its schedule inside make-ahead, and for each slot that has no post yet: gets an idea from the source, makes
// the post (generatePackage with a brief, or the campaign's own makeSlotPost), writes the provenance
// (<package>/pipeline.json and the autopilot mark so Review shows "Made by autopilot" and trust works), plans
// the post for the slot time, then runs the shared review and trusted-approval steps (../autopilot/steps.ts).
// Every rule of the daily run applies: feature switches, pause switches, the daily budget checked before each
// step, the backlog limit, the unclear-post stop (checked by the caller), one run at a time. Codex formats are
// made only in a run you started for this one pipeline.
import { addDays, todayInZone } from '@/lib/time';
import { claimProblems, getCampaign, getPlan, makeSlotPost, type Slot } from '../campaigns';
import { currentLimits, listPackages, loadPackage, pkgPath, setPlan, writeJsonReplace, type PackageView } from '../content';
import { BRIEF_FORMATS, FORMAT_LABEL, generatePackage, HEADLINE_FORMATS, type Format } from '../generate';
import { discoverArticles, loadBrand, readArticle } from '../brand';
import { insights } from '../analytics';
import { agentCostOf, runAgent } from '../claude-agent';
import { higgsfieldAllowed } from '../higgsfield';
import { recordEvent } from '../memory/store';
import { currentProject } from '../projects';
import { readSettings } from '../autopilot/settings';
import { ATTENDED_ONLY, AUTOPILOT_BY, BACKLOG_LIMIT, HIGGSFIELD_FORMATS, PLAN_CAP_USD, REVIEW_CAP_USD, iso, makeCostEstimate, maybeAutoApprove, msg, reviewStep, spendOfPipeline, waitingInReview, type Job, type RunnerDeps } from '../autopilot/steps';
import { MARK_FILE } from '../autopilot/trust';
import type { AutopilotMark, AutopilotRun } from '../autopilot/types';
import { listPipelines, readState, stepProblems, upcomingSlots, writeState } from './store';
import type { Idea, Pipeline, PipelineMark, PipelineSlot, PipelineState } from './types';

export const PIPELINE_MARK_FILE = 'pipeline.json';
/** The most ideas the agent writes in one call (one call per run at most, when the queue is empty). */
const IDEAS_PER_CALL = { min: 2, max: 7 };

/** Packages a pipeline made, by slot instant (discarded ones too: what you said no to is never remade). */
export function madeBy(all: PackageView[], pipeline: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of all) if (p.pipeline?.id === pipeline) m.set(p.pipeline.slotAt, p.id);
  return m;
}

/** The calendar day (Studio time zone) a package goes (or went) out on, or is planned for; null when it has no day yet. */
function dayOf(p: PackageView): string | null {
  const at = p.posted?.posted_at ?? p.scheduled?.scheduled_for ?? p.plannedFor ?? p.dispatch?.claimed_at ?? p.pipeline?.slotAt ?? null;
  return at && Number.isFinite(Date.parse(at)) ? todayInZone(Date.parse(at)) : null;
}

/** Calendar days (Studio time zone) that already have a post from elsewhere (another pipeline, a campaign, a hand-made plan). */
export function takenDays(all: PackageView[], pipeline: string): Set<string> {
  const days = new Set<string>();
  for (const p of all) {
    if (p.status === 'discarded' || p.pipeline?.id === pipeline) continue;
    const day = dayOf(p);
    if (day) days.add(day);
  }
  return days;
}

/** Posts (not discarded) going out or planned on each calendar day, from anywhere: what the per-day limit already counts. */
export function postsPerDay(all: PackageView[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of all) {
    if (p.status === 'discarded') continue;
    const day = dayOf(p);
    if (day) m.set(day, (m.get(day) ?? 0) + 1);
  }
  return m;
}

/** {topic} {brand} {tone} in a template; an empty template is the topic itself. */
export function fillTemplate(template: string, vars: { topic: string; brand: string; tone: string }): string {
  const t = template.trim() || '{topic}';
  return t.replace(/\{topic\}/gi, vars.topic).replace(/\{brand\}/gi, vars.brand).replace(/\{tone\}/gi, vars.tone).replace(/\s+/g, ' ').trim();
}

const IDEAS_SPEC = `A JSON object:
{
  "ideas": [{                 // exactly the asked number, each a different post
    "topic": "what the post is about, one line under 120 characters",
    "hook": "first caption line, under 90 characters, a question or a surprising fact",
    "prompt": "an image prompt for an original visual (no text in the image, no real people, no other brands), under 400 characters",
    "headline": "on-image headline under 50 characters, or empty",
    "caption": "two or three short caption sentences in the brand voice, ending with what to do (answer in the comments); no hashtags"
  }]
}`;

/** The ideas agent: a handful of post ideas from the brand, past posts and results, written once and queued. */
async function writeIdeas(p: Pipeline, want: number, all: PackageView[], deps: RunnerDeps): Promise<{ ideas: Idea[]; costUsd: number | null }> {
  const project = currentProject();
  const brand = await loadBrand(project);
  const ins = insights(all);
  const recent = all
    .filter((x) => x.status !== 'discarded')
    .slice(-15)
    .map((x) => ({ title: x.title, caption: x.caption.slice(0, 160), posted: Boolean(x.posted), metrics: x.metrics?.metrics ?? null }));
  const input = {
    project: { name: project.name, instagram: project.handle },
    postType: { id: p.steps.make.format, name: FORMAT_LABEL[p.steps.make.format] },
    captionStyle: p.steps.make.captionStyle || undefined,
    brand: brand ? { name: brand.name, tagline: brand.tagline, website: brand.website, voice: brand.voice } : null,
    results: { measured: ins.measured, byFormat: ins.byFormat, bestWeekday: ins.bestWeekday, bestHour: ins.bestHour },
    count: want,
    rules: ['Original visuals only.', "Every post carries Instagram's AI label.", 'No claims about results, rankings or prizes.'],
  };
  const untrusted = { ourRecentPosts: recent, websiteCopy: brand?.copy?.slice(0, 20) ?? [] };
  const { value, meta } = await runAgent(
    'content-planner',
    {
      task: `Write ${want} post ideas for ${project.handle}: different topics, no repeats of our recent posts. It is for the "${FORMAT_LABEL[p.steps.make.format]}" post type.`,
      input,
      untrusted,
      outputSpec: IDEAS_SPEC,
      validate: (v) => {
        const rows = Array.isArray((v as { ideas?: unknown })?.ideas) ? ((v as { ideas: unknown[] }).ideas as Record<string, unknown>[]) : [];
        const s = (x: unknown, n: number) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, n) : '');
        const out = rows
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({ topic: s(r.topic, 160), hook: s(r.hook, 120), prompt: s(r.prompt, 600), headline: s(r.headline, 70), caption: typeof r.caption === 'string' ? r.caption.trim().slice(0, 900) : '' }))
          .filter((r) => r.topic);
        // The claims lint on the agent's copy: an idea that breaks it is never queued.
        const clean = out.filter((r) => ![r.topic, r.hook, r.headline, r.caption].some((t) => claimProblems(t).length)).slice(0, IDEAS_PER_CALL.max);
        if (!out.length) throw new Error('The agent returned no ideas.');
        if (!clean.length) throw new Error('Every idea broke Signal\'s content rules (unverifiable claims, timers or "tap to").');
        return clean;
      },
    },
    deps.agentRunner,
  );
  return { ideas: value, costUsd: meta.costUsd };
}

type Picked = { idea: Idea; commit: (s: PipelineState) => void } | { skip: string } | { agent: true };

/** The next idea from the pipeline's source; `commit` marks it used once the post exists. */
async function nextIdea(p: Pipeline, state: PipelineState, all: PackageView[], deps: RunnerDeps): Promise<Picked> {
  const src = p.steps.source;
  if (src.kind === 'list') {
    const topic = src.list[state.listNext];
    if (!topic) return { skip: `the list is used up (${src.list.length} of ${src.list.length} used). Add topics to keep going.` };
    return { idea: { topic }, commit: (s) => void (s.listNext += 1) };
  }
  if (src.kind === 'website') {
    let urls: string[];
    try {
      urls = await (deps.discoverArticles ?? (() => discoverArticles()))();
    } catch (e) {
      return { skip: `the website gave no pages: ${msg(e)}` };
    }
    const used = new Set<string>(all.flatMap((x) => [x.source?.category ?? '', x.pipeline?.article ?? '']));
    const url = urls.find((u) => !used.has(u));
    if (!url) return { skip: urls.length ? 'every page on the website has a post already.' : 'no pages were found on the website (no sitemap or feed).' };
    if (p.steps.make.format === 'website-card') return { idea: { topic: url, articleUrl: url }, commit: () => undefined };
    try {
      const art = await (deps.readArticle ?? ((u: string) => readArticle(u)))(url);
      return { idea: { topic: art.title || url, caption: art.summary || undefined, articleUrl: url }, commit: () => undefined };
    } catch (e) {
      return { skip: `the page could not be read: ${msg(e)}` };
    }
  }
  if (src.kind === 'ideas') {
    const next = state.ideas[0];
    if (next) return { idea: next, commit: (s) => void s.ideas.shift() };
    return { agent: true };
  }
  return { skip: 'unknown source.' };
}

/** What generatePackage needs for one idea in one format. */
export function briefFor(p: Pipeline, idea: Idea, vars: { brand: string; tone: string }): { format: Format; brief?: { prompt: string; headline?: string; caption?: string }; articleUrl?: string; captionLead?: string } {
  const format = p.steps.make.format;
  if (format === 'website-card') return { format, ...(idea.articleUrl ? { articleUrl: idea.articleUrl } : {}) };
  if (BRIEF_FORMATS.includes(format)) {
    const prompt = fillTemplate(p.steps.make.template, { topic: idea.prompt || idea.topic, ...vars });
    const caption = [idea.hook, idea.caption].filter(Boolean).join('\n\n') || undefined;
    return { format, brief: { prompt, headline: HEADLINE_FORMATS.includes(format) ? idea.headline || undefined : undefined, caption } };
  }
  return { format, captionLead: idea.hook || idea.topic };
}

/** One pipeline inside the run. */
async function runOne(run: AutopilotRun, p: Pipeline, todays: AutopilotRun[], deps: RunnerDeps, now: number, manual: boolean): Promise<void> {
  const id = p.id;
  const skip = (reason: string) => run.steps.push({ kind: 'skip', campaign: null, pipeline: id, reason });
  const state = await readState(id);
  const flush = async (result: string | null) => {
    state.lastRunAt = iso(now);
    if (result) state.lastResult = result;
    await writeState(id, state).catch(() => undefined);
  };
  const problems = stepProblems(p);
  if (problems.length) {
    skip(problems[0]!);
    return flush(problems[0]!);
  }
  const spent = () => spendOfPipeline([...todays, run], id);
  const cap = p.steps.budget.dailyUsd;
  const overBudget = (next = 0) => spent() + next > cap || spent() >= cap;
  const budgetStop = () => skip(`Daily budget of $${cap.toFixed(2)} reached: $${spent().toFixed(2)} spent today, and the next step could go over it.`);
  const review = p.steps.review.enabled;
  const autoPublish: Job['autoPublish'] = p.steps.approve.mode === 'trusted' ? 'trusted' : 'never';

  // ---- campaign source: the campaign's own planned slots, made with its own briefs --------------------------
  if (p.steps.source.kind === 'campaign') {
    const cid = p.steps.source.campaign!;
    const c = await getCampaign(cid).catch(() => null);
    if (!c) {
      skip('the linked campaign no longer exists.');
      return flush('The linked campaign no longer exists.');
    }
    if (c.status !== 'active') {
      skip(`campaign "${c.name}" is not running (${c.status}).`);
      return flush(`Campaign "${c.name}" is not running.`);
    }
    // The campaign's own autopilot switch is the master switch for making its posts unattended; a pipeline never bypasses it.
    if (!(await readSettings(cid)).enabled) {
      skip(`campaign "${c.name}" is off: its autopilot is switched off, so nothing is made from its plan.`);
      return flush(`Campaign "${c.name}" is off.`);
    }
    const today = run.day;
    const horizon = addDays(today, p.steps.schedule.makeAheadDays);
    const due = (await getPlan(cid)).slots.filter((sl) => sl.status === 'planned' && sl.date >= today && sl.date <= horizon && Date.parse(sl.at) > now).sort((a, b) => a.at.localeCompare(b.at));
    let made = 0;
    for (const sl of due) {
      const outcome = await makeOne(run, p, { id: sl.id, date: sl.date, time: sl.time, at: sl.at, packageId: null }, { idea: { topic: sl.hook, hook: sl.hook, prompt: sl.prompt, headline: sl.headline }, commit: () => undefined }, sl.format, { overBudget, budgetStop, review, autoPublish, manual, deps, now, campaign: cid, slot: sl });
      if (outcome === 'stop') break;
      if (outcome === 'made') made += 1;
    }
    return flush(made ? `Made ${made} ${made === 1 ? 'post' : 'posts'} from "${c.name}".` : due.length ? 'Nothing made (see the run).' : 'Nothing to do: no planned slot in the campaign.');
  }

  // ---- own schedule: days × times inside make-ahead ---------------------------------------------------------
  let all = await listPackages();
  const open = upcomingSlots(p, madeBy(all, id), now).filter((sl) => !sl.packageId);
  if (!open.length) return flush('Up to date: every upcoming slot has a post.');
  const taken = takenDays(all, id);
  // The account's per-day limit: a post that could never be scheduled on its day is not made at all.
  const lim = await currentLimits(now);
  if (!lim.open) {
    skip(lim.reason);
    return flush(lim.reason);
  }
  const perDay = postsPerDay(all);
  const room = new Map<string, number>();
  for (const sl of open) if (!room.has(sl.date)) room.set(sl.date, Math.max(0, lim.maxPerDay - (perDay.get(sl.date) ?? 0)));
  const format = p.steps.make.format;
  if (ATTENDED_ONLY.includes(format) && !manual) {
    skip(`${FORMAT_LABEL[format]} uses Codex, which runs only when you press Run now on this pipeline.`);
    return flush('Waiting for you: Codex posts are made only when you press Run now.');
  }
  if (HIGGSFIELD_FORMATS.includes(format)) {
    const hf = await higgsfieldAllowed();
    if (!hf.enabled) {
      skip(hf.reason);
      return flush(hf.reason);
    }
  }
  const brand = await loadBrand(currentProject()).catch(() => null);
  const vars = { brand: brand?.name || currentProject().name, tone: (brand?.voice ?? []).join(', ') };
  let made = 0;
  for (const sl of open) {
    if (taken.has(sl.date)) {
      skip(`${sl.date} already has a post from elsewhere; this slot is left out.`);
      continue;
    }
    if ((room.get(sl.date) ?? 0) <= 0) {
      skip(`${sl.date} would pass the limit of ${lim.maxPerDay} ${lim.maxPerDay === 1 ? 'post' : 'posts'} per day for ${currentProject().handle}; this slot is left out.`);
      continue;
    }
    // the idea
    let picked = await nextIdea(p, state, all, deps);
    if ('agent' in picked) {
      if (overBudget(PLAN_CAP_USD)) {
        budgetStop();
        break;
      }
      const want = Math.min(IDEAS_PER_CALL.max, Math.max(IDEAS_PER_CALL.min, open.length));
      try {
        const r = await writeIdeas(p, want, all, deps);
        state.ideas.push(...r.ideas);
        await writeState(id, state).catch(() => undefined);
        run.steps.push({ kind: 'ideas', pipeline: id, ideas: r.ideas.length, costUsd: r.costUsd });
        await recordEvent({ type: 'plan.made', by: 'agent:planner', refs: { run: run.id }, data: { pipeline: id, ideas: r.ideas.length, requestedBy: AUTOPILOT_BY } });
      } catch (e) {
        // A call that answered but gave no usable ideas was still billed: count its cost when it is known.
        run.steps.push({ kind: 'ideas', pipeline: id, ideas: 0, costUsd: agentCostOf(e), error: msg(e) });
        return flush(`Ideas failed: ${msg(e)}`);
      }
      picked = await nextIdea(p, state, all, deps);
    }
    if ('skip' in picked) {
      skip(picked.skip);
      return flush(picked.skip.charAt(0).toUpperCase() + picked.skip.slice(1));
    }
    if ('agent' in picked) break; // cannot happen: the queue was just filled
    const outcome = await makeOne(run, p, sl, picked, format, { overBudget, budgetStop, review, autoPublish, manual, deps, now, campaign: null, slot: null, vars });
    if (outcome === 'stop') break;
    if (outcome === 'made') {
      made += 1;
      room.set(sl.date, (room.get(sl.date) ?? 1) - 1);
      picked.commit(state); // the idea is used only once its post exists; a failed make keeps it for next time
      await writeState(id, state).catch(() => undefined);
      all = await listPackages();
    }
  }
  return flush(made ? `Made ${made} ${made === 1 ? 'post' : 'posts'}.` : 'Nothing made (see the run).');
}

interface MakeCtx {
  overBudget: (next?: number) => boolean;
  budgetStop: () => void;
  review: boolean;
  autoPublish: Job['autoPublish'];
  manual: boolean;
  deps: RunnerDeps;
  now: number;
  campaign: string | null;
  slot: Slot | null; // campaign source: the plan slot (made with makeSlotPost)
  vars?: { brand: string; tone: string };
}

/** Makes one post for one slot: backlog and budget first, then make → marks → plan → review → trusted approval. */
async function makeOne(run: AutopilotRun, p: Pipeline, sl: PipelineSlot, picked: { idea: Idea; commit: (s: PipelineState) => void }, format: Format, c: MakeCtx): Promise<'made' | 'skipped' | 'stop'> {
  const id = p.id;
  const skip = (reason: string) => run.steps.push({ kind: 'skip', campaign: c.campaign, pipeline: id, reason });
  if (ATTENDED_ONLY.includes(format) && !c.manual) {
    skip(`Slot ${sl.id} (${format}) uses Codex, which runs only when you press Run now on this pipeline.`);
    return 'skipped';
  }
  if (HIGGSFIELD_FORMATS.includes(format) && c.slot) {
    const hf = await higgsfieldAllowed();
    if (!hf.enabled) {
      skip(`Slot ${sl.id} (${format}): ${hf.reason}`);
      return 'skipped';
    }
  }
  const waiting = await waitingInReview();
  if (waiting >= BACKLOG_LIMIT) {
    skip(`${waiting} autopilot posts are waiting for you in Review. Making pauses until you go through them.`);
    run.note = run.note ?? `Paused making: ${waiting} posts wait in Review.`;
    return 'stop';
  }
  const estimate = makeCostEstimate(format);
  if (c.overBudget(estimate + (c.review ? REVIEW_CAP_USD : 0))) {
    c.budgetStop();
    return 'stop';
  }
  const mark: AutopilotMark = { run: run.id, campaign: c.campaign, slot: sl.id, pipeline: id, madeAt: iso(c.now), autoApproved: null };
  let packageId: string;
  try {
    if (c.slot) {
      packageId = (await (c.deps.makeSlotPost ?? ((cid, s, by, n) => makeSlotPost(cid, s, by, n)))(c.campaign!, c.slot.id, AUTOPILOT_BY, c.now)).packageId;
    } else {
      const opts = briefFor(p, picked.idea, c.vars ?? { brand: currentProject().name, tone: '' });
      packageId = (await (c.deps.generatePackage ?? ((o) => generatePackage(o)))({ ...opts, now: c.now })).id;
      if (Date.parse(sl.at) > c.now + 5 * 60_000) await setPlan(packageId, sl.at, AUTOPILOT_BY, c.now).catch(() => undefined);
    }
    const prov: PipelineMark = { pipeline: id, name: p.name, slotAt: sl.at, idea: picked.idea, madeAt: iso(c.now), run: run.id };
    await writeJsonReplace(pkgPath(packageId, PIPELINE_MARK_FILE), prov);
    await writeJsonReplace(pkgPath(packageId, MARK_FILE), mark);
    const made = await loadPackage(packageId).catch(() => null);
    const cost = made?.source?.higgsfield?.estimatedCostUsd ?? (estimate || null);
    run.steps.push({ kind: 'make', campaign: c.campaign, pipeline: id, slot: sl.id, package: packageId, format, costUsd: cost });
    await recordEvent({ type: 'post.made', by: AUTOPILOT_BY, campaign: c.campaign, refs: { package: packageId, slot: sl.id, run: run.id }, data: { format, pipeline: id, topic: picked.idea.topic.slice(0, 200), hook: (picked.idea.hook ?? '').slice(0, 200), date: sl.date, autopilot: true } });
  } catch (e) {
    run.steps.push({ kind: 'make', campaign: c.campaign, pipeline: id, slot: sl.id, package: null, format, costUsd: estimate || null, error: msg(e) });
    return 'skipped'; // one failed slot never stops the others
  }
  const job: Job = { campaign: c.campaign, pipeline: id, format, at: sl.at, review: c.review, autoPublish: c.autoPublish };
  const verdict = await reviewStep(run, job, packageId, c.overBudget, c.budgetStop, c.deps, c.now);
  if (verdict === 'budget') return 'stop';
  await maybeAutoApprove(run, job, packageId, verdict, mark, c.deps, c.now);
  return 'made';
}

/** Every pipeline that is on (or only `scope.pipeline`, which runs even when it is off: you pressed its button). */
export async function runPipelines(run: AutopilotRun, todays: AutopilotRun[], deps: RunnerDeps, now: number, scope: { pipeline?: string } = {}): Promise<void> {
  const all = (await listPipelines()).filter((p) => !p.archived); // a removed pipeline never runs, not even by Run now
  const chosen = scope.pipeline ? all.filter((p) => p.id === scope.pipeline) : all.filter((p) => p.enabled);
  if (scope.pipeline && !chosen.length) throw new Error('Unknown pipeline.');
  for (const p of chosen) {
    if (run.status !== 'running') break;
    try {
      await runOne(run, p, todays, deps, now, Boolean(scope.pipeline));
    } catch (e) {
      run.steps.push({ kind: 'skip', campaign: null, pipeline: p.id, reason: `Pipeline failed: ${msg(e)}` });
    }
  }
}
