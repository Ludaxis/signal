'use client';
// Studio projects: one Instagram account each. Switcher in the sidebar, a projects panel, and the
// "New project" wizard (name → posting: Meta or an Upload-Post profile → posts folder → limits → check).
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Select } from './Select';

// ---- selected project (per browser) -------------------------------------------------------
const KEY = 'signal.studio.project';
let current: string | null | undefined;
const subs = new Set<() => void>();
export function getProjectId(): string | null {
  if (current === undefined) {
    try {
      current = window.localStorage.getItem(KEY);
    } catch {
      current = null;
    }
  }
  return current ?? null;
}
export function setProjectId(id: string): void {
  current = id;
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable: keep in memory */
  }
  subs.forEach((f) => f());
}
function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
export function useProjectId(): string | null {
  return useSyncExternalStore(subscribe, getProjectId, () => null);
}
const CHANGED = 'signal-projects-changed';

// ---- projects list ------------------------------------------------------------------------
export interface ProjectRow {
  id: string;
  name: string;
  handle: string;
  uploadPostProfile: string;
  contentDir: string;
  account: {
    active: boolean;
    ends_at: string | null;
    max_posts: number;
    max_per_day: number;
    posting: boolean;
    codex_images: boolean;
    verified: { at: string; instagram: string | null } | null;
  } | null;
}

export function useProjects() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const load = useCallback(async () => {
    const r = await fetch('/api/studio/projects', { cache: 'no-store' });
    if (r.status === 401) {
      router.push('/login?next=%2Fstudio');
      return;
    }
    const j = (await r.json().catch(() => ({}))) as { projects?: ProjectRow[]; uploadPostKey?: boolean; error?: { message?: string } };
    if (!r.ok || !Array.isArray(j.projects)) {
      // Keep the last good list; say why instead of crashing the Studio.
      setError(j.error?.message ?? `Could not load projects (${r.status}).`);
      return;
    }
    setError('');
    setRows(j.projects);
    setHasKey(j.uploadPostKey === true);
    const sel = getProjectId();
    if (!sel || !j.projects.some((p) => p.id === sel)) if (j.projects[0]) setProjectId(j.projects[0].id);
  }, [router]);
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) void load();
    };
    run();
    window.addEventListener(CHANGED, run);
    return () => {
      alive = false;
      window.removeEventListener(CHANGED, run);
    };
  }, [load]);
  return { rows, hasKey, error, reload: load };
}
const announce = () => window.dispatchEvent(new Event(CHANGED));

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

const statusOf = (p: ProjectRow) =>
  !p.account ? { label: 'Limits not set', cls: 'off' } : p.account.active ? { label: p.account.posting ? 'One-click posting on' : 'Post by hand', cls: 'on' } : { label: 'Posting period ended', cls: 'warn' };

// ---- sidebar switcher ---------------------------------------------------------------------
export function ProjectSwitcher() {
  const { rows, error } = useProjects();
  const pid = useProjectId();
  const [open, setOpen] = useState(false);
  const cur = rows?.find((p) => p.id === pid) ?? rows?.[0];
  return (
    <div className="proj-switch st-stack" style={{ gap: 6 }}>
      <span className="label">Project</span>
      <Select
        label="Project"
        value={cur?.id ?? null}
        disabled={!rows}
        placeholder="Loading…"
        onChange={(v) => setProjectId(v)}
        options={(rows ?? []).map((p) => ({ value: p.id, text: p.name, label: p.name, hint: p.handle }))}
      />
      {cur ? <span className={`proj-status ${statusOf(cur).cls}`}>{statusOf(cur).label}</span> : null}
      {error ? <span className="xs real-error" role="alert">{error}</span> : null}
      <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setOpen(true)}>
        Manage projects
      </button>
      {open ? <ProjectsPanel onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

export function CurrentProjectLabel() {
  const { rows } = useProjects();
  const pid = useProjectId();
  const cur = rows?.find((p) => p.id === pid) ?? rows?.[0];
  return <>{cur ? `${cur.name} · Instagram ${cur.handle}` : 'Instagram'}</>;
}

// ---- projects panel -----------------------------------------------------------------------
function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const { rows, hasKey, reload } = useProjects();
  const [wizard, setWizard] = useState<null | { mode: 'new' } | { mode: 'account'; project: ProjectRow }>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  useScrollLock();
  // Portal to the Studio root: the sticky sidebar would otherwise keep the panel underneath the page.
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  const node = (
    <div className="proj-overlay" role="dialog" aria-modal="true" aria-label="Projects">
      <div className="proj-panel st-stack" style={{ gap: 14 }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 className="section-title" style={{ fontSize: 18 }}>
            {wizard ? (wizard.mode === 'new' ? 'New project' : `Posting limits for ${wizard.project.handle}`) : 'Projects'}
          </h2>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={wizard ? () => setWizard(null) : onClose}>
            {wizard ? 'Back' : 'Close'}
          </button>
        </div>
        {wizard ? (
          <Wizard
            hasKey={hasKey}
            start={wizard.mode === 'account' ? wizard.project : null}
            onDone={(id) => {
              setWizard(null);
              setProjectId(id);
              announce();
              void reload();
            }}
          />
        ) : (
          <>
            {(rows ?? []).map((p) => {
              const st = statusOf(p);
              return (
                <div key={p.id} className="st-card proj-row st-stack" style={{ gap: 6 }}>
                  <div className="row-wrap" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>
                      {p.name} <span className="st-muted">· {p.handle}</span>
                    </span>
                    <span className={`proj-status ${st.cls}`}>{st.label}</span>
                  </div>
                  <span className="st-small st-muted">
                    {p.uploadPostProfile ? `Upload-Post profile “${p.uploadPostProfile}”` : "Instagram's API (Meta)"} · posts in {p.contentDir}
                  </span>
                  {p.account ? (
                    <span className="st-small st-muted">
                      {p.account.ends_at ? `${p.account.active ? 'Posting until' : 'Posting ended'} ${new Date(p.account.ends_at).toLocaleDateString()}` : 'No end date'} · {p.account.max_posts} posts, {p.account.max_per_day}/day · Codex images {p.account.codex_images ? 'on' : 'off'}
                      {p.account.verified ? ` · checked ${p.account.verified.instagram ? '@' + p.account.verified.instagram.replace(/^@/, '') : 'no Instagram'}` : ''}
                    </span>
                  ) : null}
                  <div className="row-wrap" style={{ gap: 8 }}>
                    <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setProjectId(p.id)}>
                      Open
                    </button>
                    <button type="button" className={`st-btn ${p.account?.active ? 'st-btn-ghost' : 'st-btn-primary'} st-btn-sm`} onClick={() => setWizard({ mode: 'account', project: p })}>
                      {p.account?.active ? 'Change limits' : 'Set posting limits'}
                    </button>
                    {p.account?.active ? <VerifyButton id={p.id} onDone={() => void reload()} /> : null}
                  </div>
                </div>
              );
            })}
            <button type="button" className="st-btn st-btn-primary" onClick={() => setWizard({ mode: 'new' })}>
              + New project
            </button>
          </>
        )}
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}

function VerifyButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <>
      <button
        type="button"
        className="st-btn st-btn-ghost st-btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const j = await post<{ ok: boolean; message: string }>(`/api/studio/projects/${id}`, { action: 'verify' });
            setMsg({ ok: j.ok, text: j.message });
            onDone();
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Checking…' : 'Check connection'}
      </button>
      {msg ? <span className={`st-small ${msg.ok ? 'proj-ok' : 'real-error'}`}>{msg.text}</span> : null}
    </>
  );
}

// ---- wizard -------------------------------------------------------------------------------
type Step = 'basics' | 'upload' | 'source' | 'create' | 'account' | 'verify';
const STEPS: [Step, string][] = [
  ['basics', 'Name'],
  ['upload', 'Posting'],
  ['source', 'Folder'],
  ['create', 'Create'],
  ['account', 'Limits'],
  ['verify', 'Check'],
];

function Wizard({ hasKey, start, onDone }: { hasKey: boolean; start: ProjectRow | null; onDone: (id: string) => void }) {
  const [step, setStep] = useState<Step>(start ? 'account' : 'basics');
  const [via, setVia] = useState<'meta' | 'upload-post'>('meta');
  const [f, setF] = useState({ name: '', id: '', handle: '', uploadPostProfile: '', contentDir: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ id: string; handle: string; upload: boolean } | null>(start ? { id: start.id, handle: start.handle, upload: !!start.uploadPostProfile } : null);
  const [ap, setAp] = useState({ days: 0, maxPosts: 30, maxPerDay: 1, posting: false, codexImages: false, confirm: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const check = async (fields: string[], next: Step, extra: Partial<typeof f> = {}) => {
    setBusy(true);
    setMsg('');
    try {
      const j = await post<{ errors: Record<string, string>; id: string }>('/api/studio/projects', { ...f, ...extra, check: true });
      const relevant = Object.fromEntries(Object.entries(j.errors).filter(([k]) => fields.includes(k)));
      setErrs(relevant);
      if (!f.id && j.id) set('id', j.id);
      if (!Object.keys(relevant).length) setStep(next);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const err = (k: string) => (errs[k] ? <span className="real-error st-small">{errs[k]}</span> : null);
  const idx = STEPS.findIndex(([s]) => s === step);

  return (
    <div className="st-stack" style={{ gap: 14 }}>
      <ol className="wiz-steps">
        {STEPS.map(([s, l], i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
            {l}
          </li>
        ))}
      </ol>

      {step === 'basics' ? (
        <div className="st-stack" style={{ gap: 10 }}>
          <label className="wiz-field">
            Project name
            <input className="st-input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. My brand" />
            {err('name')}
            {err('id')}
          </label>
          <label className="wiz-field">
            Instagram account <span className="st-muted" style={{ fontWeight: 400 }}>(you can also pick it from Upload-Post on the next step)</span>
            <input className="st-input" value={f.handle} onChange={(e) => set('handle', e.target.value)} placeholder="@account or instagram.com/account" />
            <span className="st-small st-muted">Must be a Professional (Creator or Business) account.</span>
            {err('handle')}
          </label>
          <div>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !f.name} onClick={() => void check(f.handle ? ['name', 'id', 'handle'] : ['name', 'id'], 'upload')}>
              Next
            </button>
          </div>
        </div>
      ) : null}

      {step === 'upload' ? (
        <div className="st-stack" style={{ gap: 12 }}>
          <div className="st-stack" role="radiogroup" aria-label="How this project posts" style={{ gap: 6 }}>
            <label className="real-check">
              <input type="radio" name="via" checked={via === 'meta'} onChange={() => { setVia('meta'); set('uploadPostProfile', ''); }} /> <span><strong>Instagram&apos;s API with Meta</strong> (recommended): connect the account on the Connections screen after creating the project. No Upload-Post needed.</span>
            </label>
            <label className="real-check">
              <input type="radio" name="via" checked={via === 'upload-post'} onChange={() => setVia('upload-post')} /> <span><strong>Upload-Post</strong>: use a profile on your Upload-Post plan.</span>
            </label>
          </div>
          {via === 'meta' ? (
            <div className="st-stack" style={{ gap: 10 }}>
              <label className="wiz-field">
                Instagram account
                <input className="st-input" value={f.handle} onChange={(e) => set('handle', e.target.value)} placeholder="@account" />
                <span className="st-small st-muted">A Professional account that is in the business portfolio Signal&apos;s Meta login can see.</span>
                {err('handle')}
              </label>
              <div className="row-wrap" style={{ gap: 8 }}>
                <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setStep('basics')}>
                  Back
                </button>
                <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !f.handle.trim()} onClick={() => void check(['uploadPostProfile', 'handle'], 'source', { uploadPostProfile: '' })}>
                  Next
                </button>
              </div>
            </div>
          ) : (
        <UploadPostStep
          hasKey={hasKey}
          slug={f.id || f.name}
          name={f.name}
          handle={f.handle}
          profile={f.uploadPostProfile}
          setProfile={(v) => set('uploadPostProfile', v)}
          setHandle={(v) => set('handle', v)}
          error={errs.uploadPostProfile ?? errs.handle}
          busy={busy}
          onBack={() => setStep('basics')}
          onNext={(h) => void check(['uploadPostProfile', 'handle'], 'source', h ? { handle: h } : {})}
        />
          )}
        </div>
      ) : null}

      {step === 'source' ? (
        <div className="st-stack" style={{ gap: 10 }}>
          <span className="st-small st-muted">Posts are folders of files (images, video, caption) with a package.json. Signal&apos;s generators write them here; you can also drop in packages made elsewhere.</span>
          <label className="wiz-field">
            Posts folder (optional)
            <input className="st-input" value={f.contentDir} onChange={(e) => set('contentDir', e.target.value)} placeholder="Default: <data folder>/projects/<project>/posts" />
            {err('contentDir')}
          </label>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setStep('upload')}>
              Back
            </button>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy} onClick={() => void check(['contentDir'], 'create')}>
              Next
            </button>
          </div>
        </div>
      ) : null}

      {step === 'create' ? (
        <div className="st-stack" style={{ gap: 10 }}>
          <div className="st-card st-small" style={{ padding: 12, lineHeight: 1.6 }}>
            <strong>{f.name}</strong> (<code>{f.id}</code>) · Instagram {f.handle} · {f.uploadPostProfile ? `Upload-Post profile “${f.uploadPostProfile}”` : "posts with Instagram's API (Meta)"} ·{' '}
            {f.contentDir ? `posts in ${f.contentDir}` : 'posts in the default data folder'}
          </div>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setStep('source')}>
              Back
            </button>
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMsg('');
                try {
                  const j = await post<{ project: { id: string; handle: string } }>('/api/studio/projects', f);
                  setCreated({ id: j.project.id, handle: j.project.handle, upload: !!f.uploadPostProfile });
                  announce();
                  setStep('account');
                } catch (e) {
                  setMsg((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create project
            </button>
          </div>
        </div>
      ) : null}

      {step === 'account' && created ? (
        <div className="st-stack" style={{ gap: 10 }}>
          <span className="st-small">
            Posting limits for <strong>{created.handle}</strong>. They are saved locally with the time and apply to every way Signal can post. Every post still needs your approval on the Posts board.
          </span>
          <div className="row-wrap" style={{ gap: 12 }}>
            <label className="wiz-field wiz-num">
              Days (0 = no end)
              <input className="st-input" type="number" min={0} max={365} value={ap.days} onChange={(e) => setAp({ ...ap, days: Number(e.target.value) })} />
            </label>
            <label className="wiz-field wiz-num">
              Max posts
              <input className="st-input" type="number" min={1} max={1000} value={ap.maxPosts} onChange={(e) => setAp({ ...ap, maxPosts: Number(e.target.value) })} />
            </label>
            <div className="wiz-field wiz-num">
              <span>Per day</span>
              <Select label="Posts per day" value={ap.maxPerDay} onChange={(v) => setAp({ ...ap, maxPerDay: v })} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} />
            </div>
          </div>
          <label className="real-check">
            <input type="checkbox" checked={ap.posting} onChange={(e) => setAp({ ...ap, posting: e.target.checked })} /> One-click and scheduled posting{created.upload ? ' through Upload-Post' : " through Instagram's API (Meta)"} (off: post by hand and record the link)
          </label>
          <label className="real-check">
            <input type="checkbox" checked={ap.codexImages} onChange={(e) => setAp({ ...ap, codexImages: e.target.checked })} /> Codex CLI images with my own Codex account, only when I press Generate
          </label>
          <label className="wiz-field">
            Type {created.handle} to confirm
            <input className="st-input" value={ap.confirm} onChange={(e) => setAp({ ...ap, confirm: e.target.value })} placeholder={created.handle} />
          </label>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => onDone(created.id)}>
              Skip for now
            </button>
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              disabled={busy || ap.confirm.trim().toLowerCase() !== created.handle.toLowerCase()}
              onClick={async () => {
                setBusy(true);
                setMsg('');
                try {
                  await post(`/api/studio/projects/${created.id}`, { action: 'account', confirmHandle: ap.confirm, days: ap.days, maxPosts: ap.maxPosts, maxPerDay: ap.maxPerDay, posting: ap.posting, codexImages: ap.codexImages });
                  announce();
                  setStep('verify');
                } catch (e) {
                  setMsg((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save limits
            </button>
          </div>
        </div>
      ) : null}

      {step === 'verify' && created ? (
        <div className="st-stack" style={{ gap: 10 }}>
          {created.upload ? (
            <>
              <span className="st-small">Saved. Check that Upload-Post has {created.handle} connected to the profile (a read-only check).</span>
              <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
                <VerifyButton id={created.id} onDone={announce} />
              </div>
            </>
          ) : (
            <span className="st-small">Saved. Next, open the project and connect {created.handle} with Meta on the Connections screen. Posting starts working once it is connected.</span>
          )}
          <div>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => onDone(created.id)}>
              Open project
            </button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p className="real-error st-small" role="alert">
          {msg}
        </p>
      ) : null}
    </div>
  );
}

// ---- Upload-Post step (automatic when the "uploadPostProfiles" switch is on) ---------------
interface UpProfile { username: string; displayName: string | null; instagram: { handle: string | null; name: string | null; reauth: boolean } | null }

function UploadPostStep(props: {
  hasKey: boolean;
  slug: string;
  name: string;
  handle: string;
  profile: string;
  setProfile: (v: string) => void;
  setHandle: (v: string) => void;
  error?: string;
  busy: boolean;
  onBack: () => void;
  onNext: (handleFromProfile?: string) => void;
}) {
  const { profile, setProfile, setHandle, handle } = props;
  const [state, setState] = useState<{ allowed: boolean; reason: string; plan?: string | null; limit?: number | null; profiles: UpProfile[] } | null>(null);
  const [newName, setNewName] = useState(props.slug.replace(/[^A-Za-z0-9_@-]/g, '-').slice(0, 40));
  const [work, setWork] = useState(false);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/studio/upload-post', { cache: 'no-store' });
    const j = (await r.json().catch(() => null)) as typeof state & { error?: { message: string } };
    if (!r.ok || !j) {
      setState({ allowed: false, reason: j?.error?.message ?? 'Could not reach Upload-Post.', profiles: [] });
      return;
    }
    setState(j);
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const chosen = state?.profiles.find((p) => p.username === profile) ?? null;
  // Fill the Instagram handle from the connected account.
  useEffect(() => {
    const h = chosen?.instagram?.handle;
    if (h && !handle) setHandle(h);
  }, [chosen, handle, setHandle]);

  const act = async (body: Record<string, unknown>) => {
    setWork(true);
    setNote('');
    try {
      const j = await post<{ profile?: UpProfile; url?: string; hosted?: boolean; note?: string }>('/api/studio/upload-post', body);
      return j;
    } catch (e) {
      setNote((e as Error).message);
      return null;
    } finally {
      setWork(false);
    }
  };

  if (!state) return <span className="st-small st-muted">Loading your Upload-Post profiles…</span>;

  if (!state.allowed)
    return (
      <div className="st-stack" style={{ gap: 10 }}>
        <ol className="real-steps st-small">
          <li>Open Upload-Post → <strong>Manage Users</strong> and create a profile for this project (or reuse one).</li>
          <li>In that profile, connect the Instagram account.</li>
          <li>Copy the profile&apos;s <strong>username</strong> (not its display name) and paste it below.</li>
        </ol>
        <span className="st-small st-muted">{state.reason}</span>
        <label className="wiz-field">
          Upload-Post profile username
          <input className="st-input" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="e.g. default" />
          {props.error ? <span className="real-error st-small">{props.error}</span> : null}
        </label>
        <div className="row-wrap" style={{ gap: 8 }}>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={props.onBack}>
            Back
          </button>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={props.busy || !profile || !handle} onClick={() => props.onNext()}>
            Next
          </button>
        </div>
      </div>
    );

  const free = state.limit != null ? Math.max(0, state.limit - state.profiles.length) : null;
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <span className="st-small st-muted">
        Upload-Post plan: {state.plan ?? 'unknown'} · {state.profiles.length}
        {state.limit != null ? ` of ${state.limit}` : ''} profiles used
      </span>
      <div className="st-stack" style={{ gap: 6 }}>
        {state.profiles.map((p) => (
          <label key={p.username} className="real-check">
            <input type="radio" name="upprofile" checked={profile === p.username} onChange={() => setProfile(p.username)} />
            <span>
              <strong>{p.username}</strong>
              {p.displayName ? ` (${p.displayName})` : ''} ·{' '}
              {p.instagram?.handle ? `Instagram ${p.instagram.handle}${p.instagram.reauth ? ' — needs reconnecting' : ''}` : 'no Instagram connected'}
            </span>
          </label>
        ))}
      </div>
      <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <input className="st-input" style={{ maxWidth: 220 }} value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New profile username" />
        <button
          type="button"
          className="st-btn st-btn-ghost st-btn-sm"
          disabled={work || !newName || free === 0}
          onClick={async () => {
            const j = await act({ action: 'create', username: newName, displayName: props.name || newName });
            if (j?.profile) {
              await load();
              setProfile(j.profile.username);
            }
          }}
        >
          Create new profile
        </button>
        {free === 0 ? <span className="st-small real-error">No free profile slot on your plan.</span> : null}
      </div>
      {profile ? (
        <div className="st-card st-stack" style={{ padding: 12, gap: 8 }}>
          {chosen?.instagram?.handle ? (
            <span className="st-small proj-ok">
              “{profile}” is connected to Instagram {chosen.instagram.handle}
              {handle && handle.toLowerCase() !== chosen.instagram.handle.toLowerCase() ? ` — you typed ${handle}; it will use ${chosen.instagram.handle}.` : '.'}
            </span>
          ) : (
            <span className="st-small">“{profile}” has no Instagram connected yet.</span>
          )}
          <div className="row-wrap" style={{ gap: 8 }}>
            <button
              type="button"
              className="st-btn st-btn-dark st-btn-sm"
              disabled={work}
              onClick={async () => {
                const j = await act({ action: 'connect', username: profile });
                if (j?.url) {
                  setLink(j.url);
                  setNote(j.note ?? '');
                  window.open(j.url, '_blank', 'noopener');
                }
              }}
            >
              {chosen?.instagram?.handle ? 'Reconnect Instagram' : 'Connect Instagram'}
            </button>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={work} onClick={() => void load()}>
              Check again
            </button>
          </div>
          {link ? (
            <a className="real-link st-small" href={link} target="_blank" rel="noreferrer">
              Open the connect page again
            </a>
          ) : null}
        </div>
      ) : null}
      {note ? <span className="st-small st-muted">{note}</span> : null}
      {props.error ? <span className="real-error st-small">{props.error}</span> : null}
      <div className="row-wrap" style={{ gap: 8 }}>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={props.onBack}>
          Back
        </button>
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          disabled={props.busy || !profile || !(chosen?.instagram?.handle || handle)}
          onClick={() => {
            const h = chosen?.instagram?.handle ?? undefined;
            if (h && handle.toLowerCase() !== h.toLowerCase()) setHandle(h);
            props.onNext(h);
          }}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Stops the page behind a panel from scrolling while the panel is open. */
export function useScrollLock(): void {
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = 'hidden';
    return () => {
      el.style.overflow = prev;
    };
  }, []);
}

