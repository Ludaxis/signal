// Repeat templates through the daily run (the existing runner, with slot de-dup).
// - templateAttendance: a template whose steps that a repeat would run use an attended-only connector (Codex, a browser
//   agent) is refused by the daily run. A repeat template has no Run now button of its own, so its refusal sends the
//   person to Proven ("‹Template› uses ‹service›, which runs only when you start it. Make a post from it on Proven.");
//   for Codex it says "‹Template›: Images come from Codex, which only runs while you watch."; a pipeline that names
//   the template keeps the existing wording ("… when you press Run now"), since Run now on that pipeline is attended
//   and makes it. Locked steps never run in a fork, so they do not count.
// - templateEstimate: the upper bound of what one repeat post costs (the steps a fork re-makes), for the daily budget
//   check the run does before each post.
// - makeFromTemplate: forks the template for one slot (fork), runs the out-of-date steps unattended (attended
//   under Run now) inside the daily run with the day's remaining budget as a fixed cap, and then either waits at Proof
//   (the default: the run is a Today › Needs you item) or, only under the full skip-proof rule, accepts it to a `ready`
//   package: skip proof on for that template + variant, a streak of at least 3, every step live, the narration text
//   and voice the very versions a named person signed on the template, and a Premium check. acceptProof checks the
//   rule again inside its lock.
// - The made package carries the pipeline and autopilot marks (pipeline.json, autopilot.json), so the backlog limit,
//   trust and `madeBy()` see it like any automatic post.
// Nothing here starts a timer or a scheduler, calls a vendor directly or deletes a file. Generic core: no names.
import { pkgPath, setPlan, writeJsonReplace } from '../content';
import { acceptProof } from './accept';
import { PostmakerError } from './errors';
import { runVerdictOf } from './manual-score';
import { claimRepeatSlot, releaseRepeatSlot, updateRepeatSlot, type RepeatIdea } from './repeat-state';
import { PAUSE_TEXT } from './runner';
import { attendedOnlyConnector, engineFor, markAtProof, rootOf, type ServiceProject } from './service';

export { engineFor };
import { readPipeline, readRecipe } from './store/recipes';
import { readTemplate } from './store/templates';
import { makePostFork } from './template-actions';
import { gatesInherited, SKIP_PROOF_STREAK, streakOf } from './template-rules';
import { REPEAT_NEEDS_PROVEN } from './template-actions';
import { connectorById } from './connectors';
import type { PostmakerEngine } from './runner';
import type { Lang, Pipeline, Run, Template, Verdict } from './types';

// ---- attendance -----------------------------------------------------------------------------------------

export interface Attendance {
  attendedOnly: boolean;
  /** The attended-only service's name ("Codex"), null when there is none. */
  service: string | null;
  /** The daily run's refusal for the template's own Repeat (no Run now: it names Proven), null when it may repeat. */
  text: string | null;
  /** The refusal for a pipeline that names the template, whose Run now a person can press; null as above. */
  runNowText: string | null;
}

/** The existing attended wording (ATTENDED_ONLY), generalised to templates: for an owner with a Run now button. */
export const attendedText = (template: string, service: string) => `${template} uses ${service}, which runs only when you press Run now.`;

/** (note): a repeat template has no Run now of its own, so the refusal sends the person to Proven. */
export const repeatAttendedText = (template: string, service: string) =>
  service === 'Codex' ? codexTemplateText(template) : `${template} uses ${service}, which runs only when you start it. Make a post from it on Proven.`;

/**
 * (wording part): the daily run's refusal for a template whose images come from Codex (its own Repeat, or a
 * moved Codex pipeline). A template has no Run now, so it never says "press Run now".
 */
export const codexTemplateText = (template: string) => `${template}: Images come from Codex, which only runs while you watch.`;

const serviceName = (id: string) => (id === 'codex' ? 'Codex' : (connectorById(id)?.title ?? 'a service you sign in to yourself'));

/** The languages a fork of `t` for `variant` makes. */
async function forkLanguages(root: string, t: Template, variantId: string | null): Promise<Lang[]> {
  const v = variantId ? t.variants.find((x) => x.id === variantId) : null;
  if (v?.params.lang) return [v.params.lang];
  return (await readRecipe(root, t.recipeId, t.snapshot.recipeVersion).catch(() => null))?.languages ?? [];
}

/** The steps of the template's proof a fork of it runs again: every step of its languages that does not start locked. */
function forkRuns(p: Pick<Pipeline, 'nodes'>, t: Pick<Template, 'inputs'>, languages: Lang[]) {
  const locked = new Set(t.inputs.lockedNodes);
  return p.nodes.filter((n) => (n.lang === null || languages.includes(n.lang)) && !locked.has(n.id));
}

/**
 * `templateAttendance()`: whether a repeat of `t` would run an attended-only connector. Reads the template's
 * own proof pipeline; a missing proof answers "not attended" (the fork refuses it later with its own reason).
 */
export async function templateAttendance(root: string, t: Template, variantId: string | null = null): Promise<Attendance> {
  const p = await readPipeline(root, t.recipeId, t.snapshot.pipelineVersion).catch(() => null);
  if (!p) return { attendedOnly: false, service: null, text: null, runNowText: null };
  for (const n of forkRuns(p, t, await forkLanguages(root, t, variantId))) {
    const c = n.connectorChain.find(attendedOnlyConnector) ?? (n.attendance === 'attended-only' ? (n.connectorChain[0] ?? 'codex') : null);
    if (c) {
      const service = serviceName(c);
      return { attendedOnly: true, service, text: repeatAttendedText(t.name, service), runNowText: attendedText(t.name, service) };
    }
  }
  return { attendedOnly: false, service: null, text: null, runNowText: null };
}

// ---- estimate ----------------------------------------------------------------------------------------------------

/**
 * `templateEstimate()`: the cost of one repeat post, from the template's proof: the exact estimate of the
 * steps a fork re-makes (locked steps cost nothing), scaled up when the variant is longer than the proof.
 */
export async function templateEstimate(engine: PostmakerEngine, root: string, t: Template, variantId: string | null = null): Promise<{ usdLow: number; usdHigh: number }> {
  const recipe = await readRecipe(root, t.recipeId).catch(() => null);
  const p = await readPipeline(root, t.recipeId).catch(() => null);
  if (!recipe || !p) throw new PostmakerError(409, 'conflict', 'The proof this template was made from is missing.');
  const nodes = forkRuns(p, t, await forkLanguages(root, t, variantId)).map((n) => n.id);
  if (!nodes.length) return { usdLow: 0, usdHigh: 0 };
  const { estimate } = await engine.estimate(t.recipeId, { nodes }, { exact: true });
  const v = variantId ? t.variants.find((x) => x.id === variantId) : null;
  const f = v?.params.lengthSec && recipe.lengthSec > 0 ? Math.max(1, v.params.lengthSec / recipe.lengthSec) : 1;
  const r = (n: number) => Math.round(n * f * 10_000) / 10_000;
  return { usdLow: r(estimate.usdLow), usdHigh: r(estimate.usdHigh) };
}

// ---- skip proof -------------------------------------------------------------------------

export interface SkipProofFacts {
  /** "Skip proof for repeat runs" of this template + variant. */
  skipProof: boolean;
  streak: number;
  retired: boolean;
  /** Every current step of the fork ran live (no mock). */
  allLive: boolean;
  /** The fork's narration-text and voice versions are the ones the template (or variant) was accepted with. */
  gatesInherited: boolean;
  verdict: Verdict | null;
}

export const WAIT_TEXT = {
  off: 'Skip proof is off for this template.',
  streak: `Skip proof needs ${SKIP_PROOF_STREAK} Premium proofs in a row.`,
  retired: 'This template is retired.',
  mock: 'Some steps ran as mock.',
  gates: 'Narration text or voice changed since the template was signed.',
  verdict: 'The check did not rate it Premium.',
} as const;

/** Pure: does a repeat post skip Proof? All of must hold; otherwise the plain reason it waits for you. */
export function skipProofDecision(f: SkipProofFacts): { accept: true } | { accept: false; reason: string } {
  if (f.retired) return { accept: false, reason: WAIT_TEXT.retired };
  if (!f.skipProof) return { accept: false, reason: WAIT_TEXT.off };
  if (f.streak < SKIP_PROOF_STREAK) return { accept: false, reason: WAIT_TEXT.streak };
  if (!f.allLive) return { accept: false, reason: WAIT_TEXT.mock };
  if (!f.gatesInherited) return { accept: false, reason: WAIT_TEXT.gates };
  if (f.verdict !== 'premium') return { accept: false, reason: WAIT_TEXT.verdict };
  return { accept: true };
}

// ---- one slot ----------------------------------------------------------------------------------------------------

export interface RepeatSlot {
  id: string;
  date: string;
  at: string;
}

export interface MakeFromTemplateDeps {
  project: ServiceProject;
  /** Who the slot belongs to in the ledger and the marks: the template id, or a pipeline's `pl-…` id. */
  owner: string;
  ownerName: string;
  /** What is left of the owner's daily budget: the run's fixed cap (the run never spends more). */
  budgetLeftUsd: number;
  /** The daily run (autopilot run id) and its actor. */
  autopilotRun: string;
  by: string;
  now: number;
  /** A person pressed Run now on the pipeline: the attended engine makes it (Codex allowed). Default: unattended. */
  attended?: boolean;
}

export type TemplateMakeOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'made'; recipeId: string; runId: string; packageIds: string[]; spentUsd: number; verdict: Verdict }
  | { kind: 'waiting'; recipeId: string; runId: string; spentUsd: number; reason: string; atProof: boolean }
  | { kind: 'failed'; recipeId: string; runId: string | null; spentUsd: number; reason: string };

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * `makeFromTemplate(templateId, variant, idea, slot, deps)`: one repeat post for one slot. The slot is claimed
 * in the ledger, together with the fork, before anything runs, so a second daily run (or a crash and a re-run) never
 * makes it again. A run that fails or is stopped releases the slot for the next daily run.
 */
export async function makeFromTemplate(templateId: string, variantId: string | null, idea: RepeatIdea, slot: RepeatSlot, d: MakeFromTemplateDeps): Promise<TemplateMakeOutcome> {
  const root = rootOf(d.project);
  const t = await readTemplate(root, templateId).catch(() => null);
  if (!t) return { kind: 'skipped', reason: 'The template no longer exists.' };
  if (t.status === 'retired') return { kind: 'skipped', reason: WAIT_TEXT.retired };
  if (t.status !== 'proven') return { kind: 'skipped', reason: REPEAT_NEEDS_PROVEN };
  if (variantId && !t.variants.some((v) => v.id === variantId)) return { kind: 'skipped', reason: 'The variant is no longer on the template.' };
  const att = await templateAttendance(root, t, variantId);
  const attended = d.attended === true;
  if (att.attendedOnly && !attended) return { kind: 'skipped', reason: att.text! };

  // A repeat run inherits the template's named sign-offs for steps below a gate only when the
  // narration text and voice are the versions that person signed (hash-bound, `inheritedSignOff`); the run still
  // waits at Proof unless the full skip-proof rule holds. No sign-off record is ever written for the fork.
  const { engine } = await engineFor(d.project, { attended, inheritGates: true });
  const brief = { topic: idea.topic.slice(0, 200), ...(idea.hook ? { hook: idea.hook.slice(0, 200) } : {}), ...(idea.caption ? { notes: idea.caption.slice(0, 2000) } : {}) };
  // The slot is claimed and the fork made under one ledger lock: a refused claim (another run has the slot) makes no
  // fork, and a fork that fails claims nothing.
  let fork: Awaited<ReturnType<typeof makePostFork>>;
  try {
    fork = await claimRepeatSlot(root, d.owner, { slotAt: slot.at, slotId: slot.id, runId: null, packageIds: [], autopilotRun: d.autopilotRun, at: new Date(d.now).toISOString() }, async () => {
      const f = await makePostFork({ root, project: d.project, templateId, variantId: variantId ?? undefined, brief, by: d.by, now: d.now });
      return { recipeId: f.recipe.id, value: f };
    });
  } catch (e) {
    return { kind: 'skipped', reason: msg(e) };
  }
  const recipeId = fork.recipe.id;
  // A run that failed or was stopped made no post: its slot is released so the next daily run tries it again.
  const release = () => releaseRepeatSlot(root, d.owner, slot.at, recipeId, new Date(d.now).toISOString()).catch(() => undefined);

  let run: Run;
  try {
    const { estimate } = await engine.estimate(recipeId, { all: true });
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token, capUsd: Math.max(0, d.budgetLeftUsd), trigger: 'repeat', by: d.by, attended, fixedCap: true });
    await updateRepeatSlot(root, d.owner, slot.at, { runId: h.run.id });
    run = await markAtProof(root, await h.done);
  } catch (e) {
    await release();
    return { kind: 'failed', recipeId, runId: null, spentUsd: 0, reason: msg(e) };
  }
  const spentUsd = run.spentUsd;
  if (run.status === 'failed' || run.status === 'stopped') {
    await release();
    return { kind: 'failed', recipeId, runId: run.id, spentUsd, reason: run.steps.find((s) => s.error)?.error ?? 'The run did not finish.' };
  }
  const atProof = run.status === 'needs-you' && run.pausedFor === 'check';
  if (!atProof) {
    const p = run.pausedFor;
    return { kind: 'waiting', recipeId, runId: run.id, spentUsd, atProof: false, reason: p && p in PAUSE_TEXT ? PAUSE_TEXT[p as keyof typeof PAUSE_TEXT] : 'Needs you.' };
  }

  // At Proof: skip it only under the full rule (acceptProof checks it again inside its lock).
  const now = await readTemplate(root, templateId);
  const s = await engine.state(recipeId);
  const st = now ? streakOf(now, variantId) : null;
  const verdict = await runVerdictOf(root, run.id, s.current.check ?? null);
  const decision = skipProofDecision({
    skipProof: st?.skipProof ?? false,
    streak: st?.streak ?? 0,
    retired: !now || now.status === 'retired',
    allLive: Object.values(s.current).every((v) => !v || v.mode === 'live'),
    gatesInherited: !!now && gatesInherited(now, variantId, { current: s.current, languages: fork.recipe.languages }),
    verdict,
  });
  if (!decision.accept) return { kind: 'waiting', recipeId, runId: run.id, spentUsd, atProof: true, reason: decision.reason };
  let packageIds: string[];
  try {
    const r = await acceptProof({ engine, root, project: d.project, runId: run.id, asDraft: false, templateName: t.name, by: d.by, now: () => d.now, inheritGates: true });
    packageIds = r.packageIds;
  } catch (e) {
    // e.g. contentGenerators in signal.config.json leaves Post maker out: the run stays at Proof for the person.
    return { kind: 'waiting', recipeId, runId: run.id, spentUsd, atProof: true, reason: msg(e) };
  }
  await updateRepeatSlot(root, d.owner, slot.at, { packageIds });
  for (const id of packageIds) {
    const madeAt = new Date(d.now).toISOString();
    await writeJsonReplace(pkgPath(id, 'pipeline.json'), { pipeline: d.owner, name: d.ownerName, slotAt: slot.at, idea, madeAt, run: d.autopilotRun, template: { id: templateId, variant: variantId, recipeId, runId: run.id } });
    await writeJsonReplace(pkgPath(id, 'autopilot.json'), { run: d.autopilotRun, campaign: null, slot: slot.id, pipeline: d.owner, madeAt, autoApproved: null });
    if (Date.parse(slot.at) > d.now + 5 * 60_000) await setPlan(id, slot.at, d.by, d.now).catch(() => undefined);
  }
  return { kind: 'made', recipeId, runId: run.id, packageIds, spentUsd, verdict };
}
