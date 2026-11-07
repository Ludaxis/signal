// Synthetic fixtures for the Plan, Learn and Setup tabs: used by the unit tests (tests/unit/plan-setup-tabs.test.tsx
// and tests/unit/text-budget.test.tsx). Every name, handle and text here is invented; no real account, post or
// reference content is in it.

const row = (id: string, title: string, state: string, line: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  group: 'making',
  status: { state, line, fix: state === 'not-allowed' ? 'gate' : 'connections' },
  switchOn: false,
  attendance: 'any',
  costModel: { unit: 'none', usdPerUnit: null, verified: false, source: null, readAt: null },
  ...extra,
});

/** `making` as the connectors backend sends it: its 16 connectors, every vendor off (the screen groups them into one
 * row per capability). */
export const MAKING_FIXTURE = [
  row('claude-cli', 'Claude Code', 'off', 'Off'),
  row('agent-sdk', 'Claude API', 'off', 'Runs as mock'),
  row('codex', 'Codex', 'off', 'Off', { attendance: 'attended-only' }),
  row('figma', 'Figma', 'off', 'Off'),
  row('higgsfield-image', 'Higgsfield images', 'off', 'Runs as mock'),
  row('higgsfield-video', 'Higgsfield video', 'off', 'Runs as mock', { costModel: { unit: 'second', usdPerUnit: 0.07, verified: false, source: 'https://example.test/pricing', readAt: '2026-11-06' } }),
  row('elevenlabs', 'ElevenLabs', 'needs-key', 'Runs as mock'),
  row('azure-speech', 'Azure Speech', 'off', 'Runs as mock'),
  row('sync', 'Sync', 'off', 'Runs as mock'),
  row('hedra', 'Hedra', 'off', 'Runs as mock'),
  row('elevenlabs-music', 'ElevenLabs Music', 'off', 'Runs as mock'),
  row('pack-music', 'Pack music', 'off', 'Runs as mock'),
  row('owner-upload', 'Your music', 'off', 'Runs as mock'),
  row('browser-agent:suno', 'Suno', 'not-allowed', 'Not allowed · The site’s terms forbid it', { attendance: 'attended-only' }),
  row('remotion', 'Remotion renderer', 'not-installed', 'Not checked yet'),
  row('ffmpeg', 'ffmpeg', 'ready', 'Found on this computer'),
];

/** The answer to `connector.switch` for ElevenLabs turned on with no key. */
export const ELEVENLABS_ON_NO_KEY = row('elevenlabs', 'ElevenLabs', 'needs-key', 'Key missing', { switchOn: true });

const gate = (enabled: boolean, reason = '') => ({ enabled, reason });
/** A Connections payload of a project with nothing connected yet. */
export function connectionsPayload(extra: Record<string, unknown> = {}) {
  return {
    project: { id: 'fixture', name: 'Fixture project', handle: '@fixture.account', timeZone: 'Europe/Berlin' },
    account: { ready: false, reason: 'no posting limits', expiresAt: null, maxPerDay: 3, automaticPosting: false },
    paused: { paused: true, reason: 'paused' },
    instagram: { unifiedLogin: gate(false, 'off'), api: gate(false, 'off'), mode: null, connection: null, publish: gate(false), comments: gate(false), insights: gate(false) },
    uploadPost: { profile: null, instagram: null, verifiedAt: null, keySet: false, posting: gate(false), scheduling: gate(false), results: gate(false), profileSetup: gate(false), quota: null },
    mediaHost: { enabled: false, reason: 'off', publicHost: null },
    scheduler: gate(false),
    agents: gate(false, 'off'),
    codex: gate(false, 'off'),
    brand: null,
    ...extra,
  };
}
const feature = (id: string, label: string) => ({ id, label, on: false, forcedByEnv: false });
export const SETTINGS_FIXTURE = {
  ready: true,
  reason: '',
  groups: [
    { id: 'upload-post', title: 'Upload-Post', why: '', where: 'Your Upload-Post dashboard.', complete: false, saved: false, fields: [{ name: 'UPLOAD_POST_API_KEY', label: 'API key', secret: true, placeholder: '', source: 'missing', value: null, hint: null }] },
    { id: 'higgsfield', title: 'Higgsfield', why: '', where: 'Your Higgsfield account.', complete: false, saved: false, fields: [{ name: 'HF_API_KEY_ID', label: 'Key id', secret: true, placeholder: '', source: 'env', value: null, hint: '…1234' }] },
  ],
  switches: { publishing: { on: false, source: 'default' }, autopilot: { on: false, source: 'default' } },
  /** signal.config.json switches as GET /api/studio/settings lists them: the eight Post maker ones and two others. */
  features: [
    feature('postmaker', 'Post maker: make video posts from a reference'),
    feature('postmakerElevenlabs', 'ElevenLabs voice for Post maker (paid)'),
    feature('postmakerAzureSpeech', 'Azure Speech voice for Post maker (paid)'),
    feature('postmakerSync', 'Sync lip-sync for Post maker (paid)'),
    feature('postmakerHedra', 'Hedra lip-sync for Post maker (paid)'),
    feature('postmakerHiggsfieldVideo', 'Higgsfield video clips for Post maker (paid)'),
    feature('postmakerElevenlabsMusic', 'ElevenLabs music for Post maker (paid)'),
    feature('browserAgent', 'Browser agent for music sites (only while you watch)'),
    feature('scheduler', "Send scheduled posts from Signal's own scheduler"),
    feature('higgsfield', 'Higgsfield images and Reels (paid per request)'),
  ],
};
const tool = (cli: 'claude' | 'codex', label: string) => ({ cli, label, found: false, path: null, version: null, source: 'path', signedIn: null });
export const WORKSPACE_FIXTURE = { folders: [], figma: { ready: true, reason: '', connected: false, user: null, files: [], imports: [] }, tools: { claude: tool('claude', 'Claude Code'), codex: tool('codex', 'Codex') } };

const strategy = {
  summary: 'Short daily posts that invite one answer in the comments. Longer stories on weekends.',
  audience: 'People who like a quick puzzle',
  positioning: 'The calm one-minute break',
  pillars: [
    { name: 'Daily question', weight: 60, why: 'Drives comments' },
    { name: 'Behind the scenes', weight: 40, why: 'Builds trust' },
  ],
  postTypes: [],
  experiments: [{ hypothesis: 'Questions raise comments', measure: 'comments per post' }],
  kpis: [{ metric: 'Saves', target: '20 per post' }],
  research: [],
  risks: [],
  meta: { cli: 'fixture', seconds: 3, at: '2026-11-01T09:00:00.000Z' },
  approvedBy: 'owner@example.test',
  approvedAt: '2026-11-01T09:05:00.000Z',
};
const slot = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `s${i}`,
  date: `2026-11-${String(10 + i).padStart(2, '0')}`,
  time: '18:00',
  at: `2026-11-${String(10 + i).padStart(2, '0')}T17:00:00.000Z`,
  format: 'website-card',
  pillar: 'Daily question',
  hook: `Fixture hook ${i}`,
  angle: '',
  captionLead: '',
  packageId: null,
  status: 'planned',
  articleUrl: null,
  ...extra,
});
/** One running campaign with 7 planned slots (the card shows 5) and one ended campaign. */
export const CAMPAIGNS_FIXTURE = {
  campaigns: [
    { id: 'c-20261101-aaaa', name: 'Autumn questions', goal: 'engagement', brief: 'Fixture brief.', formats: ['website-card'], startDate: '2026-11-01', endDate: null, perWeek: 3, priority: 2, status: 'active', strategy, proposal: null },
    { id: 'c-20261001-bbbb', name: 'Old test', goal: 'awareness', brief: '', formats: ['website-card'], startDate: '2026-10-01', endDate: '2026-10-20', perWeek: 2, priority: 3, status: 'done', strategy: null, proposal: null },
  ],
  plans: {
    'c-20261101-aaaa': { madeAt: '2026-11-01T10:00:00.000Z', slots: [slot(1, { templateId: 'tpl-20261101-abcd' }), slot(2), slot(3), slot(4), slot(5), slot(6), slot(7)] },
    'c-20261001-bbbb': { madeAt: null, slots: [] },
  },
  agents: { enabled: true, reason: '' },
  goals: ['awareness', 'engagement'],
  formats: [{ id: 'website-card', name: 'Website post' }],
  timeZone: 'Europe/Berlin',
  templates: [{ id: 'tpl-20261101-abcd', name: 'Question card', status: 'proven' }],
};

/** A Persian comment and an English one on one post. */
export const COMMENTS_FIXTURE = {
  setup: { api: gate(true), unifiedLogin: gate(true), connection: null, mode: 'unified', scheduler: gate(false), mediaHost: gate(false), paused: { paused: true, reason: '' }, comments: gate(true), insights: gate(true), publish: gate(false), tokenEnv: 'X' },
  account: { userId: '1', username: 'fixture.account', accountType: 'BUSINESS', followers: 120, mediaCount: 3 },
  handleOk: true,
  posts: [
    {
      id: '9001',
      permalink: 'https://example.test/p/9001',
      timestamp: '2026-11-03T18:00:00+0000',
      caption: 'Which one would you pick?',
      mediaType: 'CAROUSEL_ALBUM',
      likes: 12,
      comments: 2,
      thumb: null,
      commentList: [
        { id: 'c1', text: 'این خیلی قشنگه، کی دوباره می‌ذارین؟', username: 'reader.one', timestamp: '2026-11-03T19:00:00+0000', hidden: false, likes: 1, replies: [] },
        { id: 'c2', text: 'The second one, easily.', username: 'reader.two', timestamp: '2026-11-03T19:30:00+0000', hidden: false, likes: 0, replies: [] },
      ],
    },
  ],
  timeZone: 'Europe/Berlin',
};

/** By template rows for a project with no pack and one template record. */
export const RESULTS_BY_TEMPLATE = {
  byTemplate: [
    { key: 'template:tpl-20261101-abcd', name: 'Question card', posts: 2, avgViews: 840, avgRate: 0.061 },
    { key: 'none', name: null, posts: 3, avgViews: 410, avgRate: 0.034 },
  ],
};

/** Text budgets: words of interface copy on each tab's main view (user content marked [data-content] excluded). */
export const TEXT_BUDGET = { today: 60, posts: 60, calendar: 40, campaigns: 90, brand: 70, results: 50, comments: 30, memory: 50, connections: 140 } as const;

/** Words the interface never shows: whole words, case-insensitive. */
export const BANNED = /\b(package|SHA|fingerprint|runbook|rev|gate|Probabilities|Judge|legacy)\b|\.env\b|Request failed/i;
/** Connections never shows these. */
export const CONNECTIONS_BANNED = /\.env|runbook|dev host|legacy|review calls/i;
