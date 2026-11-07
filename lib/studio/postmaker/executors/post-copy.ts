// `post-copy:<lang>`: the copywriter (sonnet, $0.40, 4 turns) writes the caption,
// hashtags, alt text and credit line for one language package; code checks and completes it:
// - the CTA from the script is kept verbatim (`script.cta.exact`), the hook sits in the first 125 characters,
//   at most 5 hashtags (Persian joined with underscores, no ZWNJ), no claim the pack does not allow;
// - Persian copy is normalised and must pass the Persian linter with zero errors;
// - `meta.<lang>.json` carries the AI flag from provenance (any upstream made by an agent, a vendor or a mock), never
//   from the agent; `subtitles.<lang>.srt` is written from the composed timeline when the step receives it.
// Mock mode fills the caption from the script's hook and CTA.
import { z } from 'zod';
import { lintFa } from '../../lang/fa/lint';
import { normalizeFa } from '../../lang/fa/normalize';
import { PostmakerError } from '../errors';
import { FPS, type ScriptDoc, type TimelineDoc } from '../graph/adapters';
import { LOCAL_CONNECTORS } from '../graph/kinds';
import type { ContextBundle, Lang, StepCheck } from '../types';
import { agentEstimate, callAgent, type AgentCall } from './agent';
import { claimsLint, type PackClaimsPolicy } from './claims';
import type { ExecInput, ExecOutput, Executor, ExecResult } from './types';
import { issueText } from './vocab';

export const HOOK_CHARS = 125;
export const MAX_HASHTAGS = 5;

export const postCopyProposalSchema = z.strictObject({
  lang: z.enum(['fa', 'en']),
  caption: z.string().min(1).max(2200),
  hashtags: z.array(z.string().max(60)).max(MAX_HASHTAGS),
  alt: z.array(z.string().max(250)).max(10),
  creditLine: z.string().max(200).nullable(),
});
export type PostCopyProposal = z.infer<typeof postCopyProposalSchema>;

/** The stored caption document: the adapters' PostCopyDoc plus alt text and the credit line. */
export interface PostCopy {
  lang: Lang;
  caption: string;
  cta: string;
  hashtags: string[];
  alt: string[];
  creditLine: string | null;
  lint: string[];
}

const HASHTAG: Record<Lang, RegExp> = { fa: /^#[^\s#‌]+$/u, en: /^#[A-Za-z0-9_]+$/ };
const bad = (m: string) => new PostmakerError(422, 'invalid-answer', m);

/** Validates a proposal for one language package against the script's CTA and the pack's claims. */
export function validatePostCopy(raw: unknown, o: { lang: Lang; cta: string; claims: PackClaimsPolicy | null }): { doc: PostCopy; checks: StepCheck[] } {
  const parsed = postCopyProposalSchema.safeParse(raw);
  if (!parsed.success) throw bad(issueText(parsed.error));
  const p = parsed.data;
  if (p.lang !== o.lang) throw bad(`lang: this package is ${o.lang}.`);
  const fa = o.lang === 'fa';
  const norm = (s: string) => (fa ? normalizeFa(s).text : s.normalize('NFC'));
  const caption = norm(p.caption).trim();
  const hashtags = p.hashtags.map((h) => norm(h).trim());
  // The caption is normalised, so the CTA is compared in the same form (a Persian CTA written with Arabic yeh/kaf
  // or digits still counts as unchanged). The stored CTA stays the script's own, so the exact contract holds.
  const cta = norm(o.cta).trim();
  if (cta && !caption.includes(cta)) throw bad('The caption must carry the call to action unchanged.');
  for (const h of hashtags) if (!HASHTAG[o.lang].test(h)) throw bad(`${h}: ${fa ? 'join Persian hashtag words with underscores, no spaces or ZWNJ' : 'hashtags are letters, digits and underscores'}.`);
  if (new Set(hashtags.map((h) => h.toLowerCase())).size !== hashtags.length) throw bad('Each hashtag once.');
  for (const t of [caption, ...hashtags, ...p.alt, p.creditLine ?? '']) {
    const c = claimsLint(t, o.claims, o.lang);
    if (c.length) throw bad(`A claim the pack does not allow (${c.map((x) => x.key).join(', ')}).`);
  }
  if (fa) {
    const errors = [caption, ...p.alt].flatMap((t) => lintFa(t, { narrated: false }).filter((i) => i.severity === 'error'));
    if (errors.length) throw bad(`Persian lint: ${errors[0]!.message}.`);
  }
  const hook = caption.split('\n')[0] ?? '';
  const checks: StepCheck[] = [{ id: 'post-copy.hook', ok: [...hook].length <= HOOK_CHARS, required: true, text: [...hook].length <= HOOK_CHARS ? 'The hook fits the first 125 characters.' : 'Shorten the first line to 125 characters.' }];
  return { doc: { lang: o.lang, caption, cta: o.cta, hashtags, alt: p.alt.map(norm), creditLine: p.creditLine ? norm(p.creditLine) : null, lint: [] }, checks };
}

const srtTime = (frames: number) => {
  const ms = Math.round((frames * 1000) / FPS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** SubRip from the composed timeline's caption pages (display tokens, frame-exact). */
export function subtitlesSrt(t: Pick<TimelineDoc, 'captions'>): string {
  return t.captions
    .slice()
    .sort((a, b) => a.from - b.from)
    .map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`)
    .join('\n');
}

/** The AI flag from provenance: any upstream made by an agent, a vendor or a mock (never from the agent's answer). */
export function aiGeneratedFrom(i: Pick<ExecInput, 'inputs' | 'mode'>): boolean {
  if (i.mode === 'mock') return true;
  return i.inputs.some((u) => u.version.mode === 'mock' || (u.version.provenance.connector !== null && !LOCAL_CONNECTORS.has(u.version.provenance.connector)) || u.version.provenance.executor !== 'local');
}

export function mockPostCopy(script: ScriptDoc, lang: Lang): PostCopyProposal {
  const hook = (script.beats[0]?.onScreen[lang] ?? '').split('\n')[0]!.trim();
  const cta = script.cta[lang] ?? '';
  return { lang, caption: [hook, cta].filter(Boolean).join('\n\n') || cta || 'mock', hashtags: [], alt: [], creditLine: null };
}

export const POST_COPY_TASK = 'Write the post caption for this language package from the script in the input: the hook in the first 125 characters, the call to action unchanged, at most 5 hashtags, alt text for each still image, a credit line only when a licence needs one.';
export const POST_COPY_OUTPUT_SPEC = 'One JSON object: { "lang": "<this package\'s language>", "caption": "≤ 2,200 characters, hook first, the CTA verbatim", "hashtags": ["#tag", ≤ 5; Persian words joined with _], "alt": ["≤ 250 each"], "creditLine": null }';

export interface PostCopyDeps {
  call?: AgentCall | null;
  /** How agent steps are billed: the Claude plan costs $0; an API key up to the role cap. */
  billing?: 'subscription' | 'api-key';
  claims?: PackClaimsPolicy | null;
}

export function postCopyExecutor(deps: PostCopyDeps = {}): Executor {
  return {
    kind: 'post-copy',
    implVersion: 'post-copy@2',
    deterministic: false,
    estimate: (e) => agentEstimate(e.mode, deps.billing, 0.4, 60),
    async run(i): Promise<ExecResult> {
      const lang = i.lang;
      if (!lang) throw new PostmakerError(400, 'validation', 'post-copy needs a language');
      const script = i.byPort.script as ScriptDoc | null;
      if (!script) throw new PostmakerError(409, 'needs_you', 'The script is missing.');
      const cta = script.cta[lang] ?? '';
      let raw: unknown;
      let costUsd: number | null = 0;
      let model: string | null = 'mock';
      if (i.mode === 'mock') raw = mockPostCopy(script, lang);
      else {
        const base: ContextBundle = i.context ?? { task: '', node: { id: i.node.id, kind: 'post-copy', lang, params: {} }, upstream: [], downstream: [], neighbours: null, pinned: [], history: [], rubric: [], pack: {}, untrusted: {}, outputSpec: '' };
        const bundle: ContextBundle = { ...base, task: [POST_COPY_TASK, base.task].filter(Boolean).join('\n\n'), node: { ...base.node, params: { ...base.node.params, cta } }, outputSpec: POST_COPY_OUTPUT_SPEC };
        const r = await callAgent({ agent: 'copywriter', kind: 'post-copy', bundle, call: deps.call ?? null, signal: i.signal, validate: (v) => v });
        raw = r.value;
        costUsd = r.costUsd;
        model = r.model;
      }
      let out: ReturnType<typeof validatePostCopy>;
      try {
        out = validatePostCopy(raw, { lang, cta, claims: deps.claims ?? null });
      } catch (e) {
        if (e instanceof Error) (e as Error & { costUsd?: number | null }).costUsd = costUsd;
        throw e;
      }
      const outputs: ExecOutput[] = [
        { port: 'caption', name: `caption.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: out.doc },
        { port: 'meta', name: `meta.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: { aiGenerated: aiGeneratedFrom(i), lang, creditLine: out.doc.creditLine } },
      ];
      const timeline = (i.byPort.timeline as TimelineDoc | undefined) ?? null;
      if (timeline?.captions?.length) outputs.push({ port: 'subtitles', name: `subtitles.${lang}.srt`, kind: 'subtitle', mime: 'application/x-subrip', lang, data: null, bytes: Buffer.from(subtitlesSrt(timeline), 'utf8') });
      const checks: StepCheck[] = [...out.checks, { id: 'post-copy.subtitles', ok: Boolean(timeline), required: false, text: timeline ? 'Subtitles written from the captions.' : 'Subtitles are written once the video is composed.' }];
      return { outputs, provides: { cta: { [lang]: cta } }, checks, status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok', costUsd, model };
    },
    contractOf: (data) => {
      const d = data.caption as PostCopy;
      return { cta: { [d.lang]: d.cta } };
    },
  };
}
