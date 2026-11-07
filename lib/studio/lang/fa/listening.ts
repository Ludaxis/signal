// Listening-test harness and scorer. The test itself is CLOSED (spend, key and terms
// gates): this module plans sessions and scores judgments on the MOCK provider only. A non-mock
// provider or profile is refused with LISTENING_TEST_CLOSED before anything is synthesised.

import { stripMarks } from './chars';
import { sha256 } from './pron';
import { assertVoiceProfile, type VoiceProfile } from './project';
import { mockAlignment, type CharAlignment } from './offsets';
import listeningSet from './data/listening-set.json';

export type ListeningGroup = 'homographs' | 'ezafe' | 'numbers' | 'loanwords' | 'verbs' | 'questions' | 'long';

export interface ListeningItem {
  id: string;
  group: ListeningGroup;
  display: string;
  pron: string;
  roman: string;
  targets: { token: string; roman: string }[];
}

export interface ListeningCorpus {
  schema: string;
  groups: Record<string, number>;
  items: ListeningItem[];
}

export const LISTENING_SET = listeningSet as unknown as ListeningCorpus;

/** Projection settings per condition. Model and voice come from the caller's profile. */
export interface ListeningCondition {
  id: string;
  diacritics: VoiceProfile['diacritics'];
  ezafe: VoiceProfile['ezafe'];
  ipaInline: boolean;
  conjO?: boolean;
}

export const LISTENING_CONDITIONS: ListeningCondition[] = [
  { id: 'C-a', diacritics: 'none', ezafe: 'display', ipaInline: false },
  { id: 'C-b', diacritics: 'homographs', ezafe: 'kasra', ipaInline: false },
  { id: 'C-c', diacritics: 'homographs', ezafe: 'display', ipaInline: false },
  { id: 'C-d', diacritics: 'homographs', ezafe: 'kasra', ipaInline: true },
];

export class ListeningTestClosedError extends Error {
  readonly code = 'LISTENING_TEST_CLOSED';
  constructor(message: string) {
    super(message);
    this.name = 'ListeningTestClosedError';
  }
}

export interface MockTake {
  takeId: string;
  durationMs: number;
  alignment: CharAlignment;
}

export interface TtsProvider {
  id: string;
  synthesize(tts: string, profile: VoiceProfile, seed: number): MockTake;
}

/** Deterministic mock provider: no audio, 60 ms per character, a seed-derived take id. */
export const mockTtsProvider: TtsProvider = {
  id: 'mock',
  synthesize(tts, profile, seed) {
    const alignment = mockAlignment(tts, 60);
    return { takeId: `mock-${sha256(`${tts}|${profile.id}|${seed}`).slice(0, 12)}`, durationMs: [...tts].length * 60, alignment };
  },
};

/** Project a corpus item's pron for a condition (corpus pron carries its ezafe kasra on the word end). */
export function projectCorpusItem(item: ListeningItem, condition: ListeningCondition): string {
  const homographTargets = new Set(item.group === 'homographs' ? item.targets.map((t) => t.token) : []);
  const displayWords = item.display.split(' ');
  const words = item.pron.split(' ').map((w, k) => {
    const isEzafe = w.endsWith('\u0650') && k < item.pron.split(' ').length - 1;
    const core = isEzafe ? w.slice(0, -1) : w;
    const targetHere = homographTargets.has(stripMarks(displayWords[k] ?? '')) || homographTargets.has(displayWords[k] ?? '');
    const keep = condition.diacritics === 'all' || (condition.diacritics === 'homographs' && targetHere);
    let out = keep ? core : stripMarks(core);
    if (isEzafe && condition.ezafe === 'kasra') out += '\u0650';
    return out;
  });
  let tts = words.join(' ');
  if (condition.conjO) tts = tts.replace(/ و (?=\S)/g, '\u064F ');
  return tts;
}

export interface PlannedTake {
  takeId: string;
  itemId: string;
  /** Hidden from listeners (blind test); kept in the session key. */
  conditionId: string;
  tts: string;
  ttsHash: string;
  durationMs: number;
}

export interface ListeningSession {
  takes: PlannedTake[];
  /** Randomised, blind playback order (take ids only). */
  playlist: string[];
  provisional: true;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Plan a session on the mock provider. Refuses any real provider: the listening test is closed. */
export function planListeningSession(input: {
  corpus?: ListeningCorpus;
  conditions?: ListeningCondition[];
  profile: VoiceProfile;
  provider?: TtsProvider;
  seed?: number;
}): ListeningSession {
  const provider = input.provider ?? mockTtsProvider;
  if (provider.id !== 'mock' || input.profile.provider !== 'mock') {
    throw new ListeningTestClosedError('The Persian listening test is closed (spend, key and terms gates). Only the mock provider can run.');
  }
  assertVoiceProfile(input.profile);
  const corpus = input.corpus ?? LISTENING_SET;
  const conditions = input.conditions ?? LISTENING_CONDITIONS;
  const seed = input.seed ?? 1;
  const takes: PlannedTake[] = [];
  for (const item of corpus.items) {
    for (const c of conditions) {
      const profile: VoiceProfile = { ...input.profile, diacritics: c.diacritics, ezafe: c.ezafe, ipaInline: c.ipaInline, conjO: !!c.conjO };
      const tts = projectCorpusItem(item, c);
      const take = provider.synthesize(tts, profile, seed);
      takes.push({ takeId: `${take.takeId}-${c.id}`, itemId: item.id, conditionId: c.id, tts, ttsHash: sha256(tts + profile.id + profile.model), durationMs: take.durationMs });
    }
  }
  const order = takes.map((t) => t.takeId);
  const r = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { takes, playlist: order, provisional: true };
}

// ---------------------------------------------------------------------------------------------
// Scoring

export interface TokenJudgment {
  listener: string;
  itemId: string;
  conditionId: string;
  /** target token → pass/fail against roman (task 1). */
  tokens: Record<string, 'pass' | 'fail'>;
  /** 1-5, "sounds like a native Tehran speaker" (task 2). */
  naturalness?: number;
}

export interface AbJudgment {
  listener: string;
  itemId: string;
  a: string;
  b: string;
  choice: 'A' | 'B' | 'none';
}

export interface ConditionScore {
  id: string;
  correct: number;
  total: number;
  accuracy: number;
  byGroup: Partial<Record<ListeningGroup, number>>;
  naturalness: number;
  eligible: boolean;
  ineligibleBecause: string[];
}

export interface AbScore {
  a: string;
  b: string;
  winsA: number;
  winsB: number;
  ties: number;
  decisive: boolean;
  winner: string | null;
}

export interface ListeningScore {
  conditions: ConditionScore[];
  ab: AbScore[];
  agreement: number;
  toEditor: string[];
  chosen: string | null;
  diacriticsEarned: boolean | null;
  reasons: string[];
}

/** Smallest k with P(X ≥ k) < alpha for X ~ Binomial(n, 0.5): 37 for n = 60. */
export function binomialThreshold(n: number, alpha = 0.05): number {
  // P(X >= k) computed from the exact distribution with log-factorials
  const logC = (k: number) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
  };
  for (let k = 0; k <= n; k++) {
    let tail = 0;
    for (let j = k; j <= n; j++) tail += Math.exp(logC(j) - n * Math.LN2);
    if (tail < alpha) return k;
  }
  return n + 1;
}

const ELIGIBILITY = { overall: 0.98, numbers: 1, loanwords: 1, ezafe: 0.95, naturalness: 4.0 };

function complexity(c: ListeningCondition | undefined): number {
  if (!c) return 99;
  return (c.diacritics === 'all' ? 2 : c.diacritics === 'homographs' ? 1 : 0) + (c.ezafe === 'kasra' ? 1 : 0) + (c.ipaInline ? 1 : 0);
}

export function scoreListeningTest(
  judgments: TokenJudgment[],
  ab: AbJudgment[] = [],
  opts: { corpus?: ListeningCorpus; conditions?: ListeningCondition[]; baseline?: string } = {},
): ListeningScore {
  const corpus = opts.corpus ?? LISTENING_SET;
  const conditions = opts.conditions ?? LISTENING_CONDITIONS;
  const baseline = opts.baseline ?? 'C-a';
  const groupOf = new Map(corpus.items.map((i) => [i.id, i.group]));
  const listeners = new Set(judgments.map((j) => j.listener));
  const condIds = [...new Set([...conditions.map((c) => c.id), ...judgments.map((j) => j.conditionId)])];
  const scores: ConditionScore[] = condIds.map((id) => {
    const js = judgments.filter((j) => j.conditionId === id);
    let correct = 0;
    let total = 0;
    const g: Record<string, [number, number]> = {};
    for (const j of js) {
      const grp = groupOf.get(j.itemId) ?? 'long';
      for (const v of Object.values(j.tokens)) {
        total++;
        if (v === 'pass') correct++;
        const cell = (g[grp] ??= [0, 0]);
        cell[1]++;
        if (v === 'pass') cell[0]++;
      }
    }
    const nat = js.filter((j) => typeof j.naturalness === 'number');
    const naturalness = nat.length ? nat.reduce((s, j) => s + (j.naturalness ?? 0), 0) / nat.length : 0;
    const byGroup = Object.fromEntries(Object.entries(g).map(([k, [c, t]]) => [k, t ? c / t : 0])) as Partial<Record<ListeningGroup, number>>;
    const accuracy = total ? correct / total : 0;
    const why: string[] = [];
    if (accuracy < ELIGIBILITY.overall) why.push('accuracy < 98 %');
    if ((byGroup.numbers ?? 1) < ELIGIBILITY.numbers) why.push('numbers < 100 %');
    if ((byGroup.loanwords ?? 1) < ELIGIBILITY.loanwords) why.push('brands/loanwords < 100 %');
    if ((byGroup.ezafe ?? 1) < ELIGIBILITY.ezafe) why.push('ezafe < 95 %');
    if (naturalness < ELIGIBILITY.naturalness) why.push('naturalness < 4.0');
    return { id, correct, total, accuracy, byGroup, naturalness, eligible: total > 0 && why.length === 0, ineligibleBecause: why };
  });

  // A/B
  const pairs = new Map<string, AbScore>();
  for (const j of ab) {
    const [a, b] = [j.a, j.b].sort();
    const key = `${a}|${b}`;
    const s = pairs.get(key) ?? { a: a!, b: b!, winsA: 0, winsB: 0, ties: 0, decisive: false, winner: null };
    const pick = j.choice === 'none' ? null : j.choice === 'A' ? j.a : j.b;
    if (pick === null) s.ties++;
    else if (pick === s.a) s.winsA++;
    else s.winsB++;
    pairs.set(key, s);
  }
  const abScores = [...pairs.values()].map((s) => {
    const n = s.winsA + s.winsB;
    const k = binomialThreshold(n);
    const decisive = n > 0 && Math.max(s.winsA, s.winsB) >= k;
    return { ...s, decisive, winner: decisive ? (s.winsA > s.winsB ? s.a : s.b) : null };
  });

  // agreement (task 1) and items for the editor
  const cells = new Map<string, ('pass' | 'fail')[]>();
  for (const j of judgments) for (const [tok, v] of Object.entries(j.tokens)) {
    const key = `${j.itemId}|${j.conditionId}|${tok}`;
    cells.set(key, [...(cells.get(key) ?? []), v]);
  }
  let agree = 0;
  const toEditor = new Set<string>();
  for (const [key, vs] of cells) {
    if (vs.every((v) => v === vs[0])) agree++;
    const passes = vs.filter((v) => v === 'pass').length;
    const majority = Math.max(passes, vs.length - passes);
    if (majority < 2 || (vs.length >= 2 && passes * 2 === vs.length)) toEditor.add(key.split('|')[0]!);
  }
  const agreement = cells.size ? agree / cells.size : 0;

  // choice
  const reasons: string[] = [];
  const eligible = scores.filter((s) => s.eligible);
  const tokensPerListener = (s: ConditionScore) => s.correct / Math.max(1, listeners.size);
  const condById = new Map(conditions.map((c) => [c.id, c]));
  const ranked = [...eligible].sort((x, y) => {
    if (Math.abs(tokensPerListener(x) - tokensPerListener(y)) > 1) return y.accuracy - x.accuracy;
    if (Math.abs(x.naturalness - y.naturalness) > 0.2) return y.naturalness - x.naturalness;
    return complexity(condById.get(x.id)) - complexity(condById.get(y.id));
  });
  let chosen = ranked[0]?.id ?? null;
  if (!chosen) reasons.push('no condition is eligible');
  let diacriticsEarned: boolean | null = null;
  const chosenCond = chosen ? condById.get(chosen) : undefined;
  const base = scores.find((s) => s.id === baseline);
  if (chosen && chosenCond && chosenCond.diacritics !== 'none' && base) {
    const homographItems = (s: ConditionScore) => (s.byGroup.homographs ?? 0) * corpus.items.filter((i) => i.group === 'homographs').length;
    const c = scores.find((s) => s.id === chosen)!;
    diacriticsEarned = homographItems(c) - homographItems(base) >= 2 && base.naturalness - c.naturalness <= 0.3;
    if (!diacriticsEarned) {
      reasons.push('diacritics did not earn their place against the baseline');
      const plain = ranked.find((s) => condById.get(s.id)?.diacritics === 'none');
      chosen = plain?.id ?? null;
      if (!plain) reasons.push('no eligible condition without diacritics');
    }
  }
  return { conditions: scores, ab: abScores, agreement, toEditor: [...toEditor].sort(), chosen, diacriticsEarned, reasons };
}

/** The result record shape written to `<pack>/lexicon/listening/<testId>.json` (by a person, after a live test). */
export function listeningResultRecord(testId: string, listeners: string[], score: ListeningScore, judgments: TokenJudgment[], corpus: ListeningCorpus = LISTENING_SET) {
  const failed = new Set(judgments.filter((j) => j.conditionId === score.chosen && Object.values(j.tokens).includes('fail')).map((j) => j.itemId));
  return {
    testId,
    corpus: corpus.schema,
    listeners,
    conditions: score.conditions.map((c) => ({ id: c.id, accuracy: c.accuracy, byGroup: c.byGroup, naturalness: c.naturalness })),
    ab: score.ab.map(({ a, b, winsA, winsB, ties }) => ({ a, b, winsA, winsB, ties })),
    chosen: score.chosen,
    failedItems: [...failed].sort(),
    agreement: score.agreement,
    provisional: true,
  };
}

