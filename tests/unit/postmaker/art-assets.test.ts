// @vitest-environment node
// Missing assets: "Make with Codex" runs only attended, with the Post maker switch on and the Codex images
// approval open; the result is one draft asset with full provenance that a draft run may use and the final
// render refuses; approval needs a named person; the prompt lint; the Codex child environment carries
// no key. Codex is always a fake here (an injected `codexImage` spy); the network guard stays empty.
import { networkGuardLog, tmp } from './guard';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { CLI_ENV_ALLOW } from '@/lib/studio/claude-agent';
import type { CodexImage } from '@/lib/studio/codex';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { gateBackend } from '@/lib/studio/postmaker/connectors/allowed';
import { makeCliConnectors } from '@/lib/studio/postmaker/connectors/cli';
import { featureEnvName, POSTMAKER_PAUSED_ENV } from '@/lib/studio/postmaker/connectors/features';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { ART_REJECTS, artContext, artExecutor, planScenes, scenePlanIssues, type ArtWorld } from '@/lib/studio/postmaker/executors/art';
import { approveAsset, artWorldFor, codexChildEnv, codexModelLabel, lintImagePrompt, makeRequestedAsset, makeWithCodexState, missingAssetRow, readRequests, recordAssetRequests, rejectAsset, rejectedText, type MakeAssetOptions } from '@/lib/studio/postmaker/executors/art-assets';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { loadProjectAssets, mergeLibraries, packEntries, resolveAsset } from '@/lib/studio/postmaker/pack/resolve';
import { _setServiceDeps, handleAction, type ServiceProject } from '@/lib/studio/postmaker/service';
import { getBytes } from '@/lib/studio/postmaker/store/objects';
import { projectLibraryFile } from '@/lib/studio/postmaker/store/paths';
import type { Recipe } from '@/lib/studio/postmaker/types';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const STICKER = { kind: 'sticker' as const, prompt: 'a bold flat sticker of a sparkle with a thick white outline on a plain transparent background, no words, letters or logos', targetLicence: 'ai-generated' as const, reason: 'The template asks for a sticker.' };
const BACKGROUND = { kind: 'background' as const, prompt: 'a calm, softly lit indoor room as a vertical background plate, flat illustrated style, no people, no words, letters or logos', targetLicence: 'ai-generated' as const, reason: 'No background.' };

/** A fake Codex image maker: counts calls, returns a real PNG of the asked size. Never spawns anything. */
function fakeCodex() {
  return vi.fn(async (prompt: string, w: number, h: number): Promise<CodexImage> => ({ png: await sharp({ create: { width: w, height: h, channels: 3, background: '#3c6e71' } }).png().toBuffer(), prompt: `$imagegen\n<image_brief>\n${prompt}\n</image_brief>`, cliVersion: 'codex-cli 0.0.0-test', seconds: 1 }));
}

/** The registry's Codex connector shape with the fake image maker; switches and approvals come from the options. */
const codexConnector = (spy: ReturnType<typeof fakeCodex>) => makeCliConnectors({ codexImage: spy, cliInfo: async () => ({ found: true, version: 'codex-cli 0.0.0-test', signedIn: true }) as never }).codex;
const switches = (o: { postmaker?: boolean; approval?: boolean; paused?: boolean } = {}) => ({
  env: { [featureEnvName('postmaker')]: o.postmaker === false ? '0' : '1', ...(o.paused ? { [POSTMAKER_PAUSED_ENV]: '1' } : {}) } as unknown as NodeJS.ProcessEnv,
  backend: gateBackend({ approvals: { 'codex-images': async () => o.approval !== false } }),
  now: NOW,
});
const options = (spy: ReturnType<typeof fakeCodex>, o: { attended?: boolean; postmaker?: boolean; approval?: boolean; paused?: boolean; images?: boolean; by?: string } = {}): MakeAssetOptions => ({
  attended: o.attended ?? true,
  by: o.by ?? 'owner@example.test',
  connector: codexConnector(spy),
  allowed: switches(o),
  imagesAllowed: async () => (o.images === false ? { enabled: false, reason: 'Codex images are not approved for this account.' } : { enabled: true, reason: '' }),
  codexImage: spy,
  holder: 'example-project',
  now: () => NOW,
});
const pending = async () => (await recordAssetRequests(tmp.root, [STICKER], { canvas: 'reel', now: () => NOW }))[0]!;

describe('unattended or closed: Codex is never called and the request stays pending', () => {
  it('the daily run (unattended): the art step records requests only, and a make attempt is refused with the attended wording', async () => {
    const spy = fakeCodex();
    // The art step in a daily-run context: requests are recorded, never generated.
    const world: ArtWorld = { library: [{ id: 'bg-a', kind: 'background', tags: [], status: 'approved', licence: { allowedUses: ['organic'], expiresAt: null, aiGenerated: false, type: 'owned' } }], rigs: {}, template: { segments: [{ id: 'hook', shot: 'wide', require: ['stickers>=2'] }], cast: { lead: 'char-x' } }, names: [] };
    const recipe = { id: 'rc-20261107-abcd', shape: '9:16', beats: [{ id: 'b01', segment: 'hook' }] } as unknown as Recipe;
    const ex = artExecutor({ world: async () => world, onRequests: (reqs) => recordAssetRequests(tmp.root, reqs, { canvas: 'reel', now: () => NOW }) });
    await ex.run({ recipe, node: { id: 'art' }, params: {}, byPort: {}, seed: 1, mode: 'live', connector: 'pack', context: null, runId: 'run-20261107-060000-ab12', now: () => NOW, signal: new AbortController().signal } as unknown as ExecInput);
    const reqs = await readRequests(tmp.root);
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.status === 'pending' && r.waiting === 'Needs you: press Run')).toBe(true);
    // A make attempt from an unattended context.
    const e = await makeRequestedAsset(tmp.root, reqs[0]!.id, options(spy, { attended: false })).catch((x: unknown) => x);
    expect(isPostmakerError(e, 'needs_you')).toBe(true);
    expect((e as Error).message).toBe('Needs you: press Run');
    expect(spy).not.toHaveBeenCalled();
    expect((await readRequests(tmp.root))[0]).toMatchObject({ status: 'pending', waiting: 'Needs you: press Run', assetId: null });
  });

  it('attended but the Post maker switch off, the kill switch on, the approval closed or Codex images refused: 403, no call', async () => {
    const spy = fakeCodex();
    const r = await pending();
    for (const o of [{ postmaker: false }, { paused: true }, { approval: false }, { images: false }]) {
      const e = await makeRequestedAsset(tmp.root, r.id, options(spy, o)).catch((x: unknown) => x);
      expect(isPostmakerError(e, 'forbidden'), JSON.stringify(o)).toBe(true);
      expect((await readRequests(tmp.root))[0]!.status).toBe('pending');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('the StepDrawer row: one secondary button, disabled with the reason when it cannot run', async () => {
    const spy = fakeCodex();
    const r = await pending();
    const off = await makeWithCodexState(options(spy, { attended: false }));
    expect(missingAssetRow(r, off)).toEqual({ requestId: r.id, label: 'Missing asset · Make with Codex', button: 'Make with Codex', disabled: true, reason: 'Needs you: press Run' });
    const closed = await makeWithCodexState(options(spy, { postmaker: false }));
    expect(missingAssetRow(r, closed)).toMatchObject({ disabled: true, reason: 'Codex is off.' });
    const open = await makeWithCodexState(options(spy));
    expect(missingAssetRow(r, open)).toMatchObject({ disabled: false, reason: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('attended + switch on + approval open: exactly one draft asset with full provenance', () => {
  it('stores the PNG as an object and in assets/files, records a draft ai-generated asset; a draft run may use it, the final render refuses it', async () => {
    const spy = fakeCodex();
    const r = (await recordAssetRequests(tmp.root, [BACKGROUND], { canvas: 'reel', now: () => NOW }))[0]!;
    const { asset, request } = await makeRequestedAsset(tmp.root, r.id, options(spy));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([BACKGROUND.prompt, 1080, 1920, { alpha: false }]); // the text prompt only: no file is handed over (a background is opaque)
    expect(request).toMatchObject({ status: 'made', assetId: asset.id, waiting: null });
    expect(asset).toMatchObject({ kind: 'background', status: 'draft', approvedBy: null, dims: { w: 1080, h: 1920 }, tags: ['background', 'ai-generated'] });
    expect(asset.licence).toMatchObject({ type: 'ai-generated', aiGenerated: true, holder: 'example-project', source: `codex:${r.id}`, allowedUses: ['organic'], expiresAt: null });
    // the Codex CLI does not report its image model: the record names the CLI version and says so
    expect(asset.licence.vendor).toMatchObject({ name: 'codex', model: 'codex-cli 0.0.0-test; image model not reported', requestId: r.id, c2pa: false });
    const prompt = JSON.parse((await getBytes(tmp.root, asset.licence.vendor!.promptRef)).toString('utf8')) as { prompt: string; task: string; cliVersion: string; imageModel: string };
    expect(prompt).toMatchObject({ prompt: BACKGROUND.prompt, cliVersion: 'codex-cli 0.0.0-test', imageModel: 'not reported by the Codex CLI' });
    expect((await getBytes(tmp.root, asset.sha256)).length).toBeGreaterThan(0);
    const stored = JSON.parse(readFileSync(projectLibraryFile(tmp.root), 'utf8')) as unknown[];
    expect(stored).toHaveLength(1);

    // the resolver (acceptance 4): a draft run resolves it, the final render refuses it with its code
    const lib = mergeLibraries(packEntries(null), await loadProjectAssets(tmp.root));
    await expect(resolveAsset(lib, asset.id, { final: false, use: 'organic' })).resolves.toMatchObject({ sha256: asset.sha256, origin: 'project' });
    await expect(resolveAsset(lib, asset.id, { final: true, use: 'organic' })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'asset.draft-in-final'));

    // the art plan: a draft run may place it, a final run is refused with the unapproved rule
    const world = await artWorldFor(tmp.root, { manifest: { rigTier: {}, templates: [], glossary: null }, library: [], libraryDir: tmp.dir, dir: tmp.dir } as never);
    const recipe = { id: 'rc-20261107-abcd', shape: '9:16', beats: [{ id: 'b01', segment: 'hook' }] } as unknown as Recipe;
    const draftCtx = artContext({ recipe, params: {}, byPort: {}, now: () => NOW }, world);
    const plan = planScenes(draftCtx);
    expect(plan.beats[0]!.background).toBe(asset.id);
    expect(scenePlanIssues(plan, draftCtx)).toEqual([]);
    expect(scenePlanIssues(plan, artContext({ recipe, params: { final: true }, byPort: {}, now: () => NOW }, world)).map((i) => i.code)).toContain(ART_REJECTS.unapproved);

    // a second press makes nothing more
    await expect(makeRequestedAsset(tmp.root, r.id, options(spy))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'conflict'));
    expect(spy).toHaveBeenCalledTimes(1);

    // once a person approves it, the final render resolves it
    await approveAsset(tmp.root, { assetId: asset.id, name: 'Pat Example', by: 'owner@example.test' });
    const lib2 = mergeLibraries(packEntries(null), await loadProjectAssets(tmp.root));
    await expect(resolveAsset(lib2, asset.id, { final: true, use: 'organic' })).resolves.toMatchObject({ sha256: asset.sha256 });
    await expect(resolveAsset(lib2, asset.id, { final: true, use: 'paid-ads' })).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'asset.use-not-allowed'));
  });
});

describe('approve and reject need a named person', () => {
  const made = async () => {
    const spy = fakeCodex();
    return (await makeRequestedAsset(tmp.root, (await pending()).id, options(spy))).asset;
  };
  it('a named person flips draft → approved; mock, agent ids and Signal itself are refused with 403', async () => {
    const a = await made();
    for (const [name, by] of [['mock', 'owner@example.test'], ['art-director', 'owner@example.test'], ['codex', 'owner@example.test'], ['Pat Example', 'agent:art-director'], ['Pat Example', 'mock'], ['Pat Example', 'signal-postmaker']]) {
      const e = await approveAsset(tmp.root, { assetId: a.id, name: name!, by: by! }).catch((x: unknown) => x);
      expect(isPostmakerError(e, 'forbidden') && (e as { status: number }).status === 403, `${name} / ${by}`).toBe(true);
      await expect(rejectAsset(tmp.root, { assetId: a.id, name: name!, by: by! })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
    }
    await expect(approveAsset(tmp.root, { assetId: a.id, name: 'x', by: 'owner@example.test' })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'validation'));
    const ok = await approveAsset(tmp.root, { assetId: a.id, name: 'Pat Example', by: 'owner@example.test', allowedUses: ['organic', 'paid-ads'] });
    expect(ok).toMatchObject({ status: 'approved', approvedBy: 'Pat Example' });
    expect(ok.licence.allowedUses).toEqual(['organic', 'paid-ads']);
    await expect(approveAsset(tmp.root, { assetId: a.id, name: 'Pat Example', by: 'owner@example.test' })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'conflict'));
  });
  it('reject retires the draft (never deletes it) and marks its request rejected', async () => {
    const a = await made();
    const r = await rejectAsset(tmp.root, { assetId: a.id, name: 'Pat Example', by: 'owner@example.test' });
    expect(r.status).toBe('retired');
    expect((await loadProjectAssets(tmp.root)).map((e) => e.asset.id)).toEqual([a.id]);
    expect((await readRequests(tmp.root))[0]).toMatchObject({ status: 'rejected', waiting: rejectedText() });
  });
  it('a rejected wording is final: pressing again never calls Codex, and asking again in the same words stays rejected', async () => {
    const spy = fakeCodex();
    const req = await pending();
    const { asset } = await makeRequestedAsset(tmp.root, req.id, options(spy));
    await rejectAsset(tmp.root, { assetId: asset.id, name: 'Pat Example', by: 'owner@example.test' });
    const e = await makeRequestedAsset(tmp.root, req.id, options(spy)).catch((x: unknown) => x);
    expect(isPostmakerError(e, 'conflict') && (e as { status: number; message: string }).status === 409).toBe(true);
    expect((e as Error).message).toBe(rejectedText());
    expect(spy).toHaveBeenCalledTimes(1);
    // the planner asks again with the same words: the record stays rejected, the row stays disabled with the way back
    const [again] = await recordAssetRequests(tmp.root, [STICKER], { canvas: 'reel', now: () => NOW });
    expect(again).toMatchObject({ id: req.id, status: 'rejected' });
    expect(missingAssetRow(again!, { enabled: true, reason: '' })).toMatchObject({ disabled: true, reason: rejectedText() });
    await expect(makeRequestedAsset(tmp.root, req.id, options(spy))).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'conflict'));
    expect(spy).toHaveBeenCalledTimes(1);
    // the library and the request file are unchanged by the refused presses (no orphan asset, no second draft)
    expect((await loadProjectAssets(tmp.root)).map((x) => [x.asset.id, x.asset.status])).toEqual([[asset.id, 'retired']]);
    // different words are a new request with a new asset id, and the art director is told the rejected wording
    const [other] = await recordAssetRequests(tmp.root, [{ ...STICKER, prompt: STICKER.prompt.replace('sparkle', 'star') }], { canvas: 'reel', now: () => NOW });
    expect(other).toMatchObject({ status: 'pending' });
    expect(other!.id).not.toBe(req.id);
    const world = await artWorldFor(tmp.root, { manifest: { rigTier: {}, templates: [], glossary: null }, library: [], libraryDir: tmp.dir, dir: tmp.dir } as never);
    expect(world.rejectedPrompts).toEqual([STICKER.prompt]);
  });
  it('two presses at once: Codex runs once, the second press is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeCodex();
    const slow = vi.fn(async (p: string, w: number, h: number) => {
      await gate;
      return inner(p, w, h);
    });
    const req = await pending();
    const first = makeRequestedAsset(tmp.root, req.id, { ...options(inner), codexImage: slow });
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    await expect(makeRequestedAsset(tmp.root, req.id, { ...options(inner), codexImage: slow })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'conflict'));
    release();
    await expect(first).resolves.toMatchObject({ request: { status: 'made' } });
    expect(slow).toHaveBeenCalledTimes(1);
  });
  it('the model label never passes the CLI version off as an image model', () => {
    expect(codexModelLabel('codex-cli 1.2.3')).toBe('codex-cli 1.2.3; image model not reported');
    expect(codexModelLabel('1.2.3')).toBe('codex-cli 1.2.3; image model not reported');
    expect(codexModelLabel('')).toBe('codex-cli (version unknown); image model not reported');
  });
  it('the API actions parse, and the service refuses an agent actor with 403', async () => {
    expect(parseAction({ action: 'asset.make', requestId: 'ar-0123456789ab' })).toEqual({ action: 'asset.make', requestId: 'ar-0123456789ab' });
    expect(parseAction({ action: 'asset.approve', assetId: 'bg-ai-0123456789ab', name: 'Pat Example', allowedUses: ['organic'] })).toMatchObject({ action: 'asset.approve' });
    expect(parseAction({ action: 'asset.reject', assetId: 'bg-ai-0123456789ab', name: 'Pat Example' })).toMatchObject({ action: 'asset.reject' });
    expect(() => parseAction({ action: 'asset.make', requestId: '../x' })).toThrow();
    expect(() => parseAction({ action: 'asset.approve', assetId: '../x', name: 'Pat' })).toThrow();
    const a = await made();
    const project: ServiceProject = { id: 'example-project', handle: '@example', contentDir: tmp.contentDir, timeZone: 'UTC', pack: undefined } as unknown as ServiceProject;
    _setServiceDeps({ executors: defaultExecutors() });
    try {
      await expect(handleAction(project, { email: 'agent:art-director' }, { action: 'asset.approve', assetId: a.id, name: 'Pat Example' })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
      await expect(handleAction(project, { email: 'owner@example.test' }, { action: 'asset.approve', assetId: a.id, name: 'mock' })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'forbidden'));
      const ok = await handleAction(project, { email: 'owner@example.test' }, { action: 'asset.approve', assetId: a.id, name: 'Pat Example' });
      expect(ok).toMatchObject({ status: 200, body: { asset: { status: 'approved' } } });
      await expect(handleAction(project, { email: 'owner@example.test' }, { action: 'asset.make', requestId: 'ar-ffffffffffff' })).rejects.toSatisfy((x: unknown) => isPostmakerError(x, 'not_found'));
    } finally {
      _setServiceDeps({});
    }
  });
});

describe('prompt lint', () => {
  const names = ['Brandly'];
  it.each([
    ['a brand name from the pack', 'a phone showing the brandly game screen on a desk, no words', 'prompt.brand'],
    ['quoted text', 'a sign above a door that says "open now", warm light', 'prompt.text-in-image'],
    ['guillemet-quoted text', 'a banner with «hello» on it', 'prompt.text-in-image'],
    ['asking for words in the image', 'a poster with a big headline and the slogan of the day', 'prompt.text-in-image'],
    ['more than 600 characters', `a calm room ${'with soft light '.repeat(45)}`, 'prompt.too-long'],
    ['a capitalised name', 'a cat sitting next to a Zorblax console', 'prompt.name'],
    ['a third-party style', 'a forest in the style of a famous animation studio', 'prompt.third-party'],
    ['a real person', 'a portrait of a celebrity smiling at the camera', 'prompt.real-person'],
    ['a trademark sign', 'a soda can™ on a table', 'prompt.third-party'],
  ])('refuses %s', (_label, prompt, code) => {
    expect(lintImagePrompt(prompt, { names }).map((i) => i.code)).toContain(code);
  });
  it('passes plain descriptions, including the negations a prompt should carry and every prompt the planner writes', () => {
    expect(lintImagePrompt('A cosy living room at night, warm lamp light, flat illustrated style, no text, no words or logos.', { names })).toEqual([]);
    expect(lintImagePrompt(STICKER.prompt, { names })).toEqual([]);
    expect(lintImagePrompt(BACKGROUND.prompt, { names })).toEqual([]);
    const plan = planScenes(artContext({ recipe: { shape: '9:16', beats: [{ id: 'b01', segment: 'hook' }, { id: 'b02', segment: 'demo' }] } as unknown as Recipe, params: {}, byPort: {}, now: () => NOW }, { library: [], rigs: {}, template: { segments: [{ id: 'hook', shot: 'wide', require: ['stickers>=5'] }, { id: 'demo', shot: 'insert', require: ['phoneInsert'] }], cast: { lead: 'x' } }, names }));
    expect(plan.newAssets.length).toBeGreaterThanOrEqual(6);
    for (const r of plan.newAssets) expect(lintImagePrompt(r.prompt, { names }), r.prompt).toEqual([]);
  });
  it('a request whose prompt fails the lint is kept as refused and can never be made', async () => {
    const spy = fakeCodex();
    const [r] = await recordAssetRequests(tmp.root, [{ ...STICKER, prompt: 'a sticker that says "wow"' }], { canvas: 'reel', now: () => NOW });
    expect(r).toMatchObject({ status: 'refused' });
    expect(missingAssetRow(r!, { enabled: true, reason: '' })).toMatchObject({ disabled: true });
    await expect(makeRequestedAsset(tmp.root, r!.id, options(spy))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'validation'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the Codex child environment and the network guard', () => {
  it('carries no Signal or vendor key: only the allow-list and CODEX_HOME (env snapshot)', () => {
    const keys = { SIGNAL_TOKEN_KEY: 'tok-0123456789abcdef', SIGNAL_ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef', ANTHROPIC_API_KEY: 'sk-ant-fedcba9876543210', OPENAI_API_KEY: 'sk-openai-0123456789ab', ELEVENLABS_API_KEY: 'el-0123456789abcdef', HF_API_KEY_SECRET: 'hfs-0123456789abcdef', R2_SECRET_ACCESS_KEY: 'r2-0123456789abcdef', UPLOAD_POST_API_KEY: 'up-0123456789abcdef', SIGNAL_FEATURE_POSTMAKER: '1' };
    const source = { PATH: '/usr/bin:/bin', HOME: '/home/example', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/', CODEX_HOME: '/home/example/.codex', ...keys } as unknown as NodeJS.ProcessEnv;
    const env = codexChildEnv(source);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/example', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/', CODEX_HOME: '/home/example/.codex' });
    const values = Object.values(env).join('\n');
    for (const v of Object.values(keys)) if (v.length > 2) expect(values).not.toContain(v);
    expect(Object.keys(env).every((k) => (CLI_ENV_ALLOW as readonly string[]).includes(k) || k === 'CODEX_HOME')).toBe(true);
    expect(Object.keys(env).some((k) => k.startsWith('SIGNAL_'))).toBe(false);
  });
  it('the asset module hands Codex only the prompt and the size, never a file path', () => {
    const src = readFileSync(path.join(__dirname, '../../../lib/studio/postmaker/executors/art-assets.ts'), 'utf8');
    expect(src).toMatch(/\(o\.codexImage \?\? realCodexImage\)\(req\.prompt, req\.size\.w, req\.size\.h, \{ alpha: requestAlpha\(req\.kind\) \}\)/);
    expect(src).not.toMatch(/\bfetch\(|https?:\/\//);
  });
  it('no fetch, socket or child process was attempted by this file', () => {
    expect(networkGuardLog()).toEqual([]);
  });
});
