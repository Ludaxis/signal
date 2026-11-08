// Missing assets of the `art` step (`postmaker/assets/`, ADR 0011): the art director's
// `newAssets` become pending requests; "Make with Codex" turns one into a draft library asset; a named person
// approves or rejects it.
//
// - A request is recorded as pending ("Needs you: press Run") and nothing runs. Codex runs only when ALL hold at the
//   moment of the press: the run is attended (a button in an open app session), the `codex` connector is live under
//   the single decision point (`connectorAllowed`: kill switch, the Post maker switch, the `approval:codex-images`
//   gate, attendance) and `codexImagesAllowed()` is enabled. Otherwise the request stays pending with the reason.
// - Only the request's text prompt goes to the local Codex CLI (codex.ts: allow-listed child env, sandboxed temp
//   workspace); no file, reference or library asset is handed over, so nothing is uploaded by Signal (third-party
//   upload gate untouched).
// - Prompt lint (roles doc): ≤ 600 characters, no text in the image, no brand or third-party names, no real
//   people. The lint is generic: the names it refuses by spelling come from the pack (glossary), never from core.
// - The PNG is stored as an object and as `assets/files/<id>.png`, and recorded in `assets/library.json` as `draft`
//   with `aiGenerated: true`, licence `ai-generated` and the vendor record {name 'codex', model, requestId,
//   promptRef}. The Codex CLI does not report its image model, so `model` reads "codex-cli <version>; image model not
//   reported". A draft run may use it; the final render refuses it until a person approves it (`asset.draft-in-final`).
// - One request, one draft: only a `pending` request can be made, one press at a time. A rejected wording is final
//   (the same kind + prompt stays rejected); the way back is different words (a new request) or a library asset.
// - Approve / reject need a person's name: `mock`, agent ids and Signal's own process names are refused (403).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { t } from '@/app/studio/copy/en';
import { codexEnv, codexImage as realCodexImage, codexImagesAllowed, type CodexImage } from '../../codex';
import { connectorAllowed, type AllowedOptions } from '../connectors/allowed';
import type { RegisteredConnector } from '../connectors/base';
import { PostmakerError } from '../errors';
import { insideDir, type LibraryAsset, type LoadedPack } from '../pack/load';
import { loadProjectAssets, mergeLibraries, packEntries } from '../pack/resolve';
import { librarySchema } from '../pack/schema';
import { loadPackTemplates } from '../pack/template';
import { SAFE_ZONES, type CanvasId } from '../render/safeZones';
import { isAgentIdentity, personName } from '../signoffs';
import { ensureDir, pretty, readJsonFile, writeOnce, writeReplace } from '../store/fs';
import { withLock } from '../store/mutex';
import { putBytes, putJson } from '../store/objects';
import { projectAssetsDir, projectLibraryFile } from '../store/paths';
import type { AssetUse } from '../types';
import { POSES, PROMPT_MAX, type ArtAsset, type ArtTemplate, type ArtWorld, type AssetRequestRef, type NewAssetKind, type NewAssetRequest, type Pose, type RigCaps } from './art';

// ---- prompt lint --------------------------------------------------------------------------------------------------

export type PromptLintCode = 'prompt.empty' | 'prompt.too-long' | 'prompt.text-in-image' | 'prompt.brand' | 'prompt.name' | 'prompt.real-person' | 'prompt.third-party';
export interface PromptIssue {
  code: PromptLintCode;
  text: string;
}

const TEXTY = '(?:text|words?|letters?|lettering|captions?|logos?|labels?|writing|numbers|typography|signs?)';
/** "no words, letters or logos" and similar negations are what a prompt should say; they are removed before the check. */
const NEGATED = new RegExp(`\\b(?:no|without|free of)\\s+(?:any\\s+)?${TEXTY}(?:\\s*(?:,|or|and|nor)\\s*${TEXTY})*`, 'gi');
const TEXT_ASK = new RegExp(`\\b(?:${TEXTY}|fonts?|headlines?|titles?|says|saying|reads|spelled|spelling|slogans?|watermarks?)\\b`, 'i');
const QUOTES = /["“”„‟«»]|(?:^|\s)'[^']+'(?=\s|[.,;:!?]|$)/;
const REAL_PERSON = /\b(?:celebrit(?:y|ies)|famous|real (?:person|people|man|woman|child)|likeness|look-?alike|photo(?:graph)? of a specific|actual person|influencer|politician|athlete)\b/i;
const THIRD_PARTY = /\b(?:in the style of|style of the|inspired by the|fan ?art|trademark(?:ed)?|copyrighted|official (?:art|character|mascot))\b|[™®©]/i;
/** A capitalised word that does not start a sentence reads as a name (brand, product, place or person). */
const PROPER = /[^.!?:\s]\s+([A-Z][a-z]+(?:[A-Z][a-z]*)*)\b/g;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lints an image prompt (roles doc). `names` are the pack's brand and character names (from its glossary); any of
 * them, in any case, is refused. Returns every issue; an empty list means the prompt may go to a generator.
 */
export function lintImagePrompt(prompt: string, o: { names?: readonly string[] } = {}): PromptIssue[] {
  const p = (prompt ?? '').trim();
  const out: PromptIssue[] = [];
  if (!p) return [{ code: 'prompt.empty', text: 'Describe the picture.' }];
  if ([...p].length > PROMPT_MAX) out.push({ code: 'prompt.too-long', text: `Keep the prompt within ${PROMPT_MAX} characters.` });
  if (QUOTES.test(p)) out.push({ code: 'prompt.text-in-image', text: 'No quoted text: the image must carry no words.' });
  else if (TEXT_ASK.test(p.replace(NEGATED, ' '))) out.push({ code: 'prompt.text-in-image', text: 'The image must carry no words, letters or logos.' });
  for (const n of o.names ?? []) {
    const name = n.trim();
    if (name.length < 2) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(p)) {
      out.push({ code: 'prompt.brand', text: 'No brand or character names in an image prompt.' });
      break;
    }
  }
  if (THIRD_PARTY.test(p)) out.push({ code: 'prompt.third-party', text: 'No third-party styles, marks or characters.' });
  if (REAL_PERSON.test(p)) out.push({ code: 'prompt.real-person', text: 'No real people or likenesses.' });
  PROPER.lastIndex = 0;
  if (PROPER.exec(p)) out.push({ code: 'prompt.name', text: 'Describe things in plain words: no names.' });
  return out;
}

// ---- requests -----------------------------------------------------------------------------------------------------

export interface AssetRequestRecord extends AssetRequestRef {
  recipeId: string | null;
  nodeId: string | null;
  runId: string | null;
  size: { w: number; h: number };
  createdAt: string;
  madeAt: string | null;
}
interface RequestsFile {
  schema: 'signal.pm.asset-requests/1';
  requests: AssetRequestRecord[];
}

export const ASSET_REQUEST_ID_RE = /^ar-[0-9a-f]{12}$/;
export const requestsFile = (root: string) => path.join(projectAssetsDir(root), 'requests.json');
export const requestIdOf = (r: Pick<NewAssetRequest, 'kind' | 'prompt'>) => `ar-${createHash('sha256').update(`${r.kind}\n${r.prompt.trim()}`).digest('hex').slice(0, 12)}`;

/** The size Codex is asked for: full canvas for backgrounds and UI, 600 px square for stickers and props. */
export function requestSize(kind: NewAssetKind, canvas: CanvasId): { w: number; h: number } {
  const z = SAFE_ZONES[canvas];
  return kind === 'background' || kind === 'ui' ? { w: z.width, h: z.height } : { w: 600, h: 600 };
}

/** Follow-up: stickers, props and phone frames are cut-outs with alpha; backgrounds are opaque. */
export const requestAlpha = (kind: NewAssetKind): boolean => kind !== 'background';

export async function readRequests(root: string): Promise<AssetRequestRecord[]> {
  const f = await readJsonFile<RequestsFile>(requestsFile(root));
  return Array.isArray(f?.requests) ? f!.requests : [];
}

async function updateRequests<T>(root: string, fn: (all: AssetRequestRecord[]) => T | Promise<T>): Promise<T> {
  const file = requestsFile(root);
  return withLock(`pm-asset-requests:${file}`, async () => {
    const all = await readRequests(root);
    const out = await fn(all);
    await writeReplace(file, pretty({ schema: 'signal.pm.asset-requests/1', requests: all } satisfies RequestsFile));
    return out;
  });
}

/** The waiting line of a request whose draft a person rejected. */
export const rejectedText = () => 'Rejected. Ask for it in different words, or add one to the library.';

/** The waiting line of a request no one has pressed yet (the existing attended wording). */
export const pressRunText = () => t('connector.pressRun');

/**
 * Records `newAssets` as requests (idempotent by kind + prompt). A prompt that fails the lint is kept as `refused`
 * with its issues; every other new request is `pending` with the attended wording. Nothing is generated here.
 */
export async function recordAssetRequests(root: string, reqs: readonly NewAssetRequest[], meta: { recipeId?: string | null; nodeId?: string | null; runId?: string | null; canvas: CanvasId; names?: readonly string[]; now?: () => number }): Promise<AssetRequestRecord[]> {
  if (!reqs.length) return [];
  const at = new Date((meta.now ?? Date.now)()).toISOString();
  return updateRequests(root, (all) =>
    reqs.map((r) => {
      const id = requestIdOf(r);
      const prev = all.find((x) => x.id === id);
      if (prev) return prev;
      const lint = lintImagePrompt(r.prompt, { names: meta.names });
      const rec: AssetRequestRecord = { ...r, prompt: r.prompt.trim(), id, status: lint.length ? 'refused' : 'pending', waiting: lint.length ? lint[0]!.text : pressRunText(), lint, assetId: null, recipeId: meta.recipeId ?? null, nodeId: meta.nodeId ?? null, runId: meta.runId ?? null, size: requestSize(r.kind, meta.canvas), createdAt: at, madeAt: null };
      all.push(rec);
      return rec;
    }),
  );
}

// ---- Make with Codex ----------------------------------------------------------------------------------------------

export interface MakeAssetOptions {
  /** The press came from a person in an open app session. The daily run never passes true. */
  attended: boolean;
  /** The signed-in person (account id). */
  by: string;
  /** The `codex` connector (default: the registry's). */
  connector?: RegisteredConnector | null;
  /** Options for the decision point (tests: env, backend, now). */
  allowed?: Omit<AllowedOptions, 'attended'>;
  imagesAllowed?: () => Promise<{ enabled: boolean; reason: string }>;
  /** The image maker (tests inject a fake; the real one runs the local Codex CLI). */
  codexImage?: (prompt: string, width: number, height: number, o?: { alpha?: boolean }) => Promise<CodexImage>;
  /** The pack's names the prompt may not use. */
  names?: readonly string[];
  /** Licence holder written on the asset (the project id; never a person's contact detail). */
  holder?: string;
  now?: () => number;
}

/** The project assets file as stored (an Asset[]; empty when it does not exist yet). */
async function readProjectLibrary(root: string): Promise<LibraryAsset[]> {
  const raw = await readJsonFile<unknown>(projectLibraryFile(root));
  if (raw === null) return [];
  const parsed = librarySchema.safeParse(raw);
  if (!parsed.success) throw new PostmakerError(422, 'assets.invalid', 'Project assets are not valid.');
  return parsed.data;
}

export async function updateProjectLibrary<T>(root: string, fn: (all: LibraryAsset[]) => T | Promise<T>): Promise<T> {
  const file = projectLibraryFile(root);
  return withLock(`pm-assets:${file}`, async () => {
    const all = await readProjectLibrary(root);
    const out = await fn(all);
    const check = librarySchema.safeParse(all);
    if (!check.success) throw new PostmakerError(422, 'assets.invalid', 'The asset record is not valid.');
    await writeReplace(file, pretty(all));
    return out;
  });
}

const KIND_PREFIX: Record<NewAssetKind, string> = { background: 'bg', sticker: 'stk', prop: 'prop', ui: 'ui' };

/** Whether "Make with Codex" can run now, with the reason when it cannot (the StepDrawer row reads this). */
export async function makeWithCodexState(o: Pick<MakeAssetOptions, 'attended' | 'connector' | 'allowed' | 'imagesAllowed'>): Promise<{ enabled: boolean; why: 'attendance' | 'connector' | 'approval' | null; reason: string }> {
  if (!o.attended) return { enabled: false, why: 'attendance', reason: pressRunText() };
  const c = o.connector === undefined ? await registryCodex() : o.connector;
  if (!c) return { enabled: false, why: 'connector', reason: 'Codex is not set up.' };
  const d = await connectorAllowed(c, { ...o.allowed, attended: true });
  if (!d.live) return { enabled: false, why: d.why === 'attendance' ? 'attendance' : 'connector', reason: d.reason };
  const a = await (o.imagesAllowed ?? codexImagesAllowed)();
  if (!a.enabled) return { enabled: false, why: 'approval', reason: a.reason };
  return { enabled: true, why: null, reason: '' };
}

async function registryCodex(): Promise<RegisteredConnector | null> {
  const { connectorById } = await import('../connectors');
  return connectorById('codex');
}

/**
 * "Make with Codex" for one pending request: lint, the three checks, one Codex image, then a draft asset with full
 * provenance. A refused press leaves the request pending with the reason and never calls Codex.
 */
export async function makeRequestedAsset(root: string, requestId: string, o: MakeAssetOptions): Promise<{ asset: LibraryAsset; request: AssetRequestRecord }> {
  if (!ASSET_REQUEST_ID_RE.test(requestId)) throw new PostmakerError(404, 'not_found', 'Unknown asset request.');
  const req = (await readRequests(root)).find((r) => r.id === requestId);
  if (!req) throw new PostmakerError(404, 'not_found', 'Unknown asset request.');
  if (req.status === 'refused') throw new PostmakerError(400, 'validation', req.lint[0]?.text ?? req.waiting ?? 'This request was refused.');
  if (req.status !== 'pending') throw new PostmakerError(409, 'conflict', req.status === 'made' ? 'This asset is already made.' : rejectedText());
  const lint = lintImagePrompt(req.prompt, { names: o.names });
  if (lint.length) throw new PostmakerError(400, 'validation', lint[0]!.text);
  const state = await makeWithCodexState(o);
  if (!state.enabled) {
    await updateRequests(root, (all) => {
      const r = all.find((x) => x.id === requestId);
      if (r && r.status === 'pending') Object.assign(r, { waiting: state.reason });
    });
    if (state.why === 'attendance') throw new PostmakerError(409, 'needs_you', state.reason);
    throw new PostmakerError(403, 'forbidden', state.reason);
  }
  const key = `${path.resolve(root)}\n${requestId}`;
  if (MAKING.has(key)) throw new PostmakerError(409, 'conflict', 'This asset is being made.');
  MAKING.add(key);
  try {
    // Checked again while this press holds the request, so a press that cannot be stored never spends a generation.
    const cur = (await readRequests(root)).find((r) => r.id === requestId);
    if (cur?.status !== 'pending') throw new PostmakerError(409, 'conflict', cur?.status === 'made' ? 'This asset is already made.' : rejectedText());
    const id = assetIdOf(req);
    const file = `files/${id}.png`;
    if ((await readProjectLibrary(root)).some((a) => a.id === id) || (await fs.access(path.join(projectAssetsDir(root), file)).then(() => true, () => false))) throw new PostmakerError(409, 'conflict', 'This asset is already in the library.');
    return await makeOnce(root, req, id, file, o);
  } finally {
    MAKING.delete(key);
  }
}

/** Requests being made in this process: a second press while Codex is still drawing is refused, never run twice. */
const MAKING = new Set<string>();

/** The asset id of a request's one draft (one request, one draft: a rejected wording is final). */
export const assetIdOf = (req: Pick<AssetRequestRecord, 'id' | 'kind'>) => `${KIND_PREFIX[req.kind]}-ai-${req.id.slice(3)}`;

/**
 * The Codex CLI does not report the image model it used, so `vendor.model` names the CLI and its version and says the
 * model is not reported; it is never mistaken for an image model id.
 */
export function codexModelLabel(cliVersion: string | null | undefined): string {
  const v = (cliVersion ?? '').trim();
  const cli = v ? (/^codex-cli\b/i.test(v) ? v : `codex-cli ${v}`) : 'codex-cli (version unknown)';
  return `${cli}; image model not reported`;
}

async function makeOnce(root: string, req: AssetRequestRecord, id: string, file: string, o: MakeAssetOptions): Promise<{ asset: LibraryAsset; request: AssetRequestRecord }> {
  const requestId = req.id;
  const img = await (o.codexImage ?? realCodexImage)(req.prompt, req.size.w, req.size.h, { alpha: requestAlpha(req.kind) });
  const now = new Date((o.now ?? Date.now)()).toISOString();
  const png = await putBytes(root, img.png);
  const promptRef = await putJson(root, { schema: 'signal.pm.asset-prompt/1', requestId, kind: req.kind, prompt: req.prompt, task: img.prompt, cliVersion: img.cliVersion, imageModel: 'not reported by the Codex CLI' });
  await ensureDir(path.join(projectAssetsDir(root), 'files'));
  await writeOnce(path.join(projectAssetsDir(root), file), img.png);
  const asset: LibraryAsset = {
    id,
    kind: req.kind,
    file,
    sha256: png.sha256,
    dims: { w: req.size.w, h: req.size.h },
    tags: [req.kind, 'ai-generated'],
    licence: {
      type: 'ai-generated',
      holder: o.holder?.trim() || 'this project',
      source: `codex:${requestId}`,
      author: null,
      acquiredAt: now,
      proof: null,
      allowedUses: ['organic'],
      territories: 'worldwide',
      expiresAt: null,
      attribution: null,
      aiGenerated: true,
      vendor: { name: 'codex', model: codexModelLabel(img.cliVersion), requestId, promptRef: promptRef.sha256, c2pa: false },
    },
    status: 'draft',
    approvedBy: null,
  };
  await updateProjectLibrary(root, (all) => {
    if (all.some((a) => a.id === id)) throw new PostmakerError(409, 'conflict', 'This asset is already in the library.');
    all.push(asset);
  });
  const request = await updateRequests(root, (all) => {
    const r = all.find((x) => x.id === requestId)!;
    Object.assign(r, { status: 'made', waiting: null, assetId: id, madeAt: now });
    return { ...r };
  });
  return { asset, request };
}

/** The Codex child environment (codex.ts): the allow-list only, so no Signal or vendor key reaches it. */
export const codexChildEnv = (source: NodeJS.ProcessEnv = process.env) => codexEnv(source);

// ---- approve / reject ---------------------------------------------------------------------------------------------

function assertPerson(name: string, by: string): string {
  if (isAgentIdentity(by) || isAgentIdentity(typeof name === 'string' ? name : '')) throw new PostmakerError(403, 'forbidden', 'Only a named person can approve or reject an asset.');
  return personName(name);
}

/** A person approves a draft asset into the library; `allowedUses` may widen the uses it is licensed for. */
export async function approveAsset(root: string, o: { assetId: string; name: string; by: string; allowedUses?: AssetUse[] }): Promise<LibraryAsset> {
  const who = assertPerson(o.name, o.by);
  return updateProjectLibrary(root, (all) => {
    const a = all.find((x) => x.id === o.assetId);
    if (!a) throw new PostmakerError(404, 'not_found', 'Unknown asset.');
    if (a.status !== 'draft') throw new PostmakerError(409, 'conflict', a.status === 'approved' ? 'This asset is already approved.' : 'This asset is retired.');
    a.status = 'approved';
    a.approvedBy = who;
    if (o.allowedUses?.length) a.licence.allowedUses = [...new Set(o.allowedUses)];
    return { ...a };
  });
}

/**
 * A person rejects a draft: it is retired (never deleted) and its request is marked rejected. A rejected wording is
 * final: the same kind + prompt keeps its rejected request (recordAssetRequests is idempotent) and can never be made
 * again. The way back is a request in different words (a new request id, so a new asset id) or an asset added to the
 * library; the art step hands the art director the rejected wordings so it does not ask for them again.
 */
export async function rejectAsset(root: string, o: { assetId: string; name: string; by: string }): Promise<LibraryAsset> {
  assertPerson(o.name, o.by);
  const asset = await updateProjectLibrary(root, (all) => {
    const a = all.find((x) => x.id === o.assetId);
    if (!a) throw new PostmakerError(404, 'not_found', 'Unknown asset.');
    if (a.status !== 'draft') throw new PostmakerError(409, 'conflict', 'Only a draft can be rejected.');
    a.status = 'retired';
    return { ...a };
  });
  const rid = asset.licence.vendor?.requestId;
  if (rid) await updateRequests(root, (all) => void Object.assign(all.find((x) => x.id === rid) ?? {}, { status: 'rejected', waiting: rejectedText() }));
  return asset;
}

// ---- the StepDrawer row -------------------------------------------------------------------------------------------

export interface MissingAssetRow {
  requestId: string;
  label: string;
  button: string;
  disabled: boolean;
  reason: string | null;
}

/** "Missing asset · Make with Codex": one secondary button, disabled with the reason when it cannot run now. */
export function missingAssetRow(r: Pick<AssetRequestRecord, 'id' | 'status' | 'waiting' | 'lint'>, state: { enabled: boolean; reason: string }): MissingAssetRow {
  const base = { requestId: r.id, label: 'Missing asset · Make with Codex', button: 'Make with Codex' };
  if (r.status === 'refused') return { ...base, disabled: true, reason: r.lint[0]?.text ?? r.waiting };
  if (r.status !== 'pending') return { ...base, disabled: true, reason: r.status === 'made' ? 'Made. Approve it in the library.' : rejectedText() };
  return { ...base, disabled: !state.enabled, reason: state.enabled ? null : state.reason };
}

// ---- the art world from a pack ------------------------------------------------------------------------------------

/** What a loaded rig tells the art step (rig loader plugs in here for Tier A and C characters). */
export type RigLoader = (charId: string) => Promise<RigCaps | null>;

/**
 * Rig capabilities per character. Tier B (flat renders, pack format): the `front` view and `neutral`, plus one
 * pose per still asset `<charId>-<pose>` tagged `pose-of:<charId>`. Tier A and C need their rig: without a loader the
 * character is not castable (the plan cannot place a view or pose the rig may lack).
 */
export async function rigCapsFromPack(pack: Pick<LoadedPack, 'manifest'>, library: readonly ArtAsset[], loadRig?: RigLoader): Promise<Record<string, RigCaps>> {
  const out: Record<string, RigCaps> = {};
  for (const a of library) {
    if (a.kind !== 'character' || a.tags.some((x) => x.startsWith('pose-of:'))) continue;
    const tier = pack.manifest.rigTier[a.id];
    if (!tier) continue;
    if (tier === 'B') {
      const stills = library.filter((s) => s.kind === 'character' && s.tags.includes(`pose-of:${a.id}`)).map((s) => s.id.slice(a.id.length + 1));
      const poses = ['neutral', ...stills.filter((p): p is Pose => (POSES as readonly string[]).includes(p) && p !== 'neutral')] as Pose[];
      out[a.id] = { tier, views: ['front'], poses };
      continue;
    }
    const caps = loadRig ? await loadRig(a.id) : null;
    if (caps) out[a.id] = { ...caps, tier };
  }
  return out;
}

/** Brand and character display names from the pack glossary (prompt lint); [] when it has none or cannot be read. */
export async function packNames(pack: Pick<LoadedPack, 'dir' | 'manifest'> | null): Promise<string[]> {
  if (!pack?.manifest.glossary) return [];
  try {
    const raw = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ await insideDir(pack.dir, pack.manifest.glossary), 'utf8')) as { entries?: { kind?: string; display?: Record<string, string>; match?: { display?: string[] } }[] };
    const names = new Set<string>();
    for (const e of raw.entries ?? []) {
      if (e.kind !== 'brand' && e.kind !== 'character') continue;
      for (const v of [...Object.values(e.display ?? {}), ...(e.match?.display ?? [])]) if (typeof v === 'string' && v.trim().length >= 2) names.add(v.trim());
    }
    return [...names];
  } catch {
    return [];
  }
}

const toArtAsset = (a: LibraryAsset, origin: 'pack' | 'project'): ArtAsset => ({ id: a.id, kind: a.kind, tags: a.tags, ...(a.dims ? { dims: a.dims } : {}), status: a.status, licence: { allowedUses: a.licence.allowedUses, expiresAt: a.licence.expiresAt, aiGenerated: a.licence.aiGenerated, type: a.licence.type }, origin });

/** The library (pack + project assets), rigs, first story-spine template and names the art step reads. */
export async function artWorldFor(root: string, pack: LoadedPack, o: { loadRig?: RigLoader } = {}): Promise<ArtWorld> {
  const lib = mergeLibraries(packEntries(pack), await loadProjectAssets(root));
  const library = [...lib.values()].map((e) => toArtAsset(e.asset, e.origin));
  let template: ArtTemplate | null = null;
  try {
    const t = (await loadPackTemplates(pack)).find((x) => x.builder === 'story-spine@1');
    if (t) template = { segments: t.segments.map((s) => ({ id: s.id, shot: s.shot, ...(s.preset ? { preset: s.preset } : {}), require: s.require })), cast: t.cast };
  } catch {
    template = null; // a template problem shows on the pack screen; scenes then follow the core defaults
  }
  const rejectedPrompts = (await readRequests(root)).filter((r) => r.status === 'rejected').map((r) => r.prompt);
  return { library, rigs: await rigCapsFromPack(pack, library, o.loadRig), template, names: await packNames(pack), rejectedPrompts };
}
