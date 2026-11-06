// Server-only: keys and switches you set in Connections instead of editing .env.local.
//
// - Saved values are encrypted with SIGNAL_TOKEN_KEY (./secret-box.ts, ~/.signal/settings.json,
//   mode 0600) and applied to process.env when the server starts and whenever you save, so every
//   part of Signal reads them exactly as if they were in .env.local. No restart needed.
// - A saved value wins over .env.local. Removing it brings the .env.local value back.
// - Secret values never leave the server: the browser only learns whether a value is set and where
//   it comes from (and the last 4 characters of a key, to tell keys apart).
// - Switches: "Publishing" (SIGNAL_PUBLISH_PAUSED) and "Autopilot" (SIGNAL_AUTOPILOT_PAUSED). The
//   switch in Connections is the kill switch; .env.local is only the starting value.
import { deleteSecret, getSecret, listSecretNames, putSecret, tokenKey } from './secret-box';

const STORE = 'settings';

export interface Field { name: string; label: string; secret: boolean; placeholder?: string; check?: RegExp; help?: string }
export interface Group { id: string; title: string; why: string; where: string; fields: Field[] }

export const GROUPS: Group[] = [
  {
    id: 'upload-post',
    title: 'Upload-Post',
    why: 'Posts and schedules through Upload-Post, and reads results.',
    where: 'Upload-Post → Settings → API keys.',
    fields: [{ name: 'UPLOAD_POST_API_KEY', label: 'API key', secret: true, check: /^[A-Za-z0-9._-]{16,4096}$/ }],
  },
  {
    id: 'r2',
    title: 'Media bucket (Cloudflare R2)',
    why: 'Instagram’s API downloads media from a public link. Signal puts files here just before posting and deletes them after.',
    where: 'Cloudflare → R2: the bucket (public access on), and Manage API tokens → Object Read & Write for that bucket.',
    fields: [
      { name: 'R2_ACCOUNT_ID', label: 'Account ID', secret: false, check: /^[a-f0-9]{32}$/, placeholder: '32 characters' },
      { name: 'R2_BUCKET', label: 'Bucket', secret: false, check: /^[a-z0-9][a-z0-9-]{1,62}$/ },
      { name: 'R2_PUBLIC_BASE', label: 'Public address', secret: false, check: /^https:\/\/[^\s]+$/, placeholder: 'https://pub-….r2.dev' },
      { name: 'R2_ACCESS_KEY_ID', label: 'Access key ID', secret: true, check: /^[A-Za-z0-9]{16,128}$/ },
      { name: 'R2_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true, check: /^[A-Za-z0-9/+=]{16,256}$/ },
    ],
  },
  {
    id: 'meta',
    title: 'Meta app',
    why: 'Connect Instagram accounts with Meta and post through Instagram’s own API.',
    where: 'developers.facebook.com → your app → App settings → Basic, and Facebook Login for Business → Configurations.',
    fields: [
      { name: 'META_APP_ID', label: 'App ID', secret: false, check: /^\d{5,20}$/ },
      { name: 'META_LOGIN_CONFIG_ID', label: 'Login configuration ID', secret: false, check: /^\d{5,25}$/ },
      { name: 'META_REDIRECT_URI', label: 'Redirect URL', secret: false, check: /^https:\/\/[^\s?#]+\/api\/studio\/instagram\/callback$/, placeholder: 'https://…/api/studio/instagram/callback' },
      { name: 'META_APP_SECRET', label: 'App secret', secret: true, check: /^[A-Za-z0-9]{16,128}$/ },
    ],
  },
  {
    id: 'higgsfield',
    title: 'Higgsfield',
    why: 'Images and Reels from Higgsfield (paid per request).',
    where: 'cloud.higgsfield.ai → API keys.',
    fields: [
      { name: 'HF_API_KEY_ID', label: 'Key ID', secret: true, check: /^\S{8,256}$/ },
      { name: 'HF_API_KEY_SECRET', label: 'Key secret', secret: true, check: /^\S{8,512}$/ },
    ],
  },
  {
    id: 'anthropic',
    title: 'Anthropic API',
    why: 'Lets agent runs bill your API key instead of your Claude Code sign-in (only where that is switched on).',
    where: 'console.anthropic.com → API keys.',
    fields: [{ name: 'SIGNAL_ANTHROPIC_API_KEY', label: 'API key', secret: true, check: /^sk-ant-[A-Za-z0-9_-]{20,300}$/ }],
  },
];

export const SWITCHES = { publishing: 'SIGNAL_PUBLISH_PAUSED', autopilot: 'SIGNAL_AUTOPILOT_PAUSED' } as const;
export type SwitchId = keyof typeof SWITCHES;

const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.name, f] as const)));
const ALLOWED = new Set<string>([...FIELDS.keys(), ...Object.values(SWITCHES)]);

/** The .env.local values as they were before anything saved here was applied. */
const g = globalThis as typeof globalThis & { __signalEnvOriginal?: Map<string, string | undefined>; __signalSettingsApplied?: boolean };
const original = () => (g.__signalEnvOriginal ??= new Map());
function setEnv(name: string, value: string | null): void {
  if (!original().has(name)) original().set(name, process.env[name]);
  if (value === null) {
    const o = original().get(name);
    if (o === undefined) delete process.env[name];
    else process.env[name] = o;
  } else process.env[name] = value;
}

/** Applies every saved value to process.env. Runs at server start and before reading status. */
export async function applySavedSettings(): Promise<number> {
  if (!tokenKey().ok) return 0;
  let n = 0;
  for (const name of await listSecretNames(STORE)) {
    if (!ALLOWED.has(name)) continue;
    const v = await getSecret(STORE, name);
    if (v === null) continue;
    setEnv(name, v);
    n++;
  }
  g.__signalSettingsApplied = true;
  return n;
}
export async function ensureSettingsApplied(): Promise<void> {
  if (!g.__signalSettingsApplied) await applySavedSettings();
}

export class SettingsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface FieldStatus { name: string; label: string; secret: boolean; placeholder: string; source: 'saved' | 'env' | 'missing'; value: string | null; hint: string | null }
export interface GroupStatus { id: string; title: string; why: string; where: string; complete: boolean; saved: boolean; fields: FieldStatus[] }

const hintOf = (v: string) => (v.length >= 12 ? `…${v.slice(-4)}` : 'set');

export async function settingsStatus(): Promise<{ ready: boolean; reason: string; groups: GroupStatus[]; switches: Record<SwitchId, { on: boolean; source: 'saved' | 'env' | 'default' }> }> {
  await ensureSettingsApplied();
  const k = tokenKey();
  const saved = new Set(k.ok ? await listSecretNames(STORE) : []);
  const groups = GROUPS.map((gr) => {
    const fields = gr.fields.map((f): FieldStatus => {
      const v = (process.env[f.name] ?? '').trim();
      const source = saved.has(f.name) ? 'saved' : v ? 'env' : 'missing';
      return { name: f.name, label: f.label, secret: f.secret, placeholder: f.placeholder ?? '', source, value: !f.secret && v ? v : null, hint: f.secret && v ? hintOf(v) : null };
    });
    return { id: gr.id, title: gr.title, why: gr.why, where: gr.where, complete: fields.every((f) => f.source !== 'missing'), saved: fields.some((f) => f.source === 'saved'), fields };
  });
  const sw = (id: SwitchId) => {
    const v = (process.env[SWITCHES[id]] ?? '').trim().toLowerCase();
    const paused = v === '1' || v === 'true' || v === 'yes';
    return { on: !paused, source: saved.has(SWITCHES[id]) ? ('saved' as const) : v ? ('env' as const) : ('default' as const) };
  };
  return { ready: k.ok, reason: k.ok ? '' : k.reason, groups, switches: { publishing: sw('publishing'), autopilot: sw('autopilot') } };
}

/**
 * Saves the filled-in fields of one group. Empty fields keep what is there (so a saved secret is not
 * wiped by leaving its box empty). Values are checked first; nothing is saved if one is wrong.
 */
export async function saveGroup(groupId: string, values: Record<string, unknown>): Promise<string[]> {
  const gr = GROUPS.find((x) => x.id === groupId);
  if (!gr) throw new SettingsError(400, 'Unknown settings group.');
  const k = tokenKey();
  if (!k.ok) throw new SettingsError(409, k.reason);
  const todo: [Field, string][] = [];
  for (const f of gr.fields) {
    const raw = values[f.name];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v) continue;
    if (f.check && !f.check.test(v)) throw new SettingsError(400, `${f.label} does not look right.`);
    todo.push([f, f.name === 'R2_PUBLIC_BASE' ? v.replace(/\/+$/, '') : v]);
  }
  if (!todo.length) throw new SettingsError(400, 'Fill in at least one field.');
  for (const [f, v] of todo) {
    await putSecret(STORE, f.name, v);
    setEnv(f.name, v);
  }
  return todo.map(([f]) => f.label);
}

/** Removes the values saved here for one group (the .env.local values, if any, apply again). */
export async function clearGroup(groupId: string): Promise<number> {
  const gr = GROUPS.find((x) => x.id === groupId);
  if (!gr) throw new SettingsError(400, 'Unknown settings group.');
  let n = 0;
  for (const f of gr.fields) {
    if (await deleteSecret(STORE, f.name)) n++;
    setEnv(f.name, null);
  }
  return n;
}

/** Turns publishing or autopilot on (active) or off (paused). Takes effect at once. */
export async function setSwitch(id: SwitchId, on: boolean): Promise<void> {
  const k = tokenKey();
  if (!k.ok) throw new SettingsError(409, k.reason);
  const v = on ? '0' : '1';
  await putSecret(STORE, SWITCHES[id], v);
  setEnv(SWITCHES[id], v);
}
