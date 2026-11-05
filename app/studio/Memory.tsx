'use client';
// Memory: the project's track record as a decision map (Mindmap), the Timeline of events, the
// Learnings with their confidence, the Decision log and the agent Runs. Read-only: everything shown
// comes from the memory files next to the project's posts (GET /api/studio/memory). Until memory is
// switched on or before anything was recorded, the tab explains what will appear and can show
// a clearly marked example.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useOnChanged } from './sync';
import { useProjectId } from './Projects';
import { ScreenSkeleton } from './loaders';
import { MemoryMindmap, type FocusRequest } from './MemoryMindmap';
import { statusHistory } from './memory-layout';
import { DECISION_TITLE, EVENT_GROUPS, METRIC_LABEL, ROLE_LABEL, RUN_STATUS_LABEL, STATUS_LABEL, TYPE_LABEL, VIA_LABEL, describeEvent, eventGroup, eventLink, fmtDuration, fmtEffect, fmtInt, fmtPct, fmtUsd, who, type EventGroup } from './memory-format';
import { zonedParts, formatDateLabel, formatDateTime, formatTime, todayInZone } from '@/lib/time';
import type { DecisionRecord, GraphNode, Learning, MemEvent, MemoryPayload } from '@/lib/studio/memory/types';
import './memory.css';

type Tab = 'mindmap' | 'timeline' | 'learnings' | 'decisions' | 'runs';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mindmap', label: 'Mindmap' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'learnings', label: 'Learnings' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'runs', label: 'Runs' },
];

async function call<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

// ---- small shared pieces -------------------------------------------------------------------------
function GroupIcon({ g, type }: { g: EventGroup; type?: string }) {
  const special: Record<string, ReactNode> = {
    'post.published': <path d="M4 12l16-8-6 16-2-7-8-1z" />,
    'post.approved': <path d="M20 6L9 17l-5-5" />,
    'post.rejected': <path d="M18 6L6 18M6 6l12 12" />,
    'post.failed': <path d="M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5" />,
    'post.scheduled': <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2" />,
    'post.discarded': <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
    'post.edited': <path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4" />,
    'post.reviewed': <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />,
  };
  const d: Record<EventGroup, ReactNode> = {
    content: <path d="M4 4h10l6 6v10H4zM14 4v6h6M8 14h8M8 17h5" />,
    results: <path d="M4 20V11M10 20V5M16 20v-8M22 20H2" />,
    audience: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
    strategy: <path d="M4 10v4l12 5V5L4 10zM8 15v4M19 9v6" />,
    knowledge: <path d="M4 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" />,
    system: <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />,
  };
  return (
    <svg className={`mem-gicon mem-g-${g}`} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {(type && special[type]) ?? d[g]}
    </svg>
  );
}
const StatusChip = ({ s }: { s: GraphNode['status'] }) => (s ? <span className={`mem-status mem-s-${s}`}>{STATUS_LABEL[s]}</span> : null);
const ViaChip = ({ via }: { via: DecisionRecord['via'] }) => <span className={`mem-via mem-via-${via}`}>{VIA_LABEL[via]}</span>;
function ConfidenceBar({ value, threshold, label }: { value: number | null; threshold?: number | null; label: string }) {
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <span className="mem-conf" role="img" aria-label={`${label}: ${value === null ? 'unknown' : fmtPct(value)}${threshold != null ? `, threshold ${fmtPct(threshold)}` : ''}`}>
      <i style={{ width: `${v * 100}%` }} />
      {threshold != null ? <b style={{ left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }} /> : null}
    </span>
  );
}
function LearningCard({ l, now, nodeLabel, compact = false }: { l: Learning; now: string; nodeLabel?: (id: string) => string | null; compact?: boolean }) {
  const age = Math.max(0, (Date.parse(now) - Date.parse(l.lastEvidence ?? l.updatedAt)) / 86_400_000);
  const weight = Math.pow(0.5, age / Math.max(1, l.halfLifeDays));
  const little = l.status === 'too-little-data';
  const scope: string[] = [];
  if (l.scope.format) scope.push(`format: ${l.scope.format}`);
  if (l.scope.hookStyle) scope.push(`hook: ${l.scope.hookStyle}`);
  if (l.scope.hour !== undefined) scope.push(`at ${String(l.scope.hour).padStart(2, '0')}:00`);
  if (l.scope.branch && nodeLabel) {
    const lb = nodeLabel(l.scope.branch);
    if (lb) scope.push(lb);
  }
  return (
    <article className={`st-card mem-learning ${l.status === 'retired' ? 'is-retired' : ''} ${compact ? 'is-compact' : ''}`} aria-label={l.text}>
      <div className="mem-learning-head">
        <p className="mem-learning-text">{l.text}</p>
        {little ? <span className="mem-tag mem-tag-amber">Too little data</span> : l.status === 'retired' ? <span className="mem-tag">Retired</span> : null}
      </div>
      <div className="mem-learning-effect">
        <b className={l.effect !== null && l.effect < 1 ? 'is-down' : 'is-up'}>{fmtEffect(l.effect)}</b>
        <span className="st-small">{METRIC_LABEL[l.metric]}</span>
        {l.interval ? <span className="xs st-muted">· interval {l.interval[0].toFixed(2)}–{l.interval[1].toFixed(2)}</span> : null}
      </div>
      <div className="mem-learning-conf">
        <ConfidenceBar value={l.confidence} label="Confidence" />
        <span className="xs"><b>{fmtPct(l.confidence)}</b> <span className="st-muted">confidence</span></span>
        <span className="xs st-muted">n {l.n} · nEff {l.nEff.toFixed(1)}</span>
      </div>
      {!compact ? (
        <div className="mem-learning-foot">
          <span className="row-wrap" style={{ gap: 6 }}>
            {scope.map((s) => (
              <span key={s} className="pill pill-soft">{s}</span>
            ))}
          </span>
          <span className="xs st-muted">{l.lastEvidence ? `Last evidence ${formatDateLabel(zonedParts(l.lastEvidence).date)}` : 'No evidence yet'} · recency weight {weight.toFixed(2)}</span>
        </div>
      ) : null}
    </article>
  );
}
function Probabilities({ p, answer }: { p: Record<string, number> | null; answer: DecisionRecord['answer'] }) {
  if (!p) return <span className="st-muted">—</span>;
  const rows = Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const key = typeof answer === 'boolean' ? (answer ? 'yes' : 'no') : String(answer);
  return (
    <span className="mem-probs">
      {rows.map(([k, v]) => (
        <span key={k} className={`mem-prob ${key === k ? 'is-answer' : ''}`} title={`${k}: ${fmtPct(v)}`}>
          <span className="mem-prob-k">{k}</span>
          <i style={{ width: `${Math.max(2, v * 100)}%` }} />
          <span className="mem-prob-v">{fmtPct(v)}</span>
        </span>
      ))}
    </span>
  );
}

// ---- views ---------------------------------------------------------------------------------------
function Timeline({ data, onOpenNode }: { data: MemoryPayload; onOpenNode: (id: string) => void }) {
  const [groups, setGroups] = useState<Set<EventGroup>>(() => new Set());
  const [q, setQ] = useState('');
  const nodeLabel = useMemo(() => new Map(data.graph.nodes.map((n) => [n.id, n.label])), [data.graph.nodes]);
  const campaignName = useMemo(() => new Map(data.campaigns.map((c) => [c.id, c.name])), [data.campaigns]);
  const counts = useMemo(() => {
    const c = new Map<EventGroup, number>();
    for (const e of data.events) c.set(eventGroup(e.type), (c.get(eventGroup(e.type)) ?? 0) + 1);
    return c;
  }, [data.events]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.events
      .map((e) => ({ e, g: eventGroup(e.type), text: describeEvent(e) }))
      .filter((x) => (groups.size === 0 || groups.has(x.g)) && (!needle || `${x.text} ${x.e.type} ${who(x.e.by)} ${x.e.refs.branch ? nodeLabel.get(x.e.refs.branch) ?? '' : ''}`.toLowerCase().includes(needle)));
  }, [data.events, groups, q, nodeLabel]);
  const byDay = useMemo(() => {
    const m = new Map<string, typeof items>();
    for (const it of items) {
      const d = zonedParts(it.e.at).date;
      m.set(d, [...(m.get(d) ?? []), it]);
    }
    return [...m.entries()];
  }, [items]);
  const toggleGroup = (g: EventGroup) =>
    setGroups((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  return (
    <div className="st-stack" style={{ gap: 14 }}>
      <div className="mem-filters">
        <div className="row-wrap mem-chips" role="group" aria-label="Event groups">
          {EVENT_GROUPS.map((g) => (
            <button key={g.id} type="button" className={`st-chip mem-chip-${g.id}`} aria-pressed={groups.has(g.id)} onClick={() => toggleGroup(g.id)} disabled={!counts.get(g.id)}>
              {g.label} <span className="mem-chip-n">{counts.get(g.id) ?? 0}</span>
            </button>
          ))}
          {groups.size ? (
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setGroups(new Set())}>Clear</button>
          ) : null}
        </div>
        <label className="mem-search">
          <span className="st-vh">Search events</span>
          <input className="st-input" type="search" placeholder="Search events…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {byDay.length === 0 ? (
        <p className="st-small st-muted" role="status">No events match.</p>
      ) : (
        <ol className="mem-days" aria-label="Timeline">
          {byDay.map(([d, rows]) => (
            <li key={d} className="mem-dayrow">
              <h3 className="mem-dayhead">
                <span>{formatDateLabel(d, true)}</span>
                <span className="xs st-muted">{rows.length} {rows.length === 1 ? 'event' : 'events'}</span>
              </h3>
              <ol className="mem-events">
                {rows.map(({ e, g, text }) => {
                  const link = eventLink(e);
                  const branch = e.refs.branch && nodeLabel.has(e.refs.branch) ? e.refs.branch : null;
                  return (
                    <li key={e.id} className={`mem-event mem-g-${g}`}>
                      <GroupIcon g={g} type={e.type} />
                      <div className="mem-event-body">
                        <p className="mem-event-text">{text}</p>
                        <p className="xs st-muted mem-event-meta">
                          <span>{formatTime(e.at)}</span>
                          <span>· {who(e.by)}</span>
                          {e.campaign && campaignName.get(e.campaign) ? <span>· {campaignName.get(e.campaign)}</span> : null}
                          <span className="mem-event-type">· {e.type}</span>
                          {link ? (
                            <a href={link} target="_blank" rel="noreferrer noopener">source</a>
                          ) : null}
                        </p>
                      </div>
                      {branch ? (
                        <button type="button" className="mem-open" onClick={() => onOpenNode(branch)} aria-label={`Open “${nodeLabel.get(branch)}” in the map`}>
                          <span className="mem-open-label">{nodeLabel.get(branch)}</span>
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Learnings({ data, now }: { data: MemoryPayload; now: string }) {
  const nodeLabel = useCallback((id: string) => data.graph.nodes.find((n) => n.id === id)?.label ?? null, [data.graph.nodes]);
  const sorted = useMemo(
    () =>
      [...data.learnings]
        .map((l) => {
          const age = Math.max(0, (Date.parse(now) - Date.parse(l.lastEvidence ?? l.updatedAt)) / 86_400_000);
          return { l, score: (l.status === 'retired' ? 0.1 : 1) * l.confidence * Math.pow(0.5, age / Math.max(1, l.halfLifeDays)) };
        })
        .sort((a, b) => b.score - a.score || a.l.id.localeCompare(b.l.id))
        .map((x) => x.l),
    [data.learnings, now],
  );
  if (sorted.length === 0) return <p className="st-small st-muted">No learnings yet. They appear after the first results come in.</p>;
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <p className="st-small st-muted" style={{ margin: 0 }}>Beliefs the agents read, with numbers instead of opinions. Sorted by confidence × recency (half-life {sorted[0]?.halfLifeDays ?? 14} days); below nEff 3 a learning is shown but never used to pivot.</p>
      <div className="mem-learnings">
        {sorted.map((l) => (
          <LearningCard key={l.id} l={l} now={now} nodeLabel={nodeLabel} />
        ))}
      </div>
    </div>
  );
}

function Decisions({ data }: { data: MemoryPayload }) {
  const totals = useMemo(() => {
    const via: Record<DecisionRecord['via'], number> = { rule: 0, cache: 0, judge: 0, escalated: 0 };
    let right = 0;
    let wrong = 0;
    for (const d of data.decisions) {
      via[d.via]++;
      if (d.outcome === 'right') right++;
      if (d.outcome === 'wrong') wrong++;
    }
    return { via, right, wrong };
  }, [data.decisions]);
  return (
    <div className="st-stack" style={{ gap: 14 }}>
      <div className="mem-totals">
        <div className="st-card stat mem-stat">
          <span className="label">Decisions</span>
          <span className="stat-num mem-stat-num">{fmtInt(data.stats.decisions)}</span>
          <span className="xs st-muted">{totals.right + totals.wrong ? `${totals.right} right · ${totals.wrong} wrong so far` : 'outcomes not known yet'}</span>
        </div>
        <div className="st-card stat mem-stat">
          <span className="label">By route</span>
          <span className="row-wrap mem-via-row">
            {(['rule', 'cache', 'judge', 'escalated'] as const).map((v) => (
              <span key={v} className="mem-via-count">
                <ViaChip via={v} />
                <b>{totals.via[v]}</b>
              </span>
            ))}
          </span>
        </div>
        <div className="st-card stat mem-stat">
          <span className="label">Judge cost</span>
          <span className="stat-num mem-stat-num">{fmtUsd(data.stats.judgeCostUsd, '$0')}</span>
          <span className="xs st-muted">{totals.via.judge} judge calls · rules and cache are free</span>
        </div>
      </div>
      {data.decisions.length === 0 ? (
        <p className="st-small st-muted">No decisions yet.</p>
      ) : (
        <div className="st-card mem-tablewrap">
          <table className="res-table mem-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Decision</th>
                <th scope="col">Via</th>
                <th scope="col">Answer</th>
                <th scope="col">Probabilities</th>
                <th scope="col">Confidence</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d) => {
                const score = d.kind === 'score' && typeof d.answer === 'number' ? d.answer : null;
                const below = score !== null ? d.threshold !== null && score < d.threshold : d.confidence !== null && d.threshold !== null && d.confidence < d.threshold;
                return (
                  <tr key={d.id} className={d.via === 'escalated' ? 'is-escalated' : ''}>
                    <td data-label="When" className="mem-td-when">{formatDateTime(d.at)}</td>
                    <td data-label="Decision" className="mem-td-dec">
                      <span className="mem-dec-title">{DECISION_TITLE[d.decision] ?? d.decision}</span>
                      {d.note ? <span className="xs st-muted mem-dec-note">{d.note}</span> : null}
                    </td>
                    <td data-label="Via"><ViaChip via={d.via} />{d.judge ? <span className="xs st-muted mem-judge">{d.judge}</span> : null}</td>
                    <td data-label="Answer" className="mem-td-answer">
                      {d.answer === null ? <span className="st-muted">to you</span> : d.kind === 'predicate' ? (d.answer === true ? 'yes' : d.answer === false ? 'no' : String(d.answer)) : String(d.answer)}
                      {score !== null && d.threshold !== null ? <span className={`xs ${below ? 'mem-below' : 'st-muted'}`}> {below ? '<' : '≥'} {d.threshold}</span> : null}
                      {d.outcome ? <span className={`mem-outcome is-${d.outcome}`}>{d.outcome}</span> : null}
                    </td>
                    <td data-label="Probabilities"><Probabilities p={d.probabilities} answer={d.answer} /></td>
                    <td data-label="Confidence" className="mem-td-conf">
                      {d.confidence === null ? (
                        <span className="st-muted">—</span>
                      ) : (
                        <span className={`mem-confcell ${below && score === null ? 'is-below' : ''}`}>
                          <ConfidenceBar value={d.confidence} threshold={score === null ? d.threshold : null} label="Confidence" />
                          <span className="xs">{fmtPct(d.confidence)}{score === null && d.threshold !== null ? <span className="st-muted"> {below ? '<' : '≥'} {fmtPct(d.threshold)}</span> : null}</span>
                        </span>
                      )}
                    </td>
                    <td data-label="Cost" className="mem-td-cost">{fmtUsd(d.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Runs({ data }: { data: MemoryPayload }) {
  if (data.runs.length === 0) return <p className="st-small st-muted">No agent runs yet. Every run shows its role, model, cost and what it produced.</p>;
  return (
    <div className="st-stack" style={{ gap: 10 }}>
      <div className="row-wrap" style={{ gap: 14, alignItems: 'baseline' }}>
        <span className="st-small"><b>{data.runs.length}</b> runs</span>
        <span className="st-small">agents <b>{fmtUsd(data.stats.agentCostUsd, '$0')}</b> in total</span>
      </div>
      <ol className="mem-runs">
        {data.runs.map((r) => (
          <li key={r.id} className={`st-card mem-run is-${r.status}`}>
            <div className="mem-run-head">
              <span className="mem-role">{ROLE_LABEL[r.role] ?? r.role}</span>
              <span className={`mem-runstatus is-${r.status}`}>
                <i aria-hidden="true" />
                {RUN_STATUS_LABEL[r.status]}
              </span>
              <span className="xs st-muted mem-run-when">{formatDateTime(r.startedAt)}</span>
            </div>
            <p className="st-small mem-run-summary">{r.summary ?? (r.error ? <span className="real-error">{r.error}</span> : r.status === 'running' ? 'Working…' : 'No summary.')}</p>
            <div className="xs st-muted mem-run-meta">
              <span><b>{r.status === 'running' ? 'cost so far unknown' : fmtUsd(r.costUsd)}</b></span>
              <span>· {fmtDuration(r.startedAt, r.endedAt)}</span>
              {r.turns !== null ? <span>· {r.turns} turns</span> : null}
              {r.model ? <span>· {r.model}</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NodePanel({ data, node, now, onClose, onOpenTimeline, onSelect }: { data: MemoryPayload; node: GraphNode; now: string; onClose: () => void; onOpenTimeline: () => void; onSelect: (id: string) => void }) {
  const titleId = useId();
  const learning = node.learning ? data.learnings.find((l) => l.id === node.learning) : undefined;
  const eventsById = useMemo(() => new Map(data.events.map((e) => [e.id, e])), [data.events]);
  const evidence = node.evidence.map((id) => eventsById.get(id)).filter((e): e is MemEvent => Boolean(e)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const decisionIds = new Set(evidence.map((e) => e.refs.decision).filter(Boolean));
  const decisions = data.decisions.filter((d) => decisionIds.has(d.id) || (d.note ?? '').includes(node.id)).slice(0, 8);
  const hist = statusHistory(node);
  const metrics = node.meta.metrics && typeof node.meta.metrics === 'object' ? Object.entries(node.meta.metrics as Record<string, unknown>).filter((x): x is [string, number] => typeof x[1] === 'number') : [];
  const parent = node.parent ? data.graph.nodes.find((n) => n.id === node.parent) : undefined;
  const children = data.graph.nodes.filter((n) => n.parent === node.id);
  const campaign = data.campaigns.find((c) => c.id === node.campaign);
  const approved = (node.meta as { approvedAt?: string }).approvedAt;
  const metricName = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  return (
    <aside className="mem-panel st-card" aria-labelledby={titleId}>
      <div className="mem-panel-head">
        <div className="st-stack" style={{ gap: 4, minWidth: 0 }}>
          <span className="label">{TYPE_LABEL[node.type]}{node.weight !== null ? ` · ${node.weight}%` : ''}</span>
          <h3 id={titleId} className="mem-panel-title">{node.label}</h3>
          <div className="row-wrap" style={{ gap: 6, alignItems: 'center' }}>
            <StatusChip s={node.status} />
            {node.type === 'pivot' ? <span className={`mem-status ${approved ? 'mem-s-pivot-approved' : 'mem-s-proposed'}`}>{approved ? 'Approved' : 'Proposed'}</span> : null}
            {campaign ? <span className="pill pill-soft">{campaign.name}</span> : null}
            <span className="xs st-muted">created {formatDateLabel(zonedParts(node.created).date)}</span>
          </div>
        </div>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm mem-close" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <div className="mem-panel-body">
        {parent || children.length ? (
          <section className="mem-sec">
            <span className="label">In the tree</span>
            <div className="row-wrap" style={{ gap: 6 }}>
              {parent ? (
                <button type="button" className="pill pill-outline mem-pillbtn" onClick={() => onSelect(parent.id)}>↑ {parent.label}</button>
              ) : null}
              {children.map((c) => (
                <button key={c.id} type="button" className="pill pill-outline mem-pillbtn" onClick={() => onSelect(c.id)}>↳ {c.label}</button>
              ))}
            </div>
          </section>
        ) : null}
        {hist.length > 0 ? (
          <section className="mem-sec">
            <span className="label">Status history</span>
            <ol className="mem-hist">
              {hist.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <span className="xs st-muted">{formatDateLabel(zonedParts(h.at).date)}</span>
                  {h.status ? <StatusChip s={h.status} /> : <span className="mem-status mem-s-pivot-approved">{node.type === 'pivot' ? 'Approved' : 'No status'}</span>}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {metrics.length > 0 ? (
          <section className="mem-sec">
            <span className="label">Numbers</span>
            <dl className="mem-metrics">
              {metrics.map(([k, v]) => (
                <div key={k}>
                  <dt className="xs st-muted">{metricName(k)}</dt>
                  <dd>{v < 1 ? v.toFixed(4) : fmtInt(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {learning ? (
          <section className="mem-sec">
            <span className="label">Learning</span>
            <LearningCard l={learning} now={now} compact />
          </section>
        ) : null}
        <section className="mem-sec">
          <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="label">Evidence · {evidence.length}</span>
            {evidence.length ? <button type="button" className="mem-link" onClick={onOpenTimeline}>Timeline</button> : null}
          </div>
          {evidence.length === 0 ? (
            <p className="xs st-muted">No events linked yet.</p>
          ) : (
            <ol className="mem-evlist">
              {evidence.slice(0, 12).map((e) => (
                <li key={e.id} className="mem-evitem">
                  <GroupIcon g={eventGroup(e.type)} type={e.type} />
                  <span className="st-stack" style={{ gap: 1, minWidth: 0 }}>
                    <span className="st-small">{describeEvent(e)}</span>
                    <span className="xs st-muted">{formatDateTime(e.at)} · {who(e.by)}</span>
                  </span>
                </li>
              ))}
              {evidence.length > 12 ? <li className="xs st-muted">and {evidence.length - 12} more</li> : null}
            </ol>
          )}
        </section>
        {decisions.length > 0 ? (
          <section className="mem-sec">
            <span className="label">Decisions</span>
            <ol className="mem-declist">
              {decisions.map((d) => (
                <li key={d.id} className="mem-decitem">
                  <ViaChip via={d.via} />
                  <span className="st-stack" style={{ gap: 1, minWidth: 0 }}>
                    <span className="st-small">{DECISION_TITLE[d.decision] ?? d.decision} → <b>{d.answer === null ? 'to you' : String(d.answer)}</b></span>
                    <span className="xs st-muted">{formatDateTime(d.at)}{d.confidence !== null ? ` · ${fmtPct(d.confidence)}` : ''}{d.threshold !== null ? ` vs ${fmtPct(d.threshold)}` : ''}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function EmptyState({ reason, demo, onDemo }: { reason: string; demo: boolean; onDemo: (on: boolean) => void }) {
  return (
    <div className="st-card mem-empty">
      <div className="st-stack" style={{ gap: 6 }}>
        <span className="label">Nothing recorded yet</span>
        <h3 className="mem-empty-title">Memory starts with the first campaign.</h3>
        <p className="st-small st-muted">Once posts, results and decisions are recorded, this tab shows where the project started, how the map grew and why: a decision map from goal to strategy to pillars and tested ideas, a timeline of every event, learnings with their confidence, and every routing decision with its cost.</p>
        {reason ? <p className="st-small notice">{reason}</p> : null}
      </div>
      <button type="button" className="st-chip" aria-pressed={demo} onClick={() => onDemo(!demo)}>
        {demo ? 'Showing example data' : 'Preview with example data'}
      </button>
    </div>
  );
}

// ---- screen --------------------------------------------------------------------------------------
export function Memory({ say }: { say: (t: string) => void }) {
  const pid = useProjectId();
  const [d, setD] = useState<MemoryPayload | null>(null);
  const [err, setErr] = useState('');
  const [demo, setDemo] = useState(false);
  const [tab, setTab] = useState<Tab>('mindmap');
  const [selected, setSelected] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const tabId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async () => {
    if (!pid) return;
    try {
      setD(await call<MemoryPayload>(`/api/studio/memory?project=${encodeURIComponent(pid)}${demo ? '&demo=1' : ''}`));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [pid, demo]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['content', 'campaigns'], load);

  const now = useMemo(() => {
    if (!d) return new Date().toISOString();
    const latest = [...d.events.map((e) => e.at), ...d.learnings.map((l) => l.updatedAt)].sort().pop() ?? '';
    const today = `${todayInZone()}T12:00:00.000Z`;
    return latest > today ? latest : today;
  }, [d]);
  const selectedNode = useMemo(() => (d && selected ? d.graph.nodes.find((n) => n.id === selected) ?? null : null), [d, selected]);

  const openNode = (id: string) => {
    setTab('mindmap');
    setSelected(id);
    setFocusReq((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = TABS[next];
    if (!t) return;
    setTab(t.id);
    tabRefs.current[next]?.focus();
  };

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!d) return <ScreenSkeleton variant="cards" count={3} label="Loading memory" />;
  const empty = !d.enabled || d.graph.nodes.length === 0;
  const showEmpty = empty && !demo;

  return (
    <section className="screen st-stack mem" style={{ gap: 18 }} aria-label="Memory">
      <div className="row-wrap mem-head">
        <span className="st-small st-muted mem-headline">
          Memory for <b>{d.project.name}</b> ({d.project.handle})
          {!showEmpty ? (
            <>
              {' '}· {fmtInt(d.stats.events)} events · {fmtInt(d.stats.decisions)} decisions · judge {fmtUsd(d.stats.judgeCostUsd, '$0')} · agents {fmtUsd(d.stats.agentCostUsd, '$0')}
            </>
          ) : null}
        </span>
        <span className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
          {demo ? (
            <span className="mem-badge" role="status">
              <i aria-hidden="true" />
              Example data
              <button type="button" className="mem-badge-x" onClick={() => { setDemo(false); setSelected(null); }} aria-label="Stop showing example data">×</button>
            </span>
          ) : null}
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => void load()}>Refresh</button>
        </span>
      </div>

      {showEmpty ? (
        <EmptyState reason={d.enabled ? '' : d.reason} demo={demo} onDemo={(on) => { setDemo(on); setSelected(null); }} />
      ) : (
        <>
          {!d.enabled && demo ? <p className="notice st-small" style={{ margin: 0 }}>{d.reason} The example below shows what the tab looks like once it is on.</p> : null}
          <div className="seg mem-tabs" role="tablist" aria-label="Memory views">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${tabId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${tabId}-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {t.label}
                {t.id === 'learnings' ? <span className="mem-tab-n">{d.learnings.length}</span> : t.id === 'runs' ? <span className="mem-tab-n">{d.runs.length}</span> : null}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabId}-panel-${tab}`} aria-labelledby={`${tabId}-tab-${tab}`} className="mem-panelwrap">
            {tab === 'mindmap' ? (
              <div className={`mem-split ${selectedNode ? 'has-panel' : ''}`}>
                <MemoryMindmap data={d} selectedId={selected} onSelect={setSelected} focusReq={focusReq} say={say} />
                {selectedNode ? (
                  <>
                    <button type="button" className="scrim mem-scrim" aria-label="Close details" onClick={() => setSelected(null)} />
                    <NodePanel data={d} node={selectedNode} now={now} onClose={() => setSelected(null)} onOpenTimeline={() => setTab('timeline')} onSelect={(id) => openNode(id)} />
                  </>
                ) : null}
              </div>
            ) : tab === 'timeline' ? (
              <Timeline data={d} onOpenNode={openNode} />
            ) : tab === 'learnings' ? (
              <Learnings data={d} now={now} />
            ) : tab === 'decisions' ? (
              <Decisions data={d} />
            ) : (
              <Runs data={d} />
            )}
          </div>
        </>
      )}
    </section>
  );
}
