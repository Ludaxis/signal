'use client';
// Connections: every service the selected project uses, in one place — status, permissions, expiry,
// read-only checks, connect and disconnect. Shows status only; values and secrets never reach the browser.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { notifyChanged, useOnChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { formatDateTime } from '@/lib/time';
import { ScreenSkeleton } from './loaders';

interface Gate { enabled: boolean; reason: string }
interface Conn { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
interface Payload {
  project: { id: string; name: string; handle: string };
  account: { ready: boolean; reason: string; expiresAt: number | null; maxPerDay: number; automaticPosting: boolean };
  paused: { paused: boolean; reason: string };
  instagram: { unifiedLogin: Gate; api: Gate; mode: 'unified' | 'instagram-login' | null; connection: Conn | null; publish: Gate; comments: Gate; insights: Gate };
  uploadPost: { profile: string | null; keySet: boolean; posting: Gate; scheduling: Gate; results: Gate; profileSetup: Gate };
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

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!d) return <ScreenSkeleton variant="connections" count={6} label="Loading connections" />;
  const ig = d.instagram;
  const c = ig.connection;
  const igTone: Tone = ig.api.enabled ? (c?.daysLeft != null && c.daysLeft <= 10 ? 'warn' : 'on') : c?.expired ? 'warn' : 'off';

  return (
    <section className="screen st-stack" style={{ gap: 18 }} aria-label="Connections">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="st-small st-muted">
          Connections for <b>{d.project.name}</b> ({d.project.handle}) · posting limits {d.account.ready ? `set${d.account.expiresAt && Number.isFinite(d.account.expiresAt) ? ` until ${formatDateTime(new Date(d.account.expiresAt).toISOString())}` : ''} · ${d.account.maxPerDay} a day` : `not set: ${d.account.reason}`}
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
                Test (read-only)
              </button>
              <button
                type="button"
                className="st-btn st-btn-ghost st-btn-sm"
                aria-busy={busy === 'review'}
                disabled={!!busy || !ig.api.enabled}
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
              Unified Login · connected {formatDateTime(c.connectedAt)} · {c.expiresAt ? (c.expired ? 'token expired' : `expires in ${c.daysLeft} days`) : 'token does not expire'}
            </span>
          ) : null}
          <Line g={ig.unifiedLogin} label="Meta Unified Login set up" />
          {ig.api.enabled ? (
            <>
              <Line g={ig.publish} label="Publish" />
              <Line g={ig.insights} label="Results (insights)" />
              <Line g={ig.comments} label="Comments" />
            </>
          ) : (
            <Line g={ig.api} label="Account connected" />
          )}
        </Card>

        <Card title="Upload-Post" tone={d.uploadPost.posting.enabled ? 'on' : d.uploadPost.keySet ? 'warn' : 'off'} status={d.uploadPost.profile ? `Profile “${d.uploadPost.profile}”` : 'No profile'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'upload-post'} disabled={!!busy || !d.uploadPost.profileSetup.enabled || !d.uploadPost.profile} title={d.uploadPost.profileSetup.enabled ? '' : d.uploadPost.profileSetup.reason} onClick={() => void check('upload-post')}>Check profile</button>}>
          <Line g={{ enabled: d.uploadPost.keySet, reason: 'UPLOAD_POST_API_KEY is not set' }} label="API key set" />
          <Line g={d.uploadPost.posting} label="Post now" />
          <Line g={d.uploadPost.scheduling} label="Schedule on Upload-Post (posts while your machine is off)" />
          <Line g={d.uploadPost.results} label="Results" />
        </Card>

        <Card title="Media bucket (Cloudflare R2)" tone={d.mediaHost.enabled ? 'on' : 'off'} status={d.mediaHost.publicHost ?? 'Not set'}>
          <span className="xs st-muted">Temporary public links Instagram downloads posts from; files are deleted after publishing.</span>
          {!d.mediaHost.enabled ? <span className="xs st-muted">{d.mediaHost.reason}</span> : null}
        </Card>

        <Card title="Scheduling in Signal" tone={d.scheduler.enabled && !d.paused.paused ? 'on' : 'off'} status={d.paused.paused ? 'Paused' : d.scheduler.enabled ? 'On' : 'Off'}>
          <span className="xs st-muted">Sends scheduled posts while Signal runs on this machine. Missed times wait for you.</span>
        </Card>
      </div>

      <span className="label">Creation</span>
      <div className="conn-grid">
        <Card title="Claude (strategy and planning agents)" tone={d.agents.enabled ? 'on' : 'off'} status={d.agents.enabled ? (d.agents.billing === 'api-key' ? 'Your API key' : 'Your Claude Code sign-in') : 'Off'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'claude'} disabled={!!busy} onClick={() => void check('claude')}>Check Claude Code</button>}>
          <span className="xs st-muted">{d.agents.reason}</span>
        </Card>
        <Card title="Codex (images)" tone={d.codex.enabled ? 'on' : 'off'} status={d.codex.enabled ? 'Your Codex sign-in' : 'Off'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'codex'} disabled={!!busy} onClick={() => void check('codex')}>Check Codex CLI</button>}>
          <span className="xs st-muted">{d.codex.reason}</span>
        </Card>
        <Card title="Brand and sources" tone={d.brand ? 'on' : 'off'} status={d.brand ? d.brand.name : 'Not imported'} actions={<button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={openBrand}>Open Brand</button>}>
          {d.brand?.website ? <span className="xs st-muted">Website: {d.brand.website}</span> : null}
          {d.brand ? <span className="xs st-muted">Updated {formatDateTime(d.brand.updatedAt)}</span> : null}
        </Card>
      </div>

      <span className="label">Not yet supported</span>
      <div className="conn-grid">
        <Card title="TikTok" tone="soon" status="Not available yet"><span className="xs st-muted">Instagram only for now.</span></Card>
        <Card title="YouTube Shorts" tone="soon" status="Not available yet"><span className="xs st-muted">Instagram only for now.</span></Card>
      </div>
    </section>
  );
}
