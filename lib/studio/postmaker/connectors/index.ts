// Post maker connector registry: every provider behind one interface, looked up by id or capability,
// with the single decision point (allowed.ts) and the Connections rows. Nothing here calls a vendor: rows read
// switches, keys and records; test() of every connector is free by construction.
import { claudeAgentsAllowed } from '../../claude-agent';
import { codexImagesAllowed } from '../../codex';
import { acceptTerms, readConfig, setFeature } from '@/lib/server/signalConfig';
import { higgsfieldAllowed } from '../../higgsfield';
import { teamAllowed } from '../../team/runtime';
import { PostmakerError } from '../errors';
import type { CapabilityId, ConnectorRow, StepKind } from '../types';
import { SITE_BINDINGS } from '../browser-agent/sites/suno';
import { connectorStatus, registerApprovals, termsRefs, type AllowedOptions } from './allowed';
import { azureSpeech } from './azure-speech';
import type { RegisteredConnector } from './base';
import { browserAgentConnector } from './browser-agent';
import { makeCliConnectors } from './cli';
import { elevenlabs } from './elevenlabs';
import { featureOn, isFeature, type FeatureId } from './features';
import { higgsfieldImage, higgsfieldVideo } from './higgsfield';
import { hedra, sync } from './lipsync';
// A namespace import on purpose: webpack rewrites calls of a named `createRequire` import and, with a non-literal
// argument, bundles `.resolve(id)` as an empty context that always throws, so Remotion read as not installed.
import * as nodeModule from 'node:module';
import path from 'node:path';
import { renderServiceDir } from '../render/fonts';
import { defaultRenderChain, remotionRenderer } from '../render/renderer';
import { makeFfmpeg, makeFigma, makeRemotion } from './local';
import { customerUpload, elevenlabsMusic, packMusic } from './music';

export { callConnector, connectorAllowed, connectorStatus, defaultBackend, gateBackend, termsRefs, vendorDayCapUsd } from './allowed';
export { FEATURES, featureEnvName, POSTMAKER_PAUSED_ENV } from './features';

/** Existing approvals Post maker reuses (`approval:<name>` gate refs). */
export const DEFAULT_APPROVALS: Record<string, () => Promise<boolean>> = {
  'claude-cli-agents': async () => (await claudeAgentsAllowed()).enabled,
  'agent-team': async () => (await teamAllowed()).enabled,
  'codex-images': async () => (await codexImagesAllowed()).enabled,
  'higgsfield-api': async () => (await higgsfieldAllowed()).enabled,
};
registerApprovals(DEFAULT_APPROVALS);

/** What each step kind may call (kinds). Kinds without an entry run locally with no connector. */
export const KIND_CAPABILITIES: Partial<Record<StepKind, CapabilityId[]>> = {
  analyse: ['llm.vision', 'llm.text'],
  script: ['llm.text'],
  'narration-text': ['llm.text'],
  voice: ['tts'],
  art: ['image.generate', 'image.export'],
  broll: ['video.i2v'],
  lipsync: ['lipsync'],
  music: ['music.import', 'music.generate'],
  motion: ['llm.text'],
  compose: ['render.video'],
  mix: ['render.audio', 'audio.loudness'],
  render: ['render.video'],
  'post-copy': ['llm.text'],
  check: ['llm.text', 'llm.vision'],
};

/** The render child injected into the remotion connector when Remotion is installed (the render workspace). */
function remotionConnector() {
  const chain = defaultRenderChain();
  return chain ? makeRemotion({ render: remotionRenderer(chain), resolve: (id) => nodeModule.createRequire(path.join(renderServiceDir(), 'package.json')).resolve(id) }) : makeRemotion();
}

export function buildRegistry(deps: Parameters<typeof makeCliConnectors>[0] = {}): RegisteredConnector[] {
  const cli = makeCliConnectors(deps);
  return [
    cli.claudeCli,
    cli.agentSdk,
    cli.codex,
    makeFigma(),
    higgsfieldImage,
    higgsfieldVideo,
    elevenlabs,
    azureSpeech,
    sync,
    hedra,
    elevenlabsMusic,
    packMusic,
    customerUpload,
    ...SITE_BINDINGS.map((b) => browserAgentConnector(b)),
    remotionConnector(),
    makeFfmpeg(),
  ] as RegisteredConnector[];
}

export const CONNECTORS: readonly RegisteredConnector[] = buildRegistry();

export const connectorById = (id: string, list: readonly RegisteredConnector[] = CONNECTORS) => list.find((c) => c.id === id) ?? null;

export const connectorsFor = (cap: CapabilityId, list: readonly RegisteredConnector[] = CONNECTORS) => list.filter((c) => c.capabilities.some((k) => k.id === cap));

/** A node's connector chain may name only connectors with one of its kind's capabilities; 'mock' may end it. */
export function validateChain(kind: StepKind, chain: readonly string[], list: readonly RegisteredConnector[] = CONNECTORS): string[] {
  const caps = KIND_CAPABILITIES[kind] ?? [];
  const errors: string[] = [];
  chain.forEach((id, i) => {
    if (id === 'mock') {
      if (i !== chain.length - 1) errors.push('mock must be last');
      return;
    }
    const c = connectorById(id, list);
    if (!c) errors.push(`${id}: unknown connector`);
    else if (!c.capabilities.some((k) => caps.includes(k.id))) errors.push(`${id}: cannot do ${kind}`);
  });
  return errors;
}

/**
 * Feature ids that are one connector's own switch (shown as a switch on its row). 'postmaker' is the tab itself.
 * For claude-cli ('agents'), agent-sdk ('agentsApiKey') and higgsfield-image ('higgsfield') it is the same switch
 * the Studio's agents and Higgsfield formats use.
 */
export const hasOwnSwitch = (c: RegisteredConnector) => isFeature(c.feature) && c.feature !== 'postmaker';

export async function connectorRow(c: RegisteredConnector, status: ConnectorRow['status']): Promise<ConnectorRow> {
  const { unit, usdPerUnit, verified, source, readAt } = c.costModel;
  return { id: c.id, title: c.title, group: 'making', status, switchOn: isFeature(c.feature) && (await featureOn(c.feature)), attendance: c.attendance, costModel: { unit, usdPerUnit, verified, source, readAt } };
}

/** The Making rows for GET /api/studio/connections: state only, never a key value. */
export async function connectorRows(o: AllowedOptions & { list?: readonly RegisteredConnector[] } = {}): Promise<ConnectorRow[]> {
  const list = o.list ?? CONNECTORS;
  return Promise.all(list.filter((c) => c.group === 'making').map(async (c) => connectorRow(c, await connectorStatus(c, o))));
}

/** Runs a connector's free test; the answer text is redacted. */
export async function testConnector(id: string, list: readonly RegisteredConnector[] = CONNECTORS) {
  const c = connectorById(id, list);
  if (!c) throw new PostmakerError(404, 'not_found', 'Unknown service.');
  const r = await c.test();
  return { ok: r.ok, text: c.redact(r.text), costUsd: 0 as const };
}

/** Thrown when a paid service is turned on before its terms were accepted; the screen asks and sends `acceptTerms`. */
export const TERMS_NEEDED = 'terms-needed';

/**
 * Turns a connector's own switch on or off in signal.config.json. Turning a paid service on the first time needs
 * `acceptTerms: true` (the one-time "you accept <service> terms" confirmation); the acceptance is kept in
 * signal.config.json and is not asked again. A blocked binding cannot be switched on.
 */
export async function switchConnector(id: string, on: boolean, o: { acceptTerms?: boolean; list?: readonly RegisteredConnector[]; now?: number } = {}): Promise<RegisteredConnector> {
  const c = connectorById(id, o.list ?? CONNECTORS);
  if (!c) throw new PostmakerError(404, 'not_found', 'Unknown service.');
  if (!hasOwnSwitch(c)) throw new PostmakerError(400, 'validation', `${c.title} has no switch.`);
  if (on && c.blocked) throw new PostmakerError(403, 'forbidden', `${c.title}: ${c.blocked.reason}`);
  if (on) {
    const refs = termsRefs(c);
    if (refs.length) {
      const accepted = (await readConfig()).postmaker.acceptedTerms;
      const missing = refs.filter((r) => !accepted[r]);
      if (missing.length && o.acceptTerms !== true) throw new PostmakerError(409, TERMS_NEEDED, `Turning on ${c.title} means you accept ${c.title}'s terms. Confirm to go on.`);
      if (missing.length) await acceptTerms(missing, new Date(o.now ?? Date.now()).toISOString());
    }
  }
  await setFeature(c.feature as FeatureId, on);
  return c;
}
