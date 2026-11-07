'use client';
// Recipe: the beat strip (LTR timeline; a click selects the beat), the beat rows (time, name, purpose; Edit
// inline, Enter saves, Esc cancels; Regenerate beat asks for an optional note), Style, and Assets needed grouped Have /
// Make / Missing. One primary: "Use this recipe" builds the pipeline (or "Update pipeline" when the recipe changed
// since the pipeline was built) and opens Pipeline. Beat content is user content. Text budget 40 words.
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Pipeline, Recipe as R, RecipeBeat } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Dialog, FaText } from '../ui';
import { pmApi } from './api';
import { useKeys } from './keys';
import { clock } from './model';

export interface RecipeProps {
  pid: string;
  recipe: R;
  pipeline: Pipeline | null;
  onUsed: () => void;
  onChanged: () => void;
  say: (text: string) => void;
}

export function Recipe({ pid, recipe, pipeline, onUsed, onChanged, say }: RecipeProps) {
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<RecipeBeat | null>(null);
  const [regen, setRegen] = useState<RecipeBeat | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const beats = recipe.beats;
  const len = Math.max(1, recipe.lengthSec);
  const stale = !!pipeline && pipeline.builtFrom.recipeVersion !== recipe.version;

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!pipeline || stale) await pmApi.action(pid, { action: 'pipeline.build', recipeId: recipe.id, recipeVersion: recipe.version });
      onUsed();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (b: RecipeBeat) => {
    try {
      await pmApi.action(pid, { action: 'recipe.update', recipeId: recipe.id, baseVersion: recipe.version, patch: { beats: beats.map((x) => (x.id === b.id ? b : x)) } });
      setEditing(null);
      say(t('pm.recipe.saved'));
      onChanged();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };
  const regenerate = async (b: RecipeBeat) => {
    try {
      await pmApi.action(pid, { action: 'recipe.regenerate-beat', recipeId: recipe.id, beatId: b.id, note: note.trim() || undefined });
      onChanged();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };
  const focusBeat = (i: number) => {
    const n = Math.max(0, Math.min(beats.length - 1, i));
    setSel(n);
    document.querySelector<HTMLElement>(`[data-beat="${beats[n]?.id}"]`)?.focus();
  };
  useKeys(
    {
      ArrowDown: () => focusBeat(sel + 1),
      ArrowUp: () => focusBeat(sel - 1),
      Enter: () => beats[sel] && setEditing({ ...beats[sel]! }),
      R: () => beats[sel] && (setNote(''), setRegen(beats[sel]!)),
      '⌘Enter': () => void apply(),
    },
    !editing,
  );

  const fa = recipe.languages.includes('fa');
  return (
    <div className="pm-recipe">
      <div className="pm-strip timeline" dir="ltr" role="group" aria-label={t('pm.recipe.strip')}>
        {beats.map((b, i) => (
          <button
            key={b.id}
            type="button"
            className={`pm-strip-beat ${i === sel ? 'is-selected' : ''}`}
            style={{ '--start': `${(b.start / len) * 100}%`, '--width': `${((b.end - b.start) / len) * 100}%` } as CSSProperties}
            onClick={() => focusBeat(i)}
            data-content
          >
            {b.name}
          </button>
        ))}
      </div>
      <div className="pm-recipe-cols">
        <section className="pm-beats" aria-labelledby="pm-beats-h">
          <h3 id="pm-beats-h" className="pm-h">
            {t('pm.recipe.beats', { count: beats.length })}
          </h3>
          <ol className="pm-beat-list">
            {beats.map((b, i) => (
              <li key={b.id} className={`pm-beat ${i === sel ? 'is-selected' : ''}`}>
                {editing?.id === b.id ? (
                  <BeatEditor beat={editing} onChange={setEditing} onSave={() => void save(editing)} onCancel={() => setEditing(null)} />
                ) : (
                  <>
                    <button type="button" className="pm-beat-sel" data-beat={b.id} onFocus={() => setSel(i)} onClick={() => setSel(i)}>
                      <span className="pm-beat-n" data-content>
                        {i + 1}
                      </span>
                      <span className="pm-beat-name" data-content>
                        {b.name}
                      </span>
                      <span className="pm-beat-time" dir="ltr" data-content>
                        {clock(b.start)}–{clock(b.end)}
                      </span>
                      <span className="pm-beat-purpose xs" data-content>
                        {b.purpose || b.visual}
                      </span>
                    </button>
                    {fa && b.onScreenText.fa ? (
                      <FaText as="span" variant="sm" className="pm-beat-fa">
                        {b.onScreenText.fa}
                      </FaText>
                    ) : null}
                    {i === sel ? (
                      <span className="pm-beat-actions">
                        <Button dense level="tertiary" onClick={() => setEditing({ ...b })}>
                          {t('pm.recipe.edit')}
                        </Button>
                        <Button dense level="tertiary" onClick={() => (setNote(''), setRegen(b))}>
                          {t('pm.recipe.regenBeat')}
                        </Button>
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
        <aside className="pm-recipe-side">
          <section aria-labelledby="pm-style-h">
            <h3 id="pm-style-h" className="pm-h">
              {t('pm.recipe.style')}
            </h3>
            <dl className="pm-dl">
              {(['captions', 'pace', 'type', 'voice', 'music'] as const).map((k) => (
                <div key={k} className="pm-dl-row">
                  <dt>{t(`pm.recipe.style.${k}`)}</dt>
                  <dd data-content>{recipe.style[k]}</dd>
                </div>
              ))}
            </dl>
          </section>
          {recipe.assets.length ? (
            <section aria-labelledby="pm-assets-h">
              <h3 id="pm-assets-h" className="pm-h">
                {t('pm.recipe.assets', { count: recipe.assets.length })}
              </h3>
              <dl className="pm-dl">
                {(['have', 'make', 'missing'] as const).map((st) => {
                  const list = recipe.assets.filter((a) => a.state === st);
                  return list.length ? (
                    <div key={st} className="pm-dl-row">
                      <dt>{t(`pm.recipe.asset.${st}`)}</dt>
                      <dd data-content>{list.map((a) => a.label).join(', ')}</dd>
                    </div>
                  ) : null;
                })}
              </dl>
            </section>
          ) : null}
        </aside>
      </div>
      <div className="pm-foot">
        <Button level="primary" busy={busy} onClick={() => void apply()}>
          {stale ? t('pm.recipe.update') : t('pm.recipe.use')}
        </Button>
      </div>
      <Dialog
        open={!!regen}
        role="dialog"
        title={t('pm.recipe.regenBeatTitle', { name: regen?.name ?? '' })}
        body={t('pm.recipe.regenBeatBody')}
        confirmLabel={t('pm.recipe.regenBeat')}
        onCancel={() => setRegen(null)}
        onConfirm={() => {
          const b = regen;
          setRegen(null);
          if (b) void regenerate(b);
        }}
      >
        <label className="pm-field">
          <span className="pm-label">{t('pm.recipe.note')}</span>
          <textarea className="pm-input" dir="auto" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </Dialog>
    </div>
  );
}

function BeatEditor({ beat, onChange, onSave, onCancel }: { beat: RecipeBeat; onChange: (b: RecipeBeat) => void; onSave: () => void; onCancel: () => void }) {
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="pm-beat-edit">
      <label className="pm-field">
        <span className="pm-label">{t('pm.recipe.beatName')}</span>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- inline edit: focus moves into the beat being edited. */}
        <input className="pm-input" dir="auto" autoFocus onKeyDown={keys} value={beat.name} onChange={(e) => onChange({ ...beat, name: e.target.value })} />
      </label>
      <label className="pm-field">
        <span className="pm-label">{t('pm.recipe.beatPurpose')}</span>
        <input className="pm-input" dir="auto" onKeyDown={keys} value={beat.purpose} onChange={(e) => onChange({ ...beat, purpose: e.target.value })} />
      </label>
      <label className="pm-field">
        <span className="pm-label">{t('pm.recipe.beatVisual')}</span>
        <input className="pm-input" dir="auto" onKeyDown={keys} value={beat.visual} onChange={(e) => onChange({ ...beat, visual: e.target.value })} />
      </label>
      <span className="pm-beat-actions">
        <Button dense level="secondary" onClick={onSave}>
          {t('pm.recipe.save')}
        </Button>
        <Button dense level="tertiary" onClick={onCancel}>
          {t('pm.recipe.cancel')}
        </Button>
      </span>
    </div>
  );
}
