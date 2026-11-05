'use client';
// Autopilot: Signal makes a campaign's planned posts by itself once a day, and — only for
// post types the owner has trusted by approving five in a row — approves and schedules them too.
// This file is the UI only: the per-campaign panel (Campaigns), the project summary on Today
// (with trust per post type and the log of runs), and the "Made by autopilot" badge on the Posts board.
// It talks to GET/POST /api/studio/autopilot through the contract in lib/studio/autopilot/types.ts.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AutopilotAction, AutopilotPayload, AutopilotRun, AutopilotSettings, FormatTrust, RunStep } from '@/lib/studio/autopilot/types';
import type { Format } from '@/lib/studio/generate';
import { formatDateLabel, formatDateTime, formatTime } from '@/lib/time';
import { getProjectId, useProjectId } from './Projects';
import { Select } from './Select';
import { ProgressBar, Spinner, clock } from './loaders';
import { notifyChanged, useOnChanged } from './sync';

/** Plain names for post types when the caller has none (the Campaigns payload carries the real list). */
const FORMAT_NAMES: Record<string, string> = {
  'codex-post': 'Codex image post',
  'website-card': 'Website post',
  'higgsfield-image': 'Higgsfield image',
  'higgsfield-reel': 'Higgsfield Reel',
};
type Names = Record<string, string> | undefined;
const nameOf = (f: string, names?: Names) => names?.[f] ?? FORMAT_NAMES[f] ?? f;
const money = (n: number | null | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const STATUS_WORD: Record<AutopilotRun['status'], string> = { running: 'Running', done: 'Finished', stopped: 'Stopped', failed: 'Failed' };

export function defaultSettings(campaign: string): AutopilotSettings {
  return { campaign, enabled: false, makeAheadDays: 3, autoPlan: false, review: true, autoPublish: 'never', formats: null, dailyBudgetUsd: 3, updatedAt: '', updatedBy: '' };
}

/** A slot id usually carries its date; show that day when it does. */
function slotLabel(slot: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(slot);
  const t = /(\d{2}:\d{2})/.exec(slot.replace(m?.[1] ?? '', ''));
  return m ? `${formatDateLabel(m[1]!)}${t ? `, ${t[1]}` : ''}` : slot;
}

/** One run step in plain words. */
export function describeStep(s: RunStep, campaignName: (id: string | null) => string, names?: Names): string {
  switch (s.kind) {
    case 'plan':
      return `Planned ${s.slots} more ${s.slots === 1 ? 'post' : 'posts'} for ${campaignName(s.campaign)}${s.costUsd ? ` (${money(s.costUsd)})` : ''}.`;
    case 'make':
      if (s.error) return `Could not make the ${nameOf(s.format, names).toLowerCase()} for ${slotLabel(s.slot)} (${campaignName(s.campaign)}): ${s.error}.`;
      return `Made post ${s.package ?? '?'} (${nameOf(s.format, names)}) for ${slotLabel(s.slot)}, ${campaignName(s.campaign)}${s.costUsd ? ` (${money(s.costUsd)})` : ''}.`;
    case 'review':
      if (s.error) return `The reviewer could not look at post ${s.package}: ${s.error}.`;
      return `The reviewer looked at post ${s.package}: ${s.verdict ?? 'no verdict'}${s.costUsd ? ` (${money(s.costUsd)})` : ''}`;
    case 'auto-approve':
      if (s.error) return `Post ${s.package} was not approved automatically: ${s.error}.`;
      return `Approved post ${s.package} automatically (${nameOf(s.format, names)} is trusted)${s.scheduledFor ? ` and scheduled it for ${formatDateTime(s.scheduledFor)}` : ''}${s.via ? ` via ${s.via === 'meta' ? 'Instagram' : 'Upload-Post'}` : ''}.`;
    case 'skip':
      return `Skipped ${s.campaign ? campaignName(s.campaign) : 'the run'} because ${s.reason}.`;
  }
}

// ---- data ----------------------------------------------------------------------------------
async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 404) throw new Error('Autopilot is not connected yet (its service is missing).');
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

/** The owner pulls an auto-approved post before it goes out (Posts board). */
export async function pullAutopilotPost(packageId: string): Promise<void> {
  await post('/api/studio/autopilot', { project: getProjectId(), action: 'pull', package: packageId } satisfies AutopilotAction & { project: string | null });
  notifyChanged('autopilot', 'content', 'calendar', 'campaigns');
}

/** Loads the project's autopilot state, keeps it fresh, and polls every 3 s while a run is going. */
export function useAutopilot() {
  const pid = useProjectId();
  const [data, setData] = useState<AutopilotPayload | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/autopilot?project=${encodeURIComponent(pid)}`, { cache: 'no-store' });
      const j = (await r.json().catch(() => ({}))) as AutopilotPayload & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? 'Could not load autopilot.');
      setData(j);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pid]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['autopilot', 'campaigns'], load);

  const running = data?.runs[0]?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const act = useCallback(
    async (action: AutopilotAction) => {
      await post('/api/studio/autopilot', { project: pid, ...action });
      await load();
      notifyChanged('autopilot', ...(action.action === 'pull' ? (['content', 'calendar', 'campaigns'] as const) : []));
    },
    [pid, load],
  );
  return { data, example: false, error, reload: load, act };
}

// ---- small pieces ---------------------------------------------------------------------------
function Switch({ id, checked, onChange, disabled, busy, label, hint, reason }: { id?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; busy?: boolean; label: ReactNode; hint?: ReactNode; reason?: string }) {
  const auto = useId();
  const sid = id ?? `sw-${auto}`;
  return (
    <div className={`ap-row ${disabled ? 'is-off' : ''}`}>
      <label htmlFor={sid} className="ap-row-text">
        <span className="ap-row-label">{label}</span>
        {hint ? <span className="xs st-muted">{hint}</span> : null}
        {disabled && reason ? <span className="xs ap-reason">{reason}</span> : null}
      </label>
      <button id={sid} type="button" role="switch" aria-checked={checked} className="ap-switch" disabled={disabled} aria-busy={busy || undefined} title={disabled && reason ? reason : undefined} onClick={() => onChange(!checked)}>
        <span className="ap-knob" aria-hidden="true" />
        <span className="st-vh">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'off' | 'info'; children: ReactNode }) {
  return (
    <p className={`ap-notice ap-notice-${tone} st-small`} role={tone === 'info' ? undefined : 'status'}>
      {children}
    </p>
  );
}

function ExampleNote() {
  return <Notice tone="info">Example only: the autopilot service is not connected yet, so these are sample numbers and nothing you change here is saved.</Notice>;
}

/** Live view of the run that is going on now: its steps so far, in plain words, polled every 3 s. */
function LiveRun({ run, campaignName, names }: { run: AutopilotRun; campaignName: (id: string | null) => string; names?: Names }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - Date.parse(run.startedAt)) / 1000));
  return (
    <div className="ld-task" role="status" aria-live="polite">
      <div className="ld-task-head">
        <Spinner size={14} />
        <b>Autopilot is running</b>
        <span className="st-muted">· {clock(secs)}{run.costUsd ? ` · ${money(run.costUsd)} so far` : ''}</span>
      </div>
      <ProgressBar label="Autopilot run" />
      <ol className="ld-steps ap-live-steps">
        {run.steps.length === 0 ? <li className="now">Starting: reading the plans</li> : null}
        {run.steps.map((s, i) => (
          <li key={i} className={i === run.steps.length - 1 ? 'now' : 'done'}>
            {describeStep(s, campaignName, names)}
          </li>
        ))}
      </ol>
      <span className="xs st-muted">Usually a few minutes per post. You can leave this screen; it keeps going on your machine.</span>
    </div>
  );
}

function RunNowButton({ d, act, say, example }: { d: AutopilotPayload; act: (a: AutopilotAction) => Promise<void>; say: (t: string) => void; example: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const running = d.runs[0]?.status === 'running';
  const blocked = !d.switches.autopilot.enabled ? d.switches.autopilot.reason : d.paused.paused ? d.paused.reason : running ? 'A run is already going.' : d.campaigns.every((c) => !c.settings.enabled) ? 'Switch autopilot on for a campaign first.' : '';
  return (
    <div className="st-stack" style={{ gap: 4 }}>
      <button
        type="button"
        className="st-btn st-btn-dark st-btn-sm"
        aria-busy={busy}
        disabled={busy || !!blocked}
        title={blocked}
        onClick={() => {
          setBusy(true);
          setErr('');
          act({ action: 'run-now' })
            .then(() => say(example ? 'Example run started (nothing is really made)' : 'Autopilot started. It makes the posts that are due now.'))
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Starting' : 'Run now'}
      </button>
      {blocked && !running ? <span className="xs st-muted">{blocked}</span> : null}
      {err ? <span className="xs real-error" role="alert">{err}</span> : null}
    </div>
  );
}

function ScheduleLine({ d }: { d: AutopilotPayload }) {
  return (
    <span className="st-small st-muted">
      Runs every day at {d.schedule.time} ({d.schedule.timeZone}) while Signal is running
      {d.schedule.nextRunAt ? <> · next {formatDateTime(d.schedule.nextRunAt)}</> : null}
      {!d.schedule.schedulerRunning ? <> · <span className="ap-reason">Signal’s scheduler is not running right now, so the daily run waits.</span></> : null}
    </span>
  );
}

// ---- per-campaign panel (Campaigns screen) -----------------------------------------------------
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; message: string };

export function AutopilotPanel({ campaign, formatNames, say }: { campaign: { id: string; name: string; formats: string[]; status?: string }; formatNames?: Names; say: (t: string) => void }) {
  const { data: d, example, error, act } = useAutopilot();
  const [local, setLocal] = useState<AutopilotSettings | null>(null); // optimistic copy while a save is in flight
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();
  const [budgetText, setBudgetText] = useState<string | null>(null);

  const row = d?.campaigns.find((c) => c.id === campaign.id);
  const base = row?.settings ?? defaultSettings(campaign.id);
  const s = local ?? base;
  const formats = row?.formats?.length ? row.formats : (campaign.formats as Format[]);

  const patch = async (p: Partial<Omit<AutopilotSettings, 'campaign' | 'updatedAt' | 'updatedBy'>>) => {
    const next = { ...s, ...p };
    setLocal(next);
    setSave({ kind: 'saving' });
    try {
      await act({ action: 'settings', campaign: campaign.id, patch: p });
      setSave({ kind: 'saved', at: Date.now() });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSave({ kind: 'idle' }), 2500);
    } catch (e) {
      setSave({ kind: 'error', message: (e as Error).message });
    } finally {
      setLocal(null);
    }
  };
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  if (error) return <p className="real-error st-small" role="alert" style={{ margin: 0 }}>Autopilot: {error}</p>;
  if (!d) return <span className="st-small st-muted">Loading autopilot…</span>;

  const campaignName = (id: string | null) => d.campaigns.find((c) => c.id === id)?.name ?? (id ?? 'a campaign');
  const running = d.runs[0]?.status === 'running' ? d.runs[0] : null;
  const canRun = d.switches.autopilot.enabled && !d.paused.paused;
  const state = !s.enabled ? 'Off' : !canRun ? 'Waiting' : 'On';
  const chosen = s.formats ?? formats;
  const trustedIds = new Set(d.trust.formats.filter((t) => t.trusted).map((t) => t.format));
  const busy = save.kind === 'saving';

  return (
    <div className="camp-section st-stack ap-panel" style={{ gap: 12 }}>
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Autopilot
          <span className={`camp-status ${state === 'On' ? 'active' : state === 'Waiting' ? 'paused' : ''}`}>{state}</span>
          {example ? <span className="ap-example">Example</span> : null}
        </span>
        <span className="xs st-muted" role="status" aria-live="polite">
          {save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? 'Saved' : save.kind === 'error' ? '' : s.updatedAt ? `Saved ${formatDateTime(s.updatedAt)}` : ''}
        </span>
      </div>
      {example ? <ExampleNote /> : null}
      {save.kind === 'error' ? <p className="real-error st-small" role="alert" style={{ margin: 0 }}>Not saved: {save.message}</p> : null}
      {!d.switches.autopilot.enabled ? <Notice tone="off">Autopilot can’t run yet. {d.switches.autopilot.reason || 'It needs the feature switch first.'} You can set it up now; it starts once the switch is on.</Notice> : null}
      {d.paused.paused ? <Notice tone="warn">Paused: {d.paused.reason || 'automatic runs and approvals are stopped.'}</Notice> : null}
      {s.enabled && campaign.status && campaign.status !== 'active' ? <Notice tone="off">{campaign.status === 'done' ? 'This campaign is finished, so autopilot makes nothing for it.' : 'This campaign is not running yet, so autopilot waits. Press Start above when the plan is ready.'}</Notice> : null}

      <Switch
        checked={s.enabled}
        busy={busy}
        onChange={(v) => void patch({ enabled: v })}
        label={<b>Make this campaign’s posts automatically</b>}
        hint={s.enabled ? `Each day Signal makes the posts planned for the next ${s.makeAheadDays} ${s.makeAheadDays === 1 ? 'day' : 'days'} and puts them in Planned on the Posts board.` : 'Signal makes the planned posts by itself, once a day. You still approve each one unless you trust its post type.'}
      />

      <div className="ap-grid">
        <div className="wiz-field">
          <span id={`${uid}-ahead`}>Make posts ahead</span>
          <Select label="Make posts ahead" value={s.makeAheadDays} disabled={busy} onChange={(v) => void patch({ makeAheadDays: v })} options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: `${n} ${n === 1 ? 'day' : 'days'}` }))} />
          <span className="xs st-muted" style={{ fontWeight: 400 }}>How far ahead the posts are made.</span>
        </div>
        <label className="wiz-field" htmlFor={`${uid}-budget`}>
          Daily budget
          <span className="ap-money">
            <span aria-hidden="true">$</span>
            <input
              id={`${uid}-budget`}
              className="st-input"
              type="number"
              inputMode="decimal"
              min={0}
              max={20}
              step={0.5}
              disabled={busy}
              value={budgetText ?? String(s.dailyBudgetUsd)}
              onChange={(e) => setBudgetText(e.target.value)}
              onBlur={() => {
                if (budgetText == null) return;
                const n = Math.max(0, Math.min(20, Number(budgetText)));
                setBudgetText(null);
                if (Number.isFinite(n) && n !== s.dailyBudgetUsd) void patch({ dailyBudgetUsd: Math.round(n * 100) / 100 });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </span>
          <span className="xs st-muted" style={{ fontWeight: 400 }}>Most Signal may spend on this campaign per day (Claude and images). It stops when the budget is used up.</span>
        </label>
      </div>

      <Switch checked={s.autoPlan} busy={busy} onChange={(v) => void patch({ autoPlan: v })} label="Extend the plan when it runs low" hint="When fewer days are planned than you make ahead, the planner adds the next posts. Costs a little." />
      <Switch checked={s.review} busy={busy} onChange={(v) => void patch({ review: v })} label="Review each post with the AI reviewer" hint="The reviewer checks every made post for claims, the AI label and the brand before you see it." />

      <fieldset className="ap-fieldset">
        <legend className="ap-legend">Publishing</legend>
        <label className="real-check ap-check">
          <input type="radio" name={`${uid}-pub`} checked={s.autoPublish === 'never'} disabled={busy} onChange={() => void patch({ autoPublish: 'never' })} />
          <b>Always ask me</b>
          <span className="xs st-muted ap-check-hint">Every post waits in Planned on the Posts board for your approval.</span>
        </label>
        <label className={`real-check ap-check ${!d.switches.trustedPublish.enabled ? 'is-off' : ''}`}>
          <input type="radio" name={`${uid}-pub`} checked={s.autoPublish === 'trusted'} disabled={busy || !d.switches.trustedPublish.enabled} onChange={() => void patch({ autoPublish: 'trusted' })} />
          <b>Publish post types I’ve trusted</b>
          <span className="xs st-muted ap-check-hint">
            {d.switches.trustedPublish.enabled
              ? trustedIds.size
                ? `Trusted now: ${[...trustedIds].map((f) => nameOf(f, formatNames)).join(', ')}. Other types still wait for you.`
                : 'No post type is trusted yet. Trust comes from approving 5 posts of a type in a row.'
              : `Not available: ${d.switches.trustedPublish.reason || 'needs the feature switch.'}`}
          </span>
        </label>
      </fieldset>

      <fieldset className="ap-fieldset">
        <legend className="ap-legend">Post types autopilot may make</legend>
        <div className="ap-formats">
          {formats.map((f) => {
            const on = chosen.includes(f);
            return (
              <label key={f} className="real-check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || (on && chosen.length === 1)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f);
                    const all = formats.every((x) => next.includes(x));
                    void patch({ formats: all ? null : (next as Format[]) });
                  }}
                />
                <span>
                  {nameOf(f, formatNames)}
                  {trustedIds.has(f) ? <span className="ap-trusted">Trusted</span> : null}
                </span>
              </label>
            );
          })}
        </div>
        <span className="xs st-muted">{s.formats ? 'Only the ticked types.' : 'All of this campaign’s post types.'} At least one stays ticked.</span>
      </fieldset>

      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <ScheduleLine d={d} />
        <RunNowButton d={d} act={act} say={say} example={example} />
      </div>
      {running ? <LiveRun run={running} campaignName={campaignName} names={formatNames} /> : null}
    </div>
  );
}

// ---- trust per post type (project-level) --------------------------------------------------------
function TrustRow({ t, threshold, act, names }: { t: FormatTrust; threshold: number; act: (a: AutopilotAction) => Promise<void>; names?: Names }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const earned = t.approvedInARow >= threshold;
  const n = Math.min(threshold, t.approvedInARow);
  return (
    <div className="ap-trust">
      <div className="st-stack" style={{ gap: 3, minWidth: 0, flex: '1 1 220px' }}>
        <span className="st-small" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b>{nameOf(t.format, names)}</b>
          {t.trusted ? <span className="ap-trusted">Trusted</span> : t.revoked ? <span className="ap-revoked">Trust switched off</span> : null}
        </span>
        <span className="xs st-muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ap-dots" aria-hidden="true">
            {Array.from({ length: threshold }, (_, i) => (
              <i key={i} className={i < n ? 'on' : ''} />
            ))}
          </span>
          {earned ? `${t.approvedInARow} approved in a row` : `approved ${t.approvedInARow} in a row of ${threshold} needed`}
          {t.rejectedTotal ? ` · ${t.rejectedTotal} ${t.rejectedTotal === 1 ? 'rejection' : 'rejections'} so far` : ''}
          {t.lastDecisionAt ? ` · last decision ${formatDateTime(t.lastDecisionAt)}` : ''}
        </span>
        {err ? <span className="xs real-error" role="alert">{err}</span> : null}
      </div>
      <Switch
        checked={t.trusted}
        busy={busy}
        disabled={busy || (!earned && !t.revoked)}
        reason={!earned && !t.revoked ? `Earned after ${threshold} approvals in a row.` : undefined}
        label={<span className="st-vh">Trust {nameOf(t.format, names)}</span>}
        onChange={(v) => {
          setBusy(true);
          setErr('');
          act({ action: 'trust', format: t.format, trusted: v })
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}

export function TrustView({ d, act, names }: { d: AutopilotPayload; act: (a: AutopilotAction) => Promise<void>; names?: Names }) {
  return (
    <div className="st-stack" style={{ gap: 8 }}>
      <p className="st-small st-muted" style={{ margin: 0 }}>
        Trust is earned only from your own decisions: approve {d.trust.threshold} posts of a type that autopilot made, in a row, and that type becomes trusted. One rejection sets it back to zero. You can switch trust off (and on again) here at any time.
        {d.switches.trustedPublish.enabled ? '' : ` Trusted types publish by themselves only once that switch is on: ${d.switches.trustedPublish.reason || 'see signal.config.json.'}`}
      </p>
      {d.trust.formats.length === 0 ? <span className="st-small st-muted">No decisions yet. Trust builds as you approve posts autopilot made.</span> : null}
      {d.trust.formats.map((t) => (
        <TrustRow key={t.format} t={t} threshold={d.trust.threshold} act={act} names={names} />
      ))}
    </div>
  );
}

// ---- runs log -------------------------------------------------------------------------------
export function RunsLog({ d, names, limit = 8 }: { d: AutopilotPayload; names?: Names; limit?: number }) {
  const campaignName = (id: string | null) => d.campaigns.find((c) => c.id === id)?.name ?? (id ?? 'a campaign');
  const runs = d.runs.slice(0, limit);
  if (runs.length === 0) return <span className="st-small st-muted">No runs yet. The first one happens at {d.schedule.time} tomorrow, or press Run now.</span>;
  return (
    <ol className="ap-runs">
      {runs.map((r) => {
        const made = r.steps.filter((s) => s.kind === 'make' && !s.error).length;
        const approved = r.steps.filter((s) => s.kind === 'auto-approve' && !s.error).length;
        const problems = r.steps.filter((s) => 'error' in s && s.error).length;
        return (
          <li key={r.id}>
            <details className="ap-run">
              <summary>
                <span className="ap-run-day">{formatDateLabel(r.day)}</span>
                <span className="ap-run-meta">
                  <span className={`ap-run-status is-${r.status}`}>{STATUS_WORD[r.status]}</span>
                  <span className="st-muted">{r.trigger === 'daily' ? 'daily run' : 'you pressed Run now'} · {formatTime(r.startedAt)}</span>
                  <span className="st-muted">· {made} made{approved ? `, ${approved} auto-approved` : ''}{problems ? `, ${problems} ${problems === 1 ? 'problem' : 'problems'}` : ''}</span>
                  <span className="st-muted">· {money(r.costUsd)}</span>
                </span>
              </summary>
              <div className="st-stack" style={{ gap: 6, paddingTop: 8 }}>
                {r.note ? <span className="st-small ap-note">{r.note}</span> : null}
                {r.steps.length === 0 ? <span className="st-small st-muted">Nothing to do.</span> : null}
                <ol className="ap-steps">
                  {r.steps.map((s, i) => (
                    <li key={i} className={`ap-step-${s.kind} ${'error' in s && s.error ? 'is-error' : ''}`}>
                      {describeStep(s, campaignName, names)}
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

// ---- project summary (Today screen) ----------------------------------------------------------
export function AutopilotSummary({ say, openCampaigns }: { say: (t: string) => void; openCampaigns: () => void }) {
  const { data: d, example, error, act } = useAutopilot();
  if (error) return null; // Today stays useful without it; Campaigns shows the message.
  if (!d) return null;
  const on = d.campaigns.filter((c) => c.settings.enabled);
  const running = d.runs[0]?.status === 'running' ? d.runs[0] : null;
  const last = d.runs.find((r) => r.status !== 'running');
  const budget = on.reduce((a, c) => a + c.settings.dailyBudgetUsd, 0);
  const campaignName = (id: string | null) => d.campaigns.find((c) => c.id === id)?.name ?? (id ?? 'a campaign');
  const state = d.paused.paused ? 'Paused' : !d.switches.autopilot.enabled ? 'Switched off' : on.length ? 'On' : 'Off';
  const tone = state === 'On' ? 'active' : state === 'Paused' || state === 'Switched off' ? 'paused' : '';
  return (
    <section className="st-card st-stack ap-summary" style={{ padding: 18, gap: 12 }} aria-label="Autopilot">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Autopilot
          <span className={`camp-status ${tone}`}>{state}</span>
          {example ? <span className="ap-example">Example</span> : null}
        </span>
        <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
          <RunNowButton d={d} act={act} say={say} example={example} />
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={openCampaigns}>Set up in Campaigns</button>
        </div>
      </div>
      {example ? <ExampleNote /> : null}
      {d.paused.paused ? <Notice tone="warn">Paused: {d.paused.reason || 'automatic runs and approvals are stopped.'}</Notice> : null}
      {!d.switches.autopilot.enabled ? <Notice tone="off">Autopilot can’t run yet. {d.switches.autopilot.reason || 'It needs the feature switch first.'}</Notice> : null}
      <div className="ap-facts">
        <span className="st-small">
          {on.length === 0 ? (
            <>No campaign is on autopilot. {d.campaigns.length ? 'Switch it on inside a campaign.' : 'Make a campaign first.'}</>
          ) : (
            <>
              <b>{on.map((c) => c.name).join(', ')}</b> {on.length === 1 ? 'makes its posts' : 'make their posts'} automatically
              {on.some((c) => c.settings.autoPublish === 'trusted' && d.switches.trustedPublish.enabled) ? ' and may publish trusted post types.' : '. Every post still waits for you on the Posts board.'}
            </>
          )}
        </span>
        <ScheduleLine d={d} />
        <span className="st-small st-muted">
          Spent today: <b className="ap-ink">{money(d.spendToday)}</b>{budget ? ` of ${money(budget)} budgeted` : ''}
          {last ? <> · last run {formatDateLabel(last.day)}: {STATUS_WORD[last.status].toLowerCase()}{last.note ? ` — ${last.note}` : ''}</> : null}
        </span>
      </div>
      {running ? <LiveRun run={running} campaignName={campaignName} /> : null}
      <details className="ap-section">
        <summary>
          <span className="label">Trust per post type</span>
          <span className="xs st-muted">· {d.trust.formats.filter((t) => t.trusted).length} trusted</span>
        </summary>
        <div style={{ paddingTop: 10 }}>
          <TrustView d={d} act={act} />
        </div>
      </details>
      <details className="ap-section">
        <summary>
          <span className="label">Last runs</span>
          <span className="xs st-muted">· {d.runs.length} {d.runs.length === 1 ? 'run' : 'runs'}</span>
        </summary>
        <div style={{ paddingTop: 10 }}>
          <RunsLog d={d} />
        </div>
      </details>
    </section>
  );
}

// ---- Posts badge ---------------------------------------------------------------------------
/** "Made by autopilot" on the Posts board, with the pull button while an auto-approved post waits to go out. */
export function AutopilotMarkView({ packageId, mark, live, say, onPulled }: { packageId: string; mark: { madeAt: string; autoApproved: null | { at: string; scheduledFor: string | null; trustInARow: number } }; live: boolean; say: (t: string) => void; onPulled: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const a = mark.autoApproved;
  return (
    <div className="ap-mark st-stack" style={{ gap: 6 }}>
      <span className="st-small" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="ap-badge">Made by autopilot</span>
        <span className="st-muted">{formatDateTime(mark.madeAt)}</span>
      </span>
      {a && live ? (
        <div className="row-wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span className="st-small">
            Approved automatically ({a.trustInARow} approvals of this type in a row).{' '}
            <b>{a.scheduledFor ? `Will publish ${formatDateTime(a.scheduledFor)} unless you pull it.` : 'Approved by autopilot but not scheduled yet: it will not go out until it is scheduled.'}</b>
          </span>
          <button
            type="button"
            className="st-btn st-btn-ghost st-btn-sm"
            aria-busy={busy}
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Pull post ${packageId}? Its schedule is cancelled and the post is discarded. Nothing is published.`)) return;
              setBusy(true);
              setErr('');
              pullAutopilotPost(packageId)
                .then(async () => {
                  say(`Post ${packageId} pulled. It will not be published.`);
                  await onPulled();
                })
                .catch((e: Error) => setErr(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Pull this post
          </button>
        </div>
      ) : a ? (
        <span className="xs st-muted">Approved automatically {formatDateTime(a.at)}.</span>
      ) : null}
      {err ? <span className="xs real-error" role="alert">{err}</span> : null}
    </div>
  );
}
