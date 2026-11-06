'use client';
// Signal loading system. One vocabulary for "something is happening", picked by how long it takes:
//
//   < 150 ms            nothing (useDelayedFlag stops spinners from flashing)
//   150 ms – 1 s        the control itself: busy button (aria-busy) with a spinner and a moving sheen
//   1 – 10 s, content   skeletons shaped like the content that is coming (ScreenSkeleton, Skeleton)
//   > 10 s, a task      TaskProgress: named steps, elapsed time, an honest "usually about N s" bar
//   live agent work     the agent Activity panel (Campaigns)
//   long lists/images   Reveal (fade in as you scroll), LazyImage (placeholder until decoded),
//                       useProgressiveList (renders more as you near the end)
//
// Everything respects prefers-reduced-motion and announces itself to screen readers (role=status).
import { useEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes, type ReactNode, type RefObject } from 'react';

/** True only if `active` lasts longer than `delay`, and then stays true for at least `min` ms (no flicker). */
export function useDelayedFlag(active: boolean, delay = 150, min = 400): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (active) {
      t = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, delay);
    } else {
      const left = Math.max(0, min - (Date.now() - since.current));
      t = setTimeout(() => setShown(false), since.current ? left : 0);
    }
    return () => clearTimeout(t);
  }, [active, delay, min]);
  return shown;
}

/** Seconds since `active` became true (0 when inactive). */
export function useElapsed(active: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const t0 = setTimeout(() => setS(0), 0);
    const t = setInterval(() => setS(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [active]);
  return active ? s : 0;
}
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return <span className="ld-spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Skeleton({ w = '100%', h = 12, r = 8, style, className = '' }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties; className?: string }) {
  return <span className={`ld-sk ${className}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}
export function SkeletonText({ lines = 3, last = '60%' }: { lines?: number; last?: string }) {
  return (
    <span className="ld-sk-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={10} w={i === lines - 1 ? last : '100%'} />
      ))}
    </span>
  );
}

/** Content-shaped placeholder for a whole screen while its data loads. */
export function ScreenSkeleton({ variant, count = 3, label = 'Loading' }: { variant: 'cards' | 'stats' | 'grid' | 'list' | 'connections' | 'form'; count?: number; label?: string }) {
  const show = useDelayedFlag(true, 120, 0);
  return (
    <section className={`screen ld-screen ${show ? 'is-on' : ''}`} role="status" aria-busy="true" aria-label={label}>
      <span className="st-vh">{label}…</span>
      {variant === 'stats' ? (
        <>
          <div className="grid4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="st-card ld-card" style={{ ['--i' as string]: i } as CSSProperties}>
                <Skeleton w="40%" h={10} />
                <Skeleton w="60%" h={28} r={10} />
                <Skeleton w="70%" h={10} />
              </div>
            ))}
          </div>
          <div className="st-card ld-card">
            <Skeleton w="30%" h={10} />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} h={14} />
            ))}
          </div>
        </>
      ) : variant === 'grid' ? (
        <div className="lib-grid">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="st-card ld-card ld-tile" style={{ ['--i' as string]: i } as CSSProperties}>
              <Skeleton h={0} r={12} style={{ aspectRatio: '4 / 5', height: 'auto' }} />
              <Skeleton w="70%" h={12} />
              <Skeleton w="40%" h={10} />
            </div>
          ))}
        </div>
      ) : variant === 'connections' ? (
        <div className="cx">
          <div className="st-card ld-card cx-ready">
            <Skeleton w="55%" h={18} />
            <SkeletonText lines={3} />
          </div>
          <ul className="cx-list st-card">
            {Array.from({ length: count }, (_, i) => (
              <li key={i} className="cx-row ld-card" style={{ ['--i' as string]: i } as CSSProperties}>
                <Skeleton w={36} h={36} r={10} />
                <div className="cx-row-main">
                  <Skeleton w="35%" h={14} />
                  <Skeleton w="60%" h={10} />
                </div>
                <Skeleton w={84} h={34} r={999} />
              </li>
            ))}
          </ul>
        </div>
      ) : variant === 'list' ? (
        <div className="st-stack" style={{ gap: 10 }}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="st-card ld-card ld-row" style={{ ['--i' as string]: i } as CSSProperties}>
              <Skeleton w={64} h={64} r={10} />
              <span className="st-stack" style={{ gap: 8, flex: 1 }}>
                <Skeleton w="50%" h={14} />
                <Skeleton w="80%" h={10} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="st-stack" style={{ gap: 14 }}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="st-card ld-card" style={{ ['--i' as string]: i } as CSSProperties}>
              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <Skeleton w="35%" h={16} />
                <Skeleton w={90} h={28} r={999} />
              </div>
              <SkeletonText lines={variant === 'form' ? 2 : 3} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Thin bar. Without `value` it is indeterminate. */
export function ProgressBar({ value, label }: { value?: number; label?: string }) {
  const det = typeof value === 'number';
  return (
    <span className={`ld-bar ${det ? '' : 'is-indet'}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={det ? Math.round(value) : undefined}>
      <span className="ld-bar-fill" style={det ? { width: `${Math.max(2, Math.min(100, value))}%` } : undefined} />
    </span>
  );
}

/**
 * A long task (10 s to minutes) the user started: named steps that advance with time, elapsed time,
 * and a bar that eases toward 90% of the usual duration (never claims to be done before it is).
 */
export function TaskProgress({ active, title, steps, expectedSeconds }: { active: boolean; title: string; steps: string[]; expectedSeconds: number }) {
  const elapsed = useElapsed(active);
  const show = useDelayedFlag(active, 200, 500);
  if (!show) return null;
  const frac = 1 - Math.exp(-elapsed / Math.max(4, expectedSeconds / 2));
  const pct = Math.min(92, frac * 100);
  const step = Math.min(steps.length - 1, Math.floor((elapsed / Math.max(1, expectedSeconds)) * steps.length));
  const over = elapsed > expectedSeconds * 1.5;
  return (
    <div className="ld-task" role="status" aria-live="polite">
      <div className="ld-task-head">
        <Spinner size={14} />
        <b>{title}</b>
        <span className="st-muted">· {clock(elapsed)}</span>
      </div>
      <ProgressBar value={active ? pct : 100} label={title} />
      <ol className="ld-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <span className="xs st-muted">{over ? 'Taking longer than usual. It is still working; you can leave this screen open.' : `Usually about ${expectedSeconds < 60 ? `${expectedSeconds} s` : `${Math.round(expectedSeconds / 60)} min`}.`}</span>
    </div>
  );
}

/** Fades and lifts its children in when they scroll into view (once). Stagger with `index`. */
export function Reveal({ children, index = 0, className = '' }: { children: ReactNode; index?: number; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      const t = setTimeout(() => setInView(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px 40px 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`ld-reveal ${inView ? 'is-in' : ''} ${className}`} style={{ ['--i' as string]: index % 8 } as CSSProperties}>
      {children}
    </div>
  );
}

/** Image that loads lazily, shows a shimmer placeholder until decoded, then fades in. */
export function LazyImage({ className = '', alt = '', ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className={`ld-img ${loaded ? 'is-loaded' : ''} ${failed ? 'is-failed' : ''} ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...rest} alt={alt} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
    </span>
  );
}

/** Renders a long list in steps: the next batch appears as the sentinel nears the viewport. */
export function useProgressiveList<T>(items: T[], initial = 12, step = 12) {
  const [count, setCount] = useState(initial);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const hasMore = count < items.length;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) setCount((c) => c + step);
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, step, count]);
  return { visible: items.slice(0, count), hasMore, sentinel, more: () => setCount((c) => c + step) };
}

export function LoadMoreSentinel({ hasMore, sentinel, more }: { hasMore: boolean; sentinel: RefObject<HTMLDivElement | null>; more: () => void }) {
  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="ld-more">
      <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={more}>
        Show more
      </button>
    </div>
  );
}

/**
 * A screen whose data did not load: says so, shows the server's message and offers a retry,
 * instead of a skeleton that never ends.
 */
export function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="screen">
      <div className="st-card st-stack" role="alert" style={{ padding: 18, gap: 10 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span className="st-small real-error">{message}</span>
        <div>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            aria-busy={busy}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } finally {
                setBusy(false);
              }
            }}
          >
            Try again
          </button>
        </div>
      </div>
    </section>
  );
}
