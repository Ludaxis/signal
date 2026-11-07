'use client';
// Campaigns: several campaigns run in parallel for the project's account and share its posting days. Each
// campaign gets a strategy from the strategist agent, which the owner approves; then a two-week plan; each
// slot becomes a normal post on the Posts board. Agents run on the owner's own Claude Code, only on a button
// press. Layout: a card is a 3-line summary plus the next 5 slots; the strategy and the
// autopilot settings open in drawers; status words come from the dictionary (Draft, Running, Paused, Ended).
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyChanged, useOnChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { Select } from './Select';
import { Reveal, ScreenSkeleton, TaskProgress } from './loaders';
import { AutopilotPanel } from './Autopilot';
import { More } from './More';
import { formatDateLabel, formatDateTime, zoneCity } from '@/lib/time';
import { projectTimeZone } from '@/lib/studio/time';
import { t } from './copy/en';
import { Button, Chip, ChipRow, Drawer, Notice, Pill, useConfirm, type StatusWord } from './ui';
import { navigateTo } from './url-state';

type Status = 'draft' | 'active' | 'paused' | 'done';
interface PostType { format: string; role: string; hooks: string[]; captionStyle: string; visualDirection: string; hashtags: string[]; bestTimes: string[]; dos: string[]; donts: string[] }
interface Strategy {
  summary: string;
  audience: string;
  positioning: string;
  pillars: { name: string; weight: number; why: string }[];
  postTypes: PostType[];
  experiments: { hypothesis: string; measure: string }[];
  kpis: { metric: string; target: string }[];
  research: { finding: string; source: string }[];
  risks: string[];
  meta: { cli: string; seconds: number; at: string; billing?: string; costUsd?: number | null };
  approvedBy?: string;
  approvedAt?: string;
}
export interface Campaign {
  id: string;
  name: string;
  goal: string;
  brief: string;
  formats: string[];
  startDate: string;
  endDate: string | null;
  perWeek: number;
  priority: 1 | 2 | 3;
  status: Status;
  strategy: Strategy | null;
  proposal: Strategy | null;
}
export interface Slot { id: string; date: string; time: string; at: string; format: string; pillar: string; hook: string; angle: string; captionLead: string; packageId: string | null; status: 'planned' | 'made' | 'skipped'; articleUrl: string | null }
interface Plan { madeAt: string | null; slots: Slot[] }
export interface ListPayload { campaigns: Campaign[]; plans: Record<string, Plan>; agents: { enabled: boolean; reason: string }; goals: string[]; formats: { id: string; name: string }[]; timeZone?: string }

/** What Make does per format, and how long it usually takes (seconds), for the progress view. */
export const MAKE_STEPS: Record<string, string[]> = {
  default: [t('make.step.brief'), t('make.step.visual'), t('make.step.headline'), t('make.step.save')],
  'codex-post': [t('make.step.brief'), t('make.step.drawing'), t('make.step.headline'), t('make.step.save')],
  'higgsfield-image': [t('make.step.brief'), t('make.step.hfImage'), t('make.step.headline'), t('make.step.save')],
  'higgsfield-reel': [t('make.step.brief'), t('make.step.hfStill'), t('make.step.animate'), t('make.step.convert'), t('make.step.save')],
  'website-card': [t('make.step.page'), t('make.step.photo'), t('make.step.slides'), t('make.step.save')],
};
export const MAKE_SECONDS: Record<string, number> = { 'codex-post': 150, 'website-card': 12, 'higgsfield-image': 90, 'higgsfield-reel': 300 };

/** the only status words a campaign shows. */
export const CAMPAIGN_STATUS: Record<Status, StatusWord> = { draft: 'Draft', active: 'Running', paused: 'Paused', done: 'Ended' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The first sentence of a strategy summary, for the collapsed one-liner. */
export const firstSentence = (text: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  const out = (m?.[1] ?? text.trim()).trim();
  return out.length > 160 ? `${out.slice(0, 157).trimEnd()}…` : out;
};
/** a card shows at most this many slots without being expanded. */
export const PLAN_PREVIEW = 5;
/** a card shows at most this many summary lines. */
export const SUMMARY_LINES = 3;

/** The card's summary lines: plan, strategy, pillars (at most SUMMARY_LINES). */
export function summaryLines(c: Campaign): { text: string; content: boolean }[] {
  const start = formatDateLabel(c.startDate);
  const plan = c.endDate
    ? t('campaigns.line.planUntil', { goal: cap(c.goal), perWeek: c.perWeek, start, end: formatDateLabel(c.endDate) })
    : t('campaigns.line.plan', { goal: cap(c.goal), perWeek: c.perWeek, start });
  const s = c.strategy ?? c.proposal;
  const lines: { text: string; content: boolean }[] = [{ text: plan, content: false }];
  if (c.proposal) lines.push({ text: t('campaigns.line.proposal'), content: false });
  else if (s) lines.push({ text: firstSentence(s.summary), content: true });
  else lines.push({ text: t('campaigns.line.noStrategy'), content: false });
  if (s?.pillars.length) lines.push({ text: s.pillars.map((p) => p.name).join(' · '), content: true });
  return lines.slice(0, SUMMARY_LINES);
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

function NewCampaignDrawer({ data, onDone, onClose }: { data: ListPayload; onDone: (c: Campaign) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState(data.goals[0] ?? 'awareness');
  const [brief, setBrief] = useState('');
  const [formats, setFormats] = useState<string[]>([]);
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [perWeek, setPerWeek] = useState(3);
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = Boolean(name.trim() && formats.length);
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const j = await call<{ campaign: Campaign }>('/api/studio/campaigns', { project: getProjectId(), action: 'create', campaign: { name, goal, brief, formats, startDate: startDate || undefined, endDate: endDate || undefined, perWeek, priority } });
      onDone(j.campaign);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      title={t('campaigns.new')}
      dirty={Boolean(name.trim() || brief.trim() || formats.length)}
      onClose={onClose}
      primary={
        <Button level="primary" busy={busy} disabled={busy || !ready} reason={t('campaigns.needName')} onClick={() => void submit()}>
          {t('campaigns.create')}
        </Button>
      }
      secondary={<Button onClick={onClose}>{t('common.cancel')}</Button>}
    >
      <div className="u-stack u-gap-4">
        <label className="wiz-field">
          {t('campaigns.field.name')}
          <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} dir="auto" />
        </label>
        <div className="wiz-field">
          {t('campaigns.field.goal')}
          <Select label={t('campaigns.field.goal')} value={goal} onChange={(v) => setGoal(v)} options={data.goals.map((g) => ({ value: g, label: cap(g) }))} />
        </div>
        <label className="wiz-field">
          {t('campaigns.field.brief')}
          <span className="xs st-muted u-normal">{t('campaigns.field.briefHint')}</span>
          <textarea className="st-input gen-text" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={1500} dir="auto" />
        </label>
        <div className="wiz-field">
          {t('campaigns.field.types')}
          <ChipRow label={t('campaigns.field.types')}>
            {data.formats.map((f) => (
              <Chip key={f.id} selected={formats.includes(f.id)} onClick={() => setFormats(formats.includes(f.id) ? formats.filter((x) => x !== f.id) : [...formats, f.id])}>
                {f.name}
              </Chip>
            ))}
          </ChipRow>
        </div>
        <div className="camp-row4">
          <label className="wiz-field">
            {t('campaigns.field.start')}
            <input className="st-input" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="wiz-field">
            {t('campaigns.field.end')}
            <input className="st-input" type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="wiz-field">
            {t('campaigns.field.perWeek')}
            <Select label={t('campaigns.field.perWeek')} value={perWeek} onChange={(v) => setPerWeek(v)} options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))} />
          </div>
          <div className="wiz-field">
            {t('campaigns.field.priority')}
            <Select label={t('campaigns.field.priority')} value={priority} onChange={(v) => setPriority(v)} options={([1, 2, 3] as const).map((p) => ({ value: p, label: t(`campaigns.priority.${p}`) }))} />
          </div>
        </div>
        <span className="xs st-muted">{t('campaigns.field.shareNote')}</span>
        {err ? <Notice kind="error" title={t('common.couldNotChange', { thing: t('campaigns.new').toLowerCase() })} details={err} /> : null}
      </div>
    </Drawer>
  );
}

function StrategyView({ s, formats, tz }: { s: Strategy; formats: { id: string; name: string }[]; tz?: string }) {
  const fname = (id: string) => formats.find((f) => f.id === id)?.name ?? id;
  return (
    <div className="u-stack u-gap-3" data-content>
      <p className="st-small u-m0">{s.summary}</p>
      <div className="grid2 u-gap-3">
        <div className="u-stack u-gap-1">
          <span className="label">{t('campaigns.strategy.audience')}</span>
          <span className="st-small">{s.audience}</span>
        </div>
        <div className="u-stack u-gap-1">
          <span className="label">{t('campaigns.strategy.positioning')}</span>
          <span className="st-small">{s.positioning}</span>
        </div>
      </div>
      <div className="u-stack u-gap-2">
        <span className="label">{t('campaigns.strategy.pillars')}</span>
        {s.pillars.map((p) => (
          <div key={p.name} className="camp-pillar">
            <span className="st-small">
              <b>{p.name}</b> · {p.weight}% · {p.why}
            </span>
            <span className="camp-track" aria-hidden="true">
              <span className="camp-bar" style={{ '--w': `${Math.max(2, Math.min(100, p.weight))}%` } as React.CSSProperties} />
            </span>
          </div>
        ))}
      </div>
      {s.postTypes.map((p) => (
        <details key={p.format} className="camp-type">
          <summary>
            <b>{fname(p.format)}</b> <span className="xs st-muted">· {p.role}</span>
          </summary>
          <div className="u-stack u-gap-2 u-pt-2">
            <span className="st-small"><b>{t('campaigns.strategy.hooks')}:</b> {p.hooks.join(' · ')}</span>
            <span className="st-small"><b>{t('campaigns.strategy.captions')}:</b> {p.captionStyle}</span>
            <span className="st-small"><b>{t('campaigns.strategy.visuals')}:</b> {p.visualDirection}</span>
            <span className="st-small"><b>{t('campaigns.strategy.hashtags')}:</b> {p.hashtags.join(' ')}</span>
            <span className="st-small"><b>{t('campaigns.strategy.bestTimes')}:</b> {p.bestTimes.join(', ') || '—'} ({zoneCity(projectTimeZone(tz))})</span>
            {p.dos.length ? <span className="st-small"><b>{t('campaigns.strategy.do')}:</b> {p.dos.join(' · ')}</span> : null}
            {p.donts.length ? <span className="st-small"><b>{t('campaigns.strategy.dont')}:</b> {p.donts.join(' · ')}</span> : null}
          </div>
        </details>
      ))}
      <div className="grid2 u-gap-3">
        <div className="u-stack u-gap-1">
          <span className="label">{t('campaigns.strategy.experiments')}</span>
          {s.experiments.map((e) => (
            <span key={e.hypothesis} className="st-small">{e.hypothesis} <span className="st-muted">· {e.measure}</span></span>
          ))}
        </div>
        <div className="u-stack u-gap-1">
          <span className="label">{t('campaigns.strategy.targets')}</span>
          {s.kpis.map((k) => (
            <span key={k.metric} className="st-small">{k.metric}: <b>{k.target}</b></span>
          ))}
        </div>
      </div>
      {s.research.length ? (
        <details className="camp-type">
          <summary><b>{t('campaigns.strategy.research')}</b> <span className="xs st-muted">· {s.research.length}</span></summary>
          <ul className="st-small camp-research">
            {s.research.map((r) => (
              <li key={r.finding}>
                {r.finding}{' '}
                {/^https?:\/\//.test(r.source) ? (
                  <a className="real-link" href={r.source} target="_blank" rel="noreferrer">{t('campaigns.strategy.source')}</a>
                ) : <span className="st-muted">({r.source})</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {s.risks.length ? <span className="xs st-muted">{t('campaigns.strategy.risks')}: {s.risks.join(' · ')}</span> : null}
    </div>
  );
}

interface Progress { what: string; status: 'running' | 'done' | 'error'; startedAt: string; endedAt?: string; message?: string; events: { at: string; kind: string; text: string }[] }
const KIND_LABEL: Record<string, string> = { start: 'Start', note: 'Setup', search: 'Search', read: 'Read', thinking: 'Thinking', writing: 'Writing', done: 'Done', error: 'Error' };

/** Live view of an agent run: what it searches, reads and writes, polled every 1.5 s while it runs. */
function Activity({ campaignId, what, active, onFinished }: { campaignId: string; what: 'strategy' | 'plan'; active: boolean; onFinished?: () => void }) {
  const [p, setP] = useState<Progress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLOListElement | null>(null);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const j = await call<{ progress: Progress | null }>(`/api/studio/campaigns?project=${encodeURIComponent(getProjectId() ?? '')}&id=${encodeURIComponent(campaignId)}&progress=1`);
        if (!alive) return;
        setP(j.progress && j.progress.what === what ? j.progress : null);
        setNow(Date.now());
        if (j.progress?.what === what && j.progress.status === 'running') timer = setTimeout(() => void tick(), 1500);
        else if (active) timer = setTimeout(() => void tick(), 1500);
        else if (j.progress?.status !== 'running') finished.current?.();
      } catch {
        if (alive) timer = setTimeout(() => void tick(), 3000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [campaignId, what, active]);
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [p?.events.length]);
  if (!p || (p.status !== 'running' && !active)) return null;
  const secs = Math.max(0, Math.round(((p.status === 'running' ? now : Date.parse(p.endedAt ?? p.startedAt)) - Date.parse(p.startedAt)) / 1000));
  const state = p.status === 'running' ? t('campaigns.activity.working') : p.status === 'done' ? t('campaigns.activity.finished') : t('campaigns.activity.stopped');
  return (
    <div className="camp-activity" role="status" aria-live="polite">
      <span className="st-small camp-activity-head">
        {p.status === 'running' ? <span className="camp-spinner" aria-hidden="true" /> : null}
        <b>{what === 'strategy' ? t('campaigns.activity.strategist') : t('campaigns.activity.planner')}</b>
        <span className="st-muted">
          {state} · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
      </span>
      <ol className="camp-events" ref={listRef} data-content>
        {p.events.length === 0 ? <li className="xs st-muted">{t('campaigns.activity.starting')}</li> : null}
        {p.events.map((e, i) => (
          <li key={`${e.at}-${i}`} className={`camp-ev camp-ev-${e.kind}`}>
            <span className="camp-ev-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
            <span className="camp-ev-text">{e.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StrategyDrawer({ c, data, busy, onClose, act }: { c: Campaign; data: ListPayload; busy: string | null; onClose: () => void; act: (key: string, body: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [notes, setNotes] = useState('');
  const strategy = c.proposal ?? c.strategy;
  const agentsOff = !data.agents.enabled;
  const make = () => void act('strategy', { action: 'strategy', notes }, t('campaigns.strategy.ready')).then((ok) => ok && setNotes(''));
  const makeLabel = strategy ? t('campaigns.strategy.again') : t('campaigns.strategy.make');
  const makeButton = (level: 'primary' | 'secondary') => (
    <Button level={level} busy={busy === 'strategy'} disabled={!!busy || agentsOff} reason={agentsOff ? t('campaigns.agentsOff') : t('common.busy')} onClick={make}>
      {makeLabel}
    </Button>
  );
  return (
    <Drawer
      open
      width="wide"
      title={t('campaigns.strategy')}
      status={<Pill status={CAMPAIGN_STATUS[c.status]} />}
      dirty={Boolean(notes.trim())}
      onClose={onClose}
      primary={
        c.proposal ? (
          <Button level="primary" busy={busy === 'approve'} disabled={!!busy} reason={t('common.busy')} onClick={() => void act('approve', { action: 'approve-strategy' }, t('campaigns.strategy.approved'))}>
            {t('campaigns.strategy.approve')}
          </Button>
        ) : !strategy ? (
          makeButton('primary')
        ) : null
      }
      secondary={strategy ? makeButton('secondary') : null}
    >
      <div className="u-stack u-gap-4">
        {c.strategy && !c.proposal && c.strategy.approvedAt ? <span className="xs st-muted">{t('campaigns.strategy.approvedAt', { when: formatDateTime(c.strategy.approvedAt, projectTimeZone(data.timeZone)) })}</span> : null}
        {strategy ? <StrategyView s={strategy} formats={data.formats} tz={data.timeZone} /> : <span className="st-small st-muted">{t('campaigns.line.noStrategy')}</span>}
        <label className="wiz-field">
          <span className="xs st-muted u-normal">{strategy ? t('campaigns.strategy.notes') : t('campaigns.strategy.notesFirst')}</span>
          <input className="st-input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={800} dir="auto" />
        </label>
        {!strategy ? (
          <More label={t('campaigns.strategy.how')}>
            <span>{t('campaigns.strategy.howText')}</span>
          </More>
        ) : null}
        <Activity campaignId={c.id} what="strategy" active={busy === 'strategy'} />
      </div>
    </Drawer>
  );
}

type Opened = { kind: 'strategy' } | { kind: 'autopilot' } | null;

export function CampaignCard({ c, plan, data, say, onChange, openPosts }: { c: Campaign; plan: Plan; data: ListPayload; say: (t: string) => void; onChange: () => Promise<void>; openPosts: () => void }) {
  const confirmBox = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened>(null);
  const [err, setErr] = useState('');
  const formatNames = Object.fromEntries(data.formats.map((f) => [f.id, f.name]));
  const act = async (key: string, body: Record<string, unknown>, done: string): Promise<boolean> => {
    setBusy(key);
    setErr('');
    try {
      await call('/api/studio/campaigns', { project: getProjectId(), id: c.id, ...body });
      say(done);
      notifyChanged('campaigns', 'content', 'calendar');
      await onChange();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const upcoming = plan.slots.filter((s) => s.status !== 'skipped');
  const agentsOff = !data.agents.enabled;
  const ended = c.status === 'done';
  const endCampaign = () =>
    void confirmBox.confirm({ title: t('campaigns.endTitle', { name: c.name }), body: t('campaigns.endBody'), confirmLabel: t('campaigns.end'), destructive: true }).then((ok) => {
      if (ok) void act('st', { action: 'update', patch: { status: 'done' } }, t('campaigns.ended'));
    });

  function slotRow(s: Slot, i: number) {
    return (
      <Reveal key={s.id} index={i}>
        <div className={`camp-slot ${busy === s.id ? 'is-working' : ''}`} data-slot={s.id}>
          <div className="camp-when" data-content>
            <b>{formatDateLabel(s.date)}</b>
            <span className="xs st-muted">{s.time}</span>
          </div>
          <div className="camp-slot-text">
            {s.hook ? (
              <span className="st-small camp-hook" data-content dir="auto">
                {s.hook}
              </span>
            ) : null}
          </div>
          {s.status === 'made' ? (
            <Button dense onClick={openPosts}>
              {t('campaigns.slot.openPost', { id: s.packageId ?? '' })}
            </Button>
          ) : (
            <div className="camp-slot-actions">
              <Button dense busy={busy === s.id} disabled={!!busy} reason={t('common.busy')} onClick={() => void act(s.id, { action: 'make-post', slotId: s.id }, t('campaigns.slot.made'))}>
                {t('campaigns.slot.make')}
              </Button>
              <Button dense level="tertiary" busy={busy === `k${s.id}`} disabled={!!busy} reason={t('common.busy')} onClick={() => void act(`k${s.id}`, { action: 'skip-slot', slotId: s.id }, t('campaigns.slot.skipped'))}>
                {t('campaigns.slot.skip')}
              </Button>
            </div>
          )}
        </div>
        {busy === s.id ? <TaskProgress active title={t('campaigns.slot.making', { date: formatDateLabel(s.date) })} steps={MAKE_STEPS[s.format] ?? MAKE_STEPS.default!} expectedSeconds={MAKE_SECONDS[s.format] ?? 15} /> : null}
      </Reveal>
    );
  }

  const lines = summaryLines(c);
  return (
    <article className={`card camp-card camp-${c.status}`} aria-label={c.name}>
      {confirmBox.node}
      <div className="u-between u-gap-2">
        <h3 className="card-title camp-name" data-content>
          {c.name}
        </h3>
        <Pill status={CAMPAIGN_STATUS[c.status]} />
      </div>
      <ul className="camp-lines">
        {lines.map((l) => (
          <li key={l.text} className="camp-line st-small" data-content={l.content || undefined}>
            {l.text}
          </li>
        ))}
      </ul>
      <div className="camp-actions">
        {/* An ended campaign with no strategy has nothing to show or make. */}
        {!ended || c.strategy ? (
          <Button dense onClick={() => setOpened({ kind: 'strategy' })}>
            {c.proposal ? t('campaigns.strategy.approve') : c.strategy ? t('campaigns.strategy') : t('campaigns.strategy.make')}
          </Button>
        ) : null}
        {!ended ? (
          <Button dense onClick={() => setOpened({ kind: 'autopilot' })}>
            {t('campaigns.autopilot')}
          </Button>
        ) : null}
        {c.status === 'active' ? (
          <Button dense busy={busy === 'st'} disabled={!!busy} reason={t('common.busy')} onClick={() => void act('st', { action: 'update', patch: { status: 'paused' } }, t('campaigns.paused'))}>
            {t('campaigns.pause')}
          </Button>
        ) : !ended ? (
          <Button dense busy={busy === 'st'} disabled={!!busy || !c.strategy} reason={c.strategy ? t('common.busy') : t('campaigns.startReason')} onClick={() => void act('st', { action: 'update', patch: { status: 'active' } }, t('campaigns.started'))}>
            {t('campaigns.start')}
          </Button>
        ) : null}
        {!ended ? (
          <Button dense level="destructive" disabled={!!busy} reason={t('common.busy')} onClick={endCampaign}>
            {t('campaigns.end')}
          </Button>
        ) : null}
      </div>
      {err ? <Notice kind="error" title={t('common.couldNotChange', { thing: c.name })} details={err} /> : null}
      <Activity campaignId={c.id} what="strategy" active={busy === 'strategy'} />

      {!ended ? (
        <div className="camp-section">
          <div className="u-between u-gap-2">
            <span className="label">{t('campaigns.plan')}</span>
            <Button
              dense
              busy={busy === 'plan'}
              disabled={!!busy || agentsOff || c.status !== 'active'}
              reason={c.status !== 'active' ? t('campaigns.planReason') : agentsOff ? t('campaigns.agentsOff') : t('common.busy')}
              onClick={() => void act('plan', { action: 'plan' }, t('campaigns.planned'))}
            >
              {t('campaigns.plan')}
            </Button>
          </div>
          <Activity campaignId={c.id} what="plan" active={busy === 'plan'} />
          {upcoming.length === 0 ? <span className="st-small st-muted">{t('campaigns.noSlots')}</span> : null}
          {upcoming.slice(0, PLAN_PREVIEW).map((s, i) => slotRow(s, i))}
          {upcoming.length > PLAN_PREVIEW ? (
            <div>
              <Button dense level="tertiary" onClick={() => navigateTo('calendar', { params: { campaign: c.id } })}>
                {t('campaigns.showAll', { count: upcoming.length })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {opened?.kind === 'strategy' ? <StrategyDrawer c={c} data={data} busy={busy} onClose={() => setOpened(null)} act={act} /> : null}
      {opened?.kind === 'autopilot' ? (
        <Drawer open width="wide" title={t('campaigns.autopilot')} status={<Pill status={CAMPAIGN_STATUS[c.status]} />} onClose={() => setOpened(null)}>
          <AutopilotPanel campaign={{ id: c.id, name: c.name, formats: c.formats, status: c.status }} formatNames={formatNames} say={say} />
        </Drawer>
      ) : null}
    </article>
  );
}

export function Campaigns({ say, openPosts }: { say: (t: string) => void; openPosts: () => void }) {
  const pid = useProjectId();
  const [data, setData] = useState<ListPayload | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      setData(await call<ListPayload>(`/api/studio/campaigns?project=${encodeURIComponent(pid)}`));
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
  useOnChanged(['campaigns', 'content'], load);

  if (err && !data) {
    return (
      <section className="screen" aria-label="Campaigns">
        <Notice kind="error" title={t('campaigns.couldNotLoad')} details={err} onRetry={() => void load()} />
      </section>
    );
  }
  if (!data) return <ScreenSkeleton variant="cards" count={2} label={t('campaigns.loading')} />;
  const running = data.campaigns.filter((c) => c.status === 'active').length;
  const none = data.campaigns.length === 0;
  const create = (
    <Button level="primary" dense={!none} onClick={() => setCreating(true)}>
      {t('campaigns.new')}
    </Button>
  );
  return (
    <section className="screen u-stack u-gap-4" aria-label="Campaigns">
      {/* With no campaign the empty notice carries New campaign: one primary on the screen. */}
      <div className="u-between u-gap-3">
        <span className="st-small st-muted">{t('campaigns.summary', { running, total: data.campaigns.length })}</span>
        {none ? null : create}
      </div>
      {!data.agents.enabled ? <Notice kind="off" title={t('campaigns.agentsOff')} /> : null}
      {none ? <Notice kind="empty" title={t('campaigns.empty')} action={create} /> : null}
      {data.campaigns.map((c) => (
        <CampaignCard key={c.id} c={c} plan={data.plans[c.id] ?? { madeAt: null, slots: [] }} data={data} say={say} onChange={load} openPosts={openPosts} />
      ))}
      {creating ? (
        <NewCampaignDrawer
          data={data}
          onClose={() => setCreating(false)}
          onDone={(c) => {
            setCreating(false);
            say(t('campaigns.created', { name: c.name }));
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
