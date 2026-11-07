'use client';
// Reference: drop a video or image (sent as the file itself,
// streamed; mp4/mov ≤ 500 MB and ≤ 300 s, images ≤ 20 MB, the server checks), or paste a page link. Language,
// Length and Shape chips come from the template (a chip it cannot make is disabled, with the reason); the cap is the
// estimate × 1.25 rounded up to $0.50 ("Mock only · $0.00" while every step would run as mock). A new recipe has no
// estimate yet, so the cap field shows none. One primary: "Make it"; with "Stop after the recipe" off it runs through
// to Proof. Text budget 45 words.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { Lang, Recipe, Reference as Ref, Shape } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Chip, ChipRow } from '../ui';
import { pmApi, type MakeItAnswer } from './api';
import { inTextField, useKeys } from './keys';
import { bytes, capFor, clock, CORE_TEMPLATE, defaultLength, LENGTH_CHIPS, lengthAllowed, money, SHAPES } from './model';

export interface ReferenceProps {
  pid: string;
  /** The recipe this screen belongs to (its reference and options shown), or null for a new one. */
  recipe: Recipe | null;
  reference: Ref | null;
  /** The recipe's run estimate (the high end, and whether any step would run live); null before a recipe exists. */
  estimate?: { usdHigh: number; live: boolean } | null;
  onMade: (a: MakeItAnswer, stopAfterRecipe: boolean) => void;
  say: (text: string) => void;
}

type LangChoice = 'en' | 'fa' | 'both';
const langsOf = (c: LangChoice): Lang[] => (c === 'both' ? ['fa', 'en'] : [c]);
const choiceOf = (l: Lang[] | undefined): LangChoice => (!l || l.length > 1 ? 'both' : l[0] === 'fa' ? 'fa' : 'en');

export function Reference({ pid, recipe, reference: initial, estimate = null, onMade, say }: ReferenceProps) {
  const [ref, setRef] = useState<Ref | null>(initial);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [link, setLink] = useState('');
  const [lang, setLang] = useState<LangChoice>(choiceOf(recipe?.languages));
  const refSec = ref?.probe ? ref.probe.durationMs / 1000 : null;
  const [length, setLength] = useState<number | 'same'>(recipe ? recipe.lengthSec : 'same');
  const [shape, setShape] = useState<Shape>(recipe?.shape ?? '9:16');
  // The recipe's own cap, else the estimate × 1.25 rounded up to $0.50; a new recipe starts at 0 (the server's default).
  const [cap, setCap] = useState(recipe && recipe.capUsd > 0 ? String(recipe.capUsd) : estimate ? String(capFor(estimate.usdHigh)) : '0');
  const [stop, setStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const linkInput = useRef<HTMLInputElement | null>(null);

  const sameOk = refSec !== null && lengthAllowed(Math.round(refSec));
  const lengthSec = length === 'same' ? (sameOk ? Math.round(refSec!) : defaultLength(refSec)) : length;
  const lengthReason = t('pm.ref.lengthReason', { min: CORE_TEMPLATE.durationSec.min, max: CORE_TEMPLATE.durationSec.max });

  const add = async (f: File) => {
    setFile({ name: f.name, size: f.size });
    setUploading(true);
    try {
      const r = await pmApi.upload(pid, f);
      setRef(r);
      const sec = r.probe ? r.probe.durationMs / 1000 : null;
      setLength(sec !== null && lengthAllowed(Math.round(sec)) ? 'same' : defaultLength(sec));
    } catch (e) {
      setFile(null);
      say(e instanceof Error ? e.message : t('pm.ref.couldNotAdd'));
    } finally {
      setUploading(false);
    }
  };
  const addLink = async (url: string) => {
    if (!url.trim()) return;
    setUploading(true);
    try {
      const r = await pmApi.link(pid, url.trim());
      setRef(r);
      setFile({ name: r.url ?? url, size: 0 });
      setLength(defaultLength(null));
    } catch (e) {
      say(e instanceof Error ? e.message : t('pm.ref.couldNotAdd'));
    } finally {
      setUploading(false);
    }
  };
  const make = async () => {
    if (!ref || busy) return;
    setBusy(true);
    try {
      const capUsd = Number(cap);
      const a = await pmApi.action<MakeItAnswer>(pid, {
        action: 'make-it',
        referenceId: ref.id,
        options: { languages: langsOf(lang), lengthSec, shape, stopAfterRecipe: stop, ...(Number.isFinite(capUsd) && capUsd > 0 ? { capUsd } : {}) },
      });
      onMade(a, stop);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // ⌘V outside a field: a pasted link goes into the link field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (inTextField(e.target)) return;
      const text = e.clipboardData?.getData('text')?.trim() ?? '';
      if (!/^https?:\/\//i.test(text)) return;
      e.preventDefault();
      setLink(text);
      linkInput.current?.focus();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
  useKeys({ '⌘O': () => input.current?.click(), '⌘Enter': () => void make() });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void add(f);
  };

  return (
    <div className="pm-ref">
      <div className="pm-ref-main">
        <div className="pm-drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-testid="pm-drop">
          <p className="pm-drop-title">{t('pm.ref.drop')}</p>
          <Button level="secondary" onClick={() => input.current?.click()}>
            {t('pm.ref.choose')}
          </Button>
          <input
            ref={input}
            type="file"
            className="visually-hidden"
            accept="video/mp4,video/quicktime,image/png,image/jpeg,image/webp"
            aria-label={t('pm.ref.choose')}
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void add(f);
              e.target.value = '';
            }}
          />
          <p className="xs pm-muted">{t('pm.ref.help')}</p>
          <form
            className="pm-link-row"
            onSubmit={(e) => {
              e.preventDefault();
              void addLink(link);
            }}
          >
            <input ref={linkInput} className="pm-input" type="url" value={link} placeholder="https://" aria-label={t('pm.ref.link')} onChange={(e) => setLink(e.target.value)} />
            {/* Never disabled (a disabled button shows its reason); an empty link adds nothing. */}
            <Button type="submit" dense level="tertiary" busy={uploading}>
              {t('pm.ref.addLink')}
            </Button>
          </form>
        </div>
        {ref || file ? (
          <p className="pm-ref-file" data-testid="pm-ref-file">
            <span data-content>
              {file?.name ?? ref?.url ?? ref?.file ?? ''}
              {ref?.probe ? ` · ${clock(ref.probe.durationMs / 1000)} · ${ref.probe.width}×${ref.probe.height}` : ''}
              {file && file.size ? ` · ${bytes(file.size)}` : ''}
            </span>
            {uploading ? <span className="xs pm-muted"> · {t('pm.ref.uploading')}</span> : null}
            {/* Replace: a new file takes the place of this one. */}
            {ref && !uploading ? (
              <Button dense level="tertiary" onClick={() => input.current?.click()}>
                {t('pm.ref.replace')}
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="pm-ref-side">
        <div className="pm-opt">
          <span className="pm-label">{t('pm.ref.language')}</span>
          <ChipRow label={t('pm.ref.language')}>
            {(['en', 'fa', 'both'] as const).map((c) => (
              <Chip key={c} selected={lang === c} onClick={() => setLang(c)}>
                {t(`pm.ref.lang.${c}`)}
              </Chip>
            ))}
          </ChipRow>
        </div>
        <div className="pm-opt">
          <span className="pm-label">{t('pm.ref.length')}</span>
          <ChipRow label={t('pm.ref.length')}>
            <Chip selected={length === 'same'} disabled={!sameOk} title={sameOk ? undefined : lengthReason} onClick={() => setLength('same')}>
              {t('pm.ref.same')}
            </Chip>
            {LENGTH_CHIPS.map((n) => (
              <Chip key={n} selected={length === n || (length === 'same' && !sameOk && lengthSec === n)} disabled={!lengthAllowed(n)} title={lengthAllowed(n) ? undefined : lengthReason} onClick={() => setLength(n)}>
                {t('pm.ref.sec', { n })}
              </Chip>
            ))}
          </ChipRow>
        </div>
        <div className="pm-opt">
          <span className="pm-label">{t('pm.ref.shape')}</span>
          <ChipRow label={t('pm.ref.shape')}>
            {SHAPES.map((s) => {
              const ok = CORE_TEMPLATE.canvases.includes(s);
              return (
                <Chip key={s} selected={shape === s} disabled={!ok} title={ok ? undefined : t('pm.ref.shapeReason')} onClick={() => setShape(s)}>
                  <span data-content>{s}</span>
                </Chip>
              );
            })}
          </ChipRow>
        </div>
        <label className="pm-opt pm-cap">
          <span className="pm-label">{t('pm.ref.cap')}</span>
          <span data-content>$</span>
          <input className="pm-input pm-cap-input" type="number" min={0} step={0.5} value={cap} aria-label={t('pm.ref.capLabel')} onChange={(e) => setCap(e.target.value)} />
          {estimate ? (
            <span className="xs pm-muted">
              {estimate.live ? (
                <span data-content>{t('pm.ref.estimated', { usd: money(estimate.usdHigh) })}</span>
              ) : (
                <>
                  {t('pm.ref.mockOnly')} <span data-content>· {money(0)}</span>
                </>
              )}
            </span>
          ) : null}
        </label>
      </div>
      <div className="pm-foot">
        <label className="pm-check">
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />
          <span>{t('pm.ref.stop')}</span>
        </label>
        <Button level="primary" busy={busy} disabled={!ref || uploading} reason={t('pm.ref.needsRef')} onClick={() => void make()}>
          {busy ? t('pm.ref.making') : t('pm.ref.makeIt')}
        </Button>
      </div>
    </div>
  );
}
