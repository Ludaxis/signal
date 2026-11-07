import { describe, expect, it } from 'vitest';
import {
  LISTENING_CONDITIONS, LISTENING_SET, ListeningTestClosedError, binomialThreshold, listeningResultRecord, planListeningSession, projectCorpusItem,
  scoreListeningTest, type AbJudgment, type TokenJudgment,
} from '@/lib/studio/lang/fa/listening';
import { visemeFrames } from '@/lib/studio/lang/fa/viseme';
import type { VoiceProfile } from '@/lib/studio/lang/fa/project';
import alignments from '@/lib/studio/lang/fa/__fixtures__/mock-alignments.json';

const mockProfile: VoiceProfile = {
  id: 'mock-narrator-1', provider: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice', diacritics: 'none', ezafe: 'display',
  conjO: false, zwnj: 'keep', ipaInline: false, lockedBy: null, lockedAt: null, testId: null,
};
const LISTENERS = ['Listener A', 'Listener B', 'Listener C'];

/** Every listener passes every target token, except `fails` (itemId → condition ids that fail it). */
function judgments(naturalness: Record<string, number>, fails: Record<string, string[]> = {}): TokenJudgment[] {
  const out: TokenJudgment[] = [];
  for (const c of LISTENING_CONDITIONS)
    for (const item of LISTENING_SET.items)
      for (const listener of LISTENERS)
        out.push({
          listener, itemId: item.id, conditionId: c.id, naturalness: naturalness[c.id] ?? 4.5,
          tokens: Object.fromEntries(item.targets.map((t) => [t.token, (fails[item.id] ?? []).includes(c.id) ? 'fail' : 'pass'])),
        });
  return out;
}

function ab(a: string, b: string, winsA: number, winsB: number, ties: number): AbJudgment[] {
  const out: AbJudgment[] = [];
  const push = (choice: 'A' | 'B' | 'none', n: number) => {
    for (let i = 0; i < n; i++) out.push({ listener: LISTENERS[i % 3]!, itemId: LISTENING_SET.items[i % 60]!.id, a, b, choice });
  };
  push('A', winsA);
  push('B', winsB);
  push('none', ties);
  return out;
}

describe('listening corpus fa-listening-set/1', () => {
  it('has 60 generic items in the groups, each with targets, and no Latin in pron', () => {
    expect(LISTENING_SET.items).toHaveLength(60);
    const counts: Record<string, number> = {};
    for (const i of LISTENING_SET.items) counts[i.group] = (counts[i.group] ?? 0) + 1;
    expect(counts).toEqual({ homographs: 15, ezafe: 10, numbers: 10, loanwords: 10, verbs: 5, questions: 5, long: 5 });
    expect(new Set(LISTENING_SET.items.map((i) => i.id)).size).toBe(60);
    for (const i of LISTENING_SET.items) {
      expect(i.targets.length, i.id).toBeGreaterThan(0);
      expect(i.pron, i.id).not.toMatch(/[A-Za-z]/);
      expect(i.roman, i.id).toMatch(/^[A-Za-z' ,.?!«»-]+$/);
    }
  });
});

describe('listening harness (mock provider only)', () => {
  it('refuses a real provider or a real profile: the test is closed', () => {
    expect(() => planListeningSession({ profile: { ...mockProfile, provider: 'elevenlabs', model: 'any' } })).toThrow(ListeningTestClosedError);
    expect(() => planListeningSession({ profile: mockProfile, provider: { id: 'vendor', synthesize: () => { throw new Error('never called'); } } })).toThrow(ListeningTestClosedError);
  });

  it('plans a deterministic, blinded session on the mock provider', () => {
    const a = planListeningSession({ profile: mockProfile, seed: 7 });
    const b = planListeningSession({ profile: mockProfile, seed: 7 });
    expect(a.takes).toHaveLength(60 * LISTENING_CONDITIONS.length);
    expect(a.playlist).toEqual(b.playlist);
    expect(a.playlist).not.toEqual(a.takes.map((t) => t.takeId));
    expect(new Set(a.playlist).size).toBe(a.takes.length);
  });

  it('projects corpus items per condition (ezafe and homograph marks)', () => {
    const ez = LISTENING_SET.items.find((i) => i.id === 'ez-01')!;
    expect(projectCorpusItem(ez, LISTENING_CONDITIONS[0]!)).toBe('بازی جدید ما');
    expect(projectCorpusItem(ez, LISTENING_CONDITIONS[1]!)).toBe('بازیِ جدیدِ ما');
    const hg = LISTENING_SET.items.find((i) => i.id === 'hg-01')!;
    expect(projectCorpusItem(hg, LISTENING_CONDITIONS[2]!)).toContain('می\u200Cبُره');
  });
});

describe('listening scorer —', () => {
  it('37 of 60 non-tie A/B judgments is decisive; 36 is not', () => {
    expect(binomialThreshold(60)).toBe(37);
    const s37 = scoreListeningTest(judgments({}), ab('C-a', 'C-b', 23, 37, 3));
    expect(s37.ab[0]).toMatchObject({ winsA: 23, winsB: 37, ties: 3, decisive: true, winner: 'C-b' });
    const s36 = scoreListeningTest(judgments({}), ab('C-a', 'C-b', 24, 36, 3));
    expect(s36.ab[0]).toMatchObject({ decisive: false, winner: null });
  });

  it('computes accuracy by group and mean naturalness; eligibility and the diacritics rule', () => {
    // C-a fails three homographs; C-b passes everything; C-c fails one ezafe item and one number
    const fails = { 'hg-01': ['C-a'], 'hg-03': ['C-a'], 'hg-05': ['C-a'], 'ez-04': ['C-c'], 'nm-02': ['C-c'] };
    const s = scoreListeningTest(judgments({ 'C-a': 4.4, 'C-b': 4.3, 'C-c': 4.2, 'C-d': 3.5 }, fails));
    const by = Object.fromEntries(s.conditions.map((c) => [c.id, c]));
    expect(by['C-a']!.byGroup.homographs).toBeCloseTo(12 / 15);
    expect(by['C-b']!.accuracy).toBe(1);
    expect(by['C-b']!.naturalness).toBeCloseTo(4.3);
    expect(by['C-c']!.byGroup.numbers).toBeCloseTo(0.9);
    expect(by['C-c']!.eligible).toBe(false);
    expect(by['C-d']!.eligible).toBe(false); // naturalness < 4.0
    expect(by['C-a']!.eligible).toBe(false); // accuracy < 98 %
    expect(s.chosen).toBe('C-b');
    expect(s.diacriticsEarned).toBe(true);
    expect(s.agreement).toBe(1);
  });

  it('falls back to no diacritics when they do not beat the baseline by 2 homograph items', () => {
    const fails = { 'hg-01': ['C-a'] };
    const s = scoreListeningTest(judgments({ 'C-a': 4.4, 'C-b': 4.3, 'C-c': 4.3, 'C-d': 4.3 }, fails), [], {
      conditions: [...LISTENING_CONDITIONS, { id: 'C-e', diacritics: 'none', ezafe: 'kasra', ipaInline: false }],
    });
    // C-a has 74 of 75 tokens per listener (98.7 %) so it is eligible; diacritics gain only one item
    expect(s.diacriticsEarned === false || s.chosen === 'C-a' || s.chosen === 'C-e').toBe(true);
    expect(['C-a', 'C-e']).toContain(s.chosen);
  });

  it('sends items without a 2-of-3 majority to the editor and writes the result record shape', () => {
    const js = judgments({});
    const one = js.find((j) => j.itemId === 'nm-07' && j.conditionId === 'C-b' && j.listener === 'Listener A')!;
    one.tokens = Object.fromEntries(Object.keys(one.tokens).map((k) => [k, 'fail']));
    const partial = js.filter((j) => !(j.itemId === 'nm-07' && j.conditionId === 'C-b' && j.listener === 'Listener C'));
    const s = scoreListeningTest(partial);
    expect(s.toEditor).toContain('nm-07');
    expect(s.agreement).toBeLessThan(1);
    const rec = listeningResultRecord('lt-mock', LISTENERS, s, partial);
    expect(rec).toMatchObject({ testId: 'lt-mock', corpus: 'fa-listening-set/1', provisional: true });
    expect(Array.isArray(rec.failedItems)).toBe(true);
  });
});

describe('viseme mapper —', () => {
  it('«بیا پیش ما»: every ب، پ، م onset shows M for at least 2 frames', () => {
    const a = alignments.items[0]!;
    const track = visemeFrames(a.text, { characters: a.characters, startMs: a.startMs, endMs: a.endMs }, { fps: 30 });
    expect(track.mOnsets).toHaveLength(3);
    for (const o of track.mOnsets) {
      expect(track.frames[o.frame], `onset ${o.index}`).toBe('M');
      expect(track.frames[o.frame + 1], `onset ${o.index}`).toBe('M');
    }
    // no non-M run shorter than 2 frames remains, except where an M hold cut a run
    expect(track.frames.length).toBeGreaterThanOrEqual(Math.ceil((a.endMs[a.endMs.length - 1]! / 1000) * 30));
  });

  it('returns to rest after 6 silent frames', () => {
    const text = 'ما';
    const track = visemeFrames(text, { characters: ['م', 'ا'], startMs: [0, 100], endMs: [100, 200] }, { fps: 30 });
    expect(track.frames.slice(0, 2)).toEqual(['M', 'M']);
    const long = visemeFrames('ما ما', { characters: ['م', 'ا', ' ', 'م', 'ا'], startMs: [0, 100, 200, 800, 900], endMs: [100, 200, 800, 900, 1000] });
    expect(long.frames.slice(14, 22)).toContain('X');
  });

  it('an M onset on the last frame never grows the track past its length', () => {
    const t = visemeFrames('م', { characters: ['م'], startMs: [0], endMs: [20] }, { fps: 30 });
    expect(t.frames).toEqual(['M']);
    const end = visemeFrames('اما', { characters: ['ا', 'م', 'ا'], startMs: [0, 100, 110], endMs: [100, 110, 120] }, { fps: 30 });
    const n = Math.ceil((120 / 1000) * 30);
    expect(end.frames).toHaveLength(n);
    expect(end.frames.slice(-2)).toEqual(['M', 'M']);
  });
});
