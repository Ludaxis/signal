'use client';
// The decision map as an SVG tree: left-to-right, status colours, confidence rings, evidence-scaled
// pills, collapse/expand, pan and zoom (drag, wheel, pinch, buttons), keyboard navigation, a
// campaign filter and a replay slider that grows the map day by day. Layout is pure (memory-layout.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Select } from './Select';
import { formatDateLabel, todayInZone, zonedParts } from '@/lib/time';
import { ancestorsOf, dayRange, endOfDay, filterCampaign, layoutTree, visibleAt, type LayoutNode } from './memory-layout';
import { STATUS_LABEL, TYPE_LABEL } from './memory-format';
import type { BranchStatus, GraphNode, MemoryPayload } from '@/lib/studio/memory/types';

export interface FocusRequest { id: string; n: number }

const LABEL_FONT = '600 13px "Instrument Sans", ui-sans-serif, system-ui, sans-serif';
const CHIP_FONT = '600 10px "Instrument Sans", ui-sans-serif, system-ui, sans-serif';
const SMALL_FONT = '500 11px "Instrument Sans", ui-sans-serif, system-ui, sans-serif';
const PAD = 11;
const SLOT = 20;
const GAP = 6;
const MAX_LABEL = 34;
const MIN_K = 0.25;
const MAX_K = 2.5;

type Measure = (text: string, font: string) => number;
function makeMeasurer(fontsReady: boolean): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${fontsReady ? 'f' : 'd'}|${font}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let w: number;
    if (ctx) {
      ctx.font = font;
      w = ctx.measureText(text).width;
    } else w = text.length * (font.includes('13px') ? 7.2 : 6);
    cache.set(key, w);
    return w;
  };
}

const short = (label: string) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1).trimEnd()}…` : label);
/** Variants and outcomes carry no ring, weight or glyph, so their pills skip the leading slot. */
const hasSlot = (n: GraphNode, conf: number | null) => conf !== null || n.weight !== null || !['variant', 'outcome'].includes(n.type);
const baseHeight = (t: GraphNode['type']) => (t === 'goal' ? 46 : t === 'strategy' ? 42 : 38);
const pivotApproved = (n: GraphNode) => n.type === 'pivot' && n.status === null && Boolean((n.meta as { approvedAt?: unknown }).approvedAt);
function statusClass(n: GraphNode): string {
  if (n.status) return `mem-s-${n.status}`;
  if (n.type === 'pivot') return pivotApproved(n) ? 'mem-s-pivot-approved' : 'mem-s-proposed';
  return `mem-s-none mem-t-${n.type}`;
}
function statusText(n: GraphNode, present: Set<string>): string | null {
  if (n.status) return STATUS_LABEL[n.status];
  if (n.type === 'pivot') return pivotApproved(n) ? 'Approved' : 'Proposed';
  if (n.type === 'strategy') {
    const by = (n.meta as { supersededBy?: unknown }).supersededBy;
    return typeof by === 'string' && present.has(by) ? 'Superseded' : 'Approved';
  }
  return null;
}

const prefersReducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function MemoryMindmap({ data, selectedId, onSelect, focusReq, say }: { data: MemoryPayload; selectedId: string | null; onSelect: (id: string | null) => void; focusReq: FocusRequest | null; say: (t: string) => void }) {
  const graph = data.graph;
  const learnings = useMemo(() => new Map(data.learnings.map((l) => [l.id, l])), [data.learnings]);
  const [fontsReady, setFontsReady] = useState(false);
  // A fresh measurer (and cache) once web fonts are in, so pills fit the real glyph widths.
  const measure = useMemo(() => makeMeasurer(fontsReady), [fontsReady]);
  useEffect(() => {
    let alive = true;
    const f = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!f) return;
    f.ready.then(() => alive && setFontsReady(true)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // ---- replay range: first event (or node) day → today, or the last known day if later ----
  const days = useMemo(() => {
    const dates = [...data.events.map((e) => zonedParts(e.at).date), ...graph.nodes.map((n) => zonedParts(n.created).date), ...graph.nodes.map((n) => zonedParts(n.updated).date)].filter(Boolean).sort();
    const first = dates[0] ?? todayInZone();
    const last = dates[dates.length - 1] ?? first;
    const today = todayInZone();
    return dayRange(first, last > today ? last : today);
  }, [data.events, graph.nodes]);
  const [dayIdx, setDayIdx] = useState<number | null>(null); // null = latest
  const idx = dayIdx === null ? days.length - 1 : Math.min(dayIdx, days.length - 1);
  const day = days[idx] ?? todayInZone();
  const atLatest = idx >= days.length - 1;
  // playFrom is the day the replay started on; null = not playing. The interval keeps its own counter,
  // so state updaters stay pure.
  const [playFrom, setPlayFrom] = useState<number | null>(null);
  const playing = playFrom !== null;
  useEffect(() => {
    if (playFrom === null) return;
    const step = prefersReducedMotion() ? 900 : 520;
    let cur = playFrom;
    const t = setInterval(() => {
      cur += 1;
      if (cur >= days.length - 1) {
        setPlayFrom(null);
        setDayIdx(null);
      } else setDayIdx(cur);
    }, step);
    return () => clearInterval(t);
  }, [playFrom, days.length]);
  const stopPlaying = () => setPlayFrom(null);
  const play = () => {
    if (playing) {
      setPlayFrom(null);
      return;
    }
    const from = atLatest ? 0 : idx;
    setDayIdx(from);
    setPlayFrom(from);
  };

  // ---- filters and collapse ----
  const [campaign, setCampaign] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // ---- layout ----
  const iso = endOfDay(day);
  const shownNodes = useMemo(() => filterCampaign(visibleAt(graph, iso), campaign), [graph, iso, campaign]);
  const present = useMemo(() => new Set(visibleAt(graph, iso).map((n) => n.id)), [graph, iso]);
  // Evidence as of the replay day (events the payload knows; unknown ids count only at the latest day).
  const eventAt = useMemo(() => new Map(data.events.map((e) => [e.id, e.at])), [data.events]);
  const evidenceCount = useCallback((n: GraphNode) => (atLatest ? n.evidence.length : n.evidence.filter((id) => (eventAt.get(id) ?? '~') <= iso).length), [atLatest, eventAt, iso]);
  const size = useCallback(
    (n: GraphNode) => {
      const label = short(n.label);
      const chip = statusText(n, present);
      const ev = evidenceCount(n);
      const learning = n.learning ? learnings.get(n.learning) : undefined;
      const slot = hasSlot(n, learning ? learning.confidence : null) ? SLOT + GAP : 0;
      const labelW = measure(label, n.type === 'goal' ? LABEL_FONT.replace('13px', '14px') : LABEL_FONT);
      const chipW = chip ? measure(chip.toUpperCase(), CHIP_FONT) + 12 : 0;
      const evW = ev > 0 ? measure(String(ev), SMALL_FONT) + 16 : 0;
      const w = PAD + slot + labelW + (chipW ? GAP + chipW : 0) + (evW ? GAP + evW : 0) + PAD;
      const h = baseHeight(n.type) + Math.min(ev, 12) * 0.75;
      return { w: Math.ceil(w), h: Math.round(h) };
    },
    [measure, learnings, present, evidenceCount],
  );
  const layout = useMemo(() => layoutTree(shownNodes, { direction: 'lr', nodeGap: 10, levelGap: 40, size, collapsed }), [shownNodes, size, collapsed]);

  // ---- viewport: pan and zoom ----
  const wrap = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const [smooth, setSmooth] = useState(false);
  const animateTo = useCallback((v: { x: number; y: number; k: number }) => {
    setSmooth(true);
    setView(v);
  }, []);
  const fitView = useCallback(() => {
    const pad = 28;
    const k = Math.max(MIN_K, Math.min(1.15, (box.w - pad * 2) / Math.max(1, layout.width), (box.h - pad * 2) / Math.max(1, layout.height)));
    animateTo({ k, x: Math.round((box.w - layout.width * k) / 2), y: Math.round((box.h - layout.height * k) / 2) });
  }, [box, layout.width, layout.height, animateTo]);
  // First view: everything when it stays readable (zoom ≥ 0.75), otherwise fit the height, anchored on the root; "Fit" shows everything.
  const firstView = useCallback(() => {
    const pad = 28;
    const kh = (box.h - pad * 2) / Math.max(1, layout.height);
    const kw = (box.w - pad * 2) / Math.max(1, layout.width);
    const k = Math.min(1.1, Math.max(Math.min(kh, kw), Math.min(kh, 0.75)));
    const x = layout.width * k + pad * 2 <= box.w ? Math.round((box.w - layout.width * k) / 2) : pad;
    animateTo({ k, x, y: Math.round((box.h - layout.height * k) / 2) });
  }, [box, layout.width, layout.height, animateTo]);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || layout.nodes.length === 0 || box.w <= 0) return;
    fitted.current = true;
    const t = setTimeout(firstView, 0);
    return () => clearTimeout(t);
  }, [layout.nodes.length, firstView, box.w]);
  // When the layout changes (replay, collapse, filter) keep the root where it was on screen, so the map
  // grows and shrinks around it instead of drifting.
  const rootAnchor = useRef<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const root = layout.nodes.find((n) => !n.parent);
    const prev = rootAnchor.current;
    rootAnchor.current = root ? { id: root.id, x: root.x, y: root.y + root.h / 2 } : null;
    if (!root || !prev || !fitted.current) return;
    const dx = root.x - prev.x;
    const dy = root.y + root.h / 2 - prev.y;
    if (!dx && !dy) return;
    const t = setTimeout(() => {
      setSmooth(true);
      setView((v) => ({ ...v, x: v.x - dx * v.k, y: v.y - dy * v.k }));
    }, 0);
    return () => clearTimeout(t);
  }, [layout]);
  // Keep the selected node in view when the canvas or the layout changes (e.g. the side panel opens).
  useEffect(() => {
    if (!selectedId) return;
    const n = layout.byId.get(selectedId);
    if (!n) return;
    const t = setTimeout(() => {
      setSmooth(true);
      setView((v) => {
        const pad = 24;
        const l = n.x * v.k + v.x;
        const r = (n.x + n.w) * v.k + v.x;
        const tp = n.y * v.k + v.y;
        const bt = (n.y + n.h) * v.k + v.y;
        let dx = 0;
        let dy = 0;
        if (r > box.w - pad) dx = box.w - pad - r;
        if (l + dx < pad) dx = pad - l;
        if (bt > box.h - pad) dy = box.h - pad - bt;
        if (tp + dy < pad) dy = pad - tp;
        if (!dx && !dy) return v;
        return { ...v, x: v.x + dx, y: v.y + dy };
      });
    }, 0);
    return () => clearTimeout(t);
  }, [selectedId, box, layout.byId]);
  const zoomBy = (f: number, cx = box.w / 2, cy = box.h / 2) =>
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f));
      return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
    });

  // Wheel zoom needs a non-passive listener (to stop the page from scrolling).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setSmooth(false);
      const f = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0022);
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f));
        return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pointer drag (pan) and two-finger pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; pinch: number | null; k: number } | null>(null);
  const lastMoved = useRef(false); // the click that follows a drag must not select
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastMoved.current = false;
    setSmooth(false);
    // Capture only once a drag or pinch really starts, so plain clicks still reach the nodes.
    if (pointers.current.size === 1) drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, pinch: null, k: view.k };
    else if (pointers.current.size === 2 && drag.current) {
      const [a, b] = [...pointers.current.values()];
      drag.current.pinch = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      drag.current.k = view.k;
      for (const id of pointers.current.keys()) e.currentTarget.setPointerCapture(id);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId) || !drag.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (pointers.current.size >= 2 && d.pinch) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      const r = e.currentTarget.getBoundingClientRect();
      const cx = ((a?.x ?? 0) + (b?.x ?? 0)) / 2 - r.left;
      const cy = ((a?.y ?? 0) + (b?.y ?? 0)) / 2 - r.top;
      const k = Math.max(MIN_K, Math.min(MAX_K, d.k * (dist / d.pinch)));
      d.moved = true;
      setView((v) => ({ k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) }));
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      const moved = drag.current?.moved ?? false;
      lastMoved.current = moved;
      drag.current = null;
      // A plain click on the background clears the selection; a drag does not.
      if (!moved && e.target === e.currentTarget) onSelect(null);
      return;
    }
    const [a] = [...pointers.current.values()];
    if (a && drag.current) drag.current = { x: a.x, y: a.y, vx: view.x, vy: view.y, moved: true, pinch: null, k: view.k };
  };
  const clickBlocked = () => lastMoved.current || (drag.current?.moved ?? false);

  // ---- focus and selection ----
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const centerOn = useCallback(
    (id: string) => {
      const n = layout.byId.get(id);
      if (!n) return;
      setView((v) => {
        const k = Math.max(v.k, 0.8);
        return { k, x: Math.round(box.w / 2 - (n.x + n.w / 2) * k), y: Math.round(box.h / 2 - (n.y + n.h / 2) * k) };
      });
      setSmooth(true);
    },
    [layout.byId, box],
  );
  const lastFocus = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusReq || focusReq.n === lastFocus.current) return;
    lastFocus.current = focusReq.n;
    const node = graph.nodes.find((n) => n.id === focusReq.id);
    if (!node) {
      say('That branch is not in the map any more.');
      return;
    }
    // Make sure the node can be seen: latest day, its campaign, ancestors expanded.
    const t = setTimeout(() => {
      setPlayFrom(null);
      setDayIdx(null);
      if (campaign && node.campaign && node.campaign !== campaign) setCampaign(null);
      const anc = ancestorsOf(graph.nodes, node.id);
      setCollapsed((c) => {
        if (!anc.some((a) => c.has(a))) return c;
        const n = new Set(c);
        anc.forEach((a) => n.delete(a));
        return n;
      });
      onSelect(node.id);
      pendingFocus.current = node.id;
    }, 0);
    return () => clearTimeout(t);
  }, [focusReq, graph.nodes, campaign, onSelect, say]);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !layout.byId.has(id)) return;
    pendingFocus.current = null;
    const t = setTimeout(() => {
      centerOn(id);
      nodeEls.current.get(id)?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [layout, centerOn]);

  const focusNode = (id: string | undefined) => {
    if (!id) return;
    nodeEls.current.get(id)?.focus({ preventScroll: true });
  };
  const onNodeKey = (e: KeyboardEvent<SVGGElement>, n: LayoutNode<GraphNode>) => {
    const parent = n.parent ? layout.byId.get(n.parent) : undefined;
    const siblings = parent ? parent.children : layout.nodes.filter((x) => !x.parent).map((x) => x.id);
    const i = siblings.indexOf(n.id);
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(selectedId === n.id ? null : n.id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (collapsed.has(n.id)) toggle(n.id);
        else focusNode(n.children[0]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusNode(n.parent ?? undefined);
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusNode(siblings[i + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusNode(siblings[i - 1]);
        break;
      case '-':
      case '_':
        if (n.children.length) {
          e.preventDefault();
          if (!collapsed.has(n.id)) toggle(n.id);
        }
        break;
      case '+':
      case '=':
        if (n.hiddenChildren) {
          e.preventDefault();
          toggle(n.id);
        }
        break;
      case 'Escape':
        onSelect(null);
        break;
      default:
    }
  };

  const campaignName = (id: string | null) => data.campaigns.find((c) => c.id === id)?.name ?? null;
  const empty = layout.nodes.length === 0;
  const countAtDay = layout.nodes.length;
  const viewportStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` };

  return (
    <div className="mem-map st-stack">
      <div className="mem-toolbar">
        <div className="mem-tool-left">
          <div className="mem-campaign">
            <Select<string>
              label="Campaign"
              value={campaign ?? '*'}
              onChange={(v) => setCampaign(v === '*' ? null : v)}
              options={[{ value: '*', label: 'All campaigns', text: 'all campaigns' }, ...data.campaigns.map((c) => ({ value: c.id, label: c.name, text: c.name, hint: `${c.goal} · ${c.status}` }))]}
            />
          </div>
          <span className="xs st-muted mem-count" aria-live="polite">
            {countAtDay} of {graph.nodes.length} nodes{campaign ? ` · ${campaignName(campaign)}` : ''}
          </span>
        </div>
        <div className="mem-zoom" role="group" aria-label="Zoom">
          <button type="button" className="st-btn st-btn-ghost st-btn-sm mem-zbtn" aria-label="Zoom out" onClick={() => { setSmooth(true); zoomBy(1 / 1.25); }}>−</button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm mem-zbtn" aria-label="Zoom in" onClick={() => { setSmooth(true); zoomBy(1.25); }}>+</button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={fitView}>Fit</button>
        </div>
      </div>

      <div className={`mem-canvas ${smooth ? 'is-smooth' : ''}`} ref={wrap}>
        <svg
          ref={svg}
          className="mem-svg"
          width={box.w}
          height={box.h}
          role="application"
          aria-label={`Decision map for ${data.project.name}. ${countAtDay} nodes. Drag to pan, scroll to zoom, Tab to move between nodes.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <g className="mem-viewport" style={viewportStyle}>
            <g className="mem-edges">
              {layout.edges.map((e) => {
                const child = layout.byId.get(e.to)?.node;
                return <path key={e.id} className={`mem-edge ${child ? statusClass(child) : ''}`} d={e.path} pathLength={1} />;
              })}
            </g>
            <g className="mem-nodes">
              {layout.nodes.map((ln) => {
                const n = ln.node;
                const label = short(n.label);
                const chip = statusText(n, present);
                const learning = n.learning ? learnings.get(n.learning) : undefined;
                const conf = learning ? learning.confidence : null;
                const ev = evidenceCount(n);
                const r = 8;
                const circ = 2 * Math.PI * r;
                const slot = hasSlot(n, conf);
                const cx = Math.round(PAD + SLOT / 2);
                const labelX = PAD + (slot ? SLOT + GAP : 0);
                const labelW = measure(label, n.type === 'goal' ? LABEL_FONT.replace('13px', '14px') : LABEL_FONT);
                const chipX = labelX + labelW + GAP;
                const chipW = chip ? measure(chip.toUpperCase(), CHIP_FONT) + 12 : 0;
                const evX = chipX + (chipW ? chipW + GAP : 0);
                const hasKids = ln.children.length > 0 || ln.hiddenChildren > 0;
                const isCollapsed = collapsed.has(n.id);
                const weight = n.weight;
                const selected = selectedId === n.id;
                const desc = `${TYPE_LABEL[n.type]}: ${n.label}${chip ? `, ${chip.toLowerCase()}` : ''}${ev ? `, ${ev} evidence` : ''}${conf !== null ? `, confidence ${Math.round(conf * 100)}%` : ''}${hasKids ? isCollapsed ? `, ${ln.hiddenChildren} hidden` : `, ${ln.children.length} children` : ''}`;
                return (
                  <g
                    key={n.id}
                    ref={(el) => {
                      if (el) nodeEls.current.set(n.id, el);
                      else nodeEls.current.delete(n.id);
                    }}
                    className={`mem-node ${statusClass(n)} mem-type-${n.type} ${selected ? 'is-selected' : ''}`}
                    style={{ transform: `translate(${ln.x}px, ${ln.y}px)` }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={selected}
                    aria-label={desc}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (clickBlocked()) return;
                      onSelect(selected ? null : n.id);
                    }}
                    onKeyDown={(e) => onNodeKey(e, ln)}
                  >
                    <g className="mem-node-in">
                      <rect className="mem-pill" width={ln.w} height={ln.h} rx={ln.h / 2} ry={ln.h / 2} />
                      {/* slot: confidence ring, pillar weight or a type glyph */}
                      {!slot ? null : conf !== null ? (
                        <g className="mem-ring" transform={`translate(${cx} ${ln.h / 2})`}>
                          <circle className="mem-ring-bg" r={r} />
                          <circle className="mem-ring-fg" r={r} strokeDasharray={`${Math.max(0.6, conf * circ)} ${circ}`} transform="rotate(-90)" />
                        </g>
                      ) : weight !== null ? (
                        <text className="mem-weight" x={cx} y={ln.h / 2} textAnchor="middle" dominantBaseline="central">
                          {weight}%
                        </text>
                      ) : (
                        <g className="mem-glyph" transform={`translate(${cx} ${ln.h / 2})`}>
                          {n.type === 'goal' ? (
                            <>
                              <circle r={7.5} />
                              <circle r={3.5} />
                            </>
                          ) : n.type === 'strategy' ? (
                            <path d="M-5 -7v14M-5 -7h9l-2 3.5 2 3.5h-9" />
                          ) : n.type === 'pivot' ? (
                            <path d="M-6 3h8l-3 -3M2 3l-3 3M-6 -4h4" />
                          ) : n.type === 'outcome' ? (
                            <path d="M-6 2h12M-6 -2h12" />
                          ) : n.type === 'learning' ? (
                            <path d="M-6 -6h5a3 3 0 0 1 3 3v9a2 2 0 0 0 -2 -2h-6zM6 -6h-5a3 3 0 0 0 -3 3v9a2 2 0 0 1 2 -2h6z" />
                          ) : (
                            <circle r={3.5} />
                          )}
                        </g>
                      )}
                      <text className="mem-label" x={labelX} y={ln.h / 2} dominantBaseline="central">
                        {label}
                      </text>
                      {n.status === 'pruned' ? <line className="mem-strike" x1={labelX} x2={labelX + labelW} y1={ln.h / 2} y2={ln.h / 2} /> : null}
                      {chip ? (
                        <g className="mem-chip" transform={`translate(${chipX} ${ln.h / 2 - 8})`}>
                          <rect width={chipW} height={16} rx={8} />
                          <text x={chipW / 2} y={8} textAnchor="middle" dominantBaseline="central">
                            {chip.toUpperCase()}
                          </text>
                        </g>
                      ) : null}
                      {ev > 0 ? (
                        <g className="mem-ev" transform={`translate(${evX} ${ln.h / 2})`}>
                          <circle cx={4} r={2.5} />
                          <text x={11} dominantBaseline="central">
                            {ev}
                          </text>
                        </g>
                      ) : null}
                    </g>
                    {hasKids ? (
                      <g
                        className="mem-toggle"
                        transform={`translate(${ln.w} ${ln.h / 2})`}
                        role="button"
                        tabIndex={-1}
                        aria-label={isCollapsed ? `Expand ${ln.hiddenChildren} hidden` : 'Collapse branch'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (clickBlocked()) return;
                          toggle(n.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            toggle(n.id);
                          }
                        }}
                      >
                        <circle r={9} />
                        {isCollapsed ? (
                          <text textAnchor="middle" dominantBaseline="central">
                            {ln.hiddenChildren}
                          </text>
                        ) : (
                          <path d="M-3.5 0h7" />
                        )}
                      </g>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        {view.x + layout.width * view.k > box.w - 4 ? <div className="mem-fade mem-fade-r" aria-hidden="true" /> : null}
        {view.x < 4 ? <div className="mem-fade mem-fade-l" aria-hidden="true" /> : null}
        {empty ? (
          <div className="mem-canvas-empty st-small st-muted" role="status">
            Nothing on the map on {formatDateLabel(day)}{campaign ? ' for this campaign' : ''}.
          </div>
        ) : null}
        <div className="mem-legend" aria-label="Legend">
          {(['winning', 'promising', 'exploring', 'weak', 'pruned', 'proposed'] as BranchStatus[]).map((s) => (
            <span key={s} className={`mem-key mem-s-${s}`}>
              <i aria-hidden="true" />
              {STATUS_LABEL[s]}
            </span>
          ))}
          <span className="mem-key mem-key-note">ring = confidence · size = evidence</span>
        </div>
      </div>

      <div className="mem-replay" role="group" aria-label="Replay">
        <button type="button" className={`st-btn st-btn-sm ${playing ? 'st-btn-dark' : 'st-btn-ghost'} mem-play`} onClick={play} aria-pressed={playing} aria-label={playing ? 'Pause replay' : 'Play replay'}>
          {playing ? (
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="M2.5 1.5l8 4.5-8 4.5z" fill="currentColor" />
            </svg>
          )}
          {playing ? 'Pause' : 'Replay'}
        </button>
        <label className="mem-slider">
          <span className="st-vh">Show the map as it was on</span>
          <input type="range" min={0} max={Math.max(0, days.length - 1)} step={1} value={idx} onChange={(e) => { stopPlaying(); setDayIdx(Number(e.target.value)); }} aria-valuetext={formatDateLabel(day)} />
        </label>
        <span className="mem-day xs">
          <b>{formatDateLabel(day)}</b>
          {atLatest ? <span className="st-muted"> · latest</span> : <span className="st-muted"> · day {idx + 1} of {days.length}</span>}
        </span>
        {!atLatest ? (
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => { stopPlaying(); setDayIdx(null); }}>
            Latest
          </button>
        ) : null}
      </div>
      <p className="xs st-muted mem-hint">Tab moves between nodes · Enter opens one · arrows walk the tree · − / + collapse or expand a branch.</p>
    </div>
  );
}
