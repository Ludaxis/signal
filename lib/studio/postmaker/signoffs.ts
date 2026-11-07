// Named-person sign-offs. Step versions are write-once, so a person's sign-off
// cannot live inside the version file: it is appended to recipes/<id>/signoffs.jsonl and reaches the engine through
// `EngineDeps.signoffs` (merges these records with each version's own, and `gateStateOf` decides "signed").
// A record is bound to one exact version hash; editing or regenerating the step makes a new version that needs its
// own sign-off. Agents and mock runs can never sign: `mock`, agent ids and role ids are refused as signer or name,
// both when a record is written and when one is read back (a hand-edited file cannot sneak one in).
import { PostmakerError } from './errors';
import { appendLine, readJsonLines } from './store/fs';
import { readHead } from './store/heads';
import { withLock } from './store/mutex';
import { signoffsFile } from './store/paths';
import { readPipeline } from './store/recipes';
import { readVersion } from './store/versions';
import type { GateId, SignOff, StepVersion } from './types';

/** role ids plus the reviewer and QA agent ids and Signal's own process names. */
const AGENT_NAMES = new Set([
  'mock',
  'deconstructor',
  'copywriter',
  'language-editor',
  'art-director',
  'animator',
  'motion-designer',
  'sound-designer',
  'reviewer',
  'qa-agent',
  'creative-producer',
  'signal',
  'signal-postmaker',
  'claude',
  'codex',
  'agent',
  'worker',
  'system',
]);

/** True for a value that names an agent, a worker, a mock or Signal itself rather than a person. */
export function isAgentIdentity(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (AGENT_NAMES.has(v)) return true;
  if (/^(agent|worker|bot|signal|mock|claude|codex)[:\-_/.@]/.test(v)) return true;
  if (/(^|[-_:])(agent|bot|mock)$/.test(v)) return true;
  if (/@(agents?|workers?|bots?)\./.test(v)) return true;
  return false;
}

/** A person's name as typed: 2-80 characters with at least one letter, no control characters, not an agent. */
export function personName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (n.length < 2 || n.length > 80 || !/\p{L}/u.test(n) || /[\u0000-\u001f\u007f]/.test(n)) throw new PostmakerError(400, 'validation', 'Type the full name of the person who checked it.');
  if (isAgentIdentity(n)) throw new PostmakerError(400, 'validation', 'A sign-off needs a person’s name, not an agent or mock.');
  return n;
}

/** A record read back counts only when a person made it (mock and agent records are skipped). */
const fromPerson = (s: Partial<SignOff>): s is SignOff =>
  typeof s.gate === 'string' && typeof s.nodeId === 'string' && Number.isInteger(s.version) && typeof s.hash === 'string' && typeof s.by === 'string' && typeof s.name === 'string' && (s.verdict === 'pass' || s.verdict === 'fail') && !isAgentIdentity(s.by) && !isAgentIdentity(s.name);

/** Every person-made sign-off of a recipe, oldest first. */
export async function readSignOffs(root: string, recipeId: string): Promise<SignOff[]> {
  return (await readJsonLines<Partial<SignOff>>(signoffsFile(root, recipeId))).filter(fromPerson);
}

/** The engine dependency (`EngineDeps.signoffs`): the stored records of one node. */
export function signoffsDep(root: string): (recipeId: string, nodeId: string) => Promise<SignOff[]> {
  return async (recipeId, nodeId) => (await readSignOffs(root, recipeId)).filter((s) => s.nodeId === nodeId);
}

export interface SignOffInput {
  recipeId: string;
  nodeId: string;
  version: number;
  gate: GateId;
  name: string;
  verdict: 'pass' | 'fail';
  perLine?: { lineId: string; ok: boolean; note?: string }[];
  /** The signed-in person (their account id); never an agent. */
  by: string;
  now?: number;
}

/**
 * `gate.sign-off` records a person's verdict on the node's **current** version, bound to its hash. Refuses a
 * node without that gate, the Proof gate (that is Accept), a version that is not current (409, the person saw an
 * older one), unknown line ids, a pass that marks a line not ok, and agent or mock signers.
 */
export async function recordSignOff(root: string, i: SignOffInput): Promise<{ signoff: SignOff; version: StepVersion }> {
  if (isAgentIdentity(i.by)) throw new PostmakerError(403, 'forbidden', 'Only a person can sign this.');
  const name = personName(i.name);
  const pipeline = await readPipeline(root, i.recipeId);
  if (!pipeline) throw new PostmakerError(404, 'not_found', 'This recipe has no pipeline yet.');
  const node = pipeline.nodes.find((n) => n.id === i.nodeId);
  if (!node) throw new PostmakerError(404, 'not_found', 'Unknown step.');
  if (!node.gate || node.gate.id !== i.gate) throw new PostmakerError(400, 'validation', 'This step has no such sign-off.');
  if (i.gate === 'proof') throw new PostmakerError(400, 'validation', 'The proof is accepted on Proof, not signed here.');
  const head = await readHead(root, i.recipeId, i.nodeId);
  if (head.current !== i.version) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
  const v = await readVersion(root, i.recipeId, i.nodeId, i.version);
  if (!v) throw new PostmakerError(404, 'not_found', 'That version does not exist.');
  const perLine = i.perLine ?? [];
  const known = new Set(v.provides.lineIds ?? []);
  const seen = new Set<string>();
  for (const l of perLine) {
    if (known.size && !known.has(l.lineId)) throw new PostmakerError(400, 'validation', `Line ${l.lineId} is not in this version.`);
    if (seen.has(l.lineId)) throw new PostmakerError(400, 'validation', `Line ${l.lineId} is listed twice.`);
    seen.add(l.lineId);
  }
  if (i.verdict === 'pass' && perLine.some((l) => !l.ok)) throw new PostmakerError(400, 'validation', 'A pass cannot have a line marked wrong. Choose fail, or fix the line first.');
  const signoff: SignOff = {
    gate: i.gate,
    nodeId: i.nodeId,
    version: v.n,
    hash: v.hash,
    by: i.by,
    name,
    at: new Date(i.now ?? Date.now()).toISOString(),
    verdict: i.verdict,
    ...(perLine.length ? { perLine: perLine.map((l) => ({ lineId: l.lineId, ok: l.ok, ...(l.note ? { note: l.note } : {}) })) } : {}),
  };
  const file = signoffsFile(root, i.recipeId);
  await withLock(`pm-signoffs:${file}`, () => appendLine(file, JSON.stringify(signoff)));
  return { signoff, version: v };
}

/**
 * The named person's pass a fork's version inherits from its template, or null. Only a
 * version made by the fork (`source: 'fork'`) with the very outputs of the template version it names (`forkedFrom`,
 * checked by hash and by output hashes) inherits, and only a person's last record on that exact template version
 * counts (mock and agent records never do). Nothing is written: the record stays the template's, naming the template
 * version, so it can never be read as a sign-off of the fork's own version.
 */
export async function inheritedSignOff(root: string, v: StepVersion, gate: GateId): Promise<SignOff | null> {
  const from = v.forkedFrom;
  if (!from || v.source !== 'fork' || from.nodeId !== v.nodeId) return null;
  const origin = await readVersion(root, from.recipeId, from.nodeId, from.n).catch(() => null);
  if (!origin || origin.hash !== from.hash) return null;
  const same = (a: StepVersion) => JSON.stringify(a.outputs.map((o) => [o.port, o.sha256]));
  if (same(origin) !== same(v)) return null;
  const records = [...origin.signoffs, ...(await readSignOffs(root, from.recipeId))].filter((s) => s.gate === gate && s.nodeId === origin.nodeId && s.version === origin.n && s.hash === origin.hash && !isAgentIdentity(s.by) && !isAgentIdentity(s.name));
  const last = records.at(-1) ?? null;
  return last && last.verdict === 'pass' ? last : null;
}
