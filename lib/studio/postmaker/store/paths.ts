// The file layout of, inside <content parent>/postmaker/ (never inside the repository). Every id that becomes a
// path segment is checked against a strict pattern first, so no request value can reach `..`, a separator or an
// absolute path.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PostmakerError } from '../errors';
import { STEP_KINDS, type ProjectLike, type StepKind } from '../types';
import { dayIn, timeIn, zoneOf } from './day';

export const STORE_VERSION = 2;

export const SHA_RE = /^[0-9a-f]{64}$/;
export const REF_ID_RE = /^ref-\d{8}-[0-9a-f]{4}$/;
export const RECIPE_ID_RE = /^rc-\d{8}-[0-9a-f]{4}$/;
export const RUN_ID_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const TEMPLATE_ID_RE = /^tpl-\d{8}-[0-9a-f]{4}$/;
export const VARIANT_ID_RE = /^var-[0-9a-f]{4}$/;
/** `<kind>`, `<kind>:<lang>` or `<kind>#<n>`. */
export const NODE_ID_RE = /^([a-z][a-z-]{1,23})(?::([a-z]{2}))?(?:#([1-9]\d{0,2}))?$/;

const bad = (what: string) => new PostmakerError(404, 'not_found', `Unknown ${what}.`);

export function assertNodeId(id: string): StepKind {
  const m = typeof id === 'string' ? NODE_ID_RE.exec(id) : null;
  if (!m || !(STEP_KINDS as readonly string[]).includes(m[1]!)) throw bad('step');
  return m[1] as StepKind;
}
const check = (re: RegExp, what: string) => (id: string) => {
  if (typeof id !== 'string' || !re.test(id)) throw bad(what);
  return id;
};
export const assertRecipeId = check(RECIPE_ID_RE, 'recipe');
export const assertRunId = check(RUN_ID_RE, 'run');
export const assertTemplateId = check(TEMPLATE_ID_RE, 'template');
export const assertSha = check(SHA_RE, 'file');
export const assertReferenceId = check(REF_ID_RE, 'reference');

// ---- roots -----------------------------------------------------------------------------------------------------

/** `<content parent>` = path.dirname(project.contentDir), the parent `brand/` and `pipelines/` already use. */
export const contentParent = (p: Pick<ProjectLike, 'contentDir'>) => path.dirname(path.resolve(p.contentDir));
export const postmakerRoot = (p: Pick<ProjectLike, 'contentDir'>) => path.join(contentParent(p), 'postmaker');
/** Default `<content parent>/pack`, or the project's own `pack.dir`. Signal never writes inside it. */
export const packDirOf = (p: Pick<ProjectLike, 'contentDir' | 'pack'>) => (p.pack?.dir ? path.resolve(p.pack.dir) : path.join(contentParent(p), 'pack'));

// ---- layout ----------------------------------------------------------------------------------------------------

export const versionFile = (root: string) => path.join(root, 'VERSION');
export const packLockFile = (root: string) => path.join(root, 'pack-lock.json');
export const objectPath = (root: string, sha: string) => path.join(root, 'objects', 'sha256', assertSha(sha).slice(0, 2), sha);
export const recipeDir = (root: string, id: string) => path.join(root, 'recipes', assertRecipeId(id));
export const recipeIndexFile = (root: string, id: string) => path.join(recipeDir(root, id), 'recipe.json');
export const recipeVersionFile = (root: string, id: string, n: number) => path.join(recipeDir(root, id), 'recipe', `v${positive(n)}.json`);
export const pipelineVersionFile = (root: string, id: string, n: number) => path.join(recipeDir(root, id), 'pipeline', `v${positive(n)}.json`);
export const stepDir = (root: string, recipeId: string, nodeId: string) => (assertNodeId(nodeId), path.join(recipeDir(root, recipeId), 'steps', nodeId));
export const headFile = (root: string, recipeId: string, nodeId: string) => path.join(stepDir(root, recipeId, nodeId), 'head.json');
export const stepVersionFile = (root: string, recipeId: string, nodeId: string, n: number) => path.join(stepDir(root, recipeId, nodeId), `v${positive(n)}.json`);
export const pendingFile = (root: string, recipeId: string, nodeId: string) => path.join(stepDir(root, recipeId, nodeId), 'pending.json');
export const notesFile = (root: string, recipeId: string) => path.join(recipeDir(root, recipeId), 'notes.json');
/** Named-person sign-offs, kept outside the write-once version files (append-only JSON lines). */
export const signoffsFile = (root: string, recipeId: string) => path.join(recipeDir(root, recipeId), 'signoffs.jsonl');
export const refDir = (root: string, id: string) => path.join(root, 'refs', assertReferenceId(id));
export const refFile = (root: string, id: string) => path.join(refDir(root, id), 'ref.json');
export const runDir = (root: string, id: string) => path.join(root, 'runs', assertRunId(id));
export const runFile = (root: string, id: string) => path.join(runDir(root, id), 'run.json');
export const eventsFile = (root: string, id: string) => path.join(runDir(root, id), 'events.jsonl');
export const runWorkDir = (root: string, id: string) => path.join(runDir(root, id), 'work');
export const templateFile = (root: string, id: string) => path.join(root, 'templates', `${assertTemplateId(id)}.json`);
export const projectAssetsDir = (root: string) => path.join(root, 'assets');
export const projectLibraryFile = (root: string) => path.join(projectAssetsDir(root), 'library.json');
export const cacheIndexFile = (root: string) => path.join(root, 'cache', 'index.jsonl');
export const ledgerFile = (root: string) => path.join(root, 'ledger.jsonl');
export const statsFile = (root: string) => path.join(root, 'stats.json');
export const pinsFile = (root: string) => path.join(root, 'pins.json');

export const VERSION_FILE_RE = /^v([1-9]\d{0,6})\.json$/;

function positive(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 9_999_999) throw bad('version');
  return n;
}

// ---- ids (dates in the project's time zone, random suffix as newPipelineId) --------------------------------

const hex4 = () => randomBytes(2).toString('hex');
const ymd = (p: Pick<ProjectLike, 'timeZone'>, now: number) => dayIn(zoneOf(p), now).replace(/-/g, '');

export const newReferenceId = (p: Pick<ProjectLike, 'timeZone'>, now = Date.now()) => `ref-${ymd(p, now)}-${hex4()}`;
export const newRecipeId = (p: Pick<ProjectLike, 'timeZone'>, now = Date.now()) => `rc-${ymd(p, now)}-${hex4()}`;
export const newTemplateId = (p: Pick<ProjectLike, 'timeZone'>, now = Date.now()) => `tpl-${ymd(p, now)}-${hex4()}`;
export const newVariantId = () => `var-${hex4()}`;
export const newRunId = (p: Pick<ProjectLike, 'timeZone'>, now = Date.now()) => `run-${ymd(p, now)}-${timeIn(zoneOf(p), now).replace(/:/g, '')}-${hex4()}`;
