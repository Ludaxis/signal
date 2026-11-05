// Server-only: the reviewer agent for one post package (design §5, decisions 10–14; §7).
//
// reviewPackage(id) runs the reviewer role on a package: it reads the caption and the brief from Signal,
// looks at the slides (or the reel cover) through the get_post tool, and returns a structured review
// that is stored as <package>/review.json. The review informs the owner in Review; it never
// approves, schedules or changes the package, and its status stays exactly what it was.
import { ContentError, loadPackage } from '../content';
import { getPlan } from '../campaigns';
import { loadBrand } from '../brand';
import type { AgentRunRecord } from '../memory/types';
import { currentProject } from '../projects';
import { AgentError } from '../claude-agent';
import { runRole, teamAllowed, type RunDeps } from './runtime';
import { REVIEW_OUTPUT_SCHEMA, reviewSchema, type Review, type StoredReview } from './schemas';
import { reviewableFiles, storeReview } from './tools';

/** Brand rules the reviewer checks one by one (decision 12). Exported for the prompt and the dashboard. */
export const BRAND_RULES = [
  'Original visuals only: no real people, no third-party brands, logos, characters or music.',
  'No claims about results, rankings, prizes or health; no dares.',
  'Brand colours and font from the kit; tone in the brand voice.',
  'No usernames, names or personal data anywhere in the post.',
  'The post states what to do (answer in the comments) without asking for follows or likes.',
] as const;

export async function reviewPackage(id: string, deps: RunDeps = {}): Promise<{ review: StoredReview; run: AgentRunRecord }> {
  const gate = await teamAllowed();
  if (!gate.enabled) throw new AgentError(403, gate.reason);
  const pkg = await loadPackage(id);
  if (pkg.status === 'invalid') throw new ContentError(409, `Post ${id} is invalid (${pkg.problems[0] ?? 'bad package'}); nothing to review.`);
  const images = reviewableFiles(pkg);
  if (!images.length) throw new ContentError(409, `Post ${id} has no slide or cover image to review.`);
  const project = currentProject();
  const brand = await loadBrand(project);
  const slot = pkg.campaign ? (await getPlan(pkg.campaign.id).catch(() => null))?.slots.find((s) => s.id === pkg.campaign!.slot) ?? null : null;
  const brief = slot
    ? { format: slot.format, pillar: slot.pillar, hook: slot.hook, angle: slot.angle, captionLead: slot.captionLead, headline: slot.headline || undefined }
    : { format: pkg.format, note: 'No campaign brief: judge the post against its own title, source items and the brand rules; score briefMatch on internal consistency.' };

  const task = {
    label: `review post ${id}`,
    campaign: pkg.campaign?.id ?? null,
    prompt: [
      `Review post ${id} ("${pkg.title}", ${pkg.format}) for ${project.handle}. Call get_post with id "${id}" to see the ${pkg.format === 'reel' ? 'reel cover' : `${images.length} slide image(s)`} and the caption, then score it.`,
      'Use these rules for brandRules, one entry each, in this order:',
      ...BRAND_RULES.map((r, i) => `${i + 1}. ${r}`),
      'AI label: the on-image disclosure must be visible on a slide or the cover, and the caption must say the visuals were made with AI.',
      pkg.source ? `The puzzle uses category "${pkg.source.category}" with items ${JSON.stringify(pkg.source.items)} and distractors ${JSON.stringify(pkg.source.distractors.map((d) => d.itemId))}; judge whether exactly one answer fits.` : 'This post is not a generated puzzle; set answerUnambiguous to 1 unless the post itself poses a puzzle.',
    ].join('\n'),
    extraContext: [
      { title: 'Brief', text: JSON.stringify(brief, null, 2) },
      { title: 'Brand kit', text: JSON.stringify(brand ? { name: brand.name, tagline: brand.tagline, colours: brand.colors, fonts: brand.fonts, voice: brand.voice } : { note: 'no brand kit yet' }, null, 2) },
    ],
    untrusted: { caption: pkg.caption, files: pkg.files.map((f) => ({ name: f.name, role: f.role })) },
    schema: REVIEW_OUTPUT_SCHEMA,
    validate: (v: unknown): Review => reviewSchema.parse(v),
  };
  const { value, run } = await runRole<Review>('reviewer', task, deps);
  const stored: StoredReview = { ...value, packageId: id, reviewedAt: run.endedAt ?? new Date(deps.now ?? Date.now()).toISOString(), by: 'agent:reviewer', run: run.id, model: run.model, costUsd: run.costUsd, hashes: Object.fromEntries(images.map((f) => [f.name, f.sha256])) };
  await storeReview(stored);
  return { review: stored, run };
}
