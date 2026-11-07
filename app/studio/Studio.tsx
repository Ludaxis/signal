'use client';
// Signal Content Studio: Today, Post maker (behind its switch), Campaigns, Pipelines, Calendar, Posts (with the Gallery that replaced Library), Results,
// Comments, Brand, Memory and Connections for the selected project. The nav has four groups; Pipelines leaves it
// once Post maker has taken every pipeline. Everything shown here is real: posts on disk,
// approvals and plans. No sample data. Today: one Needs you list, Next up, Latest.
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Calendar } from './Calendar';
import { CurrentProjectLabel, ProjectSwitcher, useProjectId } from './Projects';
import { Brand } from './Brand';
import { Campaigns } from './Campaigns';
import { Pipelines } from './Pipelines';
import { Comments } from './Comments';
import { Connections } from './Connections';
import { Memory } from './Memory';
import { GenerateBar, thumbUrl, useRealPosts, type RealPackage, type Say } from './RealPosts';
import { Posts } from './Posts';
import { Results } from './Results';
import { LazyImage, LoadError, ScreenSkeleton } from './loaders';
import { connectedMessage } from './UploadPostPicker';
import { notifyChanged } from './sync';
import { formatDateIn, formatWhenIn } from '@/lib/studio/time';
import { t } from './copy/en';
import { Button, CountBadge, Drawer, Notice, Pill, useToast } from './ui';
import { filesChanged, isOverdue, needsYou, needsYouOrder, postedNewestFirst, postStatusWord } from './posts-rules';
import { navigateTo, useStudioView, useUrlReady, type View } from './url-state';
import { PostMaker } from './postmaker/PostMaker';
import { pmApi, type PostmakerHome } from './postmaker/api';
import { useKeys } from './postmaker/keys';
import { atProof, langName, navGroups, pipelinesInNav, runWord, runsNeedingYou } from './postmaker/model';
import { useOnChanged } from './sync';

const TITLES: Record<View, string> = {
  today: t('tab.today'),
  postmaker: t('tab.postmaker'),
  campaigns: t('tab.campaigns'),
  pipelines: t('tab.pipelines'),
  calendar: t('tab.calendar'),
  posts: t('tab.posts'),
  library: t('tab.library'),
  results: t('tab.results'),
  comments: t('tab.comments'),
  brand: t('tab.brand'),
  memory: t('tab.memory'),
  connections: t('tab.connections'),
};
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

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
  postmaker: (
    <>
      <path d="M4 20l9-9" />
      <path d="M14 4l1.2 2.8L18 8l-2.8 1.2L14 12l-1.2-2.8L10 8l2.8-1.2z" />
      <path d="M19 14l.6 1.4L21 16l-1.4.6L19 18l-.6-1.4L17 16l1.4-.6z" />
    </>
  ),
  campaigns: (
    <>
      <path d="M4 10v4l12 5V5L4 10z" />
      <path d="M8 15v4" />
      <path d="M19 9v6" />
    </>
  ),
  pipelines: (
    <>
      <rect x="2" y="9" width="5" height="6" rx="1.5" />
      <rect x="9.5" y="9" width="5" height="6" rx="1.5" />
      <rect x="17" y="9" width="5" height="6" rx="1.5" />
      <path d="M7 12h2.5M14.5 12H17" />
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

/** Rows in Today's Needs you list before "See all in Posts". */
export const NEEDS_YOU_ROWS = 5;
/** Rows in Next up. */
const NEXT_UP_ROWS = 3;

/** Runs that need the person, for Today and the Post maker nav badge; null while the switch is off. */
function usePostmakerNeeds(on: boolean, pid: string | null) {
  const [home, setHome] = useState<PostmakerHome | null>(null);
  const load = useCallback(async () => {
    if (!on || !pid) return;
    try {
      setHome(await pmApi.home(pid));
    } catch {
      /* Today still shows the posts; the Post maker tab shows its own error */
    }
  }, [on, pid]);
  useEffect(() => {
    // Off the effect's own turn (the load sets state when it answers).
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);
  // A move of pipelines (or a pipeline added or removed) changes the nav, so 'pipelines' reloads it too.
  useOnChanged(['content', 'pipelines'], load, on ? 30_000 : 0);
  return on && home ? { home, reload: load } : null;
}

export function Studio({ postmaker = false }: { postmaker?: boolean }) {
  // The open tab lives in the URL (?tab=), so reload, deep links and Back work.
  const [view, navigate] = useStudioView();
  const ready = useUrlReady();
  const toast = useToast();
  const mainRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const pid = useProjectId();
  const posts = useRealPosts();
  const [making, setMaking] = useState(false);

  const toastSay = toast.say;
  const say = useCallback<Say>((text, opts) => toastSay(text, opts), [toastSay]);
  // Back from Meta's login (callback adds ?ig=connected|error&msg=…): show the result on the Connections screen.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ig = q.get('ig');
    if (!ig) return;
    const timer = setTimeout(() => {
      navigate('connections', { replace: true });
      say((q.get('msg') ?? (ig === 'connected' ? 'Instagram connected.' : 'Connecting failed.')).slice(0, 300));
    }, 0);
    return () => clearTimeout(timer);
  }, [say, navigate]);
  // Back from Upload-Post's connect page (?connected=<profile>): open Connections, check the profile again and say what it found.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const profile = q.get('connected');
    if (!profile) return;
    let alive = true;
    const timer = setTimeout(() => {
      navigate('connections', { replace: true });
      void connectedMessage(profile).then((m) => {
        if (!alive) return;
        say(m);
        notifyChanged('connections', 'content');
      });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [say, navigate]);
  // Library became the Gallery view of Posts: old links land there.
  useEffect(() => {
    if (ready && view === 'library') navigate('posts', { replace: true, params: { view: 'gallery' } });
  }, [ready, view, navigate]);

  // Whatever changed the tab (a nav click, Back or Forward): refresh the posts it shows, move focus and scroll up.
  const shown = useRef<View | null>(null);
  const reloadPosts = posts.reload;
  useEffect(() => {
    if (!ready) return;
    const before = shown.current;
    shown.current = view;
    if (before === null || before === view) return;
    if (view === 'today' || view === 'results') void reloadPosts();
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [view, ready, reloadPosts]);
  const go = useCallback(
    (v: View, params?: Record<string, string>) => {
      if (v !== view || params) return navigate(v, params ? { params } : undefined);
      // The open tab again: refresh it in place (no new history entry).
      if (v === 'today' || v === 'results') void reloadPosts();
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [view, navigate, reloadPosts],
  );
  // The nav badge and Today's list count the same "Needs you" set.
  const badge = needsYou(posts.data?.packages ?? []).length;
  const openMake = useCallback(() => setMaking(true), []);
  const makePost = openMake;
  const pm = usePostmakerNeeds(postmaker, pid);
  const pmBadge = pm ? runsNeedingYou(pm.home.runs).length : 0;
  // Release 2: with Post maker on, Pipelines leaves the nav once no live pipeline is left (all
  // moved, keeps it for pipelines that use a template); then 10 items in 4 groups. Until Post maker answers, and
  // with its switch off, the tab stays (release 1).
  const showPipelines = !postmaker || !pm || pipelinesInNav(pm.home.migration);
  const groups = navGroups({ postmaker, pipelines: showPipelines });
  // ?tab=pipelines once the tab is gone lands on Post maker › Proven, replacing the entry so Back still works.
  useEffect(() => {
    if (ready && view === 'pipelines' && !showPipelines) navigate('postmaker', { replace: true, params: { view: 'proven' } });
  }, [ready, view, showPipelines, navigate]);
  const reloadPm = pm?.reload;
  useEffect(() => {
    if (!ready || view !== 'today' || !reloadPm) return;
    const id = setTimeout(() => void reloadPm(), 0);
    return () => clearTimeout(id);
  }, [ready, view, reloadPm]);
  // Global keys: ⌘1…⌘0 go to the nav items in order; ⌘N makes a post (Post maker › Reference when it is on).
  const order: View[] = groups.flatMap((g) => g.items);
  const navKeys: Record<string, () => void> = Object.fromEntries(order.slice(0, 10).map((v, i) => [`⌘${(i + 1) % 10}`, () => navigate(v)]));
  useKeys({ ...navKeys, '⌘N': () => (postmaker ? navigateTo('postmaker', { params: { s: 'reference' } }) : openMake()) }, ready);

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
            <i className="st-tube-fill" />
          </div>
          <div className="st-stack">
            <span className="brand-name">{t('shell.brand')}</span>
            <span className="xs st-muted">{t('shell.product')}</span>
          </div>
        </div>
        <ProjectSwitcher />
        <nav aria-label={t('shell.nav')} className="st-stack st-nav-list">
          {/*four groups; the labels are not focusable and add no words to the main view. */}
          {groups.map((g) => (
            <div key={g.group} role="group" aria-label={t(`shell.group.${g.group}`)} className="st-stack st-nav-group" data-group={g.group}>
              <span className="st-nav-label" aria-hidden="true">
                {t(`shell.group.${g.group}`)}
              </span>
              {g.items.map((v) =>
                v === 'postmaker' ? (
                  <Fragment key={v}>{nav('postmaker', <CountBadge count={pmBadge} label={t('pm.badge', { count: pmBadge })} />)}</Fragment>
                ) : v === 'posts' ? (
                  <Fragment key={v}>{nav('posts', <CountBadge count={badge} label={t('shell.postsBadge', { count: badge })} />)}</Fragment>
                ) : (
                  <Fragment key={v}>{nav(v)}</Fragment>
                ),
              )}
            </div>
          ))}
        </nav>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm st-signout" onClick={() => void logout()}>
          {t('shell.signOut')}
        </button>
      </aside>

      <main className="st-main" id="main" tabIndex={-1} ref={mainRef}>
        <header className="header">
          <div className="st-stack st-header-text">
            <span className="xs st-muted">
              <CurrentProjectLabel />
            </span>
            <h1 className="page-title">{TITLES[view === 'library' ? 'posts' : view]}</h1>
          </div>
          {/* One secondary action in the header; each screen's own primary sits in its content. On Post maker its own
              "Make a post" (home) or "Make it" (Reference) is the way in, so the header does not offer a second one. */}
          {view === 'postmaker' && postmaker ? null : (
            <div className="st-header-actions">
              <Button level="secondary" dense icon={PlusIcon} onClick={makePost}>
                {t('shell.makePost')}
              </Button>
            </div>
          )}
        </header>

        {/* Until the URL is read (hydration), no tab mounts: a deep link opens its own tab first. */}
        {!ready ? null : (
          <>
            {view === 'today' ? posts.error && !posts.data ? <Notice kind="error" title={t('today.couldNotLoad')} details={posts.error} onRetry={() => void posts.reload()} /> : <Today key={pid ?? 'none'} data={posts.data} go={go} onMake={makePost} pm={pm?.home ?? null} /> : null}
            {view === 'postmaker' ? (
              postmaker ? (
                <PostMaker key={pid ?? 'none'} say={say} openConnections={(service) => go('connections', service ? { service } : undefined)} />
              ) : (
                <section className="screen" aria-label={t('tab.postmaker')}>
                  <Notice
                    kind="off"
                    title={t('notice.serviceOff', { service: t('tab.postmaker') })}
                    action={
                      <Button level="secondary" dense onClick={() => go('connections')}>
                        {t('notice.openConnections')}
                      </Button>
                    }
                  />
                </section>
              )
            ) : null}
            {view === 'calendar' ? (
              <section className="screen" aria-label={t('calendar.region')}>
                <Calendar say={say} onOpenPosts={() => go('posts')} />
              </section>
            ) : null}
            {view === 'posts' ? (
              <section className="screen" aria-label={t('tab.posts')}>
                <Posts key={pid ?? 'none'} say={say} onMake={makePost} />
              </section>
            ) : null}
            {view === 'results' ? posts.error && !posts.data ? <LoadError title="Results could not be loaded." message={posts.error} onRetry={posts.reload} /> : <Results data={posts.data} reload={posts.reload} say={say} /> : null}
            {view === 'campaigns' ? <Campaigns key={pid ?? 'none'} say={say} openPosts={() => go('posts')} /> : null}
            {view === 'pipelines' ? <Pipelines key={pid ?? 'none'} say={say} /> : null}
            {view === 'comments' ? <Comments key={pid ?? 'none'} say={say} onManage={() => go('connections')} /> : null}
            {view === 'memory' ? <Memory key={pid ?? 'none'} say={say} /> : null}
            {view === 'connections' ? <Connections key={pid ?? 'none'} say={say} openBrand={() => go('brand')} /> : null}
            {view === 'brand' ? <Brand key={pid ?? 'none'} say={say} onMade={() => go('posts')} /> : null}
          </>
        )}
      </main>

      {making ? (
        <Drawer open title={t('make.title')} onClose={() => setMaking(false)}>
          <GenerateBar
            key={posts.data?.project?.id ?? 'p'}
            codex={posts.data?.codex}
            higgsfield={posts.data?.higgsfield}
            formats={posts.data?.formats ?? []}
            say={say}
            onMade={() => {
              setMaking(false);
              void posts.reload();
            }}
          />
        </Drawer>
      ) : null}

      {toast.node}
    </div>
  );
}

type Data = ReturnType<typeof useRealPosts>['data'];

/**
 * The one notice line on Today about the account's posting settings: only when they end within 3 days or at most 2
 * posts are left in the account limits, under 12 words, with a link to Connections. Null otherwise. Settings with no
 * end date (`expiresAt` not a finite time) never end.
 */
export function approvalNotice(exp: { open: boolean; expiresAt: number | null; posted: number; maxPosts: number } | undefined, now: number): string | null {
  if (!exp?.open) return null;
  if (typeof exp.expiresAt === 'number' && Number.isFinite(exp.expiresAt)) {
    const msLeft = exp.expiresAt - now;
    if (msLeft <= 3 * 86_400_000) return t('today.expires', { days: Math.max(0, Math.floor(msLeft / 86_400_000)) });
  }
  if (exp.maxPosts > 0 && exp.posted >= exp.maxPosts - 2) return t('today.capNear', { left: Math.max(0, exp.maxPosts - exp.posted) });
  return null;
}

/** The name of a Connections service for a Needs you row (its id when Connections has no name for it). */
function serviceName(id: string): string {
  return id === 'upload-post' ? t('connections.uploadPost') : id;
}

/** The state line of a Needs you row. */
function needLine(p: RealPackage, tz: string | null, now: number): string | null {
  if (filesChanged(p)) return t('posts.filesChanged');
  if (isOverdue(p, now) || (p.status === 'approved' && p.missedAt)) return t('posts.overdue');
  return p.plannedFor ? formatWhenIn(tz, p.plannedFor, now) : null;
}

function Thumb({ p }: { p: RealPackage }) {
  const src = thumbUrl(p);
  return src ? <LazyImage className="today-thumb" src={src} alt="" /> : <span className="today-thumb today-thumb-empty" aria-hidden="true" />;
}

type PmRun = PostmakerHome['runs'][number];

/** A Today row for a Post maker run that needs the person: "Proof ready", a pause line, or "Run failed". */
function pmLine(r: PmRun): string {
  if (r.status === 'failed') return t('pm.today.failed');
  if (atProof(r)) return t('pm.today.proofReady');
  return r.pausedFor && r.pausedFor !== 'check' ? t(`pm.pause.${r.pausedFor}`) : t('pm.today.proofReady');
}

export function Today({ data, go, onMake, pm = null }: { data: Data; go: (v: View, params?: Record<string, string>) => void; onMake: () => void; pm?: PostmakerHome | null }) {
  const [now] = useState(() => Date.now());
  const pid = useProjectId();
  if (!data) return <ScreenSkeleton variant="cards" count={3} label={t('today.loading')} />;
  const tz = data.project?.timeZone ?? null;
  const pk = data.packages.filter((p) => p.status !== 'discarded');
  const needs = needsYouOrder(needsYou(pk, now));
  const posted = postedNewestFirst(pk);
  const next = pk
    .filter((p) => !p.posted && (p.scheduled?.scheduled_for ?? p.plannedFor) && Date.parse((p.scheduled?.scheduled_for ?? p.plannedFor)!) > now)
    .sort((a, b) => ((a.scheduled?.scheduled_for ?? a.plannedFor)! < (b.scheduled?.scheduled_for ?? b.plannedFor)! ? -1 : 1))
    .slice(0, NEXT_UP_ROWS);
  const notice = approvalNotice(data.account, now);
  const openPost = (id: string) => go('posts', { post: id });
  // A connection that blocks a post within 24 h comes first: it is the most urgent row.
  const blocks = (data.connectionBlocks ?? []).slice(0, NEEDS_YOU_ROWS);
  const pmRuns = runsNeedingYou(pm?.runs ?? []);
  const pmName = (r: PmRun) => {
    const tpl = pm?.templates.find((x) => x.id === r.templateId || x.recipeId === r.recipeId);
    if (tpl) return tpl.name;
    const rc = pm?.recipes.find((x) => x.id === r.recipeId);
    return rc ? t('pm.home.draftName', { langs: rc.languages.map(langName).join(' + '), length: `${rc.lengthSec} s` }) : t('tab.postmaker');
  };
  const pmRows = Math.max(0, NEEDS_YOU_ROWS - blocks.length);
  const postRows = Math.max(0, NEEDS_YOU_ROWS - blocks.length - Math.min(pmRuns.length, pmRows));
  const total = blocks.length + pmRuns.length + needs.length;

  return (
    <section className="screen st-stack today-screen" aria-label={t('tab.today')}>
      {notice ? (
        <p className="today-notice st-small" role="note">
          <span>{notice}</span>
          <Button level="tertiary" dense onClick={() => go('connections')}>
            {t('notice.openConnections')}
          </Button>
        </p>
      ) : null}

      <section className="st-card st-stack today-card" aria-labelledby="today-needs">
        <h2 id="today-needs" className="today-h">
          {t('today.needsYou')}
          {total ? (
            <span className="pb-count" data-content>
              {total}
            </span>
          ) : null}
        </h2>
        {total === 0 ? (
          <div className="today-empty">
            <p className="st-small">{t('today.nothing')}</p>
            <Button level="primary" onClick={onMake}>
              {t('shell.makePost')}
            </Button>
          </div>
        ) : (
          <ul className="today-rows">
            {blocks.map((b) => (
              <li key={`block-${b.service}`}>
                <button type="button" className="today-row" data-block={b.service} onClick={() => go('connections', { service: b.service })} aria-label={t('today.block.open', { service: serviceName(b.service) })}>
                  <span className="today-thumb today-thumb-empty" aria-hidden="true" />
                  <span className="today-row-text">
                    <span className="today-row-title">{t('today.block.title', { service: serviceName(b.service) })}</span>
                    <span className="xs st-muted">{t('today.block.line', { count: b.count, id: b.postId, when: formatWhenIn(tz, b.plannedFor, now) })}</span>
                  </span>
                  <Pill status="Needs you" />
                </button>
              </li>
            ))}
            {pmRuns.slice(0, pmRows).map((r) => (
              <li key={r.id}>
                <button type="button" className="today-row" data-run={r.id} onClick={() => go('postmaker', { r: r.recipeId, s: atProof(r) ? 'proof' : 'pipeline' })} aria-label={t('pm.today.open', { name: pmName(r) })}>
                  {r.cover && pid ? <LazyImage className="today-thumb" src={pmApi.mediaUrl(pid, r.recipeId, r.cover)} alt="" /> : <span className="today-thumb today-thumb-empty" aria-hidden="true" />}
                  <span className="today-row-text">
                    <span className="today-row-title" data-content>
                      {pmName(r)}
                    </span>
                    <span className="xs st-muted">
                      {pmLine(r)} <span data-content>· {formatWhenIn(pm?.timeZone ?? tz, r.startedAt, now)}</span>
                    </span>
                  </span>
                  <Pill status={runWord(r.status)} />
                </button>
              </li>
            ))}
            {needs.slice(0, postRows).map((p) => {
              const line = needLine(p, tz, now);
              return (
                <li key={p.id}>
                  <button type="button" className="today-row" onClick={() => openPost(p.id)} aria-label={t('posts.open', { id: p.id })}>
                    <Thumb p={p} />
                    <span className="today-row-text">
                      <span className="today-row-title" data-content>
                        {p.title}
                      </span>
                      {line ? (
                        <span className="xs st-muted" data-content={line === t('posts.overdue') || line === t('posts.filesChanged') ? undefined : true}>
                          {line}
                        </span>
                      ) : null}
                    </span>
                    <Pill status={postStatusWord(p.status)} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {/* Each overflow has its own way out: runs past the limit go to Post maker › Runs, posts to Posts. */}
        {pmRuns.length > pmRows || needs.length > postRows ? (
          <div>
            {pmRuns.length > pmRows ? (
              <Button level="tertiary" dense onClick={() => go('postmaker', { view: 'runs' })}>
                {t('pm.today.seeAllRuns')}
              </Button>
            ) : null}
            {needs.length > postRows ? (
              <Button level="tertiary" dense onClick={() => go('posts')}>
                {t('today.seeAll')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="grid2">
        <section className="st-card st-stack today-card" aria-labelledby="today-next">
          <h2 id="today-next" className="today-h">
            {t('today.nextUp')}
          </h2>
          {next.length ? (
            <ul className="today-rows">
              {next.map((p) => (
                <li key={p.id}>
                  <button type="button" className="today-row" onClick={() => openPost(p.id)} aria-label={t('posts.open', { id: p.id })}>
                    <Thumb p={p} />
                    <span className="today-row-text">
                      <span className="today-row-title" data-content>
                        {p.title}
                      </span>
                      <span className="xs st-muted" data-content>
                        {formatWhenIn(tz, p.scheduled?.scheduled_for ?? p.plannedFor, now)}
                      </span>
                    </span>
                    <Pill status={postStatusWord(p.status)} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="st-small st-muted">{t('today.nothingNext')}</p>
          )}
          <div>
            <Button level="secondary" dense onClick={() => go('calendar')}>
              {t('today.openCalendar')}
            </Button>
          </div>
        </section>
        <section className="st-card st-stack today-card" aria-labelledby="today-latest">
          <h2 id="today-latest" className="today-h">
            {t('today.latest')}
          </h2>
          {posted.length ? (
            <div className="today-posts">
              {posted.slice(0, 4).map((p) => (
                <button key={p.id} type="button" className="today-post" onClick={() => openPost(p.id)} aria-label={t('posts.open', { id: p.id })}>
                  <Thumb p={p} />
                  <span className="xs st-muted" data-content>
                    {formatDateIn(tz, p.posted!.posted_at, now)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="st-small st-muted">{t('today.noLatest')}</p>
          )}
        </section>
      </div>
    </section>
  );
}
