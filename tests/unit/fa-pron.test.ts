import { describe, expect, it } from 'vitest';
import { verbalizeFa, jalaliParts, formatJalaliDayMonthFa } from '@/lib/studio/lang/fa/verbalize';
import { applyPronPatch, buildFaLine, checkPronInvariant, overrideSpan, pendingDecisions, runLanguageAgentPass, type FaLineText } from '@/lib/studio/lang/fa/pron';
import { project, ProjectionError, type VoiceProfile } from '@/lib/studio/lang/fa/project';
import { alignToDisplay, mockAlignment } from '@/lib/studio/lang/fa/offsets';
import { affectedLines, loadLexicon, CORE_LEXICON, type LexiconFile } from '@/lib/studio/lang/fa/lexicon';
import { finalRenderAllowed, mockSignoff, signListen, signText, SignoffError, TEXT_GATE_ITEMS, LISTEN_GATE_ITEMS } from '@/lib/studio/lang/fa/review';
import { tokenizeFa } from '@/lib/studio/lang/fa/tokenize';
import { lintFa } from '@/lib/studio/lang/fa/lint';
import homographs from '@/lib/studio/lang/fa/__fixtures__/homographs.json';
import ezafe from '@/lib/studio/lang/fa/__fixtures__/ezafe.json';
import patches from '@/lib/studio/lang/fa/__fixtures__/mock-agent-patches.json';
import bidi from '@/lib/studio/lang/fa/__fixtures__/bidi-mixed.json';

const Z = '\u200C';
const profile = (over: Partial<VoiceProfile> = {}): VoiceProfile => ({
  id: 'mock-narrator-1', provider: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice', diacritics: 'homographs', ezafe: 'kasra',
  conjO: false, zwnj: 'keep', ipaInline: false, lockedBy: null, lockedAt: null, testId: null, ...over,
});
const pass = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 'pass' as const]));
const signed = (line: FaLineText, by = 'Native Editor (named)') =>
  signText(line, { runId: 'r1', lineId: 'l1', gate: 'text', reviewer: by, at: '2026-11-06', items: pass(TEXT_GATE_ITEMS), lexiconProposals: [] });

describe('the pronunciation layer', () => {
  it('1: verbalizeFa colloquial and formal', () => {
    expect(verbalizeFa(15, 'colloquial')).toBe('پونزده');
    expect(verbalizeFa(18)).toBe('هیجده');
    expect(verbalizeFa(14)).toBe('چارده');
    expect(verbalizeFa(1405)).toBe('هزار و چارصد و پنج');
    expect(verbalizeFa(15, 'formal')).toBe('پانزده');
    expect(verbalizeFa(25)).toBe('بیست و پنج');
    expect(verbalizeFa(49000)).toBe('چهل و نه هزار');
    expect(verbalizeFa(1_000_000)).toBe('یک میلیون');
  });

  it('2: dates and percent become one span with a rule id', () => {
    const d = buildFaLine('۳۰ آذر').line;
    expect(d.pron).toBe('سیِ آذَر');
    expect(d.spans).toHaveLength(1);
    expect(d.spans[0]).toMatchObject({ kind: 'date', ruleId: 'PR-N7', d: [0, 6] });
    const p = buildFaLine('۵۰٪').line;
    expect(p.pron).toBe('پَنجاه دَرصَد');
    expect(p.spans).toHaveLength(1);
    expect(p.spans[0]).toMatchObject({ kind: 'percent', d: [0, 3] });
    expect(buildFaLine('ساعت ۱۰:۳۰').line.pron).toContain('دَه و نیم');
    expect(buildFaLine('۴۹ هزار تومان').line.pron).toBe('چِهِل و نُه هِزار تومَن');
    expect(buildFaLine('۱۵ آبان').line.roman).toBe('punzda-ye aabaan');
  });

  it('3: a mock agent patch that changes a letter is rejected with PRON_INVARIANT; the line stays draft', () => {
    const { line } = buildFaLine(patches.line);
    const bad = applyPronPatch(line, patches.letterChange);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.code)).toContain('PRON_INVARIANT');
    expect(bad.line.review.text.status).toBe('draft');
    expect(bad.line.pron).toBe(line.pron);
    const good = applyPronPatch(line, patches.valid);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.line.pron).toBe('اِمشَب نُوبَتِ شماست');
      expect(good.line.spans[1]!.reviewed).toBe(false);
      expect(checkPronInvariant(good.line)).toEqual([]);
    }
    const r = applyPronPatch(line, patches.badReading);
    expect(r.ok).toBe(false);
  });

  it('3b: the agent pass retries once with the errors, then flags the span for the editor', async () => {
    const { line } = buildFaLine(patches.line);
    let calls = 0;
    const res = await runLanguageAgentPass(line, () => {
      calls++;
      return patches.letterChange;
    });
    expect(calls).toBe(2);
    expect(res.accepted).toBe(false);
    expect(res.line.spans[1]!.flag).toBe('invariant');
    expect(pendingDecisions(res.line)).toContain(1);
  });

  it('4: homograph readings from context; needsDecision disables S1 approval', () => {
    const cut = buildFaLine(`یکی هندونه می${Z}بره`).line;
    expect(cut.pron).toContain(`می${Z}بُره`);
    expect(cut.spans[2]).toMatchObject({ kind: 'lexicon', ruleId: 'lx-core-mibare', reading: 'cut' });
    const take = buildFaLine(`یکی کیفشو می${Z}بره`).line;
    expect(take.spans[2]!.reading).toBe('take');
    for (const h of homographs.items) {
      const { line } = buildFaLine(h.display);
      const tokens = tokenizeFa(line.display);
      const idx = tokens.findIndex((t) => t.text === h.token);
      const span = line.spans.find((s) => s.d[0] === tokens[idx]!.start)!;
      if (h.reading === null) expect(span.needsDecision, h.display).toBe(true);
      else expect(span.reading, h.display).toBe(h.reading);
    }
    // «بهم» together is /beham/ (kasra on ب), to me is /behem/
    const together = buildFaLine('همه\u200Cچی بهم ریخت').line;
    const tSpan = together.spans.find((s) => s.reading === 'together')!;
    expect(together.pron.slice(tSpan.p[0], tSpan.p[1])).toBe('بِهَم');
    expect(tSpan.roman).toBe('be-ham');
    const toMe = buildFaLine('یه چیزی بهم بگو').line;
    const mSpan = toMe.spans.find((s) => s.reading === 'to-me')!;
    expect(toMe.pron.slice(mSpan.p[0], mSpan.p[1])).toBe('بِهِم');
    const open = buildFaLine('یه کرم دیدم');
    expect(pendingDecisions(open.line)).toHaveLength(1);
    expect(() => signed(open.line)).toThrow(SignoffError);
  });

  it('5: pron never keeps Latin letters or emoji', () => {
    const r = buildFaLine('با AI و Zentrix یه ویدیو ساختم 😄 #بازی');
    expect(r.line.pron).not.toMatch(/[A-Za-z]/);
    expect(r.line.pron).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(r.line.pron).toContain(`اِی${Z}آی`);
    expect(pendingDecisions(r.line).length).toBe(1); // the unknown Latin name waits for a glossary entry
    for (const item of bidi.items) expect(buildFaLine(item.display).line.pron, item.display).not.toMatch(/[A-Za-z]/);
    for (const item of bidi.items) expect(tokenizeFa(item.display).map((t) => t.kind), item.display).toEqual(item.kinds);
  });

  it('6: projection is pure and ezafe kasra→display changes the hash', () => {
    const patched = applyPronPatch(buildFaLine('فال تازه').line, [{ spanIndex: 0, ezafeAfter: true }]);
    expect(patched.ok).toBe(true);
    const line = patched.line;
    const a = project(line, profile());
    const b = project(line, profile());
    expect(a).toEqual(b);
    expect(a.tts).toBe('فالِ تازه');
    const c = project(line, profile({ ezafe: 'display' }));
    expect(c.tts).toBe('فال تازه');
    expect(c.ttsHash).not.toBe(a.ttsHash);
    const take = { ttsHash: a.ttsHash };
    expect(take.ttsHash === c.ttsHash).toBe(false); // the take becomes stale
  });

  it('7: «۵ تا» → «پنج تا» leaves ttsHash unchanged', () => {
    const digits = buildFaLine('۵ تا', { normalize: { smallNumbers: 'words' } }).line;
    const words = buildFaLine('پنج تا', { normalize: { smallNumbers: 'words' } }).line;
    for (const p of [profile(), profile({ diacritics: 'none' })]) {
      expect(project(digits, p).ttsHash).toBe(project(words, p).ttsHash);
    }
  });

  it('8: captions come out on display tokens, never on tts words', () => {
    const line = buildFaLine('۱۵ آبان').line;
    const proj = project(line, profile());
    expect(proj.tts).toBe('پونزدهِ آبان');
    const timings = alignToDisplay(mockAlignment(proj.tts), proj, line);
    expect(timings.map((t) => t.text)).toEqual(['۱۵ آبان']);
    for (const t of timings) expect(t.text).not.toContain('پونزده');
    const two = buildFaLine('امشب ۱۵ تا 😄').line;
    const p2 = project(two, profile());
    const t2 = alignToDisplay(mockAlignment(p2.tts), p2, two);
    expect(t2.map((t) => t.text)).toEqual(['امشب', '۱۵', 'تا']);
    expect(t2[1]!.startMs).toBeGreaterThan(t2[0]!.endMs - 1);
  });

  it('9: a profile without a model id fails before any provider call', () => {
    const line = buildFaLine('سلام').line;
    expect(() => project(line, profile({ model: '' }))).toThrow(ProjectionError);
    try {
      project(line, profile({ model: '' }));
    } catch (e) {
      expect((e as ProjectionError).code).toBe('MODEL_ID_REQUIRED');
    }
  });

  it('10: finalRenderAllowed refuses mock and agent reviewers, and stale signatures', () => {
    const line = buildFaLine('امشب میام').line;
    const proj = project(line, profile());
    const take = { takeId: 't1', ttsHash: proj.ttsHash };
    expect(finalRenderAllowed(mockSignoff(line, '2026-11-06', take), take).allowed).toBe(false);
    expect(() => signed(line, 'language-editor')).toThrow(SignoffError);
    expect(() => signed(line, 'mock')).toThrow(SignoffError);
    let ok = signed(line);
    ok = signListen(ok, 't1', proj.ttsHash, { runId: 'r1', lineId: 'l1', gate: 'listen', takeId: 't1', reviewer: 'Native Listener (named)', at: '2026-11-06', items: pass(LISTEN_GATE_ITEMS), lexiconProposals: [] });
    expect(finalRenderAllowed(ok, take)).toEqual({ allowed: true, reasons: [] });
    expect(finalRenderAllowed(ok, { takeId: 't1', ttsHash: 'other' }).allowed).toBe(false);
    const agentText = { ...ok, review: { ...ok.review, text: { ...ok.review.text, by: 'copywriter' } } };
    expect(finalRenderAllowed(agentText, take).allowed).toBe(false);
  });

  it('12: editing a lexicon entry used by 3 lines lists exactly those 3', () => {
    const pack: LexiconFile = {
      schema: 'signal.fa-lexicon/1', scope: 'pack', packId: 'fixture-pack', version: 1,
      entries: [{ id: 'lx-pack-zentrix', kind: 'brand', match: { display: ['Zentrix', 'زنتریکس'], mode: 'word', inflects: true }, pron: 'زِنتریکس', roman: 'zen-triks', source: 'editor', status: 'proposed', approvedBy: null, approvedAt: null }],
    };
    const lex = loadLexicon(CORE_LEXICON, pack);
    const texts = ['زنتریکس اومد', 'امشب میام', 'با Zentrix بازی کن', 'سلام دوباره', 'زنتریکسه!'];
    const lines = texts.map((t, i) => ({ id: `l${i + 1}`, line: buildFaLine(t, { lexicon: lex }).line }));
    expect(affectedLines(lines, 'lx-pack-zentrix')).toEqual(['l1', 'l3', 'l5']);
    const edited = loadLexicon(CORE_LEXICON, { ...pack, version: 2, entries: [{ ...pack.entries[0]!, pron: 'زِنتِریکس' }] });
    const changed = lines.filter((l) => buildFaLine(texts[Number(l.id.slice(1)) - 1]!, { lexicon: edited }).line.pronHash !== l.line.pronHash).map((l) => l.id);
    expect(changed).toEqual(['l1', 'l3', 'l5']);
  });
});

describe('ezafe fixture and roman shape', () => {
  it('marks every junction in pron and gives one -e/-ye per junction token in roman', () => {
    for (const item of ezafe.items) {
      const r = applyPronPatch(buildFaLine(item.display).line, item.patch);
      expect(r.ok, item.display).toBe(true);
      expect(r.line.pron, item.display).toBe(item.pron);
      expect(r.line.roman, item.display).toBe(item.roman);
      const junctions = r.line.spans.flatMap((s, i) => (s.ezafeAfter || r.line.display.slice(s.d[0], s.d[1]).endsWith(`ه${Z}ی`) && (item.junctions as number[]).includes(i) ? [i] : []));
      expect(junctions, item.display).toEqual(item.junctions as number[]);
    }
  });

  it('an editor respelling that breaks the invariant needs a written override', () => {
    const { line } = buildFaLine('سلام');
    expect(overrideSpan(line, 0, 'سَلام', '').ok).toBe(false);
    const ok = overrideSpan(line, 0, 'سَلااام', 'vocal stretch, editor choice');
    expect(ok.ok).toBe(true);
    expect(ok.line.spans[0]!.kind).toBe('override');
    expect(checkPronInvariant(ok.line)).toEqual([]);
  });

  it('rebuilding after a display edit keeps reviewed marks on unchanged tokens', () => {
    const first = applyPronPatch(buildFaLine('فال تازه').line, [{ spanIndex: 0, ezafeAfter: true, vowels: 'فال' }]);
    const reviewed = { ...first.line, spans: first.line.spans.map((s) => ({ ...s, reviewed: true })) };
    const next = buildFaLine('فال تازه امشب', { previous: reviewed }).line;
    expect(next.spans[0]).toMatchObject({ ezafeAfter: true, reviewed: true });
    expect(next.spans[2]!.reviewed).toBe(false);
    expect(next.review.text.status).toBe('draft');
  });
});

describe('Intl Jalali support (recorded)', () => {
  it('2026-11-06 is «۱۵ آبان» and 2026-12-21 is 30 Azar 1405 in this Node build', () => {
    expect(formatJalaliDayMonthFa('2026-11-06')).toBe('۱۵ آبان');
    expect(jalaliParts('2026-12-21')).toEqual({ year: 1405, month: 9, day: 30 });
    expect(jalaliParts('2026-12-20')).toEqual({ year: 1405, month: 9, day: 29 });
  });

  it('lint on a built line feeds the S1 gate', () => {
    expect(lintFa(buildFaLine('امشب میام').line.display).filter((i) => i.severity === 'error')).toEqual([]);
  });
});
