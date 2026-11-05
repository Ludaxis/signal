'use client';
// Signal Content Studio: Today, Campaigns, Calendar, Posts, Library, Results, Comments, Brand, Memory and Connections for the selected project.
// Everything shown here is real: packages on disk, approvals, posts and plans. No sample data.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Calendar, useCalendarRange } from './Calendar';
import { CurrentProjectLabel, ProjectSwitcher, useProjectId } from './Projects';
import { Brand } from './Brand';
import { Campaigns } from './Campaigns';
import { Comments } from './Comments';
import { Connections } from './Connections';
import { Memory } from './Memory';
import { useRealPosts, type RealPackage } from './RealPosts';
import { Posts } from './Posts';
import { Results } from './Results';
import { AutopilotSummary } from './Autopilot';
import { LazyImage, LoadMoreSentinel, Reveal, ScreenSkeleton, useProgressiveList } from './loaders';
import { addDays, formatDateTime, todayInZone } from '@/lib/time';

type View = 'today' | 'campaigns' | 'calendar' | 'posts' | 'library' | 'results' | 'comments' | 'brand' | 'memory' | 'connections';
const TITLES: Record<View, string> = { today: 'Today', campaigns: 'Campaigns', calendar: 'Calendar', posts: 'Posts', library: 'Library', results: 'Results', comments: 'Comments', brand: 'Brand', memory: 'Memory', connections: 'Connections' };

function Icon({ d, size = 18 }: { d: ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  );
}
const ICONS: Record<View, ReactNode> = {
  today: (
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  campaigns: (
    <>
      <path d="M4 10v4l12 5V5L4 10z" />
      <path d="M8 15v4" />
      <path d="M19 9v6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  posts: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="10" rx="1.5" />
      <rect x="17" y="4" width="4" height="7" rx="1.5" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  results: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  comments: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  memory: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="M6.6 7.2 10 10.6M17.4 7.2 14 10.6M12 14.5V18" />
    </>
  ),
  connections: (
    <>
      <path d="M9 7H7a5 5 0 0 0 0 10h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <path d="M8 12h8" />
    </>
  ),
  brand: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8.5" cy="10" r="1.3" />
      <circle cx="12" cy="7.5" r="1.3" />
      <circle cx="15.5" cy="10" r="1.3" />
      <path d="M12 21a3 3 0 0 1 0-6h2" />
    </>
  ),
};

const WAITING: RealPackage['status'][] = ['ready', 'approved', 'sending', 'submitted', 'uncertain'];
/** Planned column of the Posts board: made and waiting for the owner's OK (the nav badge). */
const PLANNED: RealPackage['status'][] = ['ready', 'changed', 'invalid'];

export function Studio() {
  const [view, setView] = useState<View>('today');
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const pid = useProjectId();
  const posts = useRealPosts();

  const say = useCallback((t: string) => {
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 3800);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // Back from Meta's login (callback adds ?ig=connected|error&msg=…): show the result on the Connections screen.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ig = q.get('ig');
    if (!ig) return;
    const t = setTimeout(() => {
      setView('connections');
      say((q.get('msg') ?? (ig === 'connected' ? 'Instagram connected.' : 'Connecting failed.')).slice(0, 300));
      window.history.replaceState(null, '', window.location.pathname);
    }, 0);
    return () => clearTimeout(t);
  }, [say]);

  const go = (v: View) => {
    setView(v);
    if (v === 'today' || v === 'library' || v === 'results') void posts.reload();
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const planned = (posts.data?.packages ?? []).filter((p) => PLANNED.includes(p.status)).length;

  const logout = async () => {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
    router.replace('/login');
  };

  const nav = (v: View, extra?: ReactNode) => (
    <button type="button" className="nav" aria-current={view === v ? 'page' : undefined} onClick={() => go(v)}>
      <Icon d={ICONS[v]} />
      <span className="nav-text">{TITLES[v]}</span>
      {extra}
    </button>
  );

  return (
    <div className="studio">
      <aside className="st-aside">
        <div className="st-brand">
          <div className="st-tube" aria-hidden="true">
            <i style={{ height: '62%', background: '#02bf7d' }} />
          </div>
          <div className="st-stack">
            <span className="brand-name">Signal</span>
            <span className="xs st-muted">Content Studio</span>
          </div>
        </div>
        <ProjectSwitcher />
        <nav aria-label="Studio" className="st-stack" style={{ gap: 4 }}>
          {nav('today')}
          {nav('campaigns')}
          {nav('calendar')}
          {nav(
            'posts',
            planned ? (
              <span className="pill" style={{ background: '#ffb020' }} aria-label={`${planned} planned, waiting for you`}>
                {planned}
              </span>
            ) : null,
          )}
          {nav('library')}
          {nav('results')}
          {nav('comments')}
          {nav('brand')}
          {nav('memory')}
          {nav('connections')}
        </nav>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" style={{ marginTop: 'auto' }} onClick={() => void logout()}>
          Sign out
        </button>
      </aside>

      <main className="st-main" id="main" tabIndex={-1} ref={mainRef}>
        <header className="header">
          <div className="st-stack" style={{ gap: 4 }}>
            <span className="xs st-muted">
              <CurrentProjectLabel />
            </span>
            <h1 className="page-title">{TITLES[view]}</h1>
          </div>
          <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
            {view !== 'posts' ? (
              <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => go('posts')}>
                Make a post
              </button>
            ) : null}
            {view !== 'calendar' ? (
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => go('calendar')}>
                Open calendar
              </button>
            ) : null}
          </div>
        </header>

        {view === 'today' ? <Today key={pid ?? 'none'} data={posts.data} go={go} say={say} /> : null}
        {view === 'calendar' ? (
          <section className="screen" aria-label="Calendar">
            <Calendar say={say} onOpenPosts={() => go('posts')} />
          </section>
        ) : null}
        {view === 'posts' ? (
          <section className="screen st-stack" style={{ gap: 16 }} aria-label="Posts">
            <Posts key={pid ?? 'none'} say={say} />
          </section>
        ) : null}
        {view === 'library' ? <Library data={posts.data} /> : null}
        {view === 'results' ? <Results data={posts.data} reload={posts.reload} say={say} /> : null}
        {view === 'campaigns' ? <Campaigns key={pid ?? 'none'} say={say} openPosts={() => go('posts')} /> : null}
        {view === 'comments' ? <Comments key={pid ?? 'none'} say={say} onManage={() => go('connections')} /> : null}
        {view === 'memory' ? <Memory key={pid ?? 'none'} say={say} /> : null}
        {view === 'connections' ? <Connections key={pid ?? 'none'} say={say} openBrand={() => go('brand')} /> : null}
        {view === 'brand' ? <Brand key={pid ?? 'none'} say={say} onMade={() => go('posts')} /> : null}
      </main>

      {toast ? (
        <div className="st-toast" role="status">
          <span className="dot" style={{ background: '#02bf7d' }} />
          {toast}
        </div>
      ) : null}
    </div>
  );
}

type Data = ReturnType<typeof useRealPosts>['data'];
const thumbOf = (p: RealPackage, project: string) => {
  const f = p.files.find((x) => x.role === 'cover') ?? p.files.find((x) => x.role === 'slide');
  return f ? `/api/studio/content/${p.id}/file/${encodeURIComponent(f.name)}?project=${encodeURIComponent(project)}` : null;
};

function Today({ data, go, say }: { data: Data; go: (v: View) => void; say: (t: string) => void }) {
  const today = todayInZone();
  const [yy, mm] = today.split('-').map(Number) as [number, number];
  const monthStart = `${today.slice(0, 8)}01`;
  const monthEnd = addDays(mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`, -1);
  const month = useCalendarRange(monthStart, monthEnd);
  const [now] = useState(() => Date.now());
  if (!data) return <ScreenSkeleton variant="cards" count={3} label="Loading today" />;
  const pk = data.packages.filter((p) => p.status !== 'discarded');
  const waiting = pk.filter((p) => WAITING.includes(p.status) || (p.status === 'posted' && !p.labelConfirmed));
  const posted = pk.filter((p) => p.posted).sort((a, b) => (a.posted!.posted_at < b.posted!.posted_at ? 1 : -1));
  const exp = data.account;
  const noEnd = exp.open && !Number.isFinite(exp.expiresAt);
  const daysLeft = exp.open && !noEnd ? Math.max(0, Math.ceil((exp.expiresAt - now) / 86_400_000)) : 0;
  const next = pk
    .filter((p) => p.plannedFor && !p.posted && Date.parse(p.plannedFor) > now - 3_600_000)
    .sort((a, b) => (a.plannedFor! < b.plannedFor! ? -1 : 1))[0];
  const due = pk.filter((p) => p.plannedFor && !p.posted && Date.parse(p.plannedFor) <= now && !['failed'].includes(p.status));
  const thisMonth = (month.data?.items ?? []).filter((i) => i.kind === 'posted' && i.when && i.when.slice(0, 7) === today.slice(0, 7)).length;
  const projectId = data.project?.id ?? '';

  return (
    <section className="screen st-stack" style={{ gap: 20 }} aria-label="Today">
      {due.length ? (
        <button type="button" className="tap-card real-summary due" onClick={() => go('posts')}>
          <span className="pill real-pill">Due now</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            {due.length === 1 ? `Post ${due[0]!.id} is planned for ${formatDateTime(due[0]!.plannedFor)}` : `${due.length} planned posts are due`}
          </span>
          <span className="st-small st-muted">Open Posts to approve and post →</span>
        </button>
      ) : null}
      <div className="grid4">
        <button type="button" className="tap-card stat" onClick={() => go('posts')}>
          <span className="label">Waiting for you</span>
          <span className="stat-num" style={{ color: waiting.length ? '#a05e00' : undefined }}>
            {waiting.length}
          </span>
          <span className="st-small st-muted">Open Posts →</span>
        </button>
        <div className="st-card stat">
          <span className="label">Posted</span>
          <span className="stat-num">
            {exp.posted}
            <span className="stat-of">/{exp.maxPosts || '—'}</span>
          </span>
          <span className="st-small st-muted">{exp.open ? `${Math.max(0, exp.maxPosts - exp.posted)} left within the limit` : 'Limits not set'}</span>
        </div>
        <div className="st-card stat">
          <span className="label">Posting period</span>
          <span className="stat-num" style={{ color: exp.open ? (!noEnd && daysLeft <= 3 ? '#a05e00' : '#017a50') : '#b4261c' }}>
            {exp.open ? (noEnd ? 'On' : `${daysLeft}d`) : 'Off'}
          </span>
          <span className="st-small st-muted">{exp.open ? `${noEnd ? 'no end date' : `until ${new Date(exp.expiresAt).toLocaleDateString()}`} · ${exp.maxPerDay}/day` : 'Set limits in Manage projects'}</span>
        </div>
        <div className="st-card stat">
          <span className="label">Uploads this month</span>
          <span className="stat-num">{month.data ? thisMonth : '…'}</span>
          <span className="st-small st-muted">All accounts · Upload-Post Free allows 10</span>
        </div>
      </div>

      <AutopilotSummary say={say} openCampaigns={() => go('campaigns')} />

      <div className="grid2">
        <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
          <span className="label">Next planned</span>
          {next ? (
            <div className="row-wrap" style={{ gap: 12, alignItems: 'center' }}>
              {thumbOf(next, projectId) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="real-thumb" src={thumbOf(next, projectId)!} alt="" />
              ) : null}
              <div className="st-stack" style={{ gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{next.title}</span>
                <span className="st-small st-muted">{formatDateTime(next.plannedFor)} · {next.status === 'approved' ? 'approved' : 'needs approval'}</span>
              </div>
            </div>
          ) : (
            <span className="st-small st-muted">Nothing planned. Drag a post onto a day in the Calendar.</span>
          )}
          <div>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => go('calendar')}>
              Plan the week
            </button>
          </div>
        </div>
        <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
          <span className="label">Latest posts</span>
          {posted.length ? (
            <div className="today-posts">
              {posted.slice(0, 4).map((p) => (
                <a key={p.id} className="today-post" href={p.posted!.url ?? '#'} target="_blank" rel="noreferrer" title={p.title}>
                  {thumbOf(p, projectId) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbOf(p, projectId)!} alt={p.title} />
                  ) : null}
                  <span className="xs st-muted">{new Date(p.posted!.posted_at).toLocaleDateString()}</span>
                </a>
              ))}
            </div>
          ) : (
            <span className="st-small st-muted">No posts yet on {data.account.destination}.</span>
          )}
        </div>
      </div>
    </section>
  );
}

function Library({ data }: { data: Data }) {
  const [filter, setFilter] = useState<'posted' | 'all'>('posted');
  const items = useMemo(
    () =>
      (data?.packages ?? [])
        .filter((p) => p.status !== 'discarded')
        .filter((p) => filter === 'all' || p.status === 'posted')
        .sort((a, b) => (b.id < a.id ? -1 : 1)),
    [data, filter],
  );
  const list = useProgressiveList(items, 12, 12);
  if (!data) return <ScreenSkeleton variant="grid" count={8} label="Loading the library" />;
  const projectId = data.project?.id ?? '';
  return (
    <section className="screen st-stack" style={{ gap: 16 }} aria-label="Library">
      <div className="st-chip-row" role="group" aria-label="Filter">
        {(['posted', 'all'] as const).map((f) => (
          <button key={f} type="button" className="st-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'posted' ? 'Posted' : 'All packages'}
          </button>
        ))}
      </div>
      {items.length === 0 ? <span className="st-small st-muted">Nothing here yet.</span> : null}
      <div className="lib-grid">
        {list.visible.map((p, i) => (
          <Reveal key={p.id} index={i}>
          <div className="st-card lib-card">
            {thumbOf(p, projectId) ? (
              <LazyImage className="lib-thumb" src={thumbOf(p, projectId)!} alt="" />
            ) : (
              <div className="lib-empty" />
            )}
            <div className="st-stack" style={{ gap: 4, padding: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {p.id} · {p.title}
              </span>
              <span className="xs st-muted">
                {p.posted ? `Posted ${formatDateTime(p.posted.posted_at)}` : p.plannedFor ? `Planned ${formatDateTime(p.plannedFor)}` : p.status}
              </span>
              {p.metrics?.metrics ? (
                <span className="xs lib-nums">
                  <b>{p.metrics.metrics.views ?? '—'}</b> views · <b>{p.metrics.metrics.likes ?? '—'}</b> likes · <b>{p.metrics.metrics.saves ?? '—'}</b> saves
                </span>
              ) : null}
              {p.posted?.url ? (
                <a className="real-link st-small" href={p.posted.url} target="_blank" rel="noreferrer">
                  View on Instagram
                </a>
              ) : null}
            </div>
          </div>
          </Reveal>
        ))}
      </div>
      <LoadMoreSentinel hasMore={list.hasMore} sentinel={list.sentinel} more={list.more} />
    </section>
  );
}
