// The step-kind catalogue: for every canonical kind, whether it is
// language-scoped, its output ports, its default role and connector chain, and the connectors registered for it
// (pipeline validation refuses any other entry). Also the process-wide connector concurrency limits and the
// role caps used as `usdHigh` for agent steps. Generic core: no project names.
import type { StepKind } from '../types';

export interface KindSpec {
  kind: StepKind;
  title: string; // ≤ 3 words
  langScoped: boolean;
  outputs: string[]; // declared output ports; every edge's `fromPort` must be one of them
  role: string | null; // role registry id
  chain: string[]; // default connector chain; 'mock' is implicit last
  registered: string[]; // connectors allowed in a chain for this kind (validation)
  deterministic: boolean; // a cache hit reuses the version
}

const k = (kind: StepKind, title: string, langScoped: boolean, outputs: string[], role: string | null, chain: string[], deterministic: boolean, extra: string[] = []): KindSpec => ({
  kind,
  title,
  langScoped,
  outputs,
  role,
  chain,
  registered: [...new Set([...chain, ...extra, 'mock'])],
  deterministic,
});

export const KINDS: Record<StepKind, KindSpec> = {
  analyse: k('analyse', 'Read the reference', false, ['recipe'], 'deconstructor', ['claude-cli'], false),
  script: k('script', 'Script', false, ['script'], 'copywriter', ['claude-cli'], false, ['agent-sdk']),
  'narration-text': k('narration-text', 'Narration text', true, ['lines'], 'language-editor', ['local'], true, ['claude-cli']),
  voice: k('voice', 'Voice', true, ['alignment', 'audio'], 'sound-designer', ['elevenlabs', 'azure-speech'], false),
  art: k('art', 'Scenes', false, ['scenes'], 'art-director', ['pack', 'figma', 'codex', 'higgsfield-image'], false),
  broll: k('broll', 'B-roll', false, ['clips'], 'motion-designer', ['higgsfield-video'], false),
  lipsync: k('lipsync', 'Lip-sync', true, ['clips'], 'animator', ['sync', 'hedra'], false, ['local']),
  music: k('music', 'Music', false, ['track', 'beatGrid'], 'sound-designer', ['pack-music', 'owner-upload', 'elevenlabs-music'], false, ['browser-agent:suno']),
  motion: k('motion', 'Animation', true, ['motion'], 'animator', ['claude-cli', 'local'], false),
  captions: k('captions', 'Captions', true, ['captionPages'], 'motion-designer', ['local'], true),
  compose: k('compose', 'Compose', true, ['timeline', 'preview'], null, ['remotion'], true),
  mix: k('mix', 'Mix', true, ['mixPlan', 'master', 'loudness'], 'sound-designer', ['remotion', 'ffmpeg'], true),
  render: k('render', 'Render', true, ['video', 'cover', 'log', 'measurements'], null, ['remotion', 'ffmpeg'], true),
  'post-copy': k('post-copy', 'Caption and hashtags', true, ['caption', 'meta'], 'copywriter', ['claude-cli'], false),
  check: k('check', 'Check', false, ['score', 'routes'], 'reviewer', ['agent-sdk', 'claude-cli', 'deterministic-only'], false),
};

/**
 * UI labels of the role registry ids: screens read these, never the ids. `language-editor` reads
 * "Persian editor" on a Persian lane and "Language editor" elsewhere.
 */
export const ROLE_LABELS: Record<string, string> = {
  deconstructor: 'Read the reference',
  copywriter: 'Copywriter',
  'language-editor': 'Language editor',
  'art-director': 'Art director',
  animator: 'Animator',
  'motion-designer': 'Motion-graphics designer',
  'sound-designer': 'Sound designer',
  reviewer: 'Check',
};

/** The UI label of a role on a lane; null for no role or an id the registry does not know (never the id). */
export function roleLabel(role: string | null | undefined, lang: string | null = null): string | null {
  if (!role) return null;
  if (role === 'language-editor' && lang === 'fa') return 'Persian editor';
  return ROLE_LABELS[role] ?? null;
}

/** UI labels of the chain entries that are not connector registry rows (free local modes, the pack, mock). */
export const LOCAL_CONNECTOR_LABELS: Record<string, string> = {
  local: 'On this computer',
  pack: 'Brand pack',
  'deterministic-only': 'Checks only',
  mock: 'Mock',
};

/** Connectors that run on this computer for free; always allowed (free local modes). */
export const LOCAL_CONNECTORS = new Set(['local', 'pack', 'pack-music', 'owner-upload', 'remotion', 'ffmpeg', 'deterministic-only']);

/** process-wide concurrency per connector (across runs and projects). Unlisted connectors are unlimited;
 * the image and video connectors of one vendor share its row (see `semaphoreKey`). */
export const CONNECTOR_LIMITS: Record<string, number> = {
  'claude-cli': 2,
  'agent-sdk': 2,
  codex: 1,
  elevenlabs: 3,
  'azure-speech': 3,
  sync: 1,
  hedra: 1,
  higgsfield: 2,
  remotion: 1,
  ffmpeg: 2,
  'browser-agent:suno': 1,
};

/** the per-call cap of the role a kind runs, used as the agent step's `usdHigh`. */
export const ROLE_CAP_USD: Partial<Record<StepKind, number>> = {
  analyse: 2.0,
  script: 1.2,
  'narration-text': 0.6,
  art: 0.6,
  motion: 1.2,
  'post-copy': 0.4,
  check: 1.0,
};

/** Kinds whose agent work happens through the CLI or SDK (2 retries on a contract violation). */
export const AGENT_KINDS = new Set<StepKind>(['analyse', 'script', 'art', 'motion', 'post-copy', 'check']);

export const kindOf = (nodeId: string): StepKind => nodeId.split(/[:#]/)[0] as StepKind;

/** The semaphore a connector counts against: `higgsfield-image` and `higgsfield-video` share `higgsfield`. */
export const semaphoreKey = (connector: string): string => (connector.startsWith('higgsfield') ? 'higgsfield' : connector);
