'use client';
// Post maker home: a segmented control Drafts · Proven · Runs and the one primary "Make a post". Drafts are
// recipes not yet accepted, with how far they got, when they changed and a status pill; Proven lists the template
// cards; Runs is the table. Text budget 40 words.
import { formatWhenIn } from '@/lib/studio/time';
import type { PostmakerHome } from './api';
import { t } from '../copy/en';
import { Button, Notice, Pill } from '../ui';
import { atProof, duration, furthest, langName, templateWord, type HomeView, type PmLocation } from './model';
import { Runs } from './Runs';

export interface HomeProps {
  pid: string;
  data: PostmakerHome;
  view: HomeView;
  runId: string | null;
  go: (l: Partial<PmLocation>, o?: { replace?: boolean }) => void;
  say: (text: string) => void;
  reload: () => void;
}

export function Home({ pid, data, view, runId, go, say, reload }: HomeProps) {
  const accepted = new Set(data.templates.map((x) => x.recipeId));
  const drafts = data.recipes.filter((r) => !accepted.has(r.id));
  const make = (
    // On the Runs view "Run again" is the screen's one primary, so Make a post steps down.
    <Button level={view === 'runs' ? 'secondary' : 'primary'} onClick={() => go({ s: 'reference' })}>
      {t('pm.home.make')}
    </Button>
  );
  return (
    <div className="pm-home">
      <div className="pm-home-head">
        <div className="pm-seg" role="tablist" aria-label={t('pm.home.views')}>
          {(['drafts', 'proven', 'runs'] as const).map((v) => (
            <button key={v} type="button" role="tab" className="pm-seg-item" aria-selected={view === v} onClick={() => go({ view: v })}>
              {t(`pm.home.${v}`)}
            </button>
          ))}
        </div>
        {make}
      </div>
      {view === 'drafts' ? (
        drafts.length === 0 ? (
          <Notice kind="empty" title={t('pm.home.noDrafts')} />
        ) : (
          <ul className="pm-rows">
            {drafts.map((r) => {
              const s = furthest(r, data.runs);
              const run = data.runs.find((x) => x.recipeId === r.id) ?? null;
              const word = run ? (atProof(run) ? 'Needs you' : run.status === 'failed' ? 'Failed' : run.status === 'running' || run.status === 'queued' ? 'Running' : 'Draft') : 'Draft';
              return (
                <li key={r.id}>
                  <button type="button" className="pm-row" onClick={() => go({ r: r.id, s })}>
                    <span className="pm-row-text">
                      <span className="pm-row-title" data-content>
                        {t('pm.home.draftName', { langs: r.languages.map(langName).join(' + '), length: duration(r.lengthSec) })}
                      </span>
                      <span className="xs pm-muted" data-content>
                        {t('pm.home.at', { screen: t(`pm.screen.${s}`) })} · {formatWhenIn(data.timeZone, r.updatedAt)}
                      </span>
                    </span>
                    <Pill status={word} />
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {view === 'proven' ? (
        data.templates.length === 0 ? (
          <Notice kind="empty" title={t('pm.home.noTemplates')} />
        ) : (
          <ul className="pm-rows">
            {data.templates.map((x) => (
              <li key={x.id}>
                <button type="button" className="pm-row" onClick={() => go({ r: x.recipeId, s: 'proof' })}>
                  <span className="pm-row-text">
                    <span className="pm-row-title" data-content>
                      {x.name}
                    </span>
                  </span>
                  <Pill status={templateWord(x.status)} />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {view === 'runs' ? <Runs pid={pid} data={data} runId={runId} go={go} say={say} reload={reload} /> : null}
    </div>
  );
}
