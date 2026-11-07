'use client';
// Proof: the 9:16 player with a beat strip
// (LTR) and the safe-zone overlay read from the one shared module; the verdict block (Premium / Standard / Regenerate /
// Unscored, the 3 hard gates, the deterministic checks, a "12 criteria" disclosure with evidence and, on an Unscored
// live proof, manual scoring with an evidence note per score); the Persian sign-off rows (read-only, bound to the
// current version hashes, "Open step"); notes pinned to a time; the version chips. One primary: "Accept", or "Accept
// as draft" when any step is mock or the proof is Unscored. Text budget 45 words.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CriterionId, Lang, PmNote, RecipeView } from '@/lib/studio/postmaker/types';
import { SAFE_ZONES } from '@/lib/studio/postmaker/render/safeZones';
import { TEMPLATE_NAME_MAX, suggestedTemplateName, templateNameOk } from '@/lib/studio/postmaker/template-name';
import { t } from '../copy/en';
import { Button, Chip, ChipRow, Dialog, Drawer, FaText, Pill } from '../ui';
import { More } from '../More';
import { pmApi } from './api';
import { useKeys } from './keys';
import { acceptState, beatAt, clock, gateRows, hasMock, langName, notesOf, ownerOf, proofFor, textOf } from './model';
import { Notes } from './Notes';

export interface ProofProps {
  pid: string;
  view: RecipeView;
  lang: Lang | null;
  onLang: (l: Lang) => void;
  openStep: (nodeId: string) => void;
  fixStep: (note: PmNote) => void;
  onAccepted: (message: string) => void;
  reload: () => void;
  say: (text: string) => void;
}

const FPS = 30;
const VERDICT_WORD = { premium: 'check.verdict.premium', standard: 'check.verdict.standard', regenerate: 'check.verdict.regenerate', unscored: 'check.verdict.unscored' } as const;

export function Proof({ pid, view, lang: langIn, onLang, openStep, fixStep, onAccepted, reload, say }: ProofProps) {
  const langs = view.recipe.languages;
  const lang: Lang | null = langIn && langs.includes(langIn) ? langIn : (langs[0] ?? null);
  const proof = proofFor(view.proof, lang);
  const render = view.nodes.find((n) => n.id === (lang ? `render:${lang}` : 'render'))?.current ?? null;
  const video = render?.outputs.find((o) => o.kind === 'video') ?? null;
  const player = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zones, setZones] = useState(false);
  const [adding, setAdding] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [scoring, setScoring] = useState(false);
  // Ruling D-3: a named template, prefilled from the reference or the recipe's title line; required, 60 at most.
  const [name, setName] = useState(() => suggestedTemplateName(view.recipe, view.reference));
  const nameOk = templateNameOk(name);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const state = acceptState(view);
  const mock = hasMock(view);
  const rows = gateRows(view);
  const notes = notesOf(view.notes, view.run?.id ?? null);
  const beats = view.recipe.beats;
  const proposed = ownerOf(beatAt(beats, time), lang, view.nodes);
  const len = Math.max(1, view.recipe.lengthSec);

  // Caption and hashtags of this language (post-copy's caption port).
  const postCopy = view.nodes.find((n) => n.id === (lang ? `post-copy:${lang}` : 'post-copy'))?.current ?? null;
  const capRef = postCopy?.outputs.find((o) => o.port === 'caption' && o.kind === 'json') ?? null;
  useEffect(() => {
    if (!capRef) return;
    let alive = true;
    void pmApi
      .json(pid, view.recipe.id, capRef.sha256)
      .then((d) => alive && setCaption(textOf(d)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, view.recipe.id, capRef]);

  const seek = (sec: number) => {
    const v = player.current;
    const s = Math.max(0, Math.min(len, sec));
    if (v) v.currentTime = s;
    setTime(s);
  };
  const toggle = () => {
    const v = player.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const beatJump = (d: 1 | -1) => {
    const i = beats.findIndex((b) => b === beatAt(beats, time));
    const b = beats[Math.max(0, Math.min(beats.length - 1, (i < 0 ? 0 : i) + d))];
    if (b) seek(b.start);
  };
  const accept = async () => {
    if (!view.run) return;
    setBusy(true);
    try {
      await pmApi.action(pid, { action: 'proof.accept', runId: view.run.id, asDraft: state.asDraft, templateName: name.replace(/\s+/g, ' ').trim() });
      onAccepted(state.asDraft ? t('pm.proof.acceptedDraft') : t('pm.proof.accepted'));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const addNote = async (n: { atSec: number; text: string; nodeId: string | null }) => {
    if (!view.run) return;
    try {
      await pmApi.action(pid, { action: 'note.add', runId: view.run.id, atSec: Math.round(n.atSec * 100) / 100, text: n.text, ...(n.nodeId ? { nodeId: n.nodeId } : {}) });
      say(t('pm.notes.added', { time: clock(n.atSec) }));
      reload();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };
  useKeys({
    Space: toggle,
    ArrowLeft: () => seek(time - 1),
    ArrowRight: () => seek(time + 1),
    '⇧ArrowLeft': () => seek(time - 5),
    '⇧ArrowRight': () => seek(time + 5),
    ',': () => seek(time - 1 / FPS),
    '.': () => seek(time + 1 / FPS),
    '[': () => beatJump(-1),
    ']': () => beatJump(1),
    N: () => view.run && setAdding(true),
    S: () => setZones((z) => !z),
    '1': () => langs.includes('en') && onLang('en'),
    '2': () => langs.includes('fa') && onLang('fa'),
    '⌘Enter': () => !state.disabled && setAccepting(true),
  });

  const reel = SAFE_ZONES.reel;
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;
  const verdict = proof?.verdict ?? 'unscored';
  return (
    <div className="pm-proof">
      <div className="pm-proof-player">
        <div className="pm-frame">
          {video ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- captions are burned into the proof video.
            <video
              ref={player}
              className="pm-video"
              src={pmApi.mediaUrl(pid, view.recipe.id, video.sha256)}
              preload="metadata"
              aria-label={t('pm.proof.player')}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          ) : (
            <p className="pm-frame-empty xs">{t('pm.proof.noVideo')}</p>
          )}
          {zones ? (
            <span className="pm-zones" aria-hidden="true" data-testid="safe-zones">
              {reel.reserves.map((r) => (
                <i key={r.id} className="pm-zone" style={{ '--x': pct(r.box.x, reel.width), '--y': pct(r.box.y, reel.height), '--w': pct(r.box.width, reel.width), '--h': pct(r.box.height, reel.height) } as CSSProperties} />
              ))}
            </span>
          ) : null}
        </div>
        <div className="pm-controls timeline" dir="ltr">
          <Button dense level="tertiary" onClick={toggle} aria-label={playing ? t('pm.proof.pause') : t('pm.proof.play')}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">{playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M7 4l13 8-13 8z" />}</svg>
          </Button>
          <span className="xs" data-content data-testid="pm-time">
            {clock(time)} / {clock(len)}
          </span>
          <input className="pm-seek" type="range" min={0} max={len} step={1 / FPS} value={time} aria-label={t('pm.proof.seek')} onChange={(e) => seek(Number(e.target.value))} />
          <Button dense level="tertiary" aria-pressed={zones} onClick={() => setZones((z) => !z)}>
            {t('pm.proof.safeZones')}
          </Button>
        </div>
        <div className="pm-strip timeline" dir="ltr">
          {beats.map((b) => (
            <button key={b.id} type="button" className={`pm-strip-beat ${beatAt(beats, time) === b ? 'is-selected' : ''}`} style={{ '--start': pct(b.start, len), '--width': pct(b.end - b.start, len) } as CSSProperties} onClick={() => seek(b.start)} data-content>
              {b.name}
            </button>
          ))}
          {notes.map((n) => (
            <i key={n.id} className="pm-pin" style={{ '--start': pct(n.atSec, len) } as CSSProperties} data-testid="note-pin" data-at={n.atSec} />
          ))}
        </div>
        {langs.length > 1 ? (
          <ChipRow label={t('pm.proof.version')}>
            {langs.map((l) => (
              <Chip key={l} selected={l === lang} onClick={() => onLang(l)}>
                {langName(l)}
              </Chip>
            ))}
          </ChipRow>
        ) : null}
      </div>

      <section className="pm-verdict-block" aria-label={t('pm.proof.verdictRegion')}>
        <p className="pm-verdict-head">
          <span className={`pm-verdict pm-verdict-${verdict}`} data-verdict={verdict}>
            {t(VERDICT_WORD[verdict])}
          </span>
          {verdict === 'unscored' && !mock && view.run ? (
            <Button dense level="secondary" onClick={() => setScoring(true)}>
              {t('pm.proof.score')}
            </Button>
          ) : null}
        </p>
        {mock ? <p className="pm-mock-line xs">{t('pm.proof.mockLine')}</p> : null}
        <ul className="pm-gate-rows">
          {(proof?.hardGates ?? []).map((g) => {
            // A scored gate below 5 failed: Needs you plus why, as in the checks list. Unscored gates keep the dot.
            const failed = g.score !== null && !g.passed;
            return (
              <li key={g.criterion} className="pm-gate-row" data-gate={g.criterion}>
                {failed ? <Pill status="Needs you" /> : <span className={`pm-ok ${g.passed && g.confirmed ? 'is-ok' : ''}`} aria-hidden="true" />}
                <span>{t(`check.gate.${g.criterion}`)}</span>
                {failed ? <span className="xs pm-muted">{t('pm.proof.gateFailed', { score: g.score ?? 0 })}</span> : null}
              </li>
            );
          })}
          {rows.map((r) => {
            const label = r.signer ? (
              <>
                {r.kind === 'text' ? t('pm.proof.textSigned') : t('pm.proof.voiceSigned')}
                <span data-content> · {r.signer}</span>
              </>
            ) : r.kind === 'text' ? (
              t('pm.proof.textUnsigned')
            ) : (
              t('pm.proof.voiceUnsigned')
            );
            // The row itself opens the step's sign-off ("Open step"); read-only here.
            return (
              <li key={r.nodeId} className="pm-gate-row" data-gate={r.nodeId}>
                <span className={`pm-ok ${r.signer ? 'is-ok' : ''}`} aria-hidden="true" />
                {r.present ? (
                  <button type="button" className="pm-row-link" title={t('pm.proof.openStep')} onClick={() => openStep(r.nodeId)}>
                    {label}
                  </button>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            );
          })}
        </ul>
        {proof ? (
          <More label={t('pm.proof.checks', { count: proof.checks.length })}>
            <ul className="pm-gate-rows">
              {proof.checks.map((c) => (
                <li key={c.id} className="pm-gate-row">
                  {c.ok ? <span className="pm-ok is-ok" aria-hidden="true" /> : <Pill status="Needs you" />}
                  <span>{t(`check.row.${c.id}`)}</span>
                  {c.reason ? (
                    <span className="xs pm-muted" data-content>
                      {c.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </More>
        ) : null}
        {proof ? (
          <More label={t('pm.proof.criteria')}>
            <ul className="pm-criteria">
              {proof.criteria.map((c) => (
                <li key={c.criterion} className="pm-criterion">
                  <span data-content>
                    {c.criterion} · {c.applicable ? (c.score ?? '–') : t('pm.proof.na')}
                  </span>
                  <span className="xs pm-muted" data-content>
                    {[c.note, ...c.evidence.map((e) => e.value ?? e.ref)].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </More>
        ) : null}
        {caption !== null ? (
          <More label={t('pm.proof.caption')}>
            {lang === 'fa' ? (
              <span data-content>
                <FaText variant="sm">{caption}</FaText>
              </span>
            ) : (
              <p className="xs" data-content>
                {caption}
              </p>
            )}
          </More>
        ) : null}
        <Notes notes={notes} nodes={view.nodes} atSec={time} proposed={proposed} canAdd={!!view.run} adding={adding} onAdding={setAdding} onAdd={addNote} onFix={fixStep} onSeek={seek} />
      </section>

      <div className="pm-foot pm-proof-foot">
        <Button level="primary" busy={busy} disabled={state.disabled} reason={t(`pm.proof.reason.${state.reason ?? 'no-run'}`)} onClick={() => setAccepting(true)}>
          {state.asDraft ? t('pm.proof.acceptDraft') : t('pm.proof.accept')}
        </Button>
      </div>

      <Dialog
        open={accepting}
        role="dialog"
        title={t('pm.proof.acceptTitle')}
        body={state.asDraft ? t('pm.proof.acceptDraftBody') : t('pm.proof.acceptBody')}
        confirmLabel={state.asDraft ? t('pm.proof.acceptDraft') : t('pm.proof.accept')}
        confirmDisabled={nameOk ? null : t('pm.proof.nameNeeded', { max: TEMPLATE_NAME_MAX })}
        onCancel={() => setAccepting(false)}
        onConfirm={() => {
          setAccepting(false);
          void accept();
        }}
      >
        <label className="pm-field">
          <span className="pm-label">{t('pm.proof.templateName')}</span>
          <input className="pm-input" dir="auto" value={name} required aria-invalid={!nameOk} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </label>
      </Dialog>
      {scoring && proof && view.run ? <ScoreDrawer pid={pid} runId={view.run.id} lang={proof.lang} criteria={proof.criteria.filter((c) => c.applicable).map((c) => c.criterion)} onClose={() => setScoring(false)} onSaved={() => (setScoring(false), say(t('pm.proof.scored')), reload())} onError={say} /> : null}
    </div>
  );
}

/** Manual scoring on an Unscored live proof: every applicable criterion 1-5 with an evidence note. */
function ScoreDrawer({ pid, runId, lang, criteria, onClose, onSaved, onError }: { pid: string; runId: string; lang: Lang; criteria: CriterionId[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [scores, setScores] = useState<Record<string, { score: number; note: string }>>(() => Object.fromEntries(criteria.map((c) => [c, { score: 4, note: '' }])));
  const [busy, setBusy] = useState(false);
  const complete = criteria.every((c) => scores[c]!.note.trim().length > 0);
  const save = async () => {
    setBusy(true);
    try {
      await pmApi.action(pid, { action: 'proof.score', runId, lang, scores: criteria.map((c) => ({ criterion: c, score: scores[c]!.score as 1 | 2 | 3 | 4 | 5, note: scores[c]!.note.trim() })) });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      width="wide"
      title={t('pm.proof.scoreTitle', { lang: langName(lang) })}
      dirty={criteria.some((c) => scores[c]!.note.trim())}
      onClose={onClose}
      primary={
        <Button level="primary" busy={busy} disabled={!complete} reason={t('pm.proof.scoreNeedsAll')} onClick={() => void save()}>
          {t('pm.proof.scoreSave')}
        </Button>
      }
    >
      <ul className="pm-score-list">
        {criteria.map((c) => (
          <li key={c} className="pm-score-row">
            <label className="pm-field pm-score-value">
              <span className="pm-label">{t('pm.proof.scoreValue', { criterion: c })}</span>
              <select className="pm-input" value={scores[c]!.score} onChange={(e) => setScores({ ...scores, [c]: { ...scores[c]!, score: Number(e.target.value) } })}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-field pm-score-note">
              <span className="pm-label">{t('pm.proof.scoreEvidence', { criterion: c })}</span>
              <input className="pm-input" dir="auto" maxLength={140} value={scores[c]!.note} onChange={(e) => setScores({ ...scores, [c]: { ...scores[c]!, note: e.target.value } })} />
            </label>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
