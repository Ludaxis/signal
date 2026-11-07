'use client';
// Connections: every service Signal uses, for the selected project.
//
//   1. The ready card: "n steps to start posting" (a way to post, posting for the account, the Posting switch).
//      Its next setup step is the only filled button on the screen.
//   2. Groups by job: Publishing, Making (one row per capability: voice, lip-sync, music, video, images, agents,
//      rendering, fed by the connectors backend's `making: ConnectorRow[]`), then Sources and Features behind one
//      closed disclosure labelled with their row count. A row is a service mark, a name, one state line (≤ 6 words),
//      a status pill from the dictionary (Ready, Needs you, Off, Not set up) and one action: a switch (off by default)
//      or a button. A Making row carries its primary connector's state and switch; the alternatives and their
//      switches sit in the row's drawer.
//   3. Everything else (keys, tests, disconnect) sits in the service's drawer; `?tab=connections&service=<id>`
//      opens it directly (a connector id opens the drawer of the capability that holds it).
// Features: the Post maker switch and its paid services, each off by default and kept in signal.config.json. Turning
// a paid service on the first time asks once to accept its terms (the answer is kept in signal.config.json too).
// The other feature switches of signal.config.json sit below them.
// Secrets never reach the browser: keys are written once and shown only as "Saved · …1234". Only a payload without
// `making` falls back to connections-making.ts (Off or Not set up). A row's drawer runs its free check
// (`connector.test`) and its own switch (`connector.switch`).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { notifyChanged, useOnChanged } from './sync';
import { announceProjectsChanged, getProjectId, useFocusTrap, useProjectId, useScrollLock } from './Projects';
import { formatIn } from '@/lib/studio/time';
import { ScreenSkeleton } from './loaders';
import { More } from './More';
import { UploadPostPicker, parseQuota, quotaText, useUpProfiles } from './UploadPostPicker';
import { FigmaPanel, FoldersPanel, ToolBlock, useWorkspace, type Tool } from './Workspace';
import { desktop } from './desktop';
import { FeaturesSection, KeyForm, settingsCall, useSettings, type GroupStatus, type SwitchId } from './Keys';
import { t } from './copy/en';
import { Button, Drawer, Notice, Pill, Row, ServiceMark, useConfirm, type StatusWord } from './ui';
import { navigateTo, useUrlParam } from './url-state';
import { KEY_GROUP, KNOWN_CONNECTORS, LOCAL_CONNECTORS, POSTMAKER_FEATURES, capabilityGroups, capabilityLine, fallbackMaking, featureRowsOf, hasSwitch, parseConnectorRow, parseMaking, statePhrase, type CapabilityGroup, type ConnectorRow } from './connections-making';

interface Gate { enabled: boolean; reason: string }
interface Conn { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
export interface ConnectionsPayload {
  project: { id: string; name: string; handle: string; timeZone?: string };
  account: { ready: boolean; reason: string; expiresAt: number | null; maxPerDay: number; automaticPosting: boolean };
  paused: { paused: boolean; reason: string };
  instagram: { unifiedLogin: Gate; api: Gate; mode: 'unified' | 'instagram-login' | null; connection: Conn | null; publish: Gate; comments: Gate; insights: Gate };
  uploadPost: { profile: string | null; instagram: string | null; verifiedAt: string | null; keySet: boolean; posting: Gate; scheduling: Gate; results: Gate; profileSetup: Gate; quota?: unknown };
  mediaHost: Gate & { publicHost: string | null };
  scheduler: Gate;
  agents: Gate & { billing?: 'subscription' | 'api-key' };
  codex: Gate;
  brand: { name: string; website: string | null; sources: string[]; updatedAt: string } | null;
  /** The connectors backend's rows, ConnectorRow[]; parsed field by field before use. */
  making?: unknown;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { code?: string; message: string } };
  if (!r.ok) throw Object.assign(new Error(j.error?.message ?? `HTTP ${r.status}`), { code: j.error?.code ?? null });
  return j;
}

// ---- small building blocks -------------------------------------------------------------------------
function Switch({ on, label, busy, disabled, reason, onChange }: { on: boolean; label: string; busy?: boolean; disabled?: boolean; reason?: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="ap-switch" disabled={disabled} aria-busy={busy || undefined} title={disabled ? reason : undefined} onClick={() => onChange(!on)}>
      <span className="ap-knob" aria-hidden="true" />
    </button>
  );
}

/** keepLine: a switch row always shows its state line, even when it repeats the pill word. */
interface RowModel { id: string; title: string; pill: StatusWord; line: ReactNode; amber?: boolean; action: ReactNode; keepLine?: boolean }

function ServiceRow({ m, onOpen }: { m: RowModel; onOpen: (id: string) => void }) {
  return (
    <li data-service={m.id}>
      <Row
        leading={<ServiceMark name={m.title} />}
        title={
          <button type="button" className="cx-row-name" onClick={() => onOpen(m.id)}>
            {m.title}
          </button>
        }
        // A line that only repeats the pill word adds nothing (text budget).
        line={m.line === m.pill && !m.keepLine ? undefined : <span className={m.amber ? 'cx-line-amber' : undefined}>{m.line}</span>}
        status={<Pill status={m.pill} />}
        action={m.action}
      />
    </li>
  );
}

function Group({ id, title, rows, onOpen }: { id: string; title: string; rows: RowModel[]; onOpen: (id: string) => void }) {
  if (!rows.length) return null;
  return (
    <section className="cx-group" aria-labelledby={`cx-${id}`}>
      <h2 id={`cx-${id}`} className="cx-group-title">
        {title}
      </h2>
      <ul className="cx-rows">
        {rows.map((m) => (
          <ServiceRow key={m.id} m={m} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

const Check = ({ g, label }: { g: Gate; label: string }) => (
  <li className={g.enabled ? 'cx-check is-ok' : 'cx-check'}>
    <span aria-hidden="true">{g.enabled ? '✓' : '–'}</span>
    <span>{label}</span>
  </li>
);

/** The legacy services Signal already checks, as making-row state (used until `making` arrives). */
function toolState(tool: Tool | undefined, gate: Gate): { pill: StatusWord; line: string; amber?: boolean } {
  if (!tool) return { pill: 'Not set up', line: t('connections.line.checking') };
  if (!tool.found) return { pill: 'Not set up', line: t('connections.line.notFound') };
  if (!gate.enabled) return { pill: 'Off', line: t('connections.line.off') };
  if (tool.signedIn === false) return { pill: 'Needs you', line: t('connections.line.signIn'), amber: true };
  return { pill: 'Ready', line: tool.version ?? t('connections.line.ready') };
}

export function Connections({ say, openBrand }: { say: (t: string) => void; openBrand: () => void }) {
  const confirmBox = useConfirm();
  const pid = useProjectId();
  const [d, setD] = useState<ConnectionsPayload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpenState] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const [figmaPanel, setFigmaPanel] = useState(false);
  const [patched, setPatched] = useState<Record<string, ConnectorRow>>({});
  // Meta's sign-in needs this browser's session cookie on the way back; inside the desktop app it opens in the system
  // browser without it and cannot finish, so the app asks to connect from a browser (docs/instagram-unified-login.md).
  const inApp = desktop() !== null; // read after hydration: panels open only on a click
  const settings = useSettings();
  const ws = useWorkspace(say);
  const service = useUrlParam('service');
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      setD(await call<ConnectionsPayload>(`/api/studio/connections?project=${encodeURIComponent(pid)}`));
      setPatched({});
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

  // Opening a drawer puts its id in the URL (?service=<id>), so the link can be shared and reload keeps it.
  const setOpen = useCallback((id: string | null) => {
    setOpenState(id);
    navigateTo('connections', { replace: true, params: id ? { service: id } : {} });
  }, []);
  const deepLinked = useRef<string | null>(null);
  useEffect(() => {
    if (!d || !service || deepLinked.current === service) return;
    deepLinked.current = service;
    const timer = setTimeout(() => setOpenState(service), 0);
    return () => clearTimeout(timer);
  }, [d, service]);

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
  const check = (svc: string) => run(svc, async () => (await call<{ message: string }>('/api/studio/connections', { project: getProjectId(), action: 'check', service: svc })).message);
  const project = (body: Record<string, unknown>) => call<{ instagram?: string | null; dispatch?: boolean }>(`/api/studio/projects/${encodeURIComponent(getProjectId() ?? '')}`, body);
  const flip = (id: SwitchId, on: boolean) => run(id, async () => (await settingsCall({ action: 'switch', id, on })).message);
  const reloadAll = async () => {
    notifyChanged('connections', 'content');
    await Promise.all([load(), settings.load()]);
  };
  /**
   * `connector.switch`: the answer is the row as it is now. Turning a paid service on the first time asks once to
   * accept its terms; the answer is sent with the switch and kept in signal.config.json.
   */
  const switchConnector = async (r: ConnectorRow, on: boolean) => {
    setBusy(`sw-${r.id}`);
    const send = (acceptTerms: boolean) => call<unknown>('/api/studio/connections', { project: getProjectId(), action: 'connector.switch', id: r.id, on, ...(acceptTerms ? { acceptTerms: true } : {}) });
    try {
      let j: unknown;
      try {
        j = await send(false);
      } catch (e) {
        if ((e as { code?: string }).code !== 'terms-needed') throw e;
        const ok = await confirmBox.confirm({ title: t('connections.terms.title', { service: r.title }), body: t('connections.terms.body', { service: r.title }), confirmLabel: t('connections.terms.confirm') });
        if (!ok) return;
        j = await send(true);
      }
      const next = parseConnectorRow((j as { row?: unknown })?.row ?? j);
      if (!next) throw new Error('bad answer');
      setPatched((p) => ({ ...p, [r.id]: next }));
      say(next.switchOn ? t('connections.switchedOn', { service: r.title }) : t('connections.switchedOff', { service: r.title }));
      notifyChanged('connections');
      await settings.load();
    } catch {
      say(t('common.couldNotChange', { thing: r.title }));
    } finally {
      setBusy(null);
    }
  };
  /** `connector.test`: the connector's free check (never a paid call); the answer carries the row as it is now. */
  const testConnector = async (r: ConnectorRow) => {
    setBusy(`test-${r.id}`);
    try {
      const j = await call<{ ok?: boolean; message?: string; row?: unknown }>('/api/studio/connections', { project: getProjectId(), action: 'connector.test', id: r.id });
      const next = parseConnectorRow(j.row);
      if (next) setPatched((p) => ({ ...p, [r.id]: next }));
      say(typeof j.message === 'string' && j.message ? `${r.title}: ${j.message}` : r.title);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (err && !d) {
    return (
      <section className="screen" aria-label="Connections">
        <Notice kind="error" title={t('connections.couldNotLoad')} details={err} onRetry={() => void load()} />
      </section>
    );
  }
  if (!d || !settings.d) return <ScreenSkeleton variant="connections" count={6} label={t('connections.loading')} />;
  const s = settings.d;
  const group = (id: string) => s.groups.find((g) => g.id === id) as GroupStatus | undefined;
  const tz = d.project.timeZone;
  const handle = d.project.handle;

  // ---- derived state ----
  const ig = d.instagram;
  const c = ig.connection;
  const up = d.uploadPost;
  const auto = d.account.automaticPosting;
  const publishingOn = s.switches.publishing.on;
  const igConnected = Boolean(c && !c.expired) || ig.mode === 'instagram-login';
  const metaRoute = ig.api.enabled && ig.publish.enabled && d.mediaHost.enabled;
  const upRoute = up.keySet && Boolean(up.profile);
  const route = metaRoute && upRoute ? t('connections.route.both') : metaRoute ? t('connections.route.meta') : upRoute ? t('connections.route.up') : null;
  const left = [Boolean(route), auto, publishingOn].filter((x) => !x).length;
  const tools = ws.d?.tools;
  const higgs = group('higgsfield');
  const folders = ws.d?.folders ?? [];
  const figma = ws.d?.figma;
  const quota = parseQuota(up.quota);

  // ---- Publishing and Sources rows ----
  const openBtn = (id: string, setUp: boolean) => (
    <Button dense onClick={() => setOpen(id)}>
      {setUp ? t('common.setUp') : t('common.open')}
    </Button>
  );
  const igRow: RowModel = c?.expired
    ? { id: 'meta', title: t('connections.instagram'), pill: 'Needs you', line: t('connections.line.expired', { handle: `@${c.username}` }), amber: true, action: openBtn('meta', false) }
    : c
      ? { id: 'meta', title: t('connections.instagram'), pill: c.daysLeft != null && c.daysLeft <= 10 ? 'Needs you' : 'Ready', line: c.daysLeft != null ? t('connections.line.validDays', { handle: `@${c.username}`, days: c.daysLeft }) : `@${c.username}`, action: openBtn('meta', false) }
      : ig.mode === 'instagram-login'
        ? { id: 'meta', title: t('connections.instagram'), pill: 'Ready', line: t('connections.line.savedOutside'), action: openBtn('meta', false) }
        : { id: 'meta', title: t('connections.instagram'), pill: 'Not set up', line: t('connections.line.connectMeta'), action: openBtn('meta', true) };
  const r2Row: RowModel = d.mediaHost.enabled
    ? { id: 'r2', title: t('connections.bucket'), pill: 'Ready', line: <span data-content>{d.mediaHost.publicHost}</span>, action: openBtn('r2', false) }
    : { id: 'r2', title: t('connections.bucket'), pill: igConnected ? 'Needs you' : 'Not set up', line: t('connections.line.bucketNeeded'), amber: igConnected, action: openBtn('r2', true) };
  const upRow: RowModel = up.profile
    ? up.keySet
      ? { id: 'upload-post', title: t('connections.uploadPost'), pill: 'Ready', line: <span data-content>{t('connections.line.profile', { profile: up.profile })}</span>, action: openBtn('upload-post', false) }
      : { id: 'upload-post', title: t('connections.uploadPost'), pill: 'Needs you', line: t('connections.line.keyMissing'), amber: true, action: openBtn('upload-post', false) }
    : up.keySet
      ? { id: 'upload-post', title: t('connections.uploadPost'), pill: 'Needs you', line: t('connections.line.pickProfile'), amber: true, action: openBtn('upload-post', false) }
      : { id: 'upload-post', title: t('connections.uploadPost'), pill: 'Not set up', line: t('connections.line.upHint'), action: openBtn('upload-post', true) };
  const brandRow: RowModel = d.brand
    ? { id: 'brand', title: t('connections.brand'), pill: 'Ready', line: t('connections.line.imported'), action: <Button dense onClick={openBrand}>{t('common.open')}</Button> }
    : { id: 'brand', title: t('connections.brand'), pill: 'Not set up', line: t('connections.line.notSetUp'), action: <Button dense onClick={openBrand}>{t('common.setUp')}</Button> };
  const foldersRow: RowModel = folders.length
    ? { id: 'folders', title: t('connections.folders'), pill: 'Ready', line: t('connections.line.linked', { count: folders.length }), action: openBtn('folders', false) }
    : { id: 'folders', title: t('connections.folders'), pill: 'Not set up', line: t('connections.line.none'), action: openBtn('folders', true) };

  // ---- Making: one row per capability ----
  const fromServer = parseMaking(d.making);
  const making = (fromServer ?? fallbackMaking()).map((r) => patched[r.id] ?? r);
  const known = (id: string): { pill: StatusWord; line: string; amber?: boolean } | null => {
    if (fromServer) return null; // the backend's own status wins once it sends rows
    if (id === 'claude-cli') return toolState(tools?.claude, d.agents);
    if (id === 'codex') return toolState(tools?.codex, d.codex);
    if (id === 'higgsfield-image') return higgs?.complete ? { pill: 'Ready', line: t('connections.line.keysSaved') } : { pill: 'Off', line: t('connections.line.off') };
    if (id === 'figma') return !figma ? { pill: 'Not set up', line: t('connections.line.checking') } : figma.connected ? { pill: 'Ready', line: figma.user ?? t('connections.line.ready') } : figma.ready ? { pill: 'Not set up', line: t('connections.line.notSetUp') } : { pill: 'Off', line: t('connections.line.off') };
    return null;
  };
  /** One connector's state in the dictionary's words: the legacy check without `making`, else its own row. */
  const stateOf = (r: ConnectorRow): ConnectorState => {
    const legacy = KNOWN_CONNECTORS.includes(r.id) ? known(r.id) : null;
    return legacy ? { pill: legacy.pill, phrase: legacy.line, amber: Boolean(legacy.amber), legacy: true } : { ...statePhrase(r), legacy: false };
  };
  const connectorSwitch = (r: ConnectorRow) => {
    const notAllowed = r.status.state === 'not-allowed';
    return <Switch on={r.switchOn} label={t('connections.switchLabel', { service: r.title })} busy={busy === `sw-${r.id}`} disabled={!!busy || notAllowed} reason={notAllowed ? t('connections.switchReason') : t('common.busy')} onChange={(on) => void switchConnector(r, on)} />;
  };
  const capGroups = capabilityGroups(making);
  const capModel = (g: CapabilityGroup): RowModel => {
    const p = g.primary;
    const st = stateOf(p);
    const l = capabilityLine(p.title, st.phrase);
    return {
      id: g.id,
      title: g.title,
      pill: st.pill,
      keepLine: true,
      line: (
        <>
          {l.service ? `${l.service} · ` : null}
          <span className={st.amber ? 'cx-line-amber' : undefined}>{l.phrase}</span>
        </>
      ),
      action: st.legacy ? openBtn(g.id, st.pill === 'Not set up') : hasSwitch(p.id) ? connectorSwitch(p) : null,
    };
  };
  const makingRows = capGroups.map(capModel);
  // A connector id opens the drawer of its capability, except the older services' own drawers without `making`.
  const legacyDrawer = (id: string) => !fromServer && KNOWN_CONNECTORS.includes(id);
  const openCap = open && !legacyDrawer(open) ? (capGroups.find((g) => g.id === open || g.members.some((m) => m.id === open)) ?? null) : null;

  // ---- the ready card's next step: the only filled button on the screen ----
  const nextStep = route ? null : up.profile || up.keySet ? (
    <>
      <Button level="primary" dense onClick={() => setOpen('upload-post')}>
        {up.keySet ? t('connections.chooseProfile') : t('connections.setUpUploadPost')}
      </Button>
      <Button dense onClick={() => setOpen(igConnected ? 'r2' : 'meta')}>
        {igConnected ? t('connections.addBucket') : t('connections.setUpMeta')}
      </Button>
    </>
  ) : (
    <>
      <Button level="primary" dense onClick={() => setOpen(igConnected ? 'r2' : 'meta')}>
        {igConnected ? t('connections.addBucket') : t('connections.setUpMeta')}
      </Button>
      <Button dense onClick={() => setOpen('upload-post')}>
        {t('connections.setUpUploadPost')}
      </Button>
    </>
  );
  const close = () => setOpen(null);
  const sourceRows = [brandRow, foldersRow];
  // Features: the Post maker switch, then its paid services (each the same switch as its Making row), then Autopilot.
  const pmOn = s.features?.find((f) => f.id === 'postmaker')?.on === true;
  const flipPostmaker = (on: boolean) => run('feature-postmaker', async () => (await settingsCall({ action: 'feature', id: 'postmaker', on })).message);
  const vendorRows: RowModel[] = featureRowsOf(making).map((r) => {
    const st = stateOf(r);
    return { id: r.id, title: r.title, pill: st.pill, keepLine: true, line: st.phrase, amber: st.amber, action: connectorSwitch(r) };
  });
  const featureRows: RowModel[] = [
    {
      id: 'postmaker',
      title: t('tab.postmaker'),
      pill: pmOn ? 'Ready' : 'Off',
      keepLine: true,
      line: pmOn ? t('pm.feature.on') : t('pm.feature.off'),
      action: <Switch on={pmOn} label={t('tab.postmaker')} busy={busy === 'feature-postmaker'} disabled={!!busy} reason={t('common.busy')} onChange={(on) => void flipPostmaker(on)} />,
    },
    ...vendorRows,
    {
      id: 'autopilot',
      title: t('connections.autopilot'),
      pill: s.switches.autopilot.on ? 'Ready' : 'Off',
      line: s.switches.autopilot.on ? t('connections.autopilotOn') : t('connections.autopilotOff'),
      action: <Switch on={s.switches.autopilot.on} label={t('connections.autopilot')} busy={busy === 'autopilot'} disabled={!!busy || !s.ready} reason={t('keys.notReady')} onChange={(on) => void flip('autopilot', on)} />,
    },
  ];

  const moreCount = sourceRows.length + featureRows.length;
  const moreLabel = t('connections.group.more', { count: moreCount });

  return (
    <section className="screen cx u-stack u-gap-5" aria-label="Connections">
      {confirmBox.node}
      {/* 1. The ready card */}
      <section className={`cx-ready st-card ${left ? '' : 'is-ready'}`} aria-labelledby="cx-ready-title">
        <div className="cx-ready-head">
          <span className={`cx-ready-badge ${left ? '' : 'is-ok'}`} aria-hidden="true">
            {left ? left : '✓'}
          </span>
          <div className="cx-ready-text">
            <h2 id="cx-ready-title" className="cx-h1">
              {left ? t('connections.steps', { count: left }) : t('connections.ready')}
            </h2>
            <p className="cx-sub">{left ? t('connections.thenLive', { handle }) : t('connections.liveNow', { handle })}</p>
          </div>
          <Button dense level="tertiary" busy={busy === 'refresh'} disabled={!!busy} reason={t('common.busy')} onClick={() => void run('refresh', async () => undefined)}>
            {t('common.refresh')}
          </Button>
        </div>
        <ol className="cx-steps">
          <li className={`cx-step ${route ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{route ? '✓' : '1'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">{t('connections.step.way')}</span>
              {/* While the setup buttons show, they say the options; the hint would repeat them. */}
              {route || !nextStep ? <span className="cx-step-sub">{route ?? t('connections.step.wayHint')}</span> : null}
            </div>
            {nextStep ? <div className="u-row u-gap-2 cx-step-act">{nextStep}</div> : null}
          </li>
          <li className={`cx-step ${auto ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{auto ? '✓' : '2'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">{t('connections.step.account', { handle })}</span>
              <span className="cx-step-sub">{!d.account.ready ? t('connections.step.accountNeeds') : auto ? t('connections.step.accountOn', { max: d.account.maxPerDay }) : t('connections.step.accountOff')}</span>
            </div>
            <Switch
              on={auto}
              label={t('connections.step.account', { handle })}
              busy={busy === 'dispatch'}
              disabled={!!busy || (!auto && !d.account.ready)}
              reason={t('connections.step.accountNeeds')}
              onChange={(on) =>
                void run('dispatch', async () => {
                  await project({ action: 'upload-post-dispatch', on });
                  announceProjectsChanged();
                  return on ? t('connections.postingOn', { handle }) : t('connections.postingOff', { handle });
                })
              }
            />
          </li>
          <li className={`cx-step ${publishingOn ? 'is-done' : ''}`}>
            <span className="cx-step-mark" aria-hidden="true">{publishingOn ? '✓' : '3'}</span>
            <div className="cx-step-text">
              <span className="cx-step-title">{t('connections.step.switch')}</span>
              <span className="cx-step-sub">{publishingOn ? t('connections.step.switchOn') : t('connections.step.switchOff')}</span>
            </div>
            <Switch on={publishingOn} label={t('connections.step.switch')} busy={busy === 'publishing'} disabled={!!busy || !s.ready} reason={t('keys.notReady')} onChange={(on) => void flip('publishing', on)} />
          </li>
        </ol>
      </section>

      {/* 2. Groups */}
      <Group id="pub" title={t('connections.group.publishing')} rows={[igRow, r2Row, upRow]} onOpen={setOpen} />
      <Group id="make" title={t('connections.group.making')} rows={makingRows} onOpen={setOpen} />
      {/* Sources and Features sit behind one disclosure, closed by default. */}
      <More className="cx-more" label={moreLabel} openLabel={moreLabel}>
        <Group id="src" title={t('connections.group.sources')} rows={sourceRows} onOpen={(id) => (id === 'brand' ? openBrand() : setOpen(id))} />
        <Group id="feat" title={t('connections.group.features')} rows={featureRows} onOpen={(id) => (id === 'autopilot' ? navigateTo('campaigns') : id === 'postmaker' ? undefined : setOpen(id))} />
        <FeaturesSection say={say} hide={POSTMAKER_FEATURES} />
      </More>

      {/* ---- drawers ---- */}
      {open === 'meta' ? (
        <Drawer
          open
          title={t('connections.instagram')}
          onClose={close}
          primary={
            <Button
              level="primary"
              busy={busy === 'connect'}
              disabled={!!busy || !ig.unifiedLogin.enabled || inApp}
              reason={inApp ? t('connections.meta.browser') : t('connections.meta.needApp')}
              onClick={() =>
                void run('connect', async () => {
                  const j = await call<{ url: string }>('/api/studio/instagram', { project: getProjectId(), action: 'connect-start' });
                  window.location.assign(j.url);
                })
              }
            >
              {c ? t('connections.meta.again') : t('connections.meta.connect')}
            </Button>
          }
          secondary={
            <>
              <Button
                busy={busy === 'igtest'}
                disabled={!!busy || !ig.api.enabled}
                reason={t('connections.meta.needAccount')}
                onClick={() =>
                  void run('igtest', async () => {
                    const j = await call<{ account: { username: string } }>('/api/studio/instagram', { project: getProjectId(), action: 'test' });
                    return `Works: @${j.account.username}. Nothing was posted.`;
                  })
                }
              >
                {t('connections.meta.test')}
              </Button>
              {c ? (
                <Button
                  level="destructive"
                  disabled={!!busy}
                  reason={t('common.busy')}
                  onClick={() =>
                    void confirmBox.confirm({ title: t('connections.meta.disconnectTitle', { handle: `@${c.username}` }), body: t('connections.meta.disconnectBody'), confirmLabel: t('connections.meta.disconnect'), destructive: true }).then((ok) => {
                      if (ok)
                        void run('disc', async () => {
                          await call('/api/studio/instagram', { project: getProjectId(), action: 'disconnect' });
                          return t('connections.meta.disconnected');
                        });
                    })
                  }
                >
                  {t('connections.meta.disconnect')}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="u-stack">
            <div className="cx-drawer-block">
              <p className="st-small st-muted u-m0">{t('connections.meta.about')}</p>
              <span className="st-small" data-content>
                {c ? `@${c.username} · ${formatIn(tz, c.connectedAt)}` : ig.mode === 'instagram-login' ? t('connections.line.savedOutside') : t('connections.meta.notConnected')}
              </span>
              {inApp ? <span className="xs st-muted">{t('connections.meta.browser')}</span> : null}
              <ul className="cx-checks">
                {ig.api.enabled ? (
                  <>
                    <Check g={ig.publish} label={t('connections.check.publish')} />
                    <Check g={ig.insights} label={t('connections.check.results')} />
                    <Check g={ig.comments} label={t('connections.check.comments')} />
                    <Check g={d.mediaHost} label={t('connections.check.bucket')} />
                  </>
                ) : (
                  <Check g={ig.api} label={t('connections.check.account')} />
                )}
              </ul>
            </div>
            {group('meta') ? <KeyForm group={group('meta')!} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title={t('connections.meta.app')} /> : null}
            {ig.api.enabled ? (
              <More label={t('connections.meta.advanced')}>
                <span>{t('connections.meta.permissionsText')}</span>
                <Button
                  dense
                  busy={busy === 'perm'}
                  disabled={!!busy}
                  reason={t('common.busy')}
                  onClick={() =>
                    void run('perm', async () => {
                      const j = await call<{ results: { permission: string; ok: boolean; note: string }[] }>('/api/studio/instagram', { project: getProjectId(), action: 'review-calls' });
                      return j.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.permission}`).join(' · ');
                    })
                  }
                >
                  {t('connections.meta.permissions')}
                </Button>
              </More>
            ) : null}
          </div>
        </Drawer>
      ) : null}

      {open === 'r2' ? (
        <Drawer open title={t('connections.bucket')} onClose={close}>
          <div className="u-stack u-gap-3">
            <p className="st-small st-muted u-m0">{t('connections.r2.about')}</p>
            {group('r2') ? <KeyForm group={group('r2')!} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title="Cloudflare R2" primary /> : null}
          </div>
        </Drawer>
      ) : null}

      {open === 'upload-post' ? (
        <Drawer
          open
          title={t('connections.uploadPost')}
          onClose={close}
          primary={
            !up.profile ? (
              <Button level="primary" disabled={!!busy || !up.profileSetup.enabled} reason={t('connections.up.needKey')} onClick={() => { close(); setPick(true); }}>
                {t('connections.chooseProfile')}
              </Button>
            ) : null
          }
        >
          <div className="u-stack">
            <div className="cx-drawer-block">
              <p className="st-small st-muted u-m0">{t('connections.up.about')}</p>
            </div>
            {group('upload-post') ? <KeyForm group={group('upload-post')!} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title={t('connections.up.key')} /> : null}
            <div className="cx-drawer-block">
              <span className="cx-subhead">{t('connections.up.profileFor', { handle })}</span>
              <span className="st-small" data-content>
                {up.profile ? `${up.profile}${up.instagram ? ` · ${up.instagram}` : ''}${up.verifiedAt ? ` · ${formatIn(tz, up.verifiedAt)}` : ''}` : t('connections.up.noProfile')}
              </span>
              {up.profile ? (
                <div className="u-row u-gap-2">
                  <Button dense disabled={!!busy || !up.profileSetup.enabled} reason={t('connections.up.needKey')} onClick={() => { close(); setPick(true); }}>
                    {t('connections.up.change')}
                  </Button>
                  <Button dense busy={busy === 'upload-post'} disabled={!!busy || !up.profileSetup.enabled} reason={t('connections.up.needKey')} onClick={() => void check('upload-post')}>
                    {t('connections.up.check')}
                  </Button>
                  <Button
                    dense
                    level="destructive"
                    disabled={!!busy}
                    reason={t('common.busy')}
                    onClick={() => {
                      void confirmBox.confirm({ title: t('connections.up.removeTitle', { profile: up.profile ?? '', project: d.project.name }), body: t('connections.up.removeBody'), confirmLabel: t('connections.up.removeConfirm'), destructive: true }).then((ok) => {
                        if (!ok) return;
                        void run('up-remove', async () => {
                          await project({ action: 'upload-post-profile', profile: '' });
                          announceProjectsChanged();
                          return t('connections.up.removed');
                        });
                      });
                    }}
                  >
                    {t('connections.up.remove')}
                  </Button>
                </div>
              ) : null}
              <ul className="cx-checks">
                <Check g={up.posting} label={t('connections.check.postNow')} />
                <Check g={up.scheduling} label={t('connections.check.schedule')} />
                <Check g={up.results} label={t('connections.check.results')} />
              </ul>
              {quota ? <span className="xs st-muted">{quotaText(quota, tz)}</span> : null}
            </div>
          </div>
        </Drawer>
      ) : null}

      {open === 'claude-cli' && !fromServer && tools ? (
        <Drawer open title="Claude Code" status={<Pill status={toolState(tools.claude, d.agents).pill} />} onClose={close}>
          <div className="u-stack">
            <div className="cx-drawer-block">
              <p className="st-small st-muted u-m0">{t('connections.claude.about')}</p>
              <ToolBlock tool={tools.claude} busy={ws.busy} run={ws.run} />
              <div>
                <Button dense busy={busy === 'claude'} disabled={!!busy} reason={t('common.busy')} onClick={() => void check('claude')}>
                  {t('connections.check')}
                </Button>
              </div>
            </div>
            {group('anthropic') ? <KeyForm group={group('anthropic')!} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title={t('connections.apiKey')} /> : null}
          </div>
        </Drawer>
      ) : null}

      {open === 'codex' && !fromServer && tools ? (
        <Drawer open title="Codex" status={<Pill status={toolState(tools.codex, d.codex).pill} />} onClose={close}>
          <div className="cx-drawer-block">
            <p className="st-small st-muted u-m0">{t('connections.codex.about')}</p>
            <ToolBlock tool={tools.codex} busy={ws.busy} run={ws.run} />
            <div>
              <Button dense busy={busy === 'codex'} disabled={!!busy} reason={t('common.busy')} onClick={() => void check('codex')}>
                {t('connections.check')}
              </Button>
            </div>
          </div>
        </Drawer>
      ) : null}

      {open === 'higgsfield-image' && !fromServer ? (
        <Drawer open title="Higgsfield images" onClose={close}>
          <div className="u-stack u-gap-3">
            <p className="st-small st-muted u-m0">{t('connections.higgs.about')}</p>
            {higgs ? <KeyForm group={higgs} ready={s.ready} reason={s.reason} say={say} onSaved={reloadAll} title={t('connections.keys')} primary /> : null}
          </div>
        </Drawer>
      ) : null}

      {/* A capability row's drawer: the primary connector, then the alternatives, each with switch, price and key. */}
      {openCap ? (
        <CapabilityDrawer
          g={openCap}
          stateOf={stateOf}
          keyGroup={(id) => (KEY_GROUP[id] ? group(KEY_GROUP[id]!) : undefined)}
          ready={s.ready}
          reason={s.reason}
          say={say}
          onSaved={reloadAll}
          busy={busy}
          switchFor={connectorSwitch}
          onTest={(r) => void testConnector(r)}
          canTest={Boolean(fromServer)}
          onOpen={setOpen}
          onClose={close}
          extra={(r) =>
            // The CLI path and the Figma token stay reachable once the server sends `making` (no file to edit).
            (r.id === 'claude-cli' || r.id === 'codex') && tools ? (
              <ToolBlock tool={r.id === 'codex' ? tools.codex : tools.claude} busy={ws.busy} run={ws.run} />
            ) : r.id === 'figma' && ws.d ? (
              <div>
                <Button dense onClick={() => { close(); setFigmaPanel(true); }}>
                  {t('connections.figma.open')}
                </Button>
              </div>
            ) : null
          }
        />
      ) : null}

      {open === 'folders' && ws.d ? <FoldersPanel folders={ws.d.folders} busy={ws.busy} run={ws.run} onClose={close} /> : null}
      {open === 'figma' && !fromServer && ws.d ? <FigmaPanel figma={ws.d.figma} busy={ws.busy} run={ws.run} say={say} onClose={close} /> : null}
      {figmaPanel && fromServer && ws.d ? <FigmaPanel figma={ws.d.figma} busy={ws.busy} run={ws.run} say={say} onClose={() => setFigmaPanel(false)} /> : null}

      {pick ? (
        <ProfilePanel
          project={d.project}
          current={up.profile ?? ''}
          onClose={() => setPick(false)}
          onLinked={async (username) => {
            setPick(false);
            await run('up-link', async () => {
              await project({ action: 'upload-post-profile', profile: username });
              announceProjectsChanged();
              return t('connections.up.linked', { profile: username });
            });
          }}
        />
      ) : null}
    </section>
  );
}

const UNIT: Record<ConnectorRow['costModel']['unit'], string> = { char: 'character', second: 'second', minute: 'minute', image: 'image', request: 'request', token: 'token', none: '' };

/** A connector's state in the dictionary's words; `legacy` = from the older service checks (no `making` yet). */
interface ConnectorState { pill: StatusWord; phrase: string; amber: boolean; legacy: boolean }

/** The drawer of one capability row: the primary connector first, then the alternatives. */
export function CapabilityDrawer({ g, stateOf, keyGroup, ready, reason, say, onSaved, busy, switchFor, onTest, canTest, onOpen, onClose, extra }: { g: CapabilityGroup; stateOf: (r: ConnectorRow) => ConnectorState; keyGroup: (id: string) => GroupStatus | undefined; ready: boolean; reason: string; say: (t: string) => void; onSaved: () => Promise<void>; busy: string | null; switchFor: (r: ConnectorRow) => ReactNode; onTest: (r: ConnectorRow) => void; canTest: boolean; onOpen: (id: string) => void; onClose: () => void; extra?: (r: ConnectorRow) => ReactNode }) {
  const keyShown = new Set<string>(); // two connectors on one key group show its form once
  return (
    <Drawer open title={g.title} status={<Pill status={stateOf(g.primary).pill} />} onClose={onClose}>
      <div className="u-stack">
        {g.members.map((r, i) => {
          const kg = keyGroup(r.id);
          const showKey = Boolean(kg && !keyShown.has(kg.id));
          if (kg) keyShown.add(kg.id);
          return (
            <section key={r.id} className="cx-drawer-block" data-connector={r.id} aria-label={r.title}>
              {g.members.length > 1 && i < 2 ? <span className="xs st-muted">{i === 0 ? t('connections.usedFirst') : t('connections.alternatives')}</span> : null}
              <ConnectorBlock r={r} st={stateOf(r)} keyGroup={showKey ? kg : undefined} keyAbove={Boolean(kg) && !showKey} ready={ready} reason={reason} say={say} onSaved={onSaved} busy={busy} switchFor={switchFor} onTest={canTest ? () => onTest(r) : undefined} onOpen={onOpen} />
              {stateOf(r).legacy ? null : extra?.(r)}
            </section>
          );
        })}
      </div>
    </Drawer>
  );
}

/** One connector inside a capability drawer: state, switch, notes, its free check, price and its key. */
function ConnectorBlock({ r, st, keyGroup, keyAbove = false, ready, reason, say, onSaved, busy, switchFor, onTest, onOpen }: { r: ConnectorRow; st: ConnectorState; keyGroup?: GroupStatus; keyAbove?: boolean; ready: boolean; reason: string; say: (t: string) => void; onSaved: () => Promise<void>; busy: string | null; switchFor: (r: ConnectorRow) => ReactNode; onTest?: () => void; onOpen: (id: string) => void }) {
  const local = LOCAL_CONNECTORS.includes(r.id);
  const notAllowed = r.status.state === 'not-allowed';
  const cm = r.costModel;
  const price = cm.unit === 'none' || cm.usdPerUnit === null ? t('connections.priceUnknown') : `${t('connections.price', { usd: `$${cm.usdPerUnit}`, unit: UNIT[cm.unit] })}${cm.verified ? '' : ` · ${t('connections.priceUnverified')}`}`;
  const head = (
    <div className="cx-switch-row">
      <h3 className="st-small u-m0">{r.title}</h3>
      <Pill status={st.pill} />
    </div>
  );
  // Without `making`, the older services keep their own drawers (sign-in, keys, Figma files).
  if (st.legacy) {
    return (
      <>
        {head}
        <span className={st.amber ? 'st-small cx-line-amber' : 'st-small'}>{st.phrase}</span>
        <div>
          <Button dense onClick={() => onOpen(r.id)}>
            {t('common.open')}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      <span className={st.amber ? 'st-small cx-line-amber' : 'st-small'}>{st.phrase}</span>
      {local ? <span className="xs st-muted">{t('connections.statusOnly')}</span> : null}
      {hasSwitch(r.id) && !notAllowed ? (
        <div className="cx-switch-row">
          <span className="st-small">{t('connections.switchLabel', { service: r.title })}</span>
          {switchFor(r)}
        </div>
      ) : null}
      {notAllowed ? <Notice kind="not-allowed" title={t('connections.notAllowed')} why={t('connections.notAllowedWhy')} /> : null}
      {!local && !r.switchOn ? <span className="xs st-muted">{t('connections.mock')}</span> : null}
      {r.attendance === 'attended-only' ? <span className="xs st-muted">{t('connections.attended')}</span> : null}
      {onTest ? (
        <div>
          <Button dense busy={busy === `test-${r.id}`} disabled={!!busy} reason={t('common.busy')} onClick={onTest}>
            {t('connections.check')}
          </Button>
        </div>
      ) : null}
      {!local ? <span className="xs st-muted">{price}</span> : null}
      {!local && !notAllowed && !keyAbove ? keyGroup ? <KeyForm group={keyGroup} ready={ready} reason={reason} say={say} onSaved={onSaved} title={t('connections.keys')} /> : <span className="xs st-muted">{t('connections.noKeyForm')}</span> : null}
    </>
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
      <div className="proj-panel u-stack u-gap-3" role="dialog" aria-modal="true" aria-label={t('connections.uploadPost')} ref={panel} tabIndex={-1}>
        <div className="u-between u-gap-2">
          <h2 className="drawer-title">{current ? t('connections.up.change') : t('connections.up.connect')}</h2>
          <Button dense level="tertiary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        <span className="st-small st-muted" data-content>
          {project.name} · {project.handle}
        </span>
        {!state ? <span className="st-small st-muted">{t('connections.up.loading')}</span> : <UploadPostPicker state={state} reload={reload} value={value} onChange={setValue} slug={project.id} displayName={project.name} />}
        {mismatch ? (
          <span className="st-small real-error" role="alert">
            {t('connections.up.mismatch', { profile: value, other: mismatch, handle: project.handle })}
          </span>
        ) : null}
        <div className="u-row u-gap-2">
          <Button
            level="primary"
            dense
            busy={busy}
            disabled={busy || !value || value === current || !state?.allowed || !!mismatch}
            reason={t('connections.up.pickFirst')}
            onClick={() => {
              setBusy(true);
              void onLinked(value).finally(() => setBusy(false));
            }}
          >
            {current ? t('connections.up.use') : t('connections.up.link')}
          </Button>
          <Button dense disabled={busy} reason={t('common.busy')} onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}
