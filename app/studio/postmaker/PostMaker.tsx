'use client';
// Post maker: the tab behind the `postmaker`
// feature switch. URL state per (`?tab=postmaker&r=<recipe>&s=reference|recipe|pipeline|proof&step=<node>`,
// `&view=drafts|proven|runs[&run=<run>]`), the stepper (Reference · Recipe · Pipeline · Proof · Proven) with the Run bar
// under it, and the six screens. The server keeps working when you leave; coming back reads the live state.
// Long actions answer with a run id at once; this polls the run every second while it goes, then every 5 s while it
// waits on a pause. Make it follows its own run to Proof with no other click.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Lang, PmNote, RecipeOnlyView, RecipeView, Run } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { getProjectId, useProjectId } from '../Projects';
import { Button, Drawer, Notice } from '../ui';
import { navigateTo, useSearch } from '../url-state';
import { pmApi, PmError, type MakeItAnswer, type PostmakerHome } from './api';
import { Home } from './Home';
import { setSingleKeys, useKeys, useSingleKeys } from './keys';
import { atProof, pmLocation, pmParams, SCREENS, type PmLocation, type Screen } from './model';
import { Pipeline } from './Pipeline';
import { Proof } from './Proof';
import { Proven } from './Proven';
import { Recipe } from './Recipe';
import { Reference } from './Reference';
import { RunBar, runBarShown } from './RunBar';
import type { StepTab } from './StepDrawer';

export interface PostMakerProps {
  /** The Studio toast; `onUndo` adds its Undo button (the move of pipelines). */
  say: (text: string, opts?: { onUndo?: () => void }) => void;
  openConnections: (service: string | null) => void;
}

type Loaded = { kind: 'view'; view: RecipeView } | { kind: 'only'; only: RecipeOnlyView } | null;

const live = (r: Pick<Run, 'status' | 'pausedFor'> | null) => !!r && (r.status === 'running' || r.status === 'queued' || (r.status === 'needs-you' && r.pausedFor !== 'check'));

export function PostMaker({ say, openConnections }: PostMakerProps) {
  const search = useSearch();
  const loc = pmLocation(search);
  const pid = useProjectId();
  const go = useCallback((l: Partial<PmLocation>, o: { replace?: boolean } = {}) => navigateTo('postmaker', { params: pmParams(l), replace: o.replace }), []);

  // ---- data ----
  const [home, setHome] = useState<PostmakerHome | null>(null);
  const [homeError, setHomeError] = useState('');
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang | null>(null);
  const [stepTab, setStepTab] = useState<StepTab>('output');
  const [regenRequest, setRegenRequest] = useState<{ nodeId: string; note: string } | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const r = loc.r;

  const loadHome = useCallback(async () => {
    const p = getProjectId();
    if (!p) return;
    try {
      setHome(await pmApi.home(p));
      setHomeError('');
    } catch (e) {
      setHomeError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const loadRecipe = useCallback(async () => {
    const p = getProjectId();
    if (!p || !r) return;
    try {
      const view = await pmApi.recipe(p, r);
      setLoaded({ kind: 'view', view });
      setError('');
    } catch (e) {
      if (e instanceof PmError && e.status === 404) {
        try {
          setLoaded({ kind: 'only', only: await pmApi.recipeOnly(p, r) });
          setError('');
          return;
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2));
          return;
        }
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [r]);

  useEffect(() => {
    if (!pid) return;
    // Off the effect's own turn (the loads set state when they answer).
    const id = setTimeout(() => void (r ? loadRecipe() : loadHome()), 0);
    return () => clearTimeout(id);
  }, [pid, r, loadRecipe, loadHome]);

  const view = loaded?.kind === 'view' && loaded.view.recipe.id === r ? loaded.view : null;
  const only = loaded?.kind === 'only' && loaded.only.recipe.id === r ? loaded.only : null;
  const viewRun = view?.run ?? null;
  const shownRun = run && view && run.recipeId === view.recipe.id && (!viewRun || run.id === viewRun.id || Date.parse(run.startedAt) >= Date.parse(viewRun.startedAt)) ? run : viewRun;
  const pollId = follow ?? (live(viewRun) ? viewRun!.id : null) ?? (live(run) ? run!.id : null);

  // ---- polling (1 s while running, 5 s while paused) ----
  const tick = useRef(0);
  useEffect(() => {
    const p = pid;
    if (!p || !pollId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = async () => {
      try {
        const v = await pmApi.run(p, pollId);
        if (!alive) return;
        setRun(v.run);
        tick.current += 1;
        await loadRecipe();
        if (!alive) return;
        if (follow === v.run.id && v.run.status !== 'running' && v.run.status !== 'queued') {
          setFollow(null);
          if (atProof(v.run) && r === v.run.recipeId) go({ r: v.run.recipeId, s: 'proof' });
        }
        const again = v.run.status === 'running' || v.run.status === 'queued' ? 1000 : live(v.run) ? 5000 : 0;
        if (again) timer = setTimeout(() => void step(), again);
      } catch {
        if (alive) timer = setTimeout(() => void step(), 5000);
      }
    };
    void step();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pid, pollId, follow, r, loadRecipe, go]);

  // ---- deep link with an open step drawer: Back closes it ----
  const landed = useRef(false);
  const pushedStep = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (loc.r && loc.step) {
      go({ ...loc, step: null }, { replace: true });
      go(loc);
      pushedStep.current = true;
    }
  }, [loc, go]);

  const openStep = useCallback(
    (nodeId: string, tab: StepTab = 'output') => {
      setStepTab(tab);
      pushedStep.current = true;
      go({ r, s: 'pipeline', step: nodeId });
    },
    [go, r],
  );
  const closeStep = useCallback(() => {
    if (pushedStep.current) {
      pushedStep.current = false;
      window.history.back();
    } else go({ r, s: 'pipeline' }, { replace: true });
  }, [go, r]);

  const started = (runId: string) => {
    setFollow(null);
    setRun(null);
    void pmApi
      .run(pid ?? '', runId)
      .then((v) => setRun(v.run))
      .catch(() => undefined);
    void loadRecipe();
  };
  // Make a post and Run proof (template.make-post) answer like Make it: follow the run to Proof.
  const onTemplateMade = (a: MakeItAnswer) => {
    say(t('pm.make.started'));
    onMade(a, false);
  };
  const onMade = (a: MakeItAnswer, stop: boolean) => {
    if (stop || !a.runId) return go({ r: a.recipeId, s: 'recipe' });
    setRun(null);
    setFollow(a.runId);
    go({ r: a.recipeId, s: 'pipeline' });
  };
  const runAction = async (body: Parameters<typeof pmApi.action>[1], message?: string) => {
    if (!pid) return;
    try {
      const x = await pmApi.action<{ run?: Run; runId?: string }>(pid, body);
      if (x.run) setRun(x.run);
      if (message) say(message);
      void loadRecipe();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- stepper ----
  const hasPipeline = !!view;
  const hasProof = !!view && (view.proof.length > 0 || !!view.nodes.find((n) => n.id === 'check')?.current);
  const screen: Screen | null = r ? (loc.s ?? (view ? 'pipeline' : 'recipe')) : loc.s === 'reference' ? 'reference' : null;
  const reach = (s: Screen | 'proven'): string | null => {
    if (s === 'proven') return view?.template ? null : t('pm.stepper.provenLater');
    if (s === 'reference') return null;
    if (!r) return t('pm.stepper.needsRecipe');
    if (s === 'recipe') return null;
    if (s === 'pipeline') return hasPipeline ? null : t('pm.stepper.needsPipeline');
    return hasProof ? null : t('pm.stepper.needsRun');
  };
  const stepTo = (d: 1 | -1) => {
    if (!screen) return;
    const i = SCREENS.indexOf(screen);
    const next = SCREENS[i + d];
    if (next && !reach(next)) go({ r, s: next });
  };
  const singleKeys = useSingleKeys();
  useKeys({ '⌘[': () => stepTo(-1), '⌘]': () => stepTo(1), '?': () => setKeysOpen(true) });

  if (!pid) return <Notice kind="loading" title={t('pm.loading')} />;

  const stepper = screen ? (
    <nav className="pm-stepper" aria-label={t('pm.stepper')}>
      <ol>
        {([...SCREENS, 'proven'] as const).map((s) => {
          const why = reach(s);
          const current = s === screen;
          const done = !current && !why && s !== 'proven' && SCREENS.indexOf(s as Screen) < SCREENS.indexOf(screen);
          return (
            <li key={s} className={`pm-stepper-item ${done ? 'is-done' : ''}`}>
              <button type="button" className="pm-stepper-btn" aria-current={current ? 'step' : undefined} disabled={!!why && !current} title={why ?? undefined} data-done={done || undefined} onClick={() => (s === 'proven' ? view?.template && go({ t: view.template.id }) : go({ r, s: s as Screen }))}>
                {t(`pm.screen.${s}`)}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  ) : null;

  const titleOf = (nodeId: string) => view?.nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  const bar =
    shownRun && runBarShown(shownRun) ? (
      <RunBar
        run={shownRun}
        titleOf={titleOf}
        onStop={() => void runAction({ action: 'run.stop', runId: shownRun.id }, t('pm.runbar.stopped'))}
        onContinue={() => void runAction({ action: 'run.continue', runId: shownRun.id })}
        onRaise={(capUsd) => void runAction({ action: 'run.raise-cap', runId: shownRun.id, capUsd })}
      />
    ) : null;

  let body: ReactNode = null;
  if (!r && loc.t) {
    body = homeError && !home ? <Notice kind="error" title={t('pm.proven.couldNotLoad')} details={homeError} onRetry={() => void loadHome()} /> : home ? <Proven key={loc.t} pid={pid} data={home} templateId={loc.t} go={go} say={say} reload={() => void loadHome()} onMade={onTemplateMade} /> : <Notice kind="loading" title={t('pm.proven.loading')} />;
  } else if (!r && screen !== 'reference') {
    body = homeError && !home ? <Notice kind="error" title={t('pm.couldNotLoad')} details={homeError} onRetry={() => void loadHome()} /> : home ? <Home pid={pid} data={home} view={loc.view} runId={loc.run} go={go} say={say} reload={() => void loadHome()} onMade={onTemplateMade} /> : <Notice kind="loading" title={t('pm.loading')} />;
  } else if (!r) {
    body = <Reference key="new" pid={pid} recipe={null} reference={null} onMade={onMade} say={say} />;
  } else if (error && !view && !only) {
    body = <Notice kind="error" title={t('pm.couldNotLoad')} details={error} onRetry={() => void loadRecipe()} />;
  } else if (!view && !only) {
    body = <Notice kind="loading" title={t('pm.loading')} />;
  } else {
    const recipe = view?.recipe ?? only!.recipe;
    const reference = view?.reference ?? only?.reference ?? null;
    const running = live(shownRun) && shownRun?.status !== 'needs-you';
    if (screen === 'reference') body = <Reference key={recipe.id} pid={pid} recipe={recipe} reference={reference} estimate={view ? { usdHigh: view.estimate.usdHigh, live: view.estimate.nodes.some((n) => n.mode === 'live') } : null} onMade={onMade} say={say} />;
    else if (screen === 'recipe' || !view) body = <Recipe key={recipe.id} pid={pid} recipe={recipe} pipeline={view?.pipeline ?? null} onUsed={() => (void loadRecipe(), go({ r, s: 'pipeline' }))} onChanged={() => void loadRecipe()} say={say} />;
    else if (screen === 'pipeline')
      body = (
        <Pipeline
          key={view.recipe.id}
          pid={pid}
          view={view}
          running={running}
          stepId={loc.step}
          stepTab={stepTab}
          onStepTab={setStepTab}
          openStep={openStep}
          closeStep={closeStep}
          onStarted={started}
          goProof={() => go({ r, s: 'proof' })}
          openConnections={openConnections}
          reload={() => void loadRecipe()}
          say={say}
          regenRequest={regenRequest}
          clearRegenRequest={() => setRegenRequest(null)}
        />
      );
    else
      body = (
        <Proof
          key={view.recipe.id}
          pid={pid}
          view={shownRun && view.run && shownRun.id === view.run.id ? { ...view, run: shownRun } : view}
          lang={lang}
          onLang={setLang}
          openStep={(nodeId) => openStep(nodeId, 'review')}
          fixStep={(n: PmNote) => {
            if (!n.nodeId) return;
            setRegenRequest({ nodeId: n.nodeId, note: n.text });
            go({ r, s: 'pipeline' });
          }}
          onAccepted={(m) => {
            say(m);
            void loadRecipe();
          }}
          reload={() => void loadRecipe()}
          say={say}
        />
      );
  }

  return (
    <section className="screen pm" aria-label={t('pm.region')}>
      {stepper}
      {bar}
      {body}
      {keysOpen ? (
        <Drawer open title={t('pm.keys.title')} onClose={() => setKeysOpen(false)}>
          <label className="pm-check">
            <input type="checkbox" checked={singleKeys} onChange={(e) => setSingleKeys(e.target.checked)} />
            <span>{t('pm.keys.toggle')}</span>
          </label>
          <dl className="pm-dl pm-keys">
            {KEY_LIST.map(([where, keys]) => (
              <div key={where} className="pm-dl-row">
                <dt>{where}</dt>
                <dd data-content>{keys}</dd>
              </div>
            ))}
          </dl>
          <Button level="secondary" onClick={() => setKeysOpen(false)}>
            {t('drawer.close')}
          </Button>
        </Drawer>
      ) : null}
    </section>
  );
}

/** The list "?" shows (keys are content, the places are screen names). */
const KEY_LIST: [string, string][] = [
  [t('pm.keys.global'), '⌘1…⌘0 · ⌘N · ?'],
  [t('pm.keys.stepper'), '⌘[ · ⌘]'],
  [t('pm.screen.reference'), '⌘O · ⌘V · ⌘Enter'],
  [t('pm.screen.recipe'), '↑ ↓ · Enter · Esc · R · ⌘Enter'],
  [t('pm.screen.pipeline'), '↑ ↓ · Enter · E · R · ⇧R · L · V · ⌥↑ ⌥↓ · ⌘Enter · Esc'],
  [t('pm.screen.proof'), 'Space · ← → (⇧) · , . · [ ] · N · S · 1 2 · ⌘Enter'],
  [t('pm.home.runs'), '↑ ↓ · Enter · ⌘Enter'],
];
