'use client';
// Campaigns: several campaigns run in parallel for the project's Instagram account and share its
// posting days. Each campaign gets a strategy from the strategist agent (brand, past posts, results,
// web research), which the owner approves; then a two-week plan of post briefs; each brief becomes
// a normal post package on the Posts board. Agents run on the owner's own Claude Code, only on a button press.
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyChanged, useOnChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { Select } from './Select';
import { Reveal, ScreenSkeleton, TaskProgress } from './loaders';
import { AutopilotPanel } from './Autopilot';
import { TIMEZONE, formatDateLabel, formatDateTime } from '@/lib/time';

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
interface Campaign {
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
interface Slot { id: string; date: string; time: string; at: string; format: string; pillar: string; hook: string; angle: string; captionLead: string; packageId: string | null; status: 'planned' | 'made' | 'skipped'; articleUrl: string | null }
interface Plan { madeAt: string | null; slots: Slot[] }
interface ListPayload { campaigns: Campaign[]; plans: Record<string, Plan>; agents: { enabled: boolean; reason: string }; goals: string[]; formats: { id: string; name: string }[] }

/** What Make post does per format, and how long it usually takes (seconds), for the progress view. */
export const MAKE_STEPS: Record<string, string[]> = {
  default: ['Reading the brief', 'Making the visual', 'Adding headline and labels', 'Saving the package'],
  'codex-post': ['Reading the brief', 'Codex is drawing the image', 'Adding headline and labels', 'Saving the package'],
  'higgsfield-image': ['Reading the brief', 'Higgsfield is making the image', 'Adding headline and labels', 'Saving the package'],
  'higgsfield-reel': ['Reading the brief', 'Higgsfield is making the still', 'Animating the video', 'Converting for Instagram', 'Saving the package'],
  'website-card': ['Reading the page', 'Fetching the photo', 'Rendering slides', 'Saving the package'],
};
export const MAKE_SECONDS: Record<string, number> = { 'codex-post': 150, 'website-card': 12, 'higgsfield-image': 90, 'higgsfield-reel': 300 };

const STATUS_TEXT: Record<Status, string> = { draft: 'Draft', active: 'Running', paused: 'Paused', done: 'Finished' };
const PRIORITY_TEXT = { 1: 'High', 2: 'Normal', 3: 'Low' } as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

function NewCampaign({ data, onDone, onCancel }: { data: ListPayload; onDone: (c: Campaign) => void; onCancel: () => void }) {
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
    <div className="st-card st-stack" style={{ padding: 18, gap: 12 }}>
      <span className="label">New campaign</span>
      <div className="grid2" style={{ gap: 12 }}>
        <label className="wiz-field">
          Name
          <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Holiday puzzles" maxLength={80} />
        </label>
        <div className="wiz-field">
          Goal
          <Select label="Goal" value={goal} onChange={(v) => setGoal(v)} options={data.goals.map((g) => ({ value: g, label: cap(g) }))} />
        </div>
      </div>
      <label className="wiz-field">
        Brief <span className="st-muted" style={{ fontWeight: 400 }}>(what you want, who for, anything to avoid)</span>
        <textarea className="st-input gen-text" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={1500} />
      </label>
      <div className="wiz-field">
        Post types
        <div className="st-chip-row" role="group" aria-label="Post types">
          {data.formats.map((f) => (
            <button key={f.id} type="button" className="st-chip" aria-pressed={formats.includes(f.id)} onClick={() => setFormats(formats.includes(f.id) ? formats.filter((x) => x !== f.id) : [...formats, f.id])}>
              {f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="camp-row4">
        <label className="wiz-field">
          Start
          <input className="st-input" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="wiz-field">
          End <span className="st-muted" style={{ fontWeight: 400 }}>(optional)</span>
          <input className="st-input" type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <div className="wiz-field">
          Posts a week
          <Select label="Posts a week" value={perWeek} onChange={(v) => setPerWeek(v)} options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))} />
        </div>
        <div className="wiz-field">
          Priority
          <Select label="Priority" value={priority} onChange={(v) => setPriority(v)} options={([1, 2, 3] as const).map((p) => ({ value: p, label: PRIORITY_TEXT[p] }))} />
        </div>
      </div>
      <span className="xs st-muted">All campaigns share one post a day on this account. Higher priority campaigns plan first.</span>
      {err ? <p className="real-error st-small" role="alert">{err}</p> : null}
      <div className="row-wrap" style={{ gap: 8 }}>
        <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy} disabled={busy || !name.trim() || !formats.length} onClick={() => void submit()}>
          {busy ? 'Creating' : 'Create campaign'}
        </button>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StrategyView({ s, formats }: { s: Strategy; formats: { id: string; name: string }[] }) {
  const fname = (id: string) => formats.find((f) => f.id === id)?.name ?? id;
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <p className="st-small" style={{ margin: 0 }}>{s.summary}</p>
      <div className="grid2" style={{ gap: 12 }}>
        <div className="st-stack" style={{ gap: 4 }}>
          <span className="label">Audience</span>
          <span className="st-small">{s.audience}</span>
        </div>
        <div className="st-stack" style={{ gap: 4 }}>
          <span className="label">Positioning</span>
          <span className="st-small">{s.positioning}</span>
        </div>
      </div>
      <div className="st-stack" style={{ gap: 6 }}>
        <span className="label">Pillars</span>
        {s.pillars.map((p) => (
          <div key={p.name} className="camp-pillar">
            <span className="st-small">
              <b>{p.name}</b> · {p.weight}% — {p.why}
            </span>
            <span className="camp-track" aria-hidden="true">
              <span className="camp-bar" style={{ width: `${Math.max(2, Math.min(100, p.weight))}%` }} />
            </span>
          </div>
        ))}
      </div>
      {s.postTypes.map((p) => (
        <details key={p.format} className="camp-type">
          <summary>
            <b>{fname(p.format)}</b> <span className="xs st-muted">· {p.role}</span>
          </summary>
          <div className="st-stack" style={{ gap: 6, paddingTop: 8 }}>
            <span className="st-small"><b>Hooks:</b> {p.hooks.join(' · ')}</span>
            <span className="st-small"><b>Captions:</b> {p.captionStyle}</span>
            <span className="st-small"><b>Visuals:</b> {p.visualDirection}</span>
            <span className="st-small"><b>Hashtags:</b> {p.hashtags.join(' ')}</span>
            <span className="st-small"><b>Best times:</b> {p.bestTimes.join(', ') || '—'} ({TIMEZONE})</span>
            {p.dos.length ? <span className="st-small"><b>Do:</b> {p.dos.join(' · ')}</span> : null}
            {p.donts.length ? <span className="st-small"><b>Don&apos;t:</b> {p.donts.join(' · ')}</span> : null}
          </div>
        </details>
      ))}
      <div className="grid2" style={{ gap: 12 }}>
        <div className="st-stack" style={{ gap: 4 }}>
          <span className="label">Experiments</span>
          {s.experiments.map((e) => (
            <span key={e.hypothesis} className="st-small">{e.hypothesis} <span className="st-muted">— {e.measure}</span></span>
          ))}
        </div>
        <div className="st-stack" style={{ gap: 4 }}>
          <span className="label">Targets</span>
          {s.kpis.map((k) => (
            <span key={k.metric} className="st-small">{k.metric}: <b>{k.target}</b></span>
          ))}
        </div>
      </div>
      {s.research.length ? (
        <details className="camp-type">
          <summary><b>Research</b> <span className="xs st-muted">· {s.research.length} findings with sources</span></summary>
          <ul className="st-small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {s.research.map((r) => (
              <li key={r.finding}>
                {r.finding}{' '}
                {/^https?:\/\//.test(r.source) ? (
                  <a className="real-link" href={r.source} target="_blank" rel="noreferrer">source</a>
                ) : <span className="st-muted">({r.source})</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {s.risks.length ? <span className="xs st-muted">Risks: {s.risks.join(' · ')}</span> : null}
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [p?.events.length]);
  if (!p || (p.status !== 'running' && !active)) return null;
  const secs = Math.max(0, Math.round(((p.status === 'running' ? now : Date.parse(p.endedAt ?? p.startedAt)) - Date.parse(p.startedAt)) / 1000));
  const searches = p.events.filter((e) => e.kind === 'search').length;
  const reads = p.events.filter((e) => e.kind === 'read').length;
  return (
    <div className="camp-activity" role="status" aria-live="polite">
      <div className="row-wrap" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="st-small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {p.status === 'running' ? <span className="camp-spinner" aria-hidden="true" /> : null}
          <b>{what === 'strategy' ? 'Strategist' : 'Content planner'}</b>
          <span className="st-muted">
            {p.status === 'running' ? 'working' : p.status === 'done' ? 'finished' : 'stopped'} · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
            {searches ? ` · ${searches} ${searches === 1 ? 'search' : 'searches'}` : ''}
            {reads ? ` · ${reads} ${reads === 1 ? 'page' : 'pages'} read` : ''}
          </span>
        </span>
      </div>
      <ol className="camp-events" ref={listRef}>
        {p.events.length === 0 ? <li className="xs st-muted">Starting…</li> : null}
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

function CampaignCard({ c, plan, data, say, onChange, openPosts }: { c: Campaign; plan: Plan; data: ListPayload; say: (t: string) => void; onChange: () => Promise<void>; openPosts: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState(c.status !== 'done');
  const fname = (id: string) => data.formats.find((f) => f.id === id)?.name ?? id;
  const formatNames = Object.fromEntries(data.formats.map((f) => [f.id, f.name]));
  const [err, setErr] = useState('');
  const act = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    setErr('');
    try {
      await call('/api/studio/campaigns', { project: getProjectId(), id: c.id, ...body });
      say(done);
      notifyChanged('campaigns', 'content', 'calendar');
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const upcoming = plan.slots.filter((s) => s.status !== 'skipped');
  const agentsOff = !data.agents.enabled;
  return (
    <div className={`st-card st-stack camp-card camp-${c.status}`} style={{ padding: 18, gap: 14 }}>
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button type="button" className="camp-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="camp-name">{c.name}</span>
          <span className="xs st-muted">
            {cap(c.goal)} · {c.perWeek}/week · {PRIORITY_TEXT[c.priority]} priority · {c.formats.map(fname).join(', ')} · from {formatDateLabel(c.startDate)}
            {c.endDate ? ` to ${formatDateLabel(c.endDate)}` : ''}
          </span>
        </button>
        <div className="row-wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className={`camp-status ${c.status}`}>{STATUS_TEXT[c.status]}</span>
          {c.status === 'active' ? (
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'st'} disabled={!!busy} onClick={() => void act('st', { action: 'update', patch: { status: 'paused' } }, 'Campaign paused')}>Pause</button>
          ) : c.status !== 'done' ? (
            <button type="button" className="st-btn st-btn-dark st-btn-sm" aria-busy={busy === 'st'} disabled={!!busy || !c.strategy} title={c.strategy ? '' : 'Approve a strategy first'} onClick={() => void act('st', { action: 'update', patch: { status: 'active' } }, 'Campaign running')}>Start</button>
          ) : null}
          {c.status !== 'done' ? (
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => { if (window.confirm(`Finish “${c.name}”? Its open slots free up for other campaigns.`)) void act('st', { action: 'update', patch: { status: 'done' } }, 'Campaign finished'); }}>Finish</button>
          ) : null}
        </div>
      </div>

      {err ? (
        <p className="real-error st-small" role="alert" style={{ margin: 0, overflowWrap: 'anywhere' }}>
          {err}
        </p>
      ) : null}
      {open ? (
        <>
          {c.brief ? <p className="st-small st-muted" style={{ margin: 0 }}>{c.brief}</p> : null}

          <div className="camp-section st-stack" style={{ gap: 10 }}>
            <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="label">{c.proposal ? 'Strategy proposal' : 'Strategy'}</span>
              {c.strategy && !c.proposal ? <span className="xs st-muted">Approved {formatDateTime(c.strategy.approvedAt)}</span> : null}
              {c.proposal ? <span className="xs st-muted">From Claude Code ({c.proposal.meta.cli}) in {c.proposal.meta.seconds}s{c.proposal.meta.costUsd != null ? ` · $${c.proposal.meta.costUsd.toFixed(2)} on your API key` : ''}</span> : null}
            </div>
            {c.proposal ? <StrategyView s={c.proposal} formats={data.formats} /> : c.strategy ? <StrategyView s={c.strategy} formats={data.formats} /> : <span className="st-small st-muted">No strategy yet. The strategist reads the brand, your past posts and results, and researches what works now.</span>}
            <div className="row-wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              {c.proposal ? (
                <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'approve'} disabled={!!busy} onClick={() => void act('approve', { action: 'approve-strategy' }, 'Strategy approved')}>Approve strategy</button>
              ) : null}
              <label className="wiz-field camp-notes">
                <span className="xs st-muted" style={{ fontWeight: 400 }}>{c.strategy || c.proposal ? 'What to change (optional)' : 'Anything the strategist should know (optional)'}</span>
                <input className="st-input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={800} />
              </label>
              <button type="button" className={`st-btn st-btn-sm ${c.proposal || c.strategy ? 'st-btn-ghost' : 'st-btn-primary'}`} aria-busy={busy === 'strategy'} disabled={!!busy || agentsOff} title={agentsOff ? data.agents.reason : ''} onClick={() => void act('strategy', { action: 'strategy', notes }, 'New strategy proposal is ready').then(() => setNotes(''))}>
                {busy === 'strategy' ? 'Researching' : c.proposal || c.strategy ? 'Make a new strategy' : 'Make strategy'}
              </button>
            </div>
            <Activity campaignId={c.id} what="strategy" active={busy === 'strategy'} />
          </div>

          <div className="camp-section st-stack" style={{ gap: 10 }}>
            <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="label">Plan</span>
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'plan'} disabled={!!busy || agentsOff || c.status !== 'active'} title={c.status !== 'active' ? 'Start the campaign first' : agentsOff ? data.agents.reason : ''} onClick={() => void act('plan', { action: 'plan' }, 'Next two weeks planned')}>
                {busy === 'plan' ? 'Planning' : upcoming.length ? 'Plan the next two weeks again' : 'Plan the next two weeks'}
              </button>
            </div>
            <Activity campaignId={c.id} what="plan" active={busy === 'plan'} />
            {upcoming.length === 0 ? <span className="st-small st-muted">No posts planned yet.</span> : null}
            {upcoming.map((s, i) => (
              <Reveal key={s.id} index={i}>
              <div className={`camp-slot ${busy === s.id ? 'is-working' : ''}`}>
                <div className="camp-when">
                  <b>{formatDateLabel(s.date)}</b>
                  <span className="xs st-muted">{s.time}</span>
                </div>
                <div className="st-stack" style={{ gap: 2, minWidth: 0, flex: '1 1 260px' }}>
                  <span className="st-small"><b>{s.hook || fname(s.format)}</b></span>
                  <span className="xs st-muted">{fname(s.format)} · {s.pillar}{s.angle ? ` · ${s.angle}` : ''}</span>
                </div>
                {s.status === 'made' ? (
                  <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={openPosts}>Post {s.packageId} in Posts</button>
                ) : (
                  <div className="row-wrap" style={{ gap: 6 }}>
                    <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === s.id} disabled={!!busy} onClick={() => void act(s.id, { action: 'make-post', slotId: s.id }, 'Post made: it is in Planned on the Posts board')}>
                      {busy === s.id ? 'Making' : 'Make post'}
                    </button>
                    <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === `k${s.id}`} disabled={!!busy} onClick={() => void act(`k${s.id}`, { action: 'skip-slot', slotId: s.id }, 'Slot skipped')}>Skip</button>
                  </div>
                )}
              </div>
              {busy === s.id ? <TaskProgress active title={`Making the ${fname(s.format).toLowerCase()} for ${formatDateLabel(s.date)}`} steps={MAKE_STEPS[s.format] ?? MAKE_STEPS.default!} expectedSeconds={MAKE_SECONDS[s.format] ?? 15} /> : null}
              </Reveal>
            ))}
          </div>

          <AutopilotPanel campaign={{ id: c.id, name: c.name, formats: c.formats, status: c.status }} formatNames={formatNames} say={say} />
        </>
      ) : null}
    </div>
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

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!data) return <ScreenSkeleton variant="cards" count={2} label="Loading campaigns" />;
  const running = data.campaigns.filter((c) => c.status === 'active').length;
  return (
    <section className="screen st-stack" style={{ gap: 16 }} aria-label="Campaigns">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="st-small st-muted">
          {running} running · {data.campaigns.length} in total · {data.agents.enabled ? 'Agents use your Claude Code on this machine, when you press a button.' : data.agents.reason}
        </span>
        {!creating ? (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => setCreating(true)}>New campaign</button>
        ) : null}
      </div>
      {creating ? (
        <NewCampaign
          data={data}
          onCancel={() => setCreating(false)}
          onDone={(c) => {
            setCreating(false);
            say(`Campaign “${c.name}” created`);
            void load();
          }}
        />
      ) : null}
      {data.campaigns.length === 0 && !creating ? <span className="st-small st-muted">No campaigns yet. Make one per goal; they run side by side and share the posting days.</span> : null}
      {data.campaigns.map((c) => (
        <CampaignCard key={c.id} c={c} plan={data.plans[c.id] ?? { madeAt: null, slots: [] }} data={data} say={say} onChange={load} openPosts={openPosts} />
      ))}
    </section>
  );
}
