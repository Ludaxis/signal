'use client';
// Connections: every service the selected project uses, in one place — status, read-only checks,
// connect and disconnect. One short line per card; details sit behind "More". Status only: values
// and secrets never reach the browser.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { notifyChanged, useOnChanged } from './sync';
import { announceProjectsChanged, getProjectId, useFocusTrap, useProjectId, useScrollLock } from './Projects';
import { formatDateTime } from '@/lib/time';
import { ScreenSkeleton } from './loaders';
import { More } from './More';
import { Switch } from './Autopilot';
import { KeyHowTo, UploadPostPicker, useUpProfiles } from './UploadPostPicker';

interface Gate { enabled: boolean; reason: string }
interface Conn { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
interface Payload {
  project: { id: string; name: string; handle: string };
  account: { ready: boolean; reason: string; expiresAt: number | null; maxPerDay: number; automaticPosting: boolean };
  paused: { paused: boolean; reason: string };
  instagram: { unifiedLogin: Gate; api: Gate; mode: 'unified' | 'instagram-login' | null; connection: Conn | null; publish: Gate; comments: Gate; insights: Gate };
  uploadPost: { profile: string | null; instagram: string | null; verifiedAt: string | null; keySet: boolean; posting: Gate; scheduling: Gate; results: Gate; profileSetup: Gate };
  mediaHost: Gate & { publicHost: string | null };
  scheduler: Gate;
  agents: Gate & { billing?: 'subscription' | 'api-key' };
  codex: Gate;
  brand: { name: string; website: string | null; sources: string[]; updatedAt: string } | null;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

type Tone = 'on' | 'off' | 'warn' | 'soon';
function Card({ title, tone, status, children, actions }: { title: string; tone: Tone; status: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`st-card conn-card conn-${tone}`}>
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="conn-title">
          <span className="conn-dot" aria-hidden="true" />
          {title}
        </span>
        <span className="conn-status">{status}</span>
      </div>
      {children ? <div className="st-stack conn-body">{children}</div> : null}
      {actions ? <div className="row-wrap" style={{ gap: 8 }}>{actions}</div> : null}
    </div>
  );
}
const Line = ({ g, label }: { g: Gate; label: string }) => (
  <span className="xs">
    <span className={g.enabled ? 'conn-ok' : 'conn-no'}>{g.enabled ? '✓' : '–'}</span> {label}
    {!g.enabled && g.reason ? <span className="st-muted"> · {g.reason}</span> : null}
  </span>
);

export function Connections({ say, openBrand }: { say: (t: string) => void; openBrand: () => void }) {
  const pid = useProjectId();
  const [d, setD] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      setD(await call<Payload>(`/api/studio/connections?project=${encodeURIComponent(pid)}`));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [pid]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['connections', 'brand'], load);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try {
      const m = await fn();
      if (m) say(m);
      notifyChanged('connections', 'content');
      await load();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const check = (service: string) => run(service, async () => (await call<{ message: string }>('/api/studio/connections', { project: getProjectId(), action: 'check', service })).message);
  const project = (body: Record<string, unknown>) => call<{ instagram?: string | null; posting?: boolean }>(`/api/studio/projects/${encodeURIComponent(getProjectId() ?? '')}`, body);

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!d) return <ScreenSkeleton variant="connections" count={6} label="Loading connections" />;
  const ig = d.instagram;
  const c = ig.connection;
  const igTone: Tone = ig.api.enabled ? (c?.daysLeft != null && c.daysLeft <= 10 ? 'warn' : 'on') : c?.expired ? 'warn' : 'off';
  const up = d.uploadPost;
  const upTone: Tone = !up.profile ? 'off' : up.posting.enabled ? 'on' : 'warn';
  const metaOn = ig.api.enabled && ig.publish.enabled;
  const auto = d.account.automaticPosting;

  return (
    <section className="screen st-stack" style={{ gap: 18 }} aria-label="Connections">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="st-small st-muted">
          <b>{d.project.name}</b> ({d.project.handle}) · {d.account.ready ? `limits set${d.account.expiresAt && Number.isFinite(d.account.expiresAt) ? ` until ${formatDateTime(new Date(d.account.expiresAt).toISOString())}` : ''} · ${d.account.maxPerDay}/day` : `limits not set: ${d.account.reason}`}
        </span>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'refresh'} disabled={!!busy} onClick={() => void run('refresh', async () => undefined)}>Refresh</button>
      </div>
      {d.paused.paused ? <p className="real-live st-small" style={{ margin: 0 }}>{d.paused.reason}</p> : null}

      <span className="label">Publishing</span>
      <div className="conn-grid">
        <Card
          title="Instagram (Meta)"
          tone={igTone}
          status={c ? (c.expired ? 'Expired' : `@${c.username}`) : ig.mode === 'instagram-login' ? 'Legacy token' : 'Not connected'}
          actions={
            <>
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-sm"
                aria-busy={busy === 'connect'}
                disabled={!!busy || !ig.unifiedLogin.enabled}
                title={ig.unifiedLogin.enabled ? '' : ig.unifiedLogin.reason}
                onClick={() =>
                  void run('connect', async () => {
                    const j = await call<{ url: string }>('/api/studio/instagram', { project: getProjectId(), action: 'connect-start' });
                    window.location.assign(j.url);
                  })
                }
              >
                {c ? 'Connect again' : 'Connect with Meta'}
              </button>
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'igtest'} disabled={!!busy || !ig.api.enabled} onClick={() => void run('igtest', async () => { const j = await call<{ account: { username: string; followers: number | null }; quota: { used: number; total: number } | null }>('/api/studio/instagram', { project: getProjectId(), action: 'test' }); return `Works: @${j.account.username}${j.quota ? ` · ${j.quota.used}/${j.quota.total} API posts used today` : ''}. Nothing was posted.`; })}>
                Test
              </button>
              {c ? (
                <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'disc'} disabled={!!busy} onClick={() => { if (window.confirm(`Disconnect @${c.username}? Signal deletes its stored token on this machine. To revoke it at Meta too, remove the app from the business portfolio's integrations.`)) void run('disc', async () => { await call('/api/studio/instagram', { project: getProjectId(), action: 'disconnect' }); return 'Disconnected. The token was deleted on this machine.'; }); }}>
                  Disconnect
                </button>
              ) : null}
            </>
          }
        >
          {c ? (
            <span className="xs st-muted">
              Connected {formatDateTime(c.connectedAt)} · {c.expiresAt ? (c.expired ? 'token expired' : `expires in ${c.daysLeft} days`) : 'no expiry'}
            </span>
          ) : null}
          <More label="More">
            <Line g={ig.unifiedLogin} label="Meta Unified Login set up" />
            {ig.api.enabled ? (
              <>
                <Line g={ig.publish} label="Publish" />
                <Line g={ig.insights} label="Results" />
                <Line g={ig.comments} label="Comments" />
              </>
            ) : (
              <Line g={ig.api} label="Account connected" />
            )}
            {ig.api.enabled ? (
              <button
                type="button"
                className="st-btn st-btn-ghost st-btn-sm"
                aria-busy={busy === 'review'}
                disabled={!!busy}
                title="One read-only call per permission, so Meta's App Review sees them. Nothing is posted or changed."
                onClick={() =>
                  void run('review', async () => {
                    const j = await call<{ results: { permission: string; ok: boolean; note: string }[] }>('/api/studio/instagram', { project: getProjectId(), action: 'review-calls' });
                    return j.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.permission}: ${r.note}`).join(' · ') + '. Meta updates its counts within 24 hours.';
                  })
                }
              >
                Meta review calls
              </button>
            ) : null}
          </More>
        </Card>

        <Card
          title="Upload-Post"
          tone={upTone}
          status={up.profile ? `“${up.profile}”${up.instagram ? ` · ${up.instagram}` : ''}` : 'Not connected'}
          actions={
            <>
              <button type="button" className={`st-btn ${up.profile ? 'st-btn-ghost' : 'st-btn-primary'} st-btn-sm`} disabled={!!busy || !up.profileSetup.enabled} title={up.profileSetup.enabled ? '' : up.profileSetup.reason} onClick={() => setPick(true)}>
                {up.profile ? 'Change profile' : 'Connect'}
              </button>
              {up.profile ? (
                <>
                  <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'upload-post'} disabled={!!busy || !up.profileSetup.enabled} title={up.profileSetup.enabled ? 'Read-only: reads the profile and its Instagram.' : up.profileSetup.reason} onClick={() => void check('upload-post')}>
                    Check
                  </button>
                  <button
                    type="button"
                    className="st-btn st-btn-ghost st-btn-sm"
                    aria-busy={busy === 'up-remove'}
                    disabled={!!busy}
                    onClick={() => {
                      if (window.confirm(`Remove profile “${up.profile}” from ${d.project.name}? Posting through Upload-Post stops. The profile stays at Upload-Post and the posting limits are kept.`))
                        void run('up-remove', async () => {
                          await project({ action: 'upload-post-profile', profile: '' });
                          announceProjectsChanged();
                          return 'Upload-Post profile removed from this project.';
                        });
                    }}
                  >
                    Remove
                  </button>
                </>
              ) : null}
            </>
          }
        >
          {!up.keySet ? (
            <>
              <span className="xs real-error">API key missing: nothing can be listed or posted.</span>
              <KeyHowTo />
            </>
          ) : null}
          {up.profile ? (
            <Switch
              checked={auto}
              busy={busy === 'up-dispatch'}
              disabled={!!busy || (!auto && !d.account.ready)}
              reason={!auto && !d.account.ready ? 'Set the posting limits first (Manage projects).' : undefined}
              label="Use for posting"
              hint={!auto ? 'Off · you post by hand.' : metaOn ? 'On · Meta posts first; Upload-Post is the fallback.' : up.posting.enabled ? 'On · approved posts go out through Upload-Post.' : `On, but blocked: ${up.posting.reason}`}
              onChange={(on) =>
                void run('up-dispatch', async () => {
                  await project({ action: 'upload-post-dispatch', on });
                  announceProjectsChanged();
                  return on ? 'One-click posting is on.' : 'One-click posting is off. You post by hand.';
                })
              }
            />
          ) : (
            <span className="xs st-muted">{metaOn ? 'Fallback for Meta; also schedules while your machine is off.' : 'Posts and schedules through Upload-Post.'}</span>
          )}
          <More label="More">
            {up.verifiedAt ? <span>Checked {formatDateTime(up.verifiedAt)}</span> : null}
            <Line g={up.posting} label="Post now" />
            <Line g={up.scheduling} label="Schedule (posts while your machine is off)" />
            <Line g={up.results} label="Results" />
            <span>Remove unlinks the profile from this project only; nothing is deleted at Upload-Post.</span>
          </More>
        </Card>

        <Card title="Media bucket (R2)" tone={d.mediaHost.enabled ? 'on' : 'off'} status={d.mediaHost.publicHost ?? 'Not set'}>
          <span className="xs st-muted">{d.mediaHost.enabled ? 'Temporary links Instagram downloads from.' : d.mediaHost.reason}</span>
          <More label="Why?">
            <span>Instagram&apos;s API fetches media from a public link. Files are deleted after publishing.</span>
          </More>
        </Card>

        <Card title="Scheduling in Signal" tone={d.scheduler.enabled && !d.paused.paused ? 'on' : 'off'} status={d.paused.paused ? 'Paused' : d.scheduler.enabled ? 'On' : 'Off'}>
          <span className="xs st-muted">{d.scheduler.enabled ? 'Sends scheduled posts while Signal runs on this machine.' : d.scheduler.reason}</span>
          {d.scheduler.enabled ? (
            <More label="More">
              <span>Missed times wait for you; nothing is sent twice.</span>
            </More>
          ) : null}
        </Card>
      </div>

      <span className="label">Creation</span>
      <div className="conn-grid">
        <Card title="Claude (agents)" tone={d.agents.enabled ? 'on' : 'off'} status={d.agents.enabled ? (d.agents.billing === 'api-key' ? 'Your API key' : 'Your Claude Code sign-in') : 'Off'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'claude'} disabled={!!busy} onClick={() => void check('claude')}>Check</button>}>
          <span className="xs st-muted">{d.agents.enabled ? 'Strategy and planning, only when you press a button.' : d.agents.reason}</span>
        </Card>
        <Card title="Codex (images)" tone={d.codex.enabled ? 'on' : 'off'} status={d.codex.enabled ? 'Your Codex sign-in' : 'Off'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'codex'} disabled={!!busy} onClick={() => void check('codex')}>Check</button>}>
          <span className="xs st-muted">{d.codex.enabled ? 'Draws images when you press Make.' : d.codex.reason}</span>
        </Card>
        <Card title="Brand" tone={d.brand ? 'on' : 'off'} status={d.brand ? d.brand.name : 'Not imported'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={openBrand}>Open Brand</button>}>
          {d.brand ? <span className="xs st-muted">{d.brand.website ?? 'no website'} · updated {formatDateTime(d.brand.updatedAt)}</span> : <span className="xs st-muted">Import the website on the Brand screen.</span>}
        </Card>
      </div>

      <span className="label">Not yet supported</span>
      <div className="conn-grid">
        <Card title="TikTok" tone="soon" status="Not yet"><span className="xs st-muted">Instagram only for now.</span></Card>
        <Card title="YouTube Shorts" tone="soon" status="Not yet"><span className="xs st-muted">Instagram only for now.</span></Card>
      </div>

      {pick ? (
        <ProfilePanel
          project={d.project}
          current={up.profile ?? ''}
          onClose={() => setPick(false)}
          onLinked={async (username) => {
            setPick(false);
            await run('up-link', async () => {
              const j = await project({ action: 'upload-post-profile', profile: username });
              announceProjectsChanged();
              return `Linked “${username}”${j.instagram ? ` · Instagram ${j.instagram}` : ' · no Instagram connected yet'}.`;
            });
          }}
        />
      ) : null}
    </section>
  );
}

/** Side panel: pick a profile on the plan (or create one), connect its Instagram, then link it to this project. */
function ProfilePanel({ project, current, onClose, onLinked }: { project: { id: string; name: string; handle: string }; current: string; onClose: () => void; onLinked: (username: string) => Promise<void> }) {
  const { state, reload } = useUpProfiles();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  useScrollLock();
  // Focus stays inside the panel, Escape closes it, and focus goes back to the button that opened it.
  useFocusTrap(panel, onClose);
  const chosen = state?.profiles.find((p) => p.username === value) ?? null;
  const same = (a: string, b: string) => a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();
  // A profile connected to another Instagram account is never linked (the server refuses it too).
  const mismatch = chosen?.instagram?.handle && !same(chosen.instagram.handle, project.handle) ? chosen.instagram.handle : null;
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  const node = (
    <div className="proj-overlay" role="presentation">
      <div className="proj-panel st-stack" style={{ gap: 14 }} role="dialog" aria-modal="true" aria-label="Upload-Post profile" ref={panel} tabIndex={-1}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 className="section-title" style={{ fontSize: 18 }}>{current ? 'Change profile' : 'Connect Upload-Post'}</h2>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onClose}>Close</button>
        </div>
        <span className="st-small st-muted">
          {project.name} · {project.handle}
        </span>
        {!state ? <span className="st-small st-muted">Loading your Upload-Post profiles…</span> : <UploadPostPicker state={state} reload={reload} value={value} onChange={setValue} slug={project.id} displayName={project.name} />}
        {mismatch ? <span className="st-small real-error" role="alert">“{value}” is connected to {mismatch}, not {project.handle}. Pick a profile connected to {project.handle}.</span> : null}
        <div className="row-wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            aria-busy={busy}
            disabled={busy || !value || value === current || !state?.allowed || !!mismatch}
            onClick={() => {
              setBusy(true);
              void onLinked(value).finally(() => setBusy(false));
            }}
          >
            {current ? 'Use this profile' : 'Link to this project'}
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}
