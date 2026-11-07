// The executor registry the Post maker service runs:
// - `script` and `post-copy` call the claude-cli connector through `connectorCall` (callConnector with
//   requireLive, so allowed.ts stays the single decision point; mock mode never calls). Vision stays refused: the
//   registry's claude-cli connector is built without `allowVision`.
// - `check` reads the store (lineage, measurements and preview strip), the sign-offs kept outside the
//   versions, platform reserves and the bundled fonts; its CLI reviewer is the same claude-cli connector.
// - `captions`, `compose`, `mix`, `render` run on the render chain when Remotion is installed for the render
//   child; without it these kinds keep their fakes.
// - the pack's claims policy goes to the script and post-copy claims lint, and the pack template tempo to
//   the script's tempo contract (pack/policy.ts); a pack that declares claims never runs with a null policy.
// - `art` plans scenes from the pack library (pack + project assets), rigs and template, through the art
//   director when Claude agents are live; `newAssets` are recorded as pending requests and never generated here
//   (Codex runs only from an attended "Make with Codex" press, executors/art-assets.ts). Without a pack it keeps
//   its fake. Registered only when the caller passes `loadPack`.
// - the default creative chain: with `loadPack`, `motion` (the animator), `music` (the sound designer,
// ) and the SFX cues on `mix` run on the pack (executors/creative-world.ts), Tier A and C rigs load through
// loader for art and motion, and compose hands StorySpine the rigs, stills and backgrounds it draws. The
//   vendor kinds (voice, lip-sync, b-roll) keep their fakes until their gates open.
// No vendor call happens while building the registry.
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import type { Billing } from '../claude-agent';
import { reservesFor } from './checks/renderMeasurements';
import { callConnector } from './connectors/allowed';
import type { RegisteredConnector } from './connectors/base';
import type { LlmRequest, LlmResult } from './connectors/cli';
import { connectorById } from './connectors';
import { connectorCall } from './executors/agent';
import type { CliReviewer } from './executors/check';
import { defaultExecutors } from './executors';
import { canvasOfShape } from './executors/art';
import { artWorldFor, recordAssetRequests, type RigLoader } from './executors/art-assets';
import { makeFakeExecutors } from './executors/fakes';
import { packWorlds, type PackWorlds } from './executors/creative-world';
import type { FakeConfig } from './executors/fakes';
import type { RenderChainDeps } from './executors/render-chain';
import type { ExecutorRegistry } from './executors/types';
import type { LoadedPack } from './pack/load';
import type { PackPolicy } from './pack/policy';
import { resolveFonts } from './render/fonts';
import type { RenderChain } from './render/renderer';
import { signoffsDep } from './signoffs';
import { getBytes } from './store/objects';
import type { InvokeCtx } from './types';

export interface WiringOptions {
  root: string;
  /** The render child chain; null = the render-chain kinds keep their fakes. */
  render: RenderChain | null;
  /** The claude-cli connector; default: the registry's (vision refused). null = no agent calls at all. */
  claudeCli?: RegisteredConnector<LlmRequest, LlmResult> | null;
  billing?: Billing;
  fakes?: FakeConfig;
  /** Overrides for the render-chain deps (tests: `ffmpeg: null`, a temp work folder). */
  renderDeps?: Omit<Partial<RenderChainDeps>, 'chain'>;
  /** The project pack's claims policy and template tempo (pack/policy.ts `packPolicy`); null = no pack. */
  pack?: PackPolicy | null;
  /** Loads the project pack for the `art` step (null = no pack: the step keeps its fake). Omitted = fake. */
  loadPack?: () => Promise<LoadedPack | null>;
  /** The rig loader the art step uses for Tier A and C characters; default loader through the pack. */
  loadRig?: RigLoader;
}

const agentCtx = (): Omit<InvokeCtx, 'signal'> => ({ runId: 'postmaker', nodeId: 'agent', workDir: os.tmpdir(), onEvent: () => {}, idempotencyKey: `pm-${randomBytes(6).toString('hex')}`, deps: {} });

/** The check's CLI reviewer over the claude-cli connector (live only; a refused call moves the chain on). */
export function cliReviewerOf(c: RegisteredConnector<LlmRequest, LlmResult>): CliReviewer {
  return async (req) => {
    const out = await callConnector(c, { prompt: req.prompt, kind: 'check', maxTurns: req.maxTurns, budgetUsd: req.budgetUsd, model: req.model }, { ...agentCtx(), signal: new AbortController().signal }, { requireLive: true });
    return { text: out.result.text, costUsd: out.result.costUsd, model: out.result.model };
  };
}

/** The bundled faces the render may use (core font lock); undefined when the lock cannot be read (fonts not audited). */
function bundledFonts(): { family: string; sha256: string }[] | undefined {
  try {
    return resolveFonts().fonts.map((f) => ({ family: f.family, sha256: f.sha256 }));
  } catch {
    return undefined;
  }
}

/** The `art` step's deps: the world from the pack, the request recorder, the fake when there is no pack. */
function artDeps(o: WiringOptions, loadPack: () => Promise<LoadedPack | null>, worlds: PackWorlds) {
  return {
    billing: o.billing,
    fallback: makeFakeExecutors(o.fakes).art,
    world: async () => {
      const pack = await loadPack();
      return pack ? artWorldFor(o.root, pack, { loadRig: o.loadRig ?? worlds.artRig }) : null;
    },
    onRequests: (reqs: Parameters<typeof recordAssetRequests>[1], i: { recipe: { id: string; shape: Parameters<typeof canvasOfShape>[0] }; node: { id: string }; runId: string; now: () => number }, world: { names: string[] }) =>
      recordAssetRequests(o.root, reqs, { recipeId: i.recipe.id, nodeId: i.node.id, runId: i.runId, canvas: canvasOfShape(i.recipe.shape), names: world.names, now: i.now }),
  };
}

/** The motion, music and SFX deps on the pack (fakes stay the fallback without a pack). */
function soundAndMotionDeps(o: WiringOptions, worlds: PackWorlds) {
  const fakes = makeFakeExecutors(o.fakes);
  return {
    motion: { billing: o.billing, world: worlds.motion, fallback: fakes.motion },
    music: { billing: o.billing, world: worlds.music, fallback: fakes.music, ...(o.renderDeps && 'ffmpeg' in o.renderDeps ? { ffmpeg: o.renderDeps.ffmpeg } : {}) },
    sfx: { library: worlds.sfx },
  };
}

export function serviceExecutors(o: WiringOptions): ExecutorRegistry {
  const cli = o.claudeCli === undefined ? (connectorById('claude-cli') as RegisteredConnector<LlmRequest, LlmResult> | null) : o.claudeCli;
  const call = cli ? connectorCall(cli, agentCtx()) : null;
  const worlds = o.loadPack ? packWorlds(o.root, o.loadPack) : null;
  return defaultExecutors({
    fakes: o.fakes,
    agents: {
      call,
      script: { billing: o.billing, claims: o.pack?.claims ?? null, ...(o.pack?.tempo ? { tempo: o.pack.tempo } : {}) },
      postCopy: { billing: o.billing, claims: o.pack?.claims ?? null },
      ...(o.loadPack && worlds ? { art: artDeps(o, o.loadPack, worlds), ...soundAndMotionDeps(o, worlds) } : {}),
    },
    check: {
      root: o.root,
      signoffs: signoffsDep(o.root),
      reserves: reservesFor,
      fonts: bundledFonts(),
      cli: cli ? cliReviewerOf(cli) : null,
      agentBilling: o.billing,
    },
    ...(o.render ? { render: { readObject: (sha: string) => getBytes(o.root, sha), ...(worlds ? { art: worlds.art } : {}), ...o.renderDeps, chain: o.render } } : {}),
  });
}
