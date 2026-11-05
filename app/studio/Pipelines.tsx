'use client';
// Pipelines: one chain per pipeline (Source → Make → Review → Approve → Schedule) that Signal runs by itself
// inside the daily autopilot run. The card shows each step as a one-word chip; a chip opens its settings.
// New pipeline = three questions; everything else has a working default. Talks to /api/studio/pipelines
// through the contract in lib/studio/pipelines/types.ts.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AutopilotRun } from '@/lib/studio/autopilot/types';
import type { Format } from '@/lib/studio/generate';
import type { Pipeline, PipelineAction, PipelineRow, PipelineSteps, PipelinesPayload, SourceKind, StepsPatch } from '@/lib/studio/pipelines/types';
import { formatDateTime } from '@/lib/time';
import { describeStep } from './Autopilot';
import { useProjectId } from './Projects';
import { Select } from './Select';
import { ScreenSkeleton, Spinner } from './loaders';
import { notifyChanged, useOnChanged } from './sync';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCE: Record<SourceKind, { word: string; hint: string }> = {
  website: { word: 'Website', hint: 'New pages on your website.' },
  ideas: { word: 'Ideas', hint: 'AI writes ideas from your brand and results. Costs a little.' },
  list: { word: 'My list', hint: 'Your own topics, in order.' },
  campaign: { word: 'Campaign', hint: 'A campaign’s planned posts, while the campaign and its autopilot are on. What they cost counts against this pipeline’s budget, not the campaign’s.' },
};
const BRIEF_FORMATS = ['codex-post', 'higgsfield-image', 'higgsfield-reel'];
const CODEX = ['codex-post'];
/** "How often" presets for the quick start: days of the week. */
const OFTEN: { label: string; perWeek: number; days: number[] }[] = [
  { label: '1 / week', perWeek: 1, days: [2] },
  { label: '2 / week', perWeek: 2, days: [1, 4] },
  { label: '3 / week', perWeek: 3, days: [0, 2, 4] },
  { label: '5 / week', perWeek: 5, days: [0, 1, 2, 3, 4] },
  { label: 'Daily', perWeek: 7, days: [0, 1, 2, 3, 4, 5, 6] },
];
const money = (n: number) => `$${n.toFixed(2)}`;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type StepKey = keyof PipelineSteps;
type StepPatch = StepsPatch;

// ---- data -------------------------------------------------------------------------------------
async function post<T>(body: unknown): Promise<T> {
  const r = await fetch('/api/studio/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

export function usePipelines() {
  const pid = useProjectId();
  const [data, setData] = useState<PipelinesPayload | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/pipelines?project=${encodeURIComponent(pid)}`, { cache: 'no-store' });
      const j = (await r.json().catch(() => ({}))) as PipelinesPayload & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? 'Could not load pipelines.');
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
  useOnChanged(['pipelines', 'autopilot', 'campaigns', 'brand'], load);
  const running = Boolean(data?.running);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, load]);
  const act = useCallback(
    async (action: PipelineAction) => {
      const r = await post<{ pipeline?: Pipeline; run?: string }>({ project: pid, ...action });
      await load();
      notifyChanged('pipelines', ...(action.action === 'run-now' ? (['autopilot', 'content'] as const) : []));
      return r;
    },
    [pid, load],
  );
  return { data, error, reload: load, act };
}

// ---- small pieces ------------------------------------------------------------------------------
function Switch({ checked, onChange, label, disabled, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ap-switch" disabled={disabled} aria-busy={busy || undefined} onClick={() => onChange(!checked)}>
      <span className="ap-knob" aria-hidden="true" />
    </button>
  );
}

function Chips<V extends string | number>({ value, options, onChange, label, multi }: { value: V | V[]; options: { value: V; label: string; hint?: string; disabled?: boolean }[]; onChange: (v: V) => void; label: string; multi?: boolean }) {
  const on = (v: V) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <div className="pl-chips" role={multi ? 'group' : 'radiogroup'} aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className="st-chip" role={multi ? undefined : 'radio'} aria-checked={multi ? undefined : on(o.value)} aria-pressed={multi ? on(o.value) : undefined} disabled={o.disabled} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Why({ items }: { items: { text: string; why: string }[] }) {
  if (!items.length) return null;
  return (
    <details className="pl-why">
      <summary className="st-small">
        <span className="ap-reason">{items.map((x) => x.text).join(' ')}</span> <span className="pl-why-link">Why?</span>
      </summary>
      <ul className="xs st-muted">
        {items.map((x, i) => (
          <li key={i}>{x.why}</li>
        ))}
      </ul>
    </details>
  );
}

/** One-word summary of a step for its chip. */
function summary(p: PipelineRow, k: StepKey, names: Record<string, string>): string {
  const s = p.steps;
  switch (k) {
    case 'source':
      return s.source.kind === 'list' ? `${SOURCE.list.word} (${s.source.list.length})` : SOURCE[s.source.kind].word;
    case 'make':
      return s.source.kind === 'campaign' ? 'As planned' : (names[s.make.format] ?? s.make.format);
    case 'review':
      return s.review.enabled ? 'AI' : 'Off';
    case 'approve':
      return s.approve.mode === 'trusted' ? 'Trusted auto' : 'Ask me';
    case 'schedule':
      return s.source.kind === 'campaign' ? 'Campaign’s' : `${s.schedule.perWeek}/wk · ${s.schedule.days.map((d) => DAYS[d]).join(' ')} ${s.schedule.times.join(' ')}`;
    case 'budget':
      return money(s.budget.dailyUsd);
  }
}
const STEP_WORD: Record<StepKey, string> = { source: 'Source', make: 'Make', review: 'Review', approve: 'Approve', schedule: 'Schedule', budget: 'Budget' };
const CHAIN: StepKey[] = ['source', 'make', 'review', 'approve', 'schedule'];

// ---- step editors ------------------------------------------------------------------------------
function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="wiz-field pl-field" htmlFor={htmlFor}>
      {label}
      {children}
      {hint ? <span className="xs st-muted" style={{ fontWeight: 400 }}>{hint}</span> : null}
    </label>
  );
}

function ListEditor({ value, onCommit }: { value: string[]; onCommit: (list: string[]) => void }) {
  const [text, setText] = useState<string | null>(null);
  const id = useId();
  const current = text ?? value.join('\n');
  return (
    <Field label="Topics, one per line" htmlFor={id} hint="Used in order. The next one is at the top.">
      <textarea id={id} className="st-input pl-textarea" rows={4} value={current} onChange={(e) => setText(e.target.value)} onBlur={() => {
        if (text == null) return;
        const list = text.split('\n').map((x) => x.trim()).filter(Boolean);
        setText(null);
        if (list.join('\n') !== value.join('\n')) onCommit(list);
      }} />
    </Field>
  );
}

function TextField({ label, value, onCommit, hint, area, placeholder }: { label: string; value: string; onCommit: (v: string) => void; hint?: ReactNode; area?: boolean; placeholder?: string }) {
  const [text, setText] = useState<string | null>(null);
  const id = useId();
  const commit = () => {
    if (text == null) return;
    const v = text.trim();
    setText(null);
    if (v !== value) onCommit(v);
  };
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      {area ? (
        <textarea id={id} className="st-input pl-textarea" rows={3} placeholder={placeholder} value={text ?? value} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input id={id} className="st-input" placeholder={placeholder} value={text ?? value} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </Field>
  );
}

function SourceEditor({ p, d, patch }: { p: PipelineRow; d: PipelinesPayload; patch: (s: StepPatch) => void }) {
  const s = p.steps.source;
  const camps = d.campaigns.filter((c) => c.status !== 'done');
  return (
    <div className="st-stack" style={{ gap: 10 }}>
      <Chips label="Source" value={s.kind} options={(Object.keys(SOURCE) as SourceKind[]).map((k) => ({ value: k, label: SOURCE[k].word, hint: SOURCE[k].hint, disabled: k === 'campaign' && !camps.length }))} onChange={(kind) => patch({ source: { kind } })} />
      <span className="xs st-muted">{SOURCE[s.kind].hint}</span>
      {s.kind === 'list' ? <ListEditor value={s.list} onCommit={(list) => patch({ source: { list } })} /> : null}
      {s.kind === 'campaign' ? (
        <Field label="Campaign">
          <Select label="Campaign" value={s.campaign} options={camps.map((c) => ({ value: c.id, label: c.name, hint: c.status }))} onChange={(campaign) => patch({ source: { campaign } })} />
        </Field>
      ) : null}
      {s.kind === 'ideas' ? <span className="xs st-muted">{p.state.ideas.length ? `${p.state.ideas.length} ideas ready.` : 'Ideas are written on the next run.'}</span> : null}
    </div>
  );
}

function MakeEditor({ p, d, patch }: { p: PipelineRow; d: PipelinesPayload; patch: (s: StepPatch) => void }) {
  const m = p.steps.make;
  if (p.steps.source.kind === 'campaign') return <span className="st-small st-muted">Each post uses the campaign’s own brief and post type.</span>;
  const brief = BRIEF_FORMATS.includes(m.format);
  return (
    <div className="st-stack" style={{ gap: 10 }}>
      <Field label="Post type" hint={CODEX.includes(m.format) ? 'Codex runs only when you press Run now.' : undefined}>
        <Select label="Post type" value={m.format} options={d.formats.map((f) => ({ value: f.id, label: f.name }))} onChange={(format) => patch({ make: { format } })} />
      </Field>
      {brief ? <TextField area label="Image prompt" value={m.template} placeholder="{topic}" hint={<>Variables: {'{topic}'} {'{brand}'} {'{tone}'}. Empty = the topic.</>} onCommit={(template) => patch({ make: { template } })} /> : null}
      <TextField label="Caption style" value={m.captionStyle} placeholder="short, warm, one question" onCommit={(captionStyle) => patch({ make: { captionStyle } })} />
    </div>
  );
}

function ReviewEditor({ p, patch }: { p: PipelineRow; patch: (s: StepPatch) => void }) {
  return (
    <div className="ap-row">
      <span className="ap-row-text">
        <span className="ap-row-label">AI reviewer checks each post</span>
        <span className="xs st-muted">Claims, AI label, brand. Needed for trusted publishing.</span>
      </span>
      <Switch label="AI reviewer" checked={p.steps.review.enabled} onChange={(enabled) => patch({ review: { enabled } })} />
    </div>
  );
}

function ApproveEditor({ p, d, patch }: { p: PipelineRow; d: PipelinesPayload; patch: (s: StepPatch) => void }) {
  const uid = useId();
  const tp = d.switches.trustedPublish;
  return (
    <div className="st-stack" style={{ gap: 8 }}>
      <label className="real-check ap-check">
        <input type="radio" name={uid} checked={p.steps.approve.mode === 'ask'} onChange={() => patch({ approve: { mode: 'ask' } })} />
        <b>Ask me</b>
        <span className="xs st-muted ap-check-hint">Every post waits on the Posts board.</span>
      </label>
      <label className={`real-check ap-check ${!tp.enabled ? 'is-off' : ''}`}>
        <input type="radio" name={uid} checked={p.steps.approve.mode === 'trusted'} onChange={() => patch({ approve: { mode: 'trusted' } })} />
        <b>Trusted post types publish by themselves</b>
        <span className="xs st-muted ap-check-hint">{tp.enabled ? 'Only types you approved 5 times in a row, after the reviewer passes them. You can pull any post.' : tp.reason}</span>
      </label>
    </div>
  );
}

function ScheduleEditor({ p, d, patch }: { p: PipelineRow; d: PipelinesPayload; patch: (s: StepPatch) => void }) {
  const s = p.steps.schedule;
  const [time, setTime] = useState('');
  const [bad, setBad] = useState(false);
  if (p.steps.source.kind === 'campaign') return <span className="st-small st-muted">Posts follow the campaign’s plan, made up to {s.makeAheadDays} {s.makeAheadDays === 1 ? 'day' : 'days'} ahead.</span>;
  const addTime = () => {
    const t = time.trim();
    if (!TIME_RE.test(t)) return setBad(true);
    setBad(false);
    setTime('');
    if (!s.times.includes(t)) patch({ schedule: { times: [...s.times, t].sort() } });
  };
  return (
    <div className="st-stack" style={{ gap: 10 }}>
      <div className="pl-two">
        <Field label="Posts per week">
          <Select label="Posts per week" value={s.perWeek} options={Array.from({ length: 14 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} onChange={(perWeek) => patch({ schedule: { perWeek } })} />
        </Field>
        <Field label="Make ahead" hint="Days before the slot.">
          <Select label="Make ahead" value={s.makeAheadDays} options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: `${n} ${n === 1 ? 'day' : 'days'}` }))} onChange={(makeAheadDays) => patch({ schedule: { makeAheadDays } })} />
        </Field>
      </div>
      <div className="st-stack" style={{ gap: 6 }}>
        <span className="st-small" style={{ fontWeight: 600 }}>Days</span>
        <Chips multi label="Days" value={s.days} options={DAYS.map((l, i) => ({ value: i, label: l }))} onChange={(dIdx) => {
          const next = s.days.includes(dIdx) ? s.days.filter((x) => x !== dIdx) : [...s.days, dIdx].sort((a, b) => a - b);
          if (next.length) patch({ schedule: { days: next } });
        }} />
      </div>
      <div className="st-stack" style={{ gap: 6 }}>
        <span className="st-small" style={{ fontWeight: 600 }}>Times ({d.timeZone})</span>
        <div className="pl-chips">
          {s.times.map((t) => (
            <button key={t} type="button" className="st-chip" aria-label={`Remove ${t}`} title="Remove" disabled={s.times.length === 1} onClick={() => patch({ schedule: { times: s.times.filter((x) => x !== t) } })}>
              {t} <span aria-hidden="true">×</span>
            </button>
          ))}
          {s.times.length < 4 ? (
            <span className="pl-addtime">
              <input className="st-input" aria-label="New time" aria-invalid={bad || undefined} placeholder="HH:MM" inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTime()} />
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={addTime}>Add</button>
            </span>
          ) : null}
        </div>
        {bad ? <span className="xs real-error" role="alert">Use HH:MM.</span> : null}
      </div>
    </div>
  );
}

function BudgetEditor({ p, patch }: { p: PipelineRow; patch: (s: StepPatch) => void }) {
  const [text, setText] = useState<string | null>(null);
  const id = useId();
  return (
    <Field label="Daily budget" htmlFor={id} hint="Most Signal may spend on this pipeline per day. It stops before going over.">
      <span className="ap-money">
        <span aria-hidden="true">$</span>
        <input id={id} className="st-input" type="number" inputMode="decimal" min={0.5} max={20} step={0.5} value={text ?? String(p.steps.budget.dailyUsd)} onChange={(e) => setText(e.target.value)} onBlur={() => {
          if (text == null) return;
          const n = Math.max(0.5, Math.min(20, Number(text))); // $0 would make nothing at all
          setText(null);
          if (Number.isFinite(n) && n !== p.steps.budget.dailyUsd) patch({ budget: { dailyUsd: Math.round(n * 100) / 100 } });
        }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </span>
    </Field>
  );
}

function NameField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="pl-name"
      aria-label="Pipeline name"
      value={text ?? value}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text == null) return;
        const v = text.trim();
        setText(null);
        if (v && v !== value) onCommit(v);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

// ---- one card -----------------------------------------------------------------------------------
function Card({ p, d, act, say, names }: { p: PipelineRow; d: PipelinesPayload; act: ReturnType<typeof usePipelines>['act']; say: (t: string) => void; names: Record<string, string> }) {
  const [open, setOpen] = useState<StepKey | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      if (ok) say(ok);
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patch = (steps: StepPatch) => void run(() => act({ action: 'update', id: p.id, patch: { steps } }));
  const running = d.runs.find((r) => r.status === 'running');
  const mine = running && (running.pipeline === p.id || running.steps.some((s) => 'pipeline' in s && s.pipeline === p.id));
  const blocked = !d.switches.autopilot.enabled ? d.switches.autopilot.reason : d.paused.paused ? d.paused.reason : running ? 'A run is already going.' : '';
  // Escape closes the open step and puts focus back on its chip (only while focus is inside this card).
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !card.current?.contains(document.activeElement)) return;
      setOpen(null);
      (card.current.querySelector(`[data-step="${open}"]`) as HTMLElement | null)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const tone = p.status.text === 'On' ? 'active' : p.status.text === 'Waiting' ? 'paused' : '';

  return (
    <article className="st-card pl-card st-stack" aria-label={p.name} ref={card}>
      <div className="pl-head">
        <NameField value={p.name} onCommit={(name) => void run(() => act({ action: 'update', id: p.id, patch: { name } }))} />
        <span className={`camp-status ${tone}`}>{p.status.text}</span>
        <span className="xs st-muted pl-saved" role="status" aria-live="polite">{busy ? 'Saving…' : saved ? 'Saved' : ''}</span>
        <Switch label={`${p.name} on`} checked={p.enabled} busy={busy} onChange={(enabled) => void run(() => act({ action: 'toggle', id: p.id, enabled }), enabled ? 'On. It runs with the daily autopilot run.' : 'Off.')} />
      </div>

      <div className="pl-chain" role="group" aria-label="Steps">
        {CHAIN.map((k, i) => (
          <span key={k} className="pl-link">
            {i ? <span className="pl-arrow" aria-hidden="true">→</span> : null}
            <button type="button" data-step={k} className={`pl-chip ${open === k ? 'is-open' : ''}`} aria-expanded={open === k} aria-controls={`${uid}-${k}`} onClick={() => setOpen(open === k ? null : k)}>
              <span className="pl-chip-k">{STEP_WORD[k]}</span>
              <span className="pl-chip-v">{summary(p, k, names)}</span>
            </button>
          </span>
        ))}
      </div>
      {/* One panel per step stays in the DOM (hidden) so every chip's aria-controls resolves; the editor mounts only while open. */}
      {CHAIN.map((k) => (
        <div key={k} id={`${uid}-${k}`} className="pl-panel pop" hidden={open !== k}>
          {open === k && k === 'source' ? <SourceEditor p={p} d={d} patch={patch} /> : null}
          {open === k && k === 'make' ? <MakeEditor p={p} d={d} patch={patch} /> : null}
          {open === k && k === 'review' ? <ReviewEditor p={p} patch={patch} /> : null}
          {open === k && k === 'approve' ? <ApproveEditor p={p} d={d} patch={patch} /> : null}
          {open === k && k === 'schedule' ? <ScheduleEditor p={p} d={d} patch={patch} /> : null}
        </div>
      ))}

      <div className="pl-foot">
        <span className="st-small st-muted pl-facts">
          {p.steps.source.kind === 'campaign' ? 'Next: as the campaign plans' : p.nextAt ? `Next ${formatDateTime(p.nextAt)}` : 'Up to date'}
          {' · '}
          {money(p.spendToday)} today of {money(p.steps.budget.dailyUsd)}
          {p.state.lastResult ? <> · {p.state.lastResult}</> : null}
        </span>
        <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
          <button type="button" className="st-btn st-btn-dark st-btn-sm" disabled={busy || !!blocked} title={blocked || 'Makes the posts due now'} aria-busy={busy} onClick={() => void run(() => act({ action: 'run-now', id: p.id }), 'Started. It makes the posts that are due now.')}>
            Run now
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-expanded={more} aria-controls={`${uid}-more`} onClick={() => setMore(!more)}>
            More
          </button>
        </div>
      </div>
      <div id={`${uid}-more`} className="pl-more pop" hidden={!more}>
        {more ? (
          <>
            <button type="button" data-step="budget" className="pl-chip" aria-expanded={open === 'budget'} aria-controls={`${uid}-budget`} onClick={() => setOpen(open === 'budget' ? null : 'budget')}>
              <span className="pl-chip-k">Budget</span>
              <span className="pl-chip-v">{summary(p, 'budget', names)}</span>
            </button>
            <span className="xs st-muted">
              {p.last ? `Last run ${formatDateTime(p.last.at)}: ${p.last.made} made${p.last.problems ? `, ${p.last.problems} problems` : ''}.` : 'No run yet.'}
              {d.nextRunAt ? ` Daily run ${formatDateTime(d.nextRunAt)}.` : ''}
            </span>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={() => {
              if (!window.confirm(`Remove “${p.name}”? Its posts stay.`)) return;
              void run(() => act({ action: 'delete', id: p.id }), 'Removed.');
            }}>
              Remove
            </button>
          </>
        ) : null}
      </div>
      <div id={`${uid}-budget`} className="pl-panel pop" hidden={!(open === 'budget' && more)}>
        {open === 'budget' && more ? <BudgetEditor p={p} patch={patch} /> : null}
      </div>
      <Why items={p.status.problems} />
      {err ? <span className="xs real-error" role="alert">{err}</span> : null}
      {mine ? (
        <div className="ld-task" role="status" aria-live="polite">
          <div className="ld-task-head">
            <Spinner size={14} />
            <b>Running</b>
          </div>
          <ol className="ld-steps ap-live-steps">
            {running!.steps.filter((s) => 'pipeline' in s && s.pipeline === p.id).map((s, i, arr) => (
              <li key={i} className={i === arr.length - 1 ? 'now' : 'done'}>{describeStep(s, () => p.name, names)}</li>
            ))}
            {!running!.steps.some((s) => 'pipeline' in s && s.pipeline === p.id) ? <li className="now">Starting</li> : null}
          </ol>
        </div>
      ) : null}
    </article>
  );
}

// ---- quick start ----------------------------------------------------------------------------------
function QuickStart({ d, onDone, onCancel }: { d: PipelinesPayload; onDone: (p: Pipeline) => void; onCancel: () => void }) {
  const pid = useProjectId();
  const camps = d.campaigns.filter((c) => c.status === 'active');
  /** A post type that can run by itself today: not Codex, Higgsfield only when switched on; else the website post. */
  const usable = (f: { id: Format }) => !CODEX.includes(f.id) && f.id !== 'website-card' && (d.switches.higgsfield.enabled || !f.id.startsWith('higgsfield'));
  const autoFormat = (): Format => d.formats.find(usable)?.id ?? d.formats.find((f) => f.id === 'website-card')?.id ?? d.formats[0]!.id;
  const [kind, setKind] = useState<SourceKind>(d.website ? 'website' : 'ideas');
  const [format, setFormat] = useState<Format>(d.website && d.formats.some((f) => f.id === 'website-card') ? 'website-card' : autoFormat());
  const [often, setOften] = useState(2);
  const [list, setList] = useState('');
  const [campaign, setCampaign] = useState<string | null>(camps[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = (k: SourceKind) => {
    setKind(k);
    if (k === 'website' && d.formats.some((f) => f.id === 'website-card')) setFormat('website-card');
    if (k !== 'website' && format === 'website-card') setFormat(autoFormat());
  };
  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      const o = OFTEN[often]!;
      const steps: StepPatch = {
        source: { kind, list: list.split('\n').map((x) => x.trim()).filter(Boolean), campaign: kind === 'campaign' ? campaign : null },
        make: { format, template: '', captionStyle: '' },
        schedule: { perWeek: o.perWeek, days: o.days, times: ['18:00'], makeAheadDays: 3 },
      };
      const r = await post<{ pipeline: Pipeline }>({ project: pid, action: 'create', pipeline: { enabled: true, steps } });
      notifyChanged('pipelines');
      onDone(r.pipeline);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="st-card pl-quick st-stack pop" aria-label="New pipeline" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <div className="st-stack" style={{ gap: 6 }}>
        <span className="label">1 · Where do ideas come from?</span>
        <Chips label="Source" value={kind} options={(Object.keys(SOURCE) as SourceKind[]).map((k) => ({ value: k, label: SOURCE[k].word, hint: SOURCE[k].hint, disabled: (k === 'campaign' && !camps.length) || (k === 'website' && !d.website) }))} onChange={pick} />
        <span className="xs st-muted">{SOURCE[kind].hint}{kind === 'website' && !d.website ? ' Import the website on the Brand screen first.' : ''}</span>
        {kind === 'list' ? <textarea className="st-input pl-textarea" rows={3} aria-label="Topics, one per line" placeholder="One topic per line" value={list} onChange={(e) => setList(e.target.value)} /> : null}
        {kind === 'campaign' ? <Select label="Campaign" value={campaign} options={camps.map((c) => ({ value: c.id, label: c.name }))} onChange={setCampaign} /> : null}
      </div>
      {kind !== 'campaign' ? (
        <div className="st-stack" style={{ gap: 6 }}>
          <span className="label">2 · What kind of post?</span>
          <Select label="Post type" value={format} options={d.formats.map((f) => ({ value: f.id, label: f.name, hint: CODEX.includes(f.id) ? 'Only on Run now' : undefined }))} onChange={setFormat} />
        </div>
      ) : null}
      {kind !== 'campaign' ? (
        <div className="st-stack" style={{ gap: 6 }}>
          <span className="label">3 · How often?</span>
          <Chips label="How often" value={often} options={OFTEN.map((o, i) => ({ value: i, label: o.label }))} onChange={setOften} />
          <span className="xs st-muted">{OFTEN[often]!.days.map((x) => DAYS[x]).join(', ')} at 18:00. Change it later on the card.</span>
        </div>
      ) : null}
      {err ? <span className="xs real-error" role="alert">{err}</span> : null}
      <div className="row-wrap" style={{ gap: 8 }}>
        <button type="submit" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy} disabled={busy || (kind === 'list' && !list.trim()) || (kind === 'campaign' && !campaign)}>
          Create
        </button>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---- the screen ----------------------------------------------------------------------------------------
export function Pipelines({ say }: { say: (t: string) => void }) {
  const { data: d, error, act, reload } = usePipelines();
  const [adding, setAdding] = useState(false);
  if (error) return <p className="real-error st-small" role="alert">{error}</p>;
  if (!d) return <ScreenSkeleton variant="cards" count={2} label="Loading pipelines" />;
  const names = Object.fromEntries(d.formats.map((f) => [f.id, f.name]));
  const global = [...(d.paused.paused ? [{ text: 'Paused.', why: d.paused.reason }] : []), ...(!d.switches.autopilot.enabled ? [{ text: 'Autopilot is switched off: nothing runs by itself.', why: d.switches.autopilot.reason }] : [])];
  const lastRuns = d.runs.filter((r) => r.status !== 'running').slice(0, 3);
  return (
    <section className="screen st-stack" style={{ gap: 16 }} aria-label="Pipelines">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span className="st-small st-muted">Each pipeline makes posts by itself, once a day{d.nextRunAt ? ` (next ${formatDateTime(d.nextRunAt)})` : ''}.</span>
        {!adding ? <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => setAdding(true)}>New pipeline</button> : null}
      </div>
      <Why items={global} />
      {adding ? <QuickStart d={d} onDone={(p) => { setAdding(false); say(`“${p.name}” created and on.`); void reload(); }} onCancel={() => setAdding(false)} /> : null}
      {!d.pipelines.length && !adding ? (
        <div className="st-card pl-empty st-stack">
          <span style={{ fontWeight: 600 }}>No pipeline yet.</span>
          <span className="st-small st-muted">Three questions, then it makes posts on its own.</span>
          <div><button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => setAdding(true)}>New pipeline</button></div>
        </div>
      ) : null}
      {d.pipelines.map((p) => (
        <Card key={p.id} p={p} d={d} act={act} say={say} names={names} />
      ))}
      {lastRuns.length ? (
        <details className="ap-section">
          <summary><span className="label">Last runs</span></summary>
          <ol className="ap-runs" style={{ paddingTop: 8 }}>
            {lastRuns.map((r: AutopilotRun) => (
              <li key={r.id}>
                <details className="ap-run">
                  <summary>
                    <span className="ap-run-day">{formatDateTime(r.startedAt)}</span>
                    <span className="ap-run-meta"><span className={`ap-run-status is-${r.status}`}>{r.status}</span><span className="st-muted">· {money(r.costUsd)}</span></span>
                  </summary>
                  <ol className="ap-steps">
                    {r.steps.filter((s) => 'pipeline' in s && s.pipeline).map((s, i) => (
                      <li key={i} className={`ap-step-${s.kind} ${'error' in s && s.error ? 'is-error' : ''}`}>{describeStep(s, () => d.pipelines.find((p) => p.id === ('pipeline' in s ? s.pipeline : ''))?.name ?? 'a pipeline', names)}</li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
