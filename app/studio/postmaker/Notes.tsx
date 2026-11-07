'use client';
// Notes on Proof: a note pins to a timecode, proposes the step that owns the beat at that time
// ("→ Captions"; the person can change it), and "Fix this step" opens that step's Regenerate dialog with the note
// as its text. Note text is content (dir auto); timecodes stay LTR.
import { useState } from 'react';
import type { PmNote, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Dialog } from '../ui';
import { clock, laneTitle } from './model';

export interface NotesProps {
  notes: PmNote[];
  nodes: RecipeViewNode[];
  /** Current player time and the step proposed for it. */
  atSec: number;
  proposed: string | null;
  canAdd: boolean;
  /** Opened from the keyboard (N). */
  adding: boolean;
  onAdding: (open: boolean) => void;
  onAdd: (note: { atSec: number; text: string; nodeId: string | null }) => Promise<void>;
  onFix: (note: PmNote) => void;
  onSeek: (sec: number) => void;
}

export function Notes({ notes, nodes, atSec, proposed, canAdd, adding, onAdding, onAdd, onFix, onSeek }: NotesProps) {
  const titleOf = (id: string | undefined) => {
    const n = nodes.find((x) => x.id === id);
    return n ? laneTitle(n) : '';
  };
  return (
    <section className="pm-notes" aria-labelledby="pm-notes-h">
      <h3 id="pm-notes-h" className="pm-h">
        {t('pm.notes.title', { count: notes.length })}
      </h3>
      <ul className="pm-note-list">
        {notes.map((n) => (
          <li key={n.id} className="pm-note" data-at={n.atSec}>
            <button type="button" className="pm-note-time" dir="ltr" onClick={() => onSeek(n.atSec)} data-content>
              {clock(n.atSec)}
            </button>
            <span className="pm-note-text" dir="auto" data-content>
              {n.text}
            </span>
            {n.nodeId ? (
              <span className="xs pm-muted pm-note-step" data-content>
                → {titleOf(n.nodeId)}
              </span>
            ) : null}
            {n.nodeId ? (
              <Button dense level="tertiary" onClick={() => onFix(n)}>
                {t('pm.notes.fix')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button dense level="secondary" disabled={!canAdd} reason={t('pm.proof.reason.no-run')} onClick={() => onAdding(true)}>
        <span className="pm-plus">{t('pm.notes.add', { time: '' }).trim()}</span> <span data-content>{clock(atSec)}</span>
      </Button>
      {adding ? <NoteDialog at={atSec} proposed={proposed} nodes={nodes} onClose={() => onAdding(false)} onAdd={onAdd} /> : null}
    </section>
  );
}

/** Mounted when opened, so the time and the proposed step are the ones at that moment. */
function NoteDialog({ at, proposed, nodes, onClose, onAdd }: { at: number; proposed: string | null; nodes: RecipeViewNode[]; onClose: () => void; onAdd: NotesProps['onAdd'] }) {
  const [text, setText] = useState('');
  const [step, setStep] = useState<string | null>(proposed);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      role="dialog"
      title={t('pm.notes.addTitle', { time: clock(at) })}
      confirmLabel={t('pm.notes.save')}
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        // The dialog answers once: an empty note just closes; a failed save closes and the screen says why.
        if (!text.trim()) return onClose();
        setBusy(true);
        void onAdd({ atSec: at, text: text.trim(), nodeId: step }).finally(() => {
          setBusy(false);
          onClose();
        });
      }}
    >
      <label className="pm-field">
        <span className="pm-label">{t('pm.notes.text')}</span>
        <textarea className="pm-input" dir="auto" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="pm-field">
        <span className="pm-label">{t('pm.notes.step')}</span>
        <select className="pm-input" value={step ?? ''} onChange={(e) => setStep(e.target.value || null)}>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {laneTitle(n)}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}
