import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionLanguageMix, checkLangLines, checkSameDate, editSimilarity, isTooLiteral, literalness, similarityGuard } from '@/lib/studio/lang/fa/bilingual';
import { applyPronPatch, buildFaLine } from '@/lib/studio/lang/fa/pron';
import { lintFa } from '@/lib/studio/lang/fa/lint';
import { CORE_LEXICON, loadLexicon, type LexiconFile } from '@/lib/studio/lang/fa/lexicon';
import { projectionProfileOf, runNarrationText, toNarrationLine, toStepChecks, type FaNarrationLine } from '@/lib/studio/postmaker/executors/narration-text';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { finalRenderAllowed } from '@/lib/studio/lang/fa/review';
import type { VoiceProfile } from '@/lib/studio/postmaker/types';
import script from '@/lib/studio/lang/fa/__fixtures__/pack-example-script.json';
import corpus from '@/lib/studio/lang/fa/__fixtures__/normalization-corpus.json';
import { maintainerDenylist } from './name-denylist';

const Z = '\u200C';
const packLex = script.packLexicon as unknown as LexiconFile;
const lex = loadLexicon(CORE_LEXICON, packLex);
// A pack voice record (VoiceProfile) with its Persian projection settings nested under `projection`.
const profile: VoiceProfile = {
  id: 'mock-narrator-1', lang: 'fa', speaker: 'narrator', connector: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice', settings: {},
  consentRef: null, approvedBy: null, measuredRate: null,
  projection: { diacritics: 'homographs', ezafe: 'kasra', conjO: false, zwnj: 'keep', ipaInline: false, lockedBy: null, lockedAt: null, testId: null },
};

describe('acceptance (automated parts)', () => {
  it('1: a missing fa line for a beat that declares fa fails with MISSING_LANG_LINE', () => {
    const issues = checkLangLines([
      { id: 'l04', beatId: 'b04', langs: ['fa', 'en'], fa: { display: 'سلام' }, en: { display: 'Hi' } },
      { id: 'l05', beatId: 'b05', langs: ['fa', 'en'], fa: null, en: { display: 'One sec!' } },
    ]);
    expect(issues).toEqual([{ code: 'MISSING_LANG_LINE', lineId: 'l05', beatId: 'b05', lang: 'fa' }]);
  });

  it('2: BL-04 compares the Jalali and Gregorian dates through Intl (30 Azar 1405 = 2026-12-21)', () => {
    expect(checkSameDate('۳۰ آذر ۱۴۰۵', 'Dec 20, 2026').ok).toBe(false);
    const ok = checkSameDate('۳۰ آذر ۱۴۰۵', 'Dec 21, 2026');
    expect(ok.ok).toBe(true);
    expect(ok.en).toEqual({ iso: '2026-12-21', jalali: { year: 1405, month: 9, day: 30 } });
  });

  it('4: a fa caption track with an English word that is not in the glossary fails', () => {
    expect(captionLanguageMix(['امشب نوبت توئه', 'wow چه بازی'], 'fa')).toEqual([{ page: 1, word: 'wow' }]);
    expect(captionLanguageMix(['با Harfino بازی کن'], 'fa', ['Harfino'])).toEqual([]);
  });

  it('5: the literalness check flags a word-for-word gloss and not the pairs', () => {
    const fa = `من امشب خونه${Z}ی مامان${Z}بزرگ می${Z}مونم`;
    expect(isTooLiteral(fa, 'I tonight house grandma stay')).toBe(true);
    expect(isTooLiteral(fa, "Sleepover at Grandma's!")).toBe(false);
    for (const l of script.narrated) expect(isTooLiteral(l.display, l.en), `${l.id} ${literalness(l.display, l.en)}`).toBe(false);
  });
});

describe('similarity guard (a reference transcript is never in the repository)', () => {
  it('3: the similarity guard flags a near copy and passes original lines; the example script is original against the 200-line corpus', () => {
    expect(editSimilarity('امشب نوبت توئه!', 'امشب نوبت توئه')).toBe(1);
    expect(similarityGuard([{ id: 'x', display: 'امشب نوبت توعه!' }], ['امشب نوبت توئه!'])).toHaveLength(1);
    expect(similarityGuard(script.narrated, corpus.lines)).toEqual([]);
  });

  const refPath = process.env.SIGNAL_FA_REFERENCE_FIXTURE;
  it.skipIf(!refPath)('3 (local only, SIGNAL_FA_REFERENCE_FIXTURE): lines pass the guard against a local reference transcript', () => {
    const ref = JSON.parse(fs.readFileSync(refPath!, 'utf8')) as { lines: { display: string }[] };
    expect(similarityGuard(script.narrated, ref.lines.map((l) => l.display))).toEqual([]);
  });

  it('4: every fa line passes the S1 automated checks in mock mode; l01 fits the 2.0 s hook at 2.6 words/s', async () => {
    const out = await runNarrationText({
      lang: 'fa', mode: 'mock', now: '2026-11-06T00:00:00Z', lexicon: { pack: packLex },
      lines: script.narrated.map((l) => ({ id: l.id, beatId: l.beatId, speaker: l.speaker, langs: ['fa', 'en'], fa: { display: l.display }, en: { display: l.en } })),
      proposePronMarks: (_line, ctx) => script.narrated.find((l) => l.id === ctx.lineId)!.patch,
    });
    expect(out.checks.filter((c) => c.severity === 'error')).toEqual([]);
    expect(out.ok).toBe(true);
    const words = script.narrated[0]!.display.split(' ').length;
    expect(words / script.hook.wordsPerSecond).toBeLessThanOrEqual(script.hook.maxSeconds);
    // mock gate records count as unsigned: no line may render clean
    for (const l of out.lines as FaNarrationLine[]) {
      expect(l.review.text.by).toBe('mock');
      expect(finalRenderAllowed(l, { takeId: 't', ttsHash: toNarrationLine(l, profile).ttsHash }).allowed).toBe(false);
    }
    for (const s of script.surfaces) {
      const errs = lintFa(s.display, { register: s.register as 'colloquial' | 'neutral', slot: s.slot as never, narrated: false, glossary: ['Harfino'] }).filter((i) => i.severity === 'error');
      expect(errs, s.display).toEqual([]);
    }
  });

  it('5: pron marks every listed ezafe junction and roman carries one -e/-ye on each junction token', () => {
    for (const l of script.narrated) {
      const built = buildFaLine(l.display, { lexicon: lex });
      const r = applyPronPatch(built.line, l.patch, { lexicon: lex });
      expect(r.ok, l.id).toBe(true);
      if ('pron' in l && l.pron) expect(r.line.pron, l.id).toBe(l.pron);
      expect(r.line.roman, l.id).toBe(l.roman);
      const junctions = r.line.spans.flatMap((s, i) => (s.ezafeAfter ? [i] : []));
      expect(junctions, l.id).toEqual(l.junctions);
      for (const j of l.junctions) {
        const s = r.line.spans[j]!;
        expect(r.line.pron.slice(s.p[0], s.p[1]), `${l.id} span ${j}`).toMatch(/\u0650$/);
      }
      const ezafeRoman = (r.line.roman.match(/-(?:e|ye)(?=[\s,.!?:]|$)/g) ?? []).length;
      expect(ezafeRoman, l.id).toBeGreaterThanOrEqual(l.junctions.length);
    }
  });
});

describe('narration-text executor', () => {
  it('produces FaLineText for fa and {display, tts, register} for en, with linter checks', async () => {
    const lines = [
      { id: 'l1', beatId: 'b1', speaker: 'narrator', langs: ['fa', 'en'] as ('fa' | 'en')[], fa: { display: 'آیا میای؟' }, en: { display: 'Coming  tonight?' } },
      { id: 'l2', beatId: 'b2', speaker: 'narrator', langs: ['fa', 'en'] as ('fa' | 'en')[], fa: { display: '۱۵ آبان میام' }, en: null },
    ];
    const fa = await runNarrationText({ lang: 'fa', mode: 'live', lines });
    expect(fa.ok).toBe(false);
    expect(fa.checks.map((c) => c.ruleId)).toContain('SK-Q1');
    const l2 = fa.lines.find((l) => l.id === 'l2') as FaNarrationLine;
    expect(l2.pron).toBe('پونزدهِ آبان میام');
    expect(l2.review.text.status).toBe('draft');
    const view = toNarrationLine(l2, profile);
    expect(view.spoken).toBe('پونزدهِ آبان میام');
    expect(view.offsets[0]).toEqual([0, 12, 0, 7]);
    const en = await runNarrationText({ lang: 'en', mode: 'mock', lines });
    expect(en.lines).toEqual([{ id: 'l1', beatId: 'b1', speaker: 'narrator', display: 'Coming tonight?', tts: 'Coming tonight?', register: 'casual' }]);
    expect(en.checks).toEqual([{ lineId: 'l2', ruleId: 'MISSING_LANG_LINE', severity: 'error', message: 'No en line for beat b2' }]);
    expect(toStepChecks(en)).toEqual([{ id: 'narration-text:en:l2:MISSING_LANG_LINE:0', ok: false, required: true, text: 'No en line for beat b2' }]);
  });

  it('reads the pack voice record: projection settings map onto the Persian profile; a voice without them is refused', () => {
    expect(projectionProfileOf(profile)).toEqual({
      id: 'mock-narrator-1', provider: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice', diacritics: 'homographs', ezafe: 'kasra',
      conjO: false, zwnj: 'keep', ipaInline: false, lockedBy: null, lockedAt: null, testId: null,
    });
    expect(projectionProfileOf({ ...profile, connector: 'azure-speech' }).provider).toBe('azure');
    expect(() => projectionProfileOf({ ...profile, projection: null })).toThrow(expect.toSatisfy((e) => isPostmakerError(e, 'voice-projection')));
  });

  it('a language-editor proposal that changes letters is rejected and the line stays a draft', async () => {
    const out = await runNarrationText({
      lang: 'fa', mode: 'live',
      lines: [{ id: 'l1', beatId: 'b1', speaker: 'narrator', langs: ['fa'], fa: { display: 'امشب نوبت شماست' } }],
      proposePronMarks: () => [{ spanIndex: 1, vowels: 'نُوبِه' }],
    });
    const l = out.lines[0] as FaNarrationLine;
    expect(l.pron).toBe('امشب نوبت شماست');
    expect(l.review.text.status).toBe('draft');
    expect(out.checks.some((c) => c.ruleId === 'PRON_INVARIANT')).toBe(true);
  });
});

describe('generic core and no network', () => {
  const dir = path.resolve(__dirname, '../../lib/studio/lang/fa');
  const files = [
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f)),
    path.resolve(__dirname, '../../lib/studio/postmaker/executors/narration-text.ts'),
  ];
  it('the Persian modules make no network call and import no network module', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\bfetch\(|node:https?|from 'https?'|XMLHttpRequest|WebSocket|node:net|node:dgram/);
    }
  });

  it('core code and data name no project, brand, game or font (strings)', () => {
    // The fixture brand, the font and the platform names stay out of core code and data; a maintainer's own names
    // come from SIGNAL_NAME_DENYLIST.
    const deny = ['Harfino', 'حرفینو', 'Vazirmatn', 'Estedad', 'Lalezar', 'Instagram', 'اینستاگرام'];
    const own = maintainerDenylist();
    const data = fs.readdirSync(path.join(dir, 'data')).map((f) => path.join(dir, 'data', f));
    for (const f of [...files, ...data]) {
      const src = fs.readFileSync(f, 'utf8');
      for (const name of deny) expect(src.includes(name), `${f} names ${name}`).toBe(false);
      expect(own?.test(src) ?? false, `${f} names a denylisted name`).toBe(false);
    }
  });
});
