// @vitest-environment node
// post-copy: the CTA is kept, ≤ 5 hashtags in the right form, claims and Persian lint, the hook in 125
// characters, the AI flag from provenance (never from the agent), SubRip from the composed timeline; and the
// project-neutral prompts (agents/studio/{deconstructor,copywriter}.md name no project, brand, city or platform).
import './guard';
import { describe, expect, it } from 'vitest';
import { aiGeneratedFrom, postCopyExecutor, subtitlesSrt, validatePostCopy } from '@/lib/studio/postmaker/executors/post-copy';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import type { ScriptDoc } from '@/lib/studio/postmaker/graph/adapters';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { postmakerAgentPrompt } from '@/lib/studio/team/roles';
import { maintainerDenylist } from '../name-denylist';

const FA_CTA = 'امشب نوبت توئه!';
const faCaption = `شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.\n\n${FA_CTA}`;
const ok = (o: Record<string, unknown> = {}) => ({ lang: 'fa', caption: faCaption, hashtags: ['#شب_یلدا', '#بازی_کلمه'], alt: [], creditLine: null, ...o });
const policy = { allowed: [], denied: [] };
const rejects = (raw: unknown, re: RegExp, cta = FA_CTA, lang: 'fa' | 'en' = 'fa') => {
  try {
    validatePostCopy(raw, { lang, cta, claims: policy });
  } catch (e) {
    expect(isPostmakerError(e, 'invalid-answer'), String(e)).toBe(true);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('expected a rejection');
};

describe('post-copy validation', () => {
  it('accepts a Persian caption that keeps the CTA, with underscore hashtags; normalises Arabic letters first', () => {
    const { doc, checks } = validatePostCopy(ok({ caption: faCaption.replace('ی', 'ي') }), { lang: 'fa', cta: FA_CTA, claims: policy });
    expect(doc.caption).toBe(faCaption);
    expect(doc.cta).toBe(FA_CTA);
    expect(checks.find((c) => c.id === 'post-copy.hook')).toMatchObject({ ok: true });
  });
  it('rejects a changed CTA, more than 5 hashtags, a ZWNJ or spaced Persian hashtag, a claim, and the wrong language', () => {
    rejects(ok({ caption: 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.' }), /call to action unchanged/);
    rejects(ok({ hashtags: ['#a_1', '#a_2', '#a_3', '#a_4', '#a_5', '#a_6'] }), /hashtags/);
    rejects(ok({ hashtags: ['#شب‌یلدا'] }), /underscores/);
    rejects(ok({ hashtags: ['#شب یلدا'] }), /underscores/);
    rejects(ok({ caption: `${faCaption}\nرایگان` }), /claim the pack does not allow/);
    rejects(ok({ lang: 'en' }), /this package is fa/);
    rejects({ lang: 'en', caption: 'Your turn tonight.', hashtags: ['#family night'], alt: [], creditLine: null }, /letters, digits/, 'Your turn tonight.', 'en');
  });
  it('a Persian CTA written with Arabic yeh/kaf still counts as unchanged when copied verbatim', () => {
    const arabicCta = 'الان بازي كن، نوبت توئه!';
    const caption = `شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.\n\n${arabicCta}`;
    const { doc } = validatePostCopy(ok({ caption }), { lang: 'fa', cta: arabicCta, claims: policy });
    expect(doc.caption).not.toContain('ي');
    expect(doc.caption).not.toContain('ك');
    expect(doc.cta).toBe(arabicCta); // the script's own CTA, so the exact contract with the script holds
    rejects(ok({ caption: 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.\n\nبازی کن' }), /call to action unchanged/, arabicCta);
  });
  it('mock: a Persian script CTA with Arabic letters gives a caption that passes', async () => {
    const arabicCta = 'الان بازي كن!';
    const script: ScriptDoc = { beats: [{ id: 'b01', segment: 'hook', targetMs: 6000, onScreen: { fa: 'شب یلداست.' } }], lines: [], tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 }, cta: { fa: arabicCta } };
    const r = await postCopyExecutor().run({ recipe: {} as never, node: { id: 'post-copy:fa', kind: 'post-copy', lang: 'fa', params: {} } as never, lang: 'fa', inputs: [], byPort: { script }, params: {}, seed: 1, mode: 'mock', connector: 'mock', note: null, beats: null, pinnedBeats: [], previous: null, violations: [], take: 1, context: null, runId: 'run-20261106-101500-ab12', now: () => 0, signal: new AbortController().signal } as ExecInput);
    expect(r.status).toBe('ok');
    expect(r.provides).toEqual({ cta: { fa: arabicCta } });
  });
  it('a hook longer than 125 characters needs you', () => {
    const long = `${'Tonight is loud and the whole family is around the table '.repeat(3)}\n\nYour turn tonight.`;
    const { checks } = validatePostCopy({ lang: 'en', caption: long, hashtags: [], alt: [], creditLine: null }, { lang: 'en', cta: 'Your turn tonight.', claims: policy });
    expect(checks.find((c) => c.id === 'post-copy.hook')).toMatchObject({ ok: false, required: true });
  });
});

describe('post-copy outputs', () => {
  const script: ScriptDoc = { beats: [{ id: 'b01', segment: 'hook', targetMs: 6000, onScreen: { en: "Grandma's house is loud tonight." } }], lines: [], tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 }, cta: { en: 'Your turn tonight.' } };
  const input = (o: Partial<ExecInput> = {}): ExecInput =>
    ({ recipe: {} as never, node: { id: 'post-copy:en', kind: 'post-copy', lang: 'en', params: {} } as never, lang: 'en', inputs: [], byPort: { script }, params: {}, seed: 1, mode: 'mock', connector: 'mock', note: null, beats: null, pinnedBeats: [], previous: null, violations: [], take: 1, context: null, runId: 'run-20261106-101500-ab12', now: () => 0, signal: new AbortController().signal, ...o }) as ExecInput;

  it('mock: caption from the hook and CTA, meta AI flag true, no subtitles until the video is composed', async () => {
    const r = await postCopyExecutor().run(input());
    expect(r.outputs.map((o) => o.port)).toEqual(['caption', 'meta']);
    expect(r.outputs[0]!.data).toMatchObject({ caption: "Grandma's house is loud tonight.\n\nYour turn tonight.", cta: 'Your turn tonight.' });
    expect(r.outputs[1]!.data).toMatchObject({ aiGenerated: true, lang: 'en' });
    expect(r.provides).toEqual({ cta: { en: 'Your turn tonight.' } });
    expect(r.status).toBe('ok');
  });

  it('writes SubRip from the timeline captions when the step receives the timeline', async () => {
    const timeline = { captions: [{ lineId: 'l02', text: 'second page', from: 45, to: 90 }, { lineId: 'l01', text: 'first page', from: 0, to: 45 }] };
    expect(subtitlesSrt(timeline)).toBe('1\n00:00:00,000 --> 00:00:01,500\nfirst page\n\n2\n00:00:01,500 --> 00:00:03,000\nsecond page\n');
    const r = await postCopyExecutor().run(input({ byPort: { script, timeline } }));
    const srt = r.outputs.find((o) => o.port === 'subtitles')!;
    expect(srt).toMatchObject({ kind: 'subtitle', mime: 'application/x-subrip', name: 'subtitles.en.srt' });
    expect(Buffer.from(srt.bytes!).toString('utf8')).toContain('first page');
  });

  it('the AI flag comes from provenance: live with only local upstreams is false, an agent upstream is true', () => {
    const up = (executor: string, connector: string | null, mode: 'live' | 'mock' = 'live') => ({ port: 'script', nodeId: 'script', data: null, refs: [], version: { mode, provenance: { executor, connector } } }) as never;
    expect(aiGeneratedFrom({ mode: 'live', inputs: [up('local', 'local')] })).toBe(false);
    expect(aiGeneratedFrom({ mode: 'live', inputs: [up('claude-cli', 'claude-cli')] })).toBe(true);
    expect(aiGeneratedFrom({ mode: 'live', inputs: [up('local', 'local', 'mock')] })).toBe(true);
  });

  it('live with the copywriter call and the composed timeline: the CTA reaches the prompt, the answer is validated and the SubRip is written', async () => {
    const seen: { kind: string; agent: string; prompt: string }[] = [];
    const call = async (req: { kind: string; agent: string; prompt: string }) => {
      seen.push(req);
      return { text: '```json\n' + JSON.stringify({ lang: 'en', caption: "Grandma's house is loud tonight.\n\nYour turn tonight.", hashtags: ['#familynight'], alt: [], creditLine: null }) + '\n```', costUsd: null, model: 'fake-sonnet' };
    };
    const timeline = { captions: [{ lineId: 'l01', text: 'first page', from: 0, to: 45 }] };
    const r = await postCopyExecutor({ call: call as never }).run(input({ mode: 'live', connector: 'claude-cli', byPort: { script, timeline } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'post-copy', agent: 'copywriter' });
    expect(seen[0]!.prompt).toContain('Your turn tonight.');
    expect(r.outputs.map((o) => o.port)).toEqual(['caption', 'meta', 'subtitles']);
    expect(r.status).toBe('ok');
  });

  it('live without a configured agent call fails clearly, before any spend', async () => {
    await expect(postCopyExecutor().run(input({ mode: 'live' }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'not_configured'));
  });
});

describe('project-neutral prompts', () => {
  // Platform and vendor words stay out of the built-in prompts; a maintainer's own names come from SIGNAL_NAME_DENYLIST.
  const WORDS = /harfino|حرفینو|instagram|tiktok|youtube|suno|elevenlabs|higgsfield/i;
  for (const agent of ['deconstructor', 'copywriter'] as const) {
    it(`the built-in ${agent} prompt names no project, brand, platform or vendor`, () => {
      const text = postmakerAgentPrompt(agent);
      expect(text.length).toBeGreaterThan(500);
      const deny = maintainerDenylist();
      expect(text.split('\n').filter((l) => WORDS.test(l) || deny?.test(l))).toEqual([]);
    });
  }
});
