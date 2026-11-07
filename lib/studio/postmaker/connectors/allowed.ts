// The single decision point "may this connector run live now?", evaluated at the moment of each call and never cached
// across calls, plus the Connections status line derived from the same checks.
//
// One decision point: a blocked binding → the Post maker kill switch (SIGNAL_POSTMAKER_PAUSED) → the connector's
// feature switch (signal.config.json) → its key → every gate ref it names → attendance. Any failure means the run uses
// the mock, unless the node says requireLive, in which case the call is refused (403, or 409 "Needs you: press Run"
// for attendance).
//
// Gate refs:
// - `approval:<name>` reuses an existing switch: the agents, agentsApiKey and higgsfield switches and the account's
//   Codex images setting (DEFAULT_APPROVALS in index.ts).
// - `vendor:<id>` and `terms:<topic>` pass once you accepted that service's terms: Connections asks once, when you
//   turn the paid service on, and keeps the time in signal.config.json (postmaker.acceptedTerms).
// The optional per-connector day cap is postmaker.dayCapUsd in signal.config.json (vendorDayCapUsd).
import { t } from '@/app/studio/copy/en';
import { readConfig } from '@/lib/server/signalConfig';
import { PostmakerError } from '../errors';
import type { ConnectorAllowed, ConnectorStatus, InvokeCtx } from '../types';
import { assertWithinCeiling, type RegisteredConnector } from './base';
import { featureOn, isFeature, postmakerPaused } from './features';

export type RefKind = 'vendor' | 'terms' | 'approval';
export interface RefResult {
  ok: boolean;
  kind: RefKind;
  reason: string;
}

/** What a ref check may know about the connector asking. */
export interface RefContext {
  /** The environment variable names the connector reads its key from (its settings group); [] = no key. */
  keyEnv?: readonly string[];
}

export interface GateBackend {
  refOk(ref: string, now: number, ctx?: RefContext): Promise<RefResult>;
}

const kindOf = (ref: string): RefKind | null => {
  const k = ref.split(':')[0];
  return k === 'vendor' || k === 'terms' || k === 'approval' ? k : null;
};

/** The refs of a connector that need a one-time terms acceptance (its `vendor:` and `terms:` refs). */
export const termsRefs = (c: Pick<RegisteredConnector, 'gates'>): string[] => c.gates.filter((g) => kindOf(g) === 'vendor' || kindOf(g) === 'terms');

export interface BackendDeps {
  /** Existing approvals by name (`approval:<name>` refs); a missing name is closed. */
  approvals?: Record<string, () => Promise<boolean>>;
  /** The refs whose terms you accepted (ref → ISO time). Default: signal.config.json postmaker.acceptedTerms. */
  acceptedTerms?: () => Promise<Record<string, string>>;
}

/** The gate backend: `approval:` refs read the existing switches, `vendor:` and `terms:` refs the accepted terms. */
export function gateBackend(deps: BackendDeps = {}): GateBackend {
  const accepted = deps.acceptedTerms ?? (async () => (await readConfig()).postmaker.acceptedTerms);
  return {
    async refOk(ref) {
      const kind = kindOf(ref);
      const name = ref.slice(ref.indexOf(':') + 1);
      if (!kind || !name) return { ok: false, kind: 'vendor', reason: 'unknown gate' };
      if (kind === 'approval') {
        const fn = deps.approvals?.[name];
        let ok = false;
        try {
          ok = fn ? await fn() : false;
        } catch {
          ok = false;
        }
        return { ok, kind, reason: ok ? '' : 'not approved' };
      }
      const at = (await accepted())[ref];
      return typeof at === 'string' && at ? { ok: true, kind, reason: '' } : { ok: false, kind, reason: 'terms not accepted' };
    },
  };
}

/**
 * The connector's own day cap in USD: signal.config.json postmaker.dayCapUsd[<connector id>], read at the moment of
 * the reservation. null when none is set (then only the run cap and the project day ceiling apply).
 */
export async function vendorDayCapUsd(c: Pick<RegisteredConnector, 'id'>, o: { readCaps?: () => Promise<Record<string, number>> } = {}): Promise<number | null> {
  const caps = o.readCaps ? await o.readCaps() : (await readConfig()).postmaker.dayCapUsd;
  const v = caps[c.id];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Existing approvals the registry registers once (index.ts), so status() resolves `approval:<name>` refs. */
let registeredApprovals: Record<string, () => Promise<boolean>> = {};
export function registerApprovals(m: Record<string, () => Promise<boolean>>): void {
  registeredApprovals = { ...m };
}

/** The gate backend with the registered approvals. */
export const defaultBackend = (deps: BackendDeps = {}): GateBackend => gateBackend({ approvals: registeredApprovals, ...deps });

// ---- the decision ------------------------------------------------------------------------------------------------

export type Why = 'blocked' | 'paused' | 'off' | 'key' | 'gate' | 'terms' | 'attendance';
export interface Decision extends ConnectorAllowed {
  why: Why | null;
}

export interface AllowedOptions {
  /** The run was started by a button press in an open app session. */
  attended?: boolean;
  backend?: GateBackend;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export async function connectorAllowed(c: RegisteredConnector, o: AllowedOptions = {}): Promise<Decision> {
  const env = o.env ?? process.env;
  const no = (state: Decision['state'], why: Why, reason: string): Decision => ({ live: false, state, why, reason });
  if (c.blocked) return no('not-allowed', 'blocked', c.blocked.reason);
  if (postmakerPaused(env)) return no('off', 'paused', 'Post maker is paused.');
  if (!isFeature(c.feature) || !(await featureOn(c.feature, env))) return no('off', 'off', `${c.title} is off.`);
  if (!(await c.keyPresent())) return no('needs-key', 'key', t('notice.serviceNeedsKey', { service: c.title }));
  const backend = o.backend ?? defaultBackend();
  const now = o.now ?? Date.now();
  for (const ref of c.gates) {
    const r = await backend.refOk(ref, now, { keyEnv: c.keyEnv ?? [] });
    if (!r.ok) return r.kind === 'approval' ? no('not-allowed', 'gate', 'Turn on its switch in Connections.') : no('not-allowed', 'terms', 'Accept its terms in Connections.');
  }
  if (c.attendance === 'attended-only' && o.attended !== true) return no('not-allowed', 'attendance', t('connector.pressRun'));
  return { live: true, state: 'ready', why: null, reason: '' };
}

/** The Connections row state: the same checks, plus install and sign-in, in the order a person fixes them. */
export async function connectorStatus(c: RegisteredConnector, o: AllowedOptions = {}): Promise<ConnectorStatus> {
  const env = o.env ?? process.env;
  const service = c.title;
  if (c.blocked) return { state: 'not-allowed', line: c.blocked.line, fix: null };
  if (postmakerPaused(env)) return { state: 'off', line: t('connector.paused'), fix: 'connections' };
  let probe: Awaited<ReturnType<NonNullable<RegisteredConnector['probe']>>> | null = null;
  if (c.probe) {
    try {
      probe = await c.probe();
    } catch {
      return { state: 'error', line: t('connector.checkFailed', { service }), fix: null };
    }
    if (!probe.installed) return { state: 'not-installed', line: t('connector.notInstalled', { service }), fix: 'install' };
  }
  const version = probe?.version ?? null;
  if (!isFeature(c.feature) || !(await featureOn(c.feature, env))) return { state: 'off', line: t('connector.offMock', { service }), fix: 'connections', version };
  if (!(await c.keyPresent())) return { state: 'needs-key', line: t('notice.serviceNeedsKey', { service }), fix: 'connections', version };
  if (probe?.signedIn === false) return { state: 'needs-sign-in', line: t('connector.needsSignIn', { service }), fix: 'sign-in', version };
  const backend = o.backend ?? defaultBackend();
  const now = o.now ?? Date.now();
  for (const ref of c.gates) {
    const r = await backend.refOk(ref, now, { keyEnv: c.keyEnv ?? [] });
    if (!r.ok) return { state: 'not-allowed', line: t(r.kind === 'approval' ? 'connector.notAllowed' : 'connector.notAllowedTerms'), fix: 'gate', version };
  }
  const line = c.costModel.billing === 'vendor-key' ? t('connector.readyPaid') : c.costModel.billing !== 'none' ? t('connector.readyPlan') : c.kind === 'local' ? t('connector.readyLocal') : t('connector.readyFree');
  return { state: 'ready', line, fix: null, version };
}

export interface CallOptions extends AllowedOptions {
  /** The node refuses to fall back to mock: the run pauses with "Not allowed yet" instead. */
  requireLive?: boolean;
}
export interface CallResult<Res> {
  mode: 'live' | 'mock';
  result: Res;
  decision: Decision;
}

/**
 * Calls a connector through the decision point: live → invoke (after the per-call ceiling), otherwise mock, or a
 * refusal when the node requires live output. Every event text goes through the connector's redact().
 */
export async function callConnector<Req, Res>(c: RegisteredConnector<Req, Res>, req: Req, ctx: InvokeCtx, o: CallOptions = {}): Promise<CallResult<Res>> {
  const decision = await connectorAllowed(c as RegisteredConnector, o);
  const emit = (kind: string, text: string) => ctx.onEvent({ kind, text: c.redact(text) });
  if (decision.live) {
    assertWithinCeiling(c.title, c.costModel, c.estimate(req));
    emit('connector', `${c.title}: live call.`);
    return { mode: 'live', result: await c.invoke(req, ctx), decision };
  }
  if (o.requireLive) {
    if (decision.why === 'attendance') throw new PostmakerError(409, 'needs_you', decision.reason);
    throw new PostmakerError(403, 'forbidden', `${c.title}: ${decision.reason}`);
  }
  emit('connector', `${c.title}: ${decision.reason} Runs as mock.`);
  return { mode: 'mock', result: await c.mock(req, ctx), decision };
}
