// Native-speaker gates. Gate 1 (text, RT-01…RT-11) and gate 2
// (listening, RA-01…RA-12) are signed per line version by a *named person*. Agents never sign.
// In mock mode the records say `reviewer: "mock"`, which counts as unsigned: a final render refuses it.

import { textGateBlockers, type LintIssue, type LintOverride } from './lint';
import { checkPronInvariant, pendingDecisions, type FaLineText, type ReviewState } from './pron';

export const TEXT_GATE_ITEMS = ['RT-01', 'RT-02', 'RT-03', 'RT-04', 'RT-05', 'RT-06', 'RT-07', 'RT-08', 'RT-09', 'RT-10', 'RT-11'] as const;
export const LISTEN_GATE_ITEMS = ['RA-01', 'RA-02', 'RA-03', 'RA-04', 'RA-05', 'RA-06', 'RA-07', 'RA-08', 'RA-09', 'RA-10', 'RA-11', 'RA-12'] as const;

export interface SignoffRecord {
  runId: string;
  lineId: string;
  gate: 'text' | 'listen';
  takeId?: string;
  /** A named person; never an agent id. */
  reviewer: string;
  at: string;
  items: Record<string, 'pass' | 'fail'>;
  notes?: string;
  /** Lexicon entry ids created from this review. */
  lexiconProposals: string[];
}

/** Agent and role ids that can never sign a gate (registry plus legacy names). */
export const AGENT_REVIEWER_IDS = new Set([
  'mock', 'agent', 'deconstructor', 'copywriter', 'language-editor', 'persian-editor', 'art-director', 'animator', 'motion-designer',
  'sound-designer', 'reviewer', 'reviewer-cli', 'creative-producer', 'claude', 'codex',
]);

export class SignoffError extends Error {
  constructor(
    readonly code: 'SIGNOFF_NOT_A_PERSON' | 'SIGNOFF_INCOMPLETE' | 'SIGNOFF_BLOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'SignoffError';
  }
}

/** True for a reviewer string that names a person (not empty, not a placeholder, not an agent or role id). */
export function isNamedPerson(reviewer: string | null | undefined): boolean {
  if (!reviewer) return false;
  const r = reviewer.trim();
  if (!r || /^<.*>$/.test(r)) return false;
  const lower = r.toLowerCase();
  if (AGENT_REVIEWER_IDS.has(lower)) return false;
  if (/^(agent|role|bot|ai|model)[:/]/.test(lower)) return false;
  return true;
}

export const textHash = (line: FaLineText): string => `${line.displayHash}:${line.pronHash}`;

function stateFrom(record: SignoffRecord, required: readonly string[], hash: string): ReviewState {
  const missing = required.filter((id) => !(id in record.items));
  if (missing.length) throw new SignoffError('SIGNOFF_INCOMPLETE', `missing checklist items: ${missing.join(', ')}`);
  const failed = required.some((id) => record.items[id] === 'fail');
  const state: ReviewState = { status: failed ? 'failed' : 'approved', by: record.reviewer, at: record.at, items: { ...record.items }, hash };
  if (record.notes) state.note = record.notes;
  return state;
}

/**
 * Sign the text gate for the line's current hashes. Refuses agents (`SIGNOFF_NOT_A_PERSON`) and a
 * line with lint errors or open decisions (`SIGNOFF_BLOCKED`); a failed item records `failed`.
 */
export function signText(line: FaLineText, record: SignoffRecord, gate: { issues?: LintIssue[]; overrides?: LintOverride[] } = {}): FaLineText {
  if (!isNamedPerson(record.reviewer)) throw new SignoffError('SIGNOFF_NOT_A_PERSON', `«${record.reviewer}» is not a named person`);
  const blockers = textGateBlockers(gate.issues ?? [], gate.overrides ?? []);
  const pending = pendingDecisions(line);
  const inv = checkPronInvariant(line);
  const passing = !Object.values(record.items).includes('fail');
  if (passing && (blockers.length || pending.length || inv.length)) {
    throw new SignoffError('SIGNOFF_BLOCKED', `the line has ${blockers.length} lint errors, ${pending.length} open decisions, ${inv.length} invariant errors`);
  }
  return { ...line, review: { ...line.review, text: stateFrom(record, TEXT_GATE_ITEMS, textHash(line)) } };
}

/** Sign the listening gate for one take, bound to the take's ttsHash. */
export function signListen(line: FaLineText, takeId: string, ttsHash: string, record: SignoffRecord): FaLineText {
  if (!isNamedPerson(record.reviewer)) throw new SignoffError('SIGNOFF_NOT_A_PERSON', `«${record.reviewer}» is not a named person`);
  return { ...line, review: { ...line.review, listen: { ...line.review.listen, [takeId]: stateFrom(record, LISTEN_GATE_ITEMS, ttsHash) } } };
}

/** Mock mode: the gates auto-pass with reviewer "mock", which counts as unsigned. */
export function mockSignoff(line: FaLineText, at: string, take?: { takeId: string; ttsHash: string }): FaLineText {
  const pass = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 'pass' as const]));
  const text: ReviewState = { status: 'approved', by: 'mock', at, items: pass(TEXT_GATE_ITEMS), hash: textHash(line) };
  const listen = take ? { ...line.review.listen, [take.takeId]: { status: 'approved' as const, by: 'mock', at, items: pass(LISTEN_GATE_ITEMS), hash: take.ttsHash } } : line.review.listen;
  return { ...line, review: { text, listen } };
}

export interface RenderVerdict {
  allowed: boolean;
  reasons: string[];
}

/**
 * A final render refuses a fa line unless the text gate and the chosen
 * take's listening gate are approved by a named person for the current hashes.
 */
export function finalRenderAllowed(line: FaLineText, take?: { takeId: string; ttsHash: string }): RenderVerdict {
  const reasons: string[] = [];
  const t = line.review.text;
  if (t.status !== 'approved') reasons.push('text gate not approved');
  if (!isNamedPerson(t.by)) reasons.push(`text gate reviewer is not a named person (${t.by ?? 'none'})`);
  if (t.status === 'approved' && t.hash !== textHash(line)) reasons.push('the text changed after it was signed');
  if (pendingDecisions(line).length) reasons.push('open pronunciation decisions');
  if (checkPronInvariant(line).length) reasons.push('pron invariant errors');
  if (!take) reasons.push('no chosen take');
  else {
    const l = line.review.listen[take.takeId];
    if (!l) reasons.push('listening gate not signed for the chosen take');
    else {
      if (l.status !== 'approved') reasons.push('listening gate not approved');
      if (!isNamedPerson(l.by)) reasons.push(`listening gate reviewer is not a named person (${l.by ?? 'none'})`);
      if (l.hash !== take.ttsHash) reasons.push('the take was made from a different tts (stale)');
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

/** S1 approval is disabled while any of these remain. */
export function textGateOpenItems(line: FaLineText, issues: LintIssue[], overrides: LintOverride[] = []): { lint: LintIssue[]; decisions: number[] } {
  return { lint: textGateBlockers(issues, overrides), decisions: pendingDecisions(line) };
}
