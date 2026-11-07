// Connections "Making" rows. The connectors come from GET /api/studio/connections (`making`, the connectors backend);
// their shape is the registry's ConnectorRow, type-imported from lib/studio/postmaker/types. A malformed row is
// dropped rather than half-shown. Only when the payload has no `making` field at all does the screen fall back to
// fallbackMaking(): every vendor Off or Not set up, so nothing can imply that a connector is live.
// Prices are left unknown on purpose; the backend owns the cost models and their sources.
//
// The Making group shows ONE row per capability (voice, lip-sync, music, video, images,
// agents, rendering). A row carries its primary connector's state (the first connector of that step's default
// chain); the alternatives and their switches sit inside the row's drawer. capabilityGroups() builds them.
import { t } from './copy/en';
import type { ConnectorRow, ConnectorState } from '@/lib/studio/postmaker/types';
import type { StatusWord } from './ui';

export type { ConnectorRow };

/** Status-only rows: the local renderer and audio tool (no switch, no key). */
export const LOCAL_CONNECTORS: readonly string[] = ['remotion', 'ffmpeg'];
/** Rows the app already knows from older services; without `making` their state comes from those checks. */
export const KNOWN_CONNECTORS: readonly string[] = ['claude-cli', 'codex', 'higgsfield-image', 'figma'];

/** The app-settings key group each connector keeps its keys in; null = no key in Signal. */
export const KEY_GROUP: Record<string, string | null> = {
  'agent-sdk': 'anthropic',
  remotion: null,
  'higgsfield-image': 'higgsfield',
  'higgsfield-video': 'higgsfield',
  elevenlabs: 'elevenlabs',
  'elevenlabs-music': 'elevenlabs',
  'azure-speech': 'azure-speech',
  sync: 'sync',
  hedra: 'hedra',
};

const row = (id: string, title: string, state: ConnectorState, line: string, attendance: ConnectorRow['attendance'] = 'any'): ConnectorRow => ({
  id,
  title,
  group: 'making',
  status: { state, line, fix: state === 'not-allowed' ? 'gate' : state === 'not-installed' ? 'install' : 'connections' },
  switchOn: false,
  attendance,
  costModel: { unit: 'none', usdPerUnit: null, verified: false, source: null, readAt: null },
});

/** The 16 Making connectors the registry sends, in registry order. */
export function fallbackMaking(): ConnectorRow[] {
  const off = t('connections.line.offMock');
  return [
    row('claude-cli', 'Claude Code', 'off', t('connections.line.off')),
    row('agent-sdk', 'Claude API', 'off', off),
    row('codex', 'Codex', 'off', t('connections.line.off'), 'attended-only'),
    row('figma', 'Figma', 'off', t('connections.line.off')),
    row('higgsfield-image', 'Higgsfield images', 'off', off),
    row('higgsfield-video', 'Higgsfield video', 'off', off),
    row('elevenlabs', 'ElevenLabs', 'off', off),
    row('azure-speech', 'Azure Speech', 'off', off),
    row('sync', 'Sync', 'off', off),
    row('hedra', 'Hedra', 'off', off),
    row('elevenlabs-music', 'ElevenLabs Music', 'off', off),
    row('pack-music', 'Pack music', 'off', off),
    row('owner-upload', 'Your music', 'off', off),
    row('browser-agent:suno', 'Suno', 'not-allowed', t('connections.line.terms'), 'attended-only'),
    row('remotion', 'Remotion renderer', 'not-installed', t('connections.line.notChecked')),
    row('ffmpeg', 'ffmpeg', 'not-installed', t('connections.line.notChecked')),
  ];
}

/** How one row reads: the dictionary word for its pill, its state line, and whether the line is amber. */
export function rowView(r: Pick<ConnectorRow, 'status' | 'switchOn'>): { pill: StatusWord; line: string; amber: boolean } {
  const s = r.status;
  // A switch turned on with no key reads "Key missing", in amber (never red).
  if (s.state === 'needs-key') return { pill: r.switchOn ? 'Needs you' : 'Off', line: r.switchOn ? t('connections.line.keyMissing') : s.line, amber: r.switchOn };
  const pill: Record<ConnectorState, StatusWord> = {
    ready: 'Ready',
    off: 'Off',
    'needs-key': 'Off',
    'not-allowed': 'Off',
    'needs-sign-in': 'Needs you',
    error: 'Needs you',
    'not-installed': 'Not set up',
  };
  return { pill: pill[s.state], line: s.line, amber: s.state === 'needs-sign-in' || s.state === 'error' };
}

/**
 * Connectors on the shared 'postmaker' feature id: they have no switch of their own and connector.switch answers 400
 * for them. Mirrors the server's hasOwnSwitch(); a registry test keeps the two in step.
 */
export const NO_OWN_SWITCH: readonly string[] = ['codex', 'figma', 'pack-music', 'owner-upload', ...LOCAL_CONNECTORS];

/** The feature switches of Post maker in signal.config.json: the tab itself, then one per paid service. */
export const POSTMAKER_FEATURES: readonly string[] = ['postmaker', 'postmakerElevenlabs', 'postmakerAzureSpeech', 'postmakerSync', 'postmakerHedra', 'postmakerHiggsfieldVideo', 'postmakerElevenlabsMusic', 'browserAgent'];
/** The Making connectors whose own switch is one of those paid-service features, in the same order. */
export const FEATURE_CONNECTORS: readonly string[] = ['elevenlabs', 'azure-speech', 'sync', 'hedra', 'higgsfield-video', 'elevenlabs-music', 'browser-agent:suno'];
/** The Features group's paid-service rows: the same connector rows the Making drawers hold, in feature order. */
export function featureRowsOf(rows: readonly ConnectorRow[]): ConnectorRow[] {
  return FEATURE_CONNECTORS.map((id) => rows.find((r) => r.id === id)).filter((r): r is ConnectorRow => Boolean(r));
}

/** Whether a row gets an on/off switch (every making row that has a switch of its own on the server). */
export const hasSwitch = (id: string) => !NO_OWN_SWITCH.includes(id);

const STATES: readonly ConnectorState[] = ['ready', 'off', 'needs-key', 'not-allowed', 'needs-sign-in', 'error', 'not-installed'];
const UNITS: readonly ConnectorRow['costModel']['unit'][] = ['char', 'second', 'minute', 'image', 'request', 'token', 'none'];

/** A row from the network, checked field by field; anything malformed is dropped rather than half-shown. */
export function parseConnectorRow(v: unknown): ConnectorRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const s = r.status as Record<string, unknown> | undefined;
  const c = (r.costModel ?? {}) as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9:-]{0,63}$/.test(r.id) || typeof r.title !== 'string' || !r.title.trim()) return null;
  if (!s || typeof s !== 'object' || !STATES.includes(s.state as ConnectorState) || typeof s.line !== 'string') return null;
  const fix = s.fix === 'connections' || s.fix === 'install' || s.fix === 'sign-in' || s.fix === 'gate' ? s.fix : null;
  return {
    id: r.id,
    title: r.title.slice(0, 40),
    group: 'making',
    status: {
      state: s.state as ConnectorState,
      line: s.line.slice(0, 80),
      fix,
      account: typeof s.account === 'string' ? s.account : null,
      version: typeof s.version === 'string' ? s.version : null,
      spentThisMonthUsd: typeof s.spentThisMonthUsd === 'number' && Number.isFinite(s.spentThisMonthUsd) ? s.spentThisMonthUsd : undefined,
    },
    switchOn: r.switchOn === true,
    attendance: r.attendance === 'attended-only' ? 'attended-only' : 'any',
    costModel: {
      unit: UNITS.includes(c.unit as ConnectorRow['costModel']['unit']) ? (c.unit as ConnectorRow['costModel']['unit']) : 'none',
      usdPerUnit: typeof c.usdPerUnit === 'number' && Number.isFinite(c.usdPerUnit) ? c.usdPerUnit : null,
      verified: c.verified === true,
      source: typeof c.source === 'string' ? c.source : null,
      readAt: typeof c.readAt === 'string' ? c.readAt : null,
    },
  };
}

/** `making` from a Connections payload, or null only when the payload has no `making` field (fallback rows). */
export function parseMaking(v: unknown): ConnectorRow[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ConnectorRow[] = [];
  for (const x of v) {
    const row = parseConnectorRow(x);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

// ---- one row per capability ----------------------------------------------------------------------------

export type CapabilityRowId = 'voice' | 'lipsync' | 'music' | 'video' | 'images' | 'agents' | 'rendering';

/**
 * The capability rows in display order. `members` follow the default connector chain of `kind` (graph/kinds.ts),
 * so the first member present is the primary; extra members (registered alternatives) come after the chain.
 * Some rows name a different primary where the chain order would mislead (PRIMARY_RULINGS): Images shows Codex
 * first, with Figma and Higgsfield in the drawer; the step's own chain is unchanged.
 * A registry test keeps every Making connector in exactly one row and the order in step with the chains.
 */
export const CAPABILITY_ROWS: readonly { id: CapabilityRowId; kind: string; members: readonly string[] }[] = [
  { id: 'voice', kind: 'voice', members: ['elevenlabs', 'azure-speech'] },
  { id: 'lipsync', kind: 'lipsync', members: ['sync', 'hedra'] },
  { id: 'music', kind: 'music', members: ['pack-music', 'owner-upload', 'elevenlabs-music', 'browser-agent:suno'] },
  { id: 'video', kind: 'broll', members: ['higgsfield-video'] },
  { id: 'images', kind: 'art', members: ['codex', 'figma', 'higgsfield-image'] },
  { id: 'agents', kind: 'script', members: ['claude-cli', 'agent-sdk'] },
  { id: 'rendering', kind: 'render', members: ['remotion', 'ffmpeg'] },
];

/** Rows whose primary is set by hand rather than by the chain order. */
export const PRIMARY_RULINGS: Partial<Record<CapabilityRowId, string>> = { images: 'codex', music: 'pack-music' };

export interface CapabilityGroup {
  /** A CapabilityRowId, or the connector id for a connector no capability row lists (shown alone, never hidden). */
  id: string;
  title: string;
  primary: ConnectorRow;
  /** Primary first, then the alternatives. */
  members: ConnectorRow[];
}

/** The capability whose drawer holds a connector (or the capability itself), else null. */
export const capabilityOf = (id: string): CapabilityRowId | null => CAPABILITY_ROWS.find((c) => c.id === id || c.members.includes(id))?.id ?? null;

/** Groups connector rows into one row per capability; a connector no row lists keeps a row of its own. */
export function capabilityGroups(rows: readonly ConnectorRow[]): CapabilityGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: CapabilityGroup[] = [];
  for (const c of CAPABILITY_ROWS) {
    const members = c.members.map((id) => byId.get(id)).filter((r): r is ConnectorRow => Boolean(r));
    if (members.length) out.push({ id: c.id, title: t(`connections.cap.${c.id}`), primary: members[0]!, members });
  }
  const listed = new Set(CAPABILITY_ROWS.flatMap((c) => c.members));
  for (const r of rows) if (!listed.has(r.id)) out.push({ id: r.id, title: r.title, primary: r, members: [r] });
  return out;
}

/** Most words a state line may have, the "·" included. */
export const STATE_LINE_WORDS = 6;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The short state of one connector (≤ 4 words): what its pill means for this row, in the dictionary's words. */
export function statePhrase(r: Pick<ConnectorRow, 'status' | 'switchOn'>): { pill: StatusWord; phrase: string; amber: boolean } {
  const { pill, amber } = rowView(r);
  const s = r.status;
  const ready: Record<string, string> = {
    [t('connector.readyPaid')]: t('connections.state.paid'),
    [t('connector.readyPlan')]: t('connections.state.plan'),
    [t('connector.readyLocal')]: t('connections.state.local'),
    [t('connector.readyFree')]: t('connections.state.free'),
  };
  const phrase: Record<ConnectorState, string> = {
    ready: ready[s.line] ?? t('connections.line.ready'),
    off: s.line === t('connector.paused') ? t('connections.state.paused') : t('connections.line.offMock'),
    'needs-key': r.switchOn ? t('connections.line.keyMissing') : t('connections.line.offMock'),
    'not-allowed': t('connections.state.notAllowed'),
    'needs-sign-in': t('connections.state.signIn'),
    error: t('connections.state.checkFailed'),
    'not-installed': s.line === t('connections.line.notChecked') ? s.line : t('connections.state.notInstalled'),
  };
  return { pill, phrase: phrase[s.state], amber };
}

/** "‹service› · ‹state›", or the state alone when the two together would pass STATE_LINE_WORDS. */
export function capabilityLine(service: string, phrase: string): { service: string | null; phrase: string } {
  const both = t('connections.capLine', { service, state: phrase });
  return words(both) <= STATE_LINE_WORDS ? { service, phrase } : { service: null, phrase: words(phrase) <= STATE_LINE_WORDS ? phrase : phrase.split(/\s+/).slice(0, STATE_LINE_WORDS).join(' ') };
}
