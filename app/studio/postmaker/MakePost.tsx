'use client';
// Make a post: one brief field, prefilled from the next planned slot of a campaign the template is
// attached to, and the cap; the one primary "Make a post" forks the template and runs it (`template.make-post`), and
// the screen follows the run to Proof. When an attached campaign has a next planned slot, the post fills
// that slot (trigger "Campaign slot") unless the person unticks "For ‹campaign› · ‹when›": then it is a one-off post. The same dialog runs a variant's proof ("Run proof"): the brief
// is made with that variant's parameters. The server is the authority for every rule; its message stays behind the
// field, never as a success toast.
import { useEffect, useId, useRef, useState } from 'react';
import type { TemplateSummary } from '@/lib/studio/postmaker/types';
import { formatWhenIn } from '@/lib/studio/time';
import { t } from '../copy/en';
import { Dialog } from '../ui';
import { pmApi, studioApi, type MakeItAnswer } from './api';
import { capFor, nextSlot, type PlannedSlot } from './model';

export interface MakePostProps {
  pid: string;
  template: Pick<TemplateSummary, 'id' | 'name' | 'campaignIds'>;
  /** A variant's proof run ("Run proof"); null or missing makes a post from the template itself. */
  variant?: { id: string; label: string } | null;
  /** The proof run's spend, for the cap's first value (× 1.25 rounded up to $0.50). */
  usd: number | null;
  timeZone: string | null;
  onMade: (a: MakeItAnswer) => void;
  onClose: () => void;
}

type Slot = { campaignId: string; campaignName: string; slot: PlannedSlot };

export function MakePostDialog({ pid, template, variant = null, usd, timeZone, onMade, onClose }: MakePostProps) {
  const [topic, setTopic] = useState('');
  const [cap, setCap] = useState(usd !== null && usd > 0 ? String(capFor(usd)) : '');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A slot found for this template is used unless the person unticks it: then the post is a one-off.
  const [forSlot, setForSlot] = useState(true);
  const topicRef = useRef<HTMLTextAreaElement | null>(null);
  const id = useId();

  // The next planned slot of an attached campaign prefills the brief (a variant's proof is not for a slot).
  useEffect(() => {
    if (variant || template.campaignIds.length === 0) return;
    let alive = true;
    studioApi
      .campaigns(pid)
      .then((list) => {
        if (!alive) return;
        const next = nextSlot(template.id, template.campaignIds, list.plans, Date.now());
        if (!next) return;
        setSlot({ campaignId: next.campaignId, campaignName: list.campaigns.find((c) => c.id === next.campaignId)?.name ?? '', slot: next.slot });
        setTopic((cur) => cur || next.topic);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, template.id, template.campaignIds, variant]);

  const make = async () => {
    const brief = topic.replace(/\s+/g, ' ').trim();
    if (!brief || busy) return;
    setBusy(true);
    setError('');
    const capUsd = Number(cap);
    try {
      const a = await pmApi.action<MakeItAnswer>(pid, {
        action: 'template.make-post',
        templateId: template.id,
        ...(variant ? { variantId: variant.id } : {}),
        brief: { topic: brief },
        ...(slot && forSlot ? { campaignSlot: { campaignId: slot.campaignId, slotId: slot.slot.id } } : {}),
        ...(Number.isFinite(capUsd) && capUsd > 0 ? { capUsd } : {}),
      });
      onMade(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="dialog"
      title={variant ? t('pm.make.proofTitle', { name: variant.label }) : t('pm.make.title', { name: template.name })}
      body={t('pm.make.body')}
      confirmLabel={variant ? t('pm.make.proofConfirm') : t('pm.make.confirm')}
      busy={busy}
      confirmDisabled={topic.trim() ? null : t('pm.make.needsTopic')}
      initialFocus={topicRef}
      onConfirm={() => void make()}
      onCancel={onClose}
    >
      <div className="pm-make">
        <label className="pm-field" htmlFor={`${id}-topic`}>
          <span className="pm-label">{t('pm.make.topic')}</span>
          <textarea ref={topicRef} id={`${id}-topic`} className="pm-input" rows={3} dir="auto" maxLength={200} value={topic} onChange={(e) => setTopic(e.target.value)} aria-invalid={error ? true : undefined} />
        </label>
        {slot ? (
          <label className="pm-check" data-testid="pm-make-slot">
            <input type="checkbox" checked={forSlot} onChange={(e) => setForSlot(e.target.checked)} />
            <span className="xs pm-muted" data-content>
              {t('pm.make.forSlot', { campaign: slot.campaignName, when: formatWhenIn(timeZone, slot.slot.at) })}
            </span>
          </label>
        ) : null}
        <label className="pm-opt pm-cap">
          <span className="pm-label">{t('pm.make.cap')}</span>
          <span data-content>$</span>
          <input className="pm-input pm-cap-input" type="number" min={0} step={0.5} value={cap} aria-label={t('pm.make.capLabel')} onChange={(e) => setCap(e.target.value)} />
        </label>
        {error ? (
          <p className="pm-error xs" role="alert" data-content>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
