'use client';
// Connections: everything Signal is connected to, for the selected project.
//
// Layout (from integration-settings practice: status first, one clear action per service, details
// on demand):
//   1. "Ready to post": the three things that decide whether dragging a post to Posted publishes it,
//      as a checklist with the switch or button for each step. Done steps collapse to a tick.
//   2. Lists by job: Publishing, Creating, Sources. One row per service: name, one line of state,
//      a status pill (Connected / Needs attention / Not set up / Off) and one button. Grey means
//      "not set up", amber means "set up but needs you", green means "working"; red is not used.
//   3. Everything else (keys, tests, disconnect, permissions) in the service's side panel.
// Secrets never reach the browser: keys are written once and shown only as "Saved · …1234".
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { notifyChanged, useOnChanged } from './sync';
import { announceProjectsChanged, getProjectId, useFocusTrap, useProjectId, useScrollLock } from './Projects';
import { formatDateTime } from '@/lib/time';
import { ScreenSkeleton } from './loaders';
import { More } from './More';
import { UploadPostPicker, parseQuota, quotaText, useUpProfiles } from './UploadPostPicker';
import { desktop } from './desktop';
import { FigmaPanel, FoldersPanel, Panel, ToolBlock, useWorkspace, type Tool } from './Workspace';
import { FeaturesSection, KeyForm, settingsCall, useSettings, type GroupStatus, type SwitchId } from './Keys';

interface Gate { enabled: boolean; reason: string }
interface Conn { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
interface Payload {
  project: { id: string; name: string; handle: string };
  account: { ready: boolean; reason: string; expiresAt: number | null; maxPerDay: number; automaticPosting: boolean };
  paused: { paused: boolean; reason: string };
  instagram: { unifiedLogin: Gate; api: Gate; mode: 'unified' | 'instagram-login' | null; connection: Conn | null; publish: Gate; comments: Gate; insights: Gate };
  uploadPost: { profile: string | null; instagram: string | null; verifiedAt: string | null; keySet: boolean; posting: Gate; scheduling: Gate; results: Gate; profileSetup: Gate; quota?: unknown };
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

// ---- small building blocks -------------------------------------------------------------------------
type Tone = 'ok' | 'warn' | 'idle' | 'off';
const Pill = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`cx-pill cx-pill-${tone}`}>{children}</span>;

function Row({ mark, name, tone, status, detail, action }: { mark: string; name: string; tone: Tone; status: string; detail: ReactNode; action: ReactNode }) {
  return (
    <li className="cx-row">
      <span className={`cx-mark cx-mark-${tone}`} aria-hidden="true">{mark}</span>
      <div className="cx-row-main">
        <div className="cx-row-top">
          <span className="cx-name">{name}</span>
          <Pill tone={tone}>{status}</Pill>
        </div>
        <span className="cx-detail">{detail}</span>
      </div>
      <div className="cx-row-action" role="group" aria-label={name}>
        {action}
      </div>
    </li>
  );
}

function Section({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="cx-section" aria-labelledby={`cx-${id}`}>
      <div className="cx-section-head">
        <h2 id={`cx-${id}`} className="cx-h2">{title}</h2>
        <p className="cx-sub">{sub}</p>
      </div>
      <ul className="cx-list st-card">{children}</ul>
    </section>
  );
}

function Toggle({ on, label, busy, disabled, title, onChange }: { on: boolean; label: string; busy?: boolean; disabled?: boolean; title?: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="ap-switch" disabled={disabled} aria-busy={busy || undefined} title={title} onClick={() => onChange(!on)}>
      <span className="ap-knob" aria-hidden="true" />
    </button>
  );
}

const Check = ({ g, label }: { g: Gate; label: string }) => (
  <li className={g.enabled ? 'cx-check is-ok' : 'cx-check'}>
    <span aria-hidden="true">{g.enabled ? '✓' : '–'}</span>
    <span>
      {label}
      {!g.enabled && g.reason ? <span className="st-muted"> · {g.reason}</span> : null}
    </span>
  </li>
);

function Btn({ primary, children, ...rest }: { primary?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`st-btn ${primary ? 'st-btn-primary' : 'st-btn-ghost'} st-btn-sm`} {...rest}>
      {children}
    </button>
  );
}

type Open = 'meta' | 'r2' | 'upload-post' | 'claude' | 'codex' | 'higgsfield' | 'folders' | 'figma' | null;

// ---- the screen --------------------------------------------------------------------------------------
export function Connections({ say, openBrand }: { say: (t: string) => void; openBrand: () => void }) {
  const pid = useProjectId();
  const [d, setD] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [pick, setPick] = useState(false);
  const settings = useSettings();
  const ws = useWorkspace(say);
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
      await Promise.all([load(), settings.load()]);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const check = (service: string) => run(service, async () => (await call<{ message: string }>('/api/studio/connections', { project: getProjectId(), action: 'check', service })).message);
  const project = (body: Record<string, unknown>) => call<{ instagram?: string | null; dispatch?: boolean }>(`/api/studio/projects/${encodeURIComponent(getProjectId() ?? '')}`, body);
  const flip = (id: SwitchId, on: boolean) => run(id, async () => (await settingsCall({ action: 'switch', id, on })).message);
  const reloadAll = async () => {
    notifyChanged('connections', 'content');
    await Promise.all([load(), settings.load()]);
  };

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!d || !settings.d) return <ScreenSkeleton variant="connections" count={6} label="Loading connections" />;
  const s = settings.d;
  const group = (id: string) => s.groups.find((g) => g.id === id) as GroupStatus;

  // ---- derived state ----
  const ig = d.instagram;
  const c = ig.connection;
  const up = d.uploadPost;
  const auto = d.account.automaticPosting;
  const publishingOn = s.switches.publishing.on;
  const igConnected = Boolean(c && !c.expired) || ig.mode === 'instagram-login';
  const metaRoute = ig.api.enabled && ig.publish.enabled && d.mediaHost.enabled;
  const upRoute = up.keySet && Boolean(up.profile);
  const route = metaRoute && upRoute ? 'Meta first, Upload-Post as backup' : metaRoute ? 'Through Meta (Instagram API)' : upRoute ? 'Through Upload-Post' : null;
  const steps = [Boolean(route), auto, publishingOn];
  const left = steps.filter((x) => !x).length;
  const tools = ws.d?.tools;
  const higgs = group('higgsfield');

  const igRow = (() => {
    if (c?.expired) return { tone: 'warn' as Tone, status: 'Reconnect', detail: `@${c.username} · the sign-in expired` };
    if (c) return { tone: (c.daysLeft != null && c.daysLeft <= 10 ? 'warn' : 'ok') as Tone, status: c.daysLeft != null && c.daysLeft <= 10 ? 'Expires soon' : 'Connected', detail: `@${c.username} · ${c.expiresAt ? `sign-in valid for ${c.daysLeft} more days` : 'no expiry'}` };
    if (ig.mode === 'instagram-login') return { tone: 'ok' as Tone, status: 'Connected', detail: 'Legacy token from .env.local' };
    return { tone: 'idle' as Tone, status: 'Not set up', detail: ig.unifiedLogin.enabled ? 'Connect the Instagram account through Meta.' : 'Add your Meta app, then connect the Instagram account.' };
  })();
  const r2Row = d.mediaHost.enabled
    ? { tone: 'ok' as Tone, status: 'Ready', detail: `${d.mediaHost.publicHost} · temporary links for Meta` }
    : { tone: (igConnected ? 'warn' : 'idle') as Tone, status: igConnected ? 'Needed for Meta' : 'Not set up', detail: 'Instagram’s API downloads each file from a public link. Needed to post through Meta.' };
  const upRow = up.profile
    ? up.keySet
      ? { tone: 'ok' as Tone, status: 'Connected', detail: `Profile “${up.profile}”${up.instagram ? ` · ${up.instagram}` : ''}` }
      : { tone: 'warn' as Tone, status: 'Key missing', detail: `Profile “${up.profile}” · add the API key to post` }
    : { tone: 'idle' as Tone, status: up.keySet ? 'Pick a profile' : 'Not set up', detail: 'Posts and schedules, also while this machine is off.' };
  const toolRow = (t: Tool | undefined, gate: Gate, what: string) =>
    !t ? { tone: 'idle' as Tone, status: 'Checking…', detail: what } : !t.found ? { tone: 'idle' as Tone, status: 'Not found', detail: `Not installed on this machine. ${what}` } : !gate.enabled ? { tone: 'off' as Tone, status: 'Off', detail: `${t.version} · ${gate.reason}` } : t.signedIn === false ? { tone: 'warn' as Tone, status: 'Sign in', detail: `${t.version} · not signed in` } : { tone: 'ok' as Tone, status: 'Ready', detail: `${t.version} · ${what}` };
  const claudeRow = toolRow(tools?.claude, d.agents, 'Strategy, planning and the agent team.');
  const codexRow = toolRow(tools?.codex, d.codex, 'Draws images when you press Make.');
  const higgsRow = higgs.complete ? { tone: 'ok' as Tone, status: 'Ready', detail: 'Images and Reels, paid per request.' } : { tone: 'idle' as Tone, status: 'Not set up', detail: 'Images and Reels, paid per request.' };
  const folders = ws.d?.folders ?? [];
  const figma = ws.d?.figma;
  const quota = parseQuota(up.quota);
  // Meta's sign-in needs this browser's session cookie on the way back; inside the Mac app it opens in the
  // system browser without it and fails. Until the app has its own sign-in window, connect from a browser
  // (see docs/instagram-unified-login.md).
  const inApp = Boolean(desktop());
  const connectBlocked = inApp ? 'Inside the Mac app, Meta’s sign-in opens in your browser without this session and cannot finish. Open Signal in your browser to connect Instagram (see docs/instagram-unified-login.md).' : '';

  return (
    <section className="screen cx" aria-label="Connections">
      {/* 1. Ready to post */}
      <section className={`cx-ready st-card ${left ? '' : 'is-ready'}`} aria-labelledby="cx-ready-title">
        <div className="cx-ready-head">
          <span className={`cx-ready-badge ${left ? '' : 'is-ok'}`} aria-hidden="true">{left ? left : '✓'}</span>
          <div className="cx-ready-text">
            <h2 id="cx-ready-title" className="cx-h1">{left ? `${left} step${left === 1 ? '' : 's'} before Signal can post for you` : 'Ready to post'}</h2>
            <p className="cx-sub">{left ? `Then dragging a post to Posted publishes it to ${d.project.handle}.` : `Drag a post to Posted and it goes out to ${d.project.handle} · ${route}.`}</p>
          </div>
          <Btn aria-busy={busy === 'refresh'} disabled={!!busy} onClick={() => void run('refresh', async () => undefined)}>Refresh</Btn>
        </div>
        <ol className="cx-steps">
          <li className={`cx-step ${route ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{route ? '✓' : '1'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">A way to post</span>
              <span className="cx-step-sub">{route ?? 'Connect Instagram through Meta (with a media bucket), or Upload-Post.'}</span>
            </div>
            {route ? null : (
              <div className="row-wrap cx-step-act">
                {up.profile || up.keySet ? (
                  <>
                    <Btn primary onClick={() => setOpen('upload-post')}>{up.keySet ? 'Choose Upload-Post profile' : 'Add Upload-Post key'}</Btn>
                    <Btn onClick={() => setOpen(igConnected ? 'r2' : 'meta')}>{igConnected ? 'Add media bucket' : 'Use Meta instead'}</Btn>
                  </>
                ) : (
                  <>
                    <Btn primary onClick={() => setOpen(igConnected ? 'r2' : 'meta')}>{igConnected ? 'Add media bucket' : 'Set up Meta'}</Btn>
                    <Btn onClick={() => setOpen('upload-post')}>Use Upload-Post</Btn>
                  </>
                )}
              </div>
            )}
          </li>
          <li className={`cx-step ${auto ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{auto ? '✓' : '2'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">Posting for {d.project.handle}</span>
              <span className="cx-step-sub">{!d.account.ready ? d.account.reason || 'Set the posting limits first (Manage projects).' : auto ? `On · up to ${d.account.maxPerDay} a day${d.account.expiresAt && Number.isFinite(d.account.expiresAt) ? `, until ${formatDateTime(new Date(d.account.expiresAt).toISOString())}` : ''}.` : 'Off · you post by hand and record the link.'}</span>
            </div>
            <Toggle
              on={auto}
              label={`Posting for ${d.project.handle}`}
              busy={busy === 'dispatch'}
              disabled={!!busy || (!auto && !d.account.ready)}
              title={!auto && !d.account.ready ? 'Set the posting limits first (Manage projects).' : undefined}
              onChange={(on) =>
                void run('dispatch', async () => {
                  await project({ action: 'upload-post-dispatch', on });
                  announceProjectsChanged();
                  return on ? `Posting is on for ${d.project.handle}.` : `Posting is off for ${d.project.handle}. You post by hand.`;
                })
              }
            />
          </li>
          <li className={`cx-step ${publishingOn ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{publishingOn ? '✓' : '3'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">Publishing</span>
              <span className="cx-step-sub">{publishingOn ? 'On for every project. Turn off to pause all posting at once.' : 'Paused for every project: nothing is posted or scheduled.'}</span>
            </div>
            <Toggle on={publishingOn} label="Publishing" busy={busy === 'publishing'} disabled={!!busy || !s.ready} title={s.ready ? undefined : s.reason} onChange={(on) => void flip('publishing', on)} />
          </li>
        </ol>
        <div className="cx-ready-foot">
          <div className="cx-foot-item">
            <Toggle on={s.switches.autopilot.on} label="Autopilot" busy={busy === 'autopilot'} disabled={!!busy || !s.ready} onChange={(on) => void flip('autopilot', on)} />
            <span>
              <b>Autopilot</b> <span className="st-muted">{s.switches.autopilot.on ? 'runs once a day where it is set up' : 'paused'}</span>
            </span>
          </div>
          <span className="cx-foot-note">
            Scheduled posts: {!publishingOn ? 'paused' : d.scheduler.enabled ? 'sent while Signal runs on this machine' : up.scheduling.enabled ? 'sent by Upload-Post' : 'not available yet'}
          </span>
        </div>
      </section>

      {/* 2. Publishing */}
      <Section id="pub" title="Publishing" sub="Where approved posts go.">
        <Row mark="IG" name="Instagram (Meta)" {...igRow} action={<Btn onClick={() => setOpen('meta')}>{c || ig.mode ? 'Manage' : 'Set up'}</Btn>} />
        <Row mark="R2" name="Media bucket" {...r2Row} action={<Btn onClick={() => setOpen('r2')}>{d.mediaHost.enabled ? 'Manage' : 'Set up'}</Btn>} />
        <Row mark="UP" name="Upload-Post" {...upRow} action={<Btn onClick={() => setOpen('upload-post')}>{up.profile || up.keySet ? 'Manage' : 'Set up'}</Btn>} />
      </Section>

      {/* 3. Creating */}
      <Section id="make" title="Creating" sub="Tools that write and draw posts. They run only when you ask, or in Autopilot.">
        <Row mark="CC" name="Claude Code" {...claudeRow} action={<Btn onClick={() => setOpen('claude')}>Manage</Btn>} />
        <Row mark="CX" name="Codex" {...codexRow} action={<Btn onClick={() => setOpen('codex')}>Manage</Btn>} />
        <Row mark="HF" name="Higgsfield" {...higgsRow} action={<Btn onClick={() => setOpen('higgsfield')}>{higgs.complete ? 'Manage' : 'Set up'}</Btn>} />
      </Section>

      {/* 4. Sources */}
      <Section id="src" title="Sources" sub="What Signal learns your brand and assets from. Read-only.">
        <Row mark="Br" name="Brand" tone={d.brand ? 'ok' : 'idle'} status={d.brand ? 'Imported' : 'Not set up'} detail={d.brand ? `${d.brand.name} · ${d.brand.website ?? 'no website'} · updated ${formatDateTime(d.brand.updatedAt)}` : 'Colours, fonts, logo and voice from your website or a folder.'} action={<Btn onClick={openBrand}>Open Brand</Btn>} />
        <Row mark="Fo" name="Project folders" tone={folders.length ? 'ok' : 'idle'} status={folders.length ? `${folders.length} linked` : 'None'} detail={folders.length ? folders.map((f) => f.label).join(' · ') : 'Art, screenshots and notes from this machine.'} action={<Btn onClick={() => setOpen('folders')}>{folders.length ? 'Open' : 'Link a folder'}</Btn>} />
        <Row mark="Fi" name="Figma" tone={figma?.connected ? 'ok' : 'idle'} status={figma?.connected ? 'Connected' : 'Not set up'} detail={!figma ? 'Export frames into this project.' : !figma.ready ? figma.reason : figma.connected ? `${figma.user} · ${figma.files.length} file${figma.files.length === 1 ? '' : 's'} · ${figma.imports.length} exported` : 'Export frames into this project with your own token.'} action={<Btn disabled={!figma?.ready} onClick={() => setOpen('figma')}>{figma?.connected ? 'Open' : 'Connect'}</Btn>} />
      </Section>

      <FeaturesSection say={say} />

      <p className="cx-soon">Coming next: TikTok and YouTube Shorts, through Upload-Post.</p>

      {/* ---- panels ---- */}
      {open === 'meta' ? (
        <Panel title="Instagram (Meta)" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Posts, results and comments through Instagram’s own API. Needs your Meta app and, for posting, the media bucket.</p>
          <div className="cx-panel-block">
            <span className="cx-subhead">Account</span>
            <span className="st-small">{c ? `@${c.username} · connected ${formatDateTime(c.connectedAt)} · ${c.expiresAt ? (c.expired ? 'sign-in expired' : `valid for ${c.daysLeft} more days`) : 'no expiry'}` : ig.mode === 'instagram-login' ? 'Legacy token from .env.local' : 'Not connected'}</span>
            <div className="row-wrap" style={{ gap: 8 }}>
              <Btn
                primary
                aria-busy={busy === 'connect'}
                disabled={!!busy || !ig.unifiedLogin.enabled || inApp}
                title={connectBlocked || (ig.unifiedLogin.enabled ? '' : ig.unifiedLogin.reason)}
                onClick={() =>
                  void run('connect', async () => {
                    const j = await call<{ url: string }>('/api/studio/instagram', { project: getProjectId(), action: 'connect-start' });
                    window.location.assign(j.url);
                  })
                }
              >
                {c ? 'Connect again' : 'Connect with Meta'}
              </Btn>
              <Btn aria-busy={busy === 'igtest'} disabled={!!busy || !ig.api.enabled} onClick={() => void run('igtest', async () => { const j = await call<{ account: { username: string; followers: number | null }; quota: { used: number; total: number } | null }>('/api/studio/instagram', { project: getProjectId(), action: 'test' }); return `Works: @${j.account.username}${j.quota ? ` · ${j.quota.used}/${j.quota.total} API posts used today` : ''}. Nothing was posted.`; })}>
                Test
              </Btn>
              {c ? (
                <Btn aria-busy={busy === 'disc'} disabled={!!busy} onClick={() => { if (window.confirm(`Disconnect @${c.username}? Signal deletes its stored token on this machine. To revoke it at Meta too, remove the app from the business portfolio's integrations.`)) void run('disc', async () => { await call('/api/studio/instagram', { project: getProjectId(), action: 'disconnect' }); return 'Disconnected. The token was deleted on this machine.'; }); }}>
                  Disconnect
                </Btn>
              ) : null}
            </div>
            {!ig.unifiedLogin.enabled ? <span className="xs st-muted">{ig.unifiedLogin.reason}</span> : connectBlocked ? <span className="xs st-muted">{connectBlocked}</span> : null}
            <ul className="cx-checks">
              {ig.api.enabled ? (
                <>
                  <Check g={ig.publish} label="Publish" />
                  <Check g={ig.insights} label="Results" />
                  <Check g={ig.comments} label="Comments" />
                  <Check g={d.mediaHost} label="Media bucket" />
                </>
              ) : (
                <Check g={ig.api} label="Account connected" />
              )}
            </ul>
          </div>
          <KeyForm group={group('meta')} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="Meta app" />
          {ig.api.enabled ? (
            <More label="Advanced">
              <span>One read-only call per permission, so Meta’s App Review sees them. Nothing is posted or changed.</span>
              <Btn
                aria-busy={busy === 'review'}
                disabled={!!busy}
                onClick={() =>
                  void run('review', async () => {
                    const j = await call<{ results: { permission: string; ok: boolean; note: string }[] }>('/api/studio/instagram', { project: getProjectId(), action: 'review-calls' });
                    return j.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.permission}: ${r.note}`).join(' · ') + '. Meta updates its counts within 24 hours.';
                  })
                }
              >
                Make Meta review calls
              </Btn>
            </More>
          ) : null}
        </Panel>
      ) : null}

      {open === 'r2' ? (
        <Panel title="Media bucket" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Instagram’s API downloads each image or video from a public link. Signal puts the approved files in your Cloudflare R2 bucket just before posting and deletes them once Instagram has them.</p>
          <KeyForm group={group('r2')} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="Cloudflare R2" />
        </Panel>
      ) : null}

      {open === 'upload-post' ? (
        <Panel title="Upload-Post" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Posts and schedules through Upload-Post, also while this machine is off, and reads results.</p>
          <KeyForm group={group('upload-post')} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="API key" />
          <div className="cx-panel-block">
            <span className="cx-subhead">Profile for {d.project.handle}</span>
            <span className="st-small">{up.profile ? `“${up.profile}”${up.instagram ? ` · ${up.instagram}` : ' · no Instagram seen yet'}${up.verifiedAt ? ` · checked ${formatDateTime(up.verifiedAt)}` : ''}` : 'None linked yet.'}</span>
            <div className="row-wrap" style={{ gap: 8 }}>
              <Btn primary={!up.profile} disabled={!!busy || !up.profileSetup.enabled} title={up.profileSetup.enabled ? '' : up.profileSetup.reason} onClick={() => { setOpen(null); setPick(true); }}>{up.profile ? 'Change profile' : 'Choose profile'}</Btn>
              {up.profile ? (
                <>
                  <Btn aria-busy={busy === 'upload-post'} disabled={!!busy || !up.profileSetup.enabled} title="Read-only: reads the profile and its Instagram." onClick={() => void check('upload-post')}>Check</Btn>
                  <Btn
                    aria-busy={busy === 'up-remove'}
                    disabled={!!busy}
                    onClick={() => {
                      if (window.confirm(`Remove profile “${up.profile}” from ${d.project.name}? Posting through Upload-Post stops. The profile stays at Upload-Post.`))
                        void run('up-remove', async () => {
                          await project({ action: 'upload-post-profile', profile: '' });
                          announceProjectsChanged();
                          return 'Upload-Post profile removed from this project.';
                        });
                    }}
                  >
                    Remove
                  </Btn>
                </>
              ) : null}
            </div>
            {up.keySet && !up.profileSetup.enabled ? <span className="xs st-muted">{up.profileSetup.reason}</span> : null}
            <ul className="cx-checks">
              <Check g={up.posting} label="Post now" />
              <Check g={up.scheduling} label="Schedule (posts while the Mac is off)" />
              <Check g={up.results} label="Results" />
            </ul>
            {quota ? <span className="xs st-muted">{quotaText(quota)} (all projects on the plan).</span> : null}
          </div>
        </Panel>
      ) : null}

      {open === 'claude' && tools ? (
        <Panel title="Claude Code" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Runs the strategist, planner and agent team with your own Claude Code sign-in on this machine, only when you ask (or in Autopilot).</p>
          <div className="cx-panel-block">
            <span className="cx-subhead">On this machine</span>
            <span className="st-small">{tools.claude.found ? tools.claude.version : 'Not found'}</span>
            <ToolBlock tool={tools.claude} busy={ws.busy} run={ws.run} />
            <div className="row-wrap" style={{ gap: 8 }}>
              <Btn aria-busy={busy === 'claude'} disabled={!!busy} onClick={() => void check('claude')}>Check</Btn>
            </div>
            <ul className="cx-checks">
              <Check g={d.agents} label={d.agents.billing === 'api-key' ? 'Agents · billed to your API key' : 'Agents · on your Claude Code sign-in'} />
            </ul>
          </div>
          <KeyForm group={group('anthropic')} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="Anthropic API key (optional)" />
        </Panel>
      ) : null}

      {open === 'codex' && tools ? (
        <Panel title="Codex" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Draws images with your own Codex sign-in on this machine, when you press Make.</p>
          <div className="cx-panel-block">
            <span className="cx-subhead">On this machine</span>
            <span className="st-small">{tools.codex.found ? `${tools.codex.version}${tools.codex.signedIn === false ? ' · not signed in (run codex login)' : tools.codex.signedIn ? ' · signed in' : ''}` : 'Not found'}</span>
            <ToolBlock tool={tools.codex} busy={ws.busy} run={ws.run} />
            <div className="row-wrap" style={{ gap: 8 }}>
              <Btn aria-busy={busy === 'codex'} disabled={!!busy} onClick={() => void check('codex')}>Check</Btn>
            </div>
            <ul className="cx-checks">
              <Check g={d.codex} label="Codex images for this account" />
            </ul>
          </div>
        </Panel>
      ) : null}

      {open === 'higgsfield' ? (
        <Panel title="Higgsfield" onClose={() => setOpen(null)}>
          <p className="st-small st-muted" style={{ margin: 0 }}>Images and Reels from Higgsfield. Paid per request; each run shows its cost first.</p>
          <KeyForm group={higgs} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="API keys" />
        </Panel>
      ) : null}

      {open === 'folders' && ws.d ? <FoldersPanel folders={ws.d.folders} busy={ws.busy} run={ws.run} onClose={() => setOpen(null)} /> : null}
      {open === 'figma' && ws.d ? <FigmaPanel figma={ws.d.figma} busy={ws.busy} run={ws.run} say={say} onClose={() => setOpen(null)} /> : null}

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
