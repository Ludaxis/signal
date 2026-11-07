import { describe, expect, it } from 'vitest';
import { normalizeFa, NORMALIZE_RULE_IDS } from '@/lib/studio/lang/fa/normalize';
import corpus from '@/lib/studio/lang/fa/__fixtures__/normalization-corpus.json';

const Z = '\u200C';
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
const n = (s: string, o = {}) => normalizeFa(s, o).text;

describe('normalizeFa', () => {
  it('1: maps Arabic kaf/yeh and keeps the hamza seat', () => {
    expect(cps(n('كتابي'))).toEqual(['06A9', '062A', '0627', '0628', '06CC']);
    expect(n('هیئت')).toContain('ئ');
  });

  it('2: Z01 inserts ZWNJ after می and leaves the exceptions alone', () => {
    const out = n('میخوام');
    expect(out).toBe(`می${Z}خوام`);
    expect(cps(out).slice(0, 3)).toEqual(['0645', '06CC', '200C']);
    for (const w of ['میز', 'میوه', 'میاد', 'درمیاد']) expect(n(w)).toBe(w);
    expect(n('نمی تونم')).toBe(`نمی${Z}تونم`);
    expect(n('برمیگرده')).toBe(`برمی${Z}گرده`);
  });

  it('3: Z02/Z03/ZC-3', () => {
    expect(n('خانه ها')).toBe(`خانه${Z}ها`);
    expect(n('تنها')).toBe('تنها');
    expect(n('بزرگتر')).toBe(`بزرگ${Z}تر`);
    expect(n(`بلند${Z}تر`)).toBe('بلندتر');
    expect(n('بهتر')).toBe('بهتر');
    expect(n('دختر')).toBe('دختر');
    expect(n('کتابها')).toBe(`کتاب${Z}ها`);
    expect(n('پاها')).toBe('پاها');
  });

  it('3b: Z03 keeps بهتر، بیشتر، کمتر solid and removes a typed ZWNJ in them', () => {
    for (const [typed, solid] of [[`کم${Z}تر`, 'کمتر'], [`بیش${Z}ترین`, 'بیشترین'], [`به${Z}تر`, 'بهتر'], [`مه${Z}تر`, 'مهتر']]) {
      const r = normalizeFa(`${typed} فلفل بریز`);
      expect(r.text).toBe(`${solid} فلفل بریز`);
      expect(r.changes.some((c) => c.ruleId === 'Z03')).toBe(true);
      expect(normalizeFa(r.text).changes).toEqual([]);
    }
    for (const w of ['کمتر', 'بیشتر', 'بهترین']) expect(n(w)).toBe(w);
    // listed adjectives keep their ZWNJ
    expect(n(`بزرگ${Z}تر`)).toBe(`بزرگ${Z}تر`);
    expect(n(`خسته${Z}تر`)).toBe(`خسته${Z}تر`);
  });

  it('4: N-07/N-08 digits, Latin runs keep ASCII digits', () => {
    expect(n('15 آبان')).toBe('۱۵ آبان');
    expect(n('٤٥')).toBe('۴۵');
    expect(n('نسخه\u200Cی iOS 18 اومد')).toContain('iOS 18');
  });

  it('5: N-05 ezafe after heh per pack setting', () => {
    expect(n('خون\u06C0 ما', { ezafeAfterHeh: 'zwnj-yeh' })).toBe(`خونه${Z}ی ما`);
    const hamza = n('خون\u06C0 ما', { ezafeAfterHeh: 'hamza' });
    expect(hamza).toBe('خونهٔ ما');
    expect(cps(hamza).slice(3, 5)).toEqual(['0647', '0654']);
  });

  it('6: N-13 keeps tanvin after alef and callouts in allowDiacritics', () => {
    expect(n('حتماً')).toContain('\u064B');
    expect(n('«گُل»')).toBe('«گل»');
    expect(n('«گُل»', { allowDiacritics: [0] })).toBe('«گُل»');
  });

  it('7: PU-1 punctuation in Persian runs', () => {
    expect(n('چی?')).toBe('چی؟');
    expect(n('"سلام"')).toBe('«سلام»');
    expect(n('صبر کن...')).toBe('صبر کن…');
    expect(n('Hello, world?')).toBe('Hello, world?');
  });

  it('N-09/N-10/N-11: percent, decimal and thousands separators', () => {
    expect(n('50% تخفیف')).toBe('۵۰٪ تخفیف');
    expect(n('قیمت 12,500 تومان')).toBe('قیمت ۱۲٬۵۰۰ تومان');
    expect(n('قیمت 1,250 تومان')).toBe('قیمت ۱۲۵۰ تومان');
    expect(n('۳.۵ ساعت')).toBe('۳٫۵ ساعت');
    expect(n('ساعت 10:30 میام')).toBe('ساعت ۱۰:۳۰ میام');
  });

  it('N-14/N-15/N-17 controls and spacing; Z04/Z05/Z06/Z07; EZ-5', () => {
    expect(n('سلام\u200F  دنیا\u00A0!')).toBe('سلام دنیا!');
    expect(n(`سل\u200Dام`)).toBe('سلام');
    expect(n('خالهم')).toBe(`خاله${Z}م`);
    expect(n('پایهست')).toBe(`پایه${Z}ست`);
    expect(n('خونه ی ما')).toBe(`خونه${Z}ی ما`);
    expect(n('خانه ای')).toBe(`خانه${Z}ای`);
    expect(n('خانهای')).toBe(`خانه${Z}ای`);
    expect(n('ماهی')).toBe('ماهی');
    expect(n('ماهها')).toBe(`ماه${Z}ها`);
    expect(n('بازیای')).toBe(`بازی${Z}ای`);
    expect(n('دنیای')).toBe('دنیای');
    expect(n('بینظیر')).toBe(`بی${Z}نظیر`);
    for (const w of ['بیا', 'بیست', 'بیمار', 'بیرون', 'بیشتر', 'همسایه', 'همه', 'همین', 'ناهار']) expect(n(w)).toBe(w);
    expect(n('مامان بزرگ')).toBe(`مامان${Z}بزرگ`);
    expect(n('خاله جون')).toBe(`خاله${Z}جون`);
    expect(n('آبمیوه')).toBe(`آب${Z}میوه`);
    expect(n('پسرخاله')).toBe('پسرخاله');
    expect(n('بیست و پنج')).toBe('بیست و پنج');
    expect(n('بهم')).toBe('بهم');
  });

  it('logs every change with a known rule id', () => {
    const { changes } = normalizeFa('كتابي 15 تا ميخوام...');
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(NORMALIZE_RULE_IDS).toContain(c.ruleId);
  });

  it('8: idempotent over the 200-line fixture corpus, every change has a known rule id', () => {
    expect(corpus.lines).toHaveLength(200);
    const known = new Set<string>(NORMALIZE_RULE_IDS);
    for (const line of corpus.lines) {
      const once = normalizeFa(line);
      for (const c of once.changes) expect(known.has(c.ruleId), `${c.ruleId} in «${line}»`).toBe(true);
      const twice = normalizeFa(once.text);
      expect(twice.text, line).toBe(once.text);
      expect(twice.changes, line).toEqual([]);
      expect(once.text).not.toMatch(/[يك\u0640\u200D\u200E\u200F]/);
    }
  });
});
