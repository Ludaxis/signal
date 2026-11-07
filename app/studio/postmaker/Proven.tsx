'use client';
// Proven: one template at `?tab=postmaker&t=<templateId>`. Its cover, name and
// pills; its campaign (select + Detach); its variants, each with its own proof (Run proof) and Add variant; Repeat
// (the Pipelines editors moved into a drawer, off by default, with the skip-proof switches per variant and the
// approval note); Results; Open pipeline, Duplicate, Retire; and the one primary "Make a post". Text budget: 50 words
// of chrome. Nothing here schedules or runs by itself: Repeat is stored only, and repeating by itself needs the
// Autopilot and Repeat switches in Connections (the switch stays disabled until the server reports them on).
import { useCallback, useEffect, useId, useState } from 'react';
import type { Lang, Shape, TemplateSummary, VariantParams } from '@/lib/studio/postmaker/types';
import { compactCount } from '@/lib/studio/format';
import { formatDateIn } from '@/lib/studio/time';
import { t } from '../copy/en';
import { navigateTo } from '../url-state';
import { Button, Chip, ChipRow, Dialog, Drawer, Notice, Pill } from '../ui';
import { pmApi, studioApi, type CampaignList, type MakeItAnswer, type PostmakerHome } from './api';
import { MakePostDialog } from './MakePost';
import { CORE_TEMPLATE, duration, isMoved, langName, money, repeatErrors, repeatForm, repeatInput, SHAPES, templatePills, templateStatusWord, variantLengths, variantLine, type PmLocation, type RepeatField, type RepeatForm, type VariantBase } from './model';
import { REPEAT_LIMITS } from '@/lib/studio/postmaker/template-rules';

export interface ProvenProps {
  pid: string;
  data: PostmakerHome;
  templateId: string;
  go: (l: Partial<PmLocation>, o?: { replace?: boolean }) => void;
  say: (text: string) => void;
  reload: () => void;
  onMade: (a: MakeItAnswer) => void;
}

type Open = { kind: 'make'; variant: { id: string; label: string } | null } | { kind: 'variant' } | { kind: 'repeat' } | { kind: 'retire' } | null;

export function Proven({ pid, data, templateId, go, say, reload, onMade }: ProvenProps) {
  const x = data.templates.find((tp) => tp.id === templateId) ?? null;
  const card = data.templateCards?.[templateId] ?? null;
  const [open, setOpen] = useState<Open>(null);
  const [campaigns, setCampaigns] = useState<CampaignList | null>(null);
  const [results, setResults] = useState<{ posts: number; avgViews: number | null } | null | 'none'>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    studioApi
      .campaigns(pid)
      .then((c) => alive && setCampaigns(c))
      .catch(() => alive && setCampaigns({ campaigns: [], plans: {} }));
    studioApi
      .results(pid)
      .then((r) => {
        if (!alive) return;
        const row = (r.byTemplate ?? []).find((b) => b.key === `template:${templateId}`);
        setResults(row ? { posts: row.posts, avgViews: row.avgViews } : 'none');
      })
      .catch(() => alive && setResults('none'));
    return () => {
      alive = false;
    };
  }, [pid, templateId]);

  const act = useCallback(
    async (key: string, body: Parameters<typeof pmApi.action>[1], done?: string): Promise<{ template?: TemplateSummary } | null> => {
      setBusy(key);
      try {
        const r = await pmApi.action<{ template?: TemplateSummary }>(pid, body);
        if (done) say(done);
        reload();
        return r;
      } catch (e) {
        say(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [pid, reload, say],
  );

  if (!x) return <Notice kind="error" title={t('pm.proven.couldNotLoad')} details={t('pm.proven.gone')} onRetry={reload} />;

  const retired = x.status === 'retired';
  // A moved pipeline makes posts on its schedule only: no Make a post, variants, copy or pipeline.
  const moved = isMoved(x);
  const base: VariantBase = { languages: card?.languages ?? [], lengthSec: card?.lengthSec ?? null, shape: card?.shape ?? null };
  const attached = x.campaignIds[0] ?? '';
  const choose = async (cid: string) => {
    if (cid) await act('campaign', { action: 'template.campaign.attach', templateId: x.id, campaignId: cid }, t('pm.proven.attached'));
    for (const old of x.campaignIds.filter((c) => c !== cid)) await act('campaign', { action: 'template.campaign.detach', templateId: x.id, campaignId: old }, cid ? undefined : t('pm.proven.detached'));
  };
  // A moved pipeline has no Post maker steps, cost or time to show; its schedule is in the Repeat row below.
  const meta = [
    moved ? null : t('pm.tcard.steps', { n: card?.steps ?? 0 }),
    !moved && card?.usd != null ? `~${money(card.usd)}` : null,
    !moved && card?.seconds != null ? `~${duration(card.seconds)}` : null,
    card?.lastRunAt ? t('pm.proven.lastRun', { when: formatDateIn(data.timeZone, card.lastRunAt) }) : null,
  ].filter(Boolean);

  return (
    <section className="pm-proven" aria-label={t('pm.proven.region')}>
      <header className="pm-proven-head">
        {/* eslint-disable-next-line @next/next/no-img-element -- a local media route, not an optimisable asset */}
        {card?.cover ? <img className="pm-cover" src={pmApi.mediaUrl(pid, card.cover.recipeId, card.cover.sha256)} alt={t('pm.tcard.cover', { name: x.name })} /> : <span className="pm-cover is-empty" aria-hidden="true" />}
        <div className="pm-proven-title">
          <h2 className="pm-h" data-content>
            {x.name}
          </h2>
          {meta.length > 0 ? (
            <p className="xs pm-muted" data-content>
              {meta.join(' · ')}
            </p>
          ) : null}
        </div>
        <span className="pm-pills">
          {templatePills(x).map((w) => (
            <Pill key={w} status={w} />
          ))}
        </span>
      </header>

      <dl className="pm-dl pm-proven-dl">
        <div className="pm-dl-row">
          <dt>{t('pm.proven.campaign')}</dt>
          <dd className="pm-proven-campaign">
            <select className="pm-input pm-select" data-content aria-label={t('pm.proven.campaign')} value={attached} disabled={retired || busy === 'campaign' || !campaigns} onChange={(e) => void choose(e.target.value)}>
              <option value="">{t('pm.proven.noCampaign')}</option>
              {(campaigns?.campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id} data-content>
                  {c.name}
                </option>
              ))}
              {/* A campaign that was deleted keeps its id as the value (so Detach still works), never as the label. */}
              {attached && campaigns && !campaigns.campaigns.some((c) => c.id === attached) ? <option value={attached}>{t('pm.proven.unknownCampaign')}</option> : null}
            </select>
            {attached ? (
              <Button dense level="tertiary" busy={busy === 'campaign'} onClick={() => void choose('')}>
                {t('pm.proven.detach')}
              </Button>
            ) : null}
          </dd>
        </div>
        <div className="pm-dl-row">
          <dt>{t('pm.proven.variants', { count: x.variants.length + 1 })}</dt>
          <dd>
            <ul className="pm-variants">
              <li className="pm-variant" data-variant="original">
                <span className="pm-variant-text">
                  <span className="pm-row-title">{t('pm.proven.original')}</span>
                  <span className="xs pm-muted" data-content>
                    {variantLine({}, base)}
                  </span>
                </span>
                <Pill status={templateStatusWord(x)} />
              </li>
              {x.variants.map((v) => (
                <li key={v.id} className="pm-variant" data-variant={v.id}>
                  <span className="pm-variant-text">
                    <span className="pm-row-title" data-content>
                      {v.label}
                    </span>
                    <span className="xs pm-muted" data-content>
                      {variantLine(v.params, base)}
                    </span>
                  </span>
                  <Pill status={v.status === 'proven' ? 'Proven' : 'Draft'} />
                  {v.status !== 'proven' && !retired ? (
                    <Button dense onClick={() => setOpen({ kind: 'make', variant: { id: v.id, label: v.label } })}>
                      {t('pm.proven.runProof')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {!retired && !moved ? (
              <Button dense level="tertiary" onClick={() => setOpen({ kind: 'variant' })}>
                {t('pm.proven.addVariant')}
              </Button>
            ) : null}
          </dd>
        </div>
        <div className="pm-dl-row">
          <dt>{t('pm.proven.repeat')}</dt>
          <dd className="pm-proven-repeat">
            <span data-testid="pm-repeat-line">{x.repeat?.enabled ? t('pm.proven.repeatOn', { n: x.repeat.perWeek }) : t('pm.proven.repeatOff')}</span>
            {!retired ? (
              <Button dense level="tertiary" onClick={() => setOpen({ kind: 'repeat' })}>
                {t('pm.proven.setUp')}
              </Button>
            ) : null}
          </dd>
        </div>
        <div className="pm-dl-row">
          <dt>{t('pm.proven.results')}</dt>
          <dd className="pm-proven-repeat">
            <span data-content>{results && results !== 'none' ? t('pm.proven.resultsLine', { posts: results.posts, views: compactCount(results.avgViews) }) : results === 'none' ? t('pm.proven.resultsNone') : ''}</span>
            <Button dense level="tertiary" onClick={() => navigateTo('results')}>
              {t('pm.proven.openResults')}
            </Button>
          </dd>
        </div>
      </dl>

      <div className="pm-foot pm-proven-foot">
        <span className="pm-proven-secondary">
          {!moved ? <Button onClick={() => go({ r: x.recipeId, s: 'pipeline' })}>{t('pm.proven.openPipeline')}</Button> : null}
          {!moved ? (
            <Button
              busy={busy === 'duplicate'}
              onClick={() =>
                void act('duplicate', { action: 'template.duplicate', templateId: x.id }, t('pm.proven.duplicated')).then((r) => {
                  if (r?.template) go({ t: r.template.id });
                })
              }
            >
              {t('pm.proven.duplicate')}
            </Button>
          ) : null}
          {!retired ? (
            <Button level="destructive" onClick={() => setOpen({ kind: 'retire' })}>
              {t('pm.proven.retire')}
            </Button>
          ) : null}
        </span>
        <Button level="primary" disabled={retired || moved} reason={retired ? t('pm.proven.isRetired') : t('pm.move.movedOnly')} onClick={() => setOpen({ kind: 'make', variant: null })}>
          {t('pm.proven.make')}
        </Button>
      </div>

      {open?.kind === 'make' ? <MakePostDialog pid={pid} template={x} variant={open.variant} usd={card?.usd ?? null} timeZone={data.timeZone} onMade={onMade} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'retire' ? (
        <Dialog
          open
          destructive
          title={t('pm.proven.retireTitle', { name: x.name })}
          body={t('pm.proven.retireBody')}
          confirmLabel={t('pm.proven.retireConfirm')}
          busy={busy === 'retire'}
          onConfirm={() => void act('retire', { action: 'template.retire', templateId: x.id }, t('pm.proven.retired')).then(() => setOpen(null))}
          onCancel={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === 'variant' ? <VariantDrawer pid={pid} template={x} base={base} onClose={() => setOpen(null)} onSaved={() => (say(t('pm.variant.added')), reload(), setOpen(null))} /> : null}
      {open?.kind === 'repeat' ? <RepeatDrawer pid={pid} template={x} onClose={() => setOpen(null)} onSaved={() => (say(t('pm.repeat.saved')), reload(), setOpen(null))} /> : null}
    </section>
  );
}

// ---- Add variant (only the declared parameters; chips that cannot be made are disabled with their reason) ---------

function VariantDrawer({ pid, template, base, onClose, onSaved }: { pid: string; template: TemplateSummary; base: VariantBase; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [label, setLabel] = useState('');
  const [lang, setLang] = useState<Lang | null>(null);
  const [lengthSec, setLengthSec] = useState<number | null>(null);
  const [shape, setShape] = useState<Shape | null>(null);
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const params: VariantParams = { ...(lang ? { lang } : {}), ...(lengthSec !== null ? { lengthSec } : {}), ...(shape ? { shape } : {}), ...(hook.trim() ? { hook: hook.trim() } : {}) };
  const why = !label.trim() ? t('pm.variant.needsName') : Object.keys(params).length === 0 ? t('pm.variant.needsChange') : null;
  const lengthReason = t('pm.ref.lengthReason', { min: CORE_TEMPLATE.durationSec.min, max: CORE_TEMPLATE.durationSec.max });
  const save = async () => {
    if (why || busy) return;
    setBusy(true);
    setError('');
    try {
      await pmApi.action(pid, { action: 'template.variant.save', templateId: template.id, variant: { label: label.replace(/\s+/g, ' ').trim(), params } });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      title={t('pm.variant.title')}
      dirty={!!label || Object.keys(params).length > 0}
      onClose={onClose}
      primary={
        <Button level="primary" busy={busy} disabled={!!why} reason={why ?? ''} onClick={() => void save()}>
          {t('pm.variant.save')}
        </Button>
      }
    >
      <div className="pm-form">
        <label className="pm-field" htmlFor={`${id}-name`}>
          <span className="pm-label">{t('pm.variant.name')}</span>
          <input id={`${id}-name`} className="pm-input" dir="auto" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {base.languages.length > 1 ? (
          <ChipRow label={t('pm.variant.language')}>
            {base.languages.map((l) => (
              <Chip key={l} selected={lang === l} onClick={() => setLang(lang === l ? null : l)}>
                {langName(l)}
              </Chip>
            ))}
          </ChipRow>
        ) : null}
        <div className="pm-field">
          <span className="pm-label">{t('pm.variant.length')}</span>
          <ChipRow label={t('pm.variant.length')}>
            {variantLengths(base.lengthSec).map((c) => (
              <Chip key={c.sec} selected={lengthSec === c.sec} disabled={!c.ok} title={c.ok ? undefined : lengthReason} onClick={() => setLengthSec(lengthSec === c.sec ? null : c.sec)}>
                {t('pm.ref.sec', { n: c.sec })}
              </Chip>
            ))}
          </ChipRow>
          {variantLengths(base.lengthSec).some((c) => !c.ok) ? <span className="xs pm-muted">{lengthReason}</span> : null}
        </div>
        <div className="pm-field">
          <span className="pm-label">{t('pm.variant.shape')}</span>
          <ChipRow label={t('pm.variant.shape')}>
            {SHAPES.map((s) => {
              const ok = CORE_TEMPLATE.canvases.includes(s);
              return (
                <Chip key={s} selected={shape === s} disabled={!ok} title={ok ? undefined : t('pm.ref.shapeReason')} onClick={() => setShape(shape === s ? null : s)}>
                  <span data-content>{s}</span>
                </Chip>
              );
            })}
          </ChipRow>
          {SHAPES.some((s) => !CORE_TEMPLATE.canvases.includes(s)) ? <span className="xs pm-muted">{t('pm.ref.shapeReason')}</span> : null}
        </div>
        <label className="pm-field" htmlFor={`${id}-hook`}>
          <span className="pm-label">{t('pm.variant.hook')}</span>
          <input id={`${id}-hook`} className="pm-input" dir="auto" maxLength={200} value={hook} onChange={(e) => setHook(e.target.value)} />
        </label>
        {error ? <Notice kind="error" title={t('pm.variant.couldNotSave')} details={error} /> : null}
      </div>
    </Drawer>
  );
}

// ---- Repeat (the Pipelines editors; off by default; skip-proof per variant) ------------------------------------------

const FIELD_ERROR: Record<RepeatField, () => string> = {
  perWeek: () => t('pm.repeat.err.perWeek', { min: REPEAT_LIMITS.perWeek.min, max: REPEAT_LIMITS.perWeek.max }),
  days: () => t('pm.repeat.err.days'),
  times: () => t('pm.repeat.err.times'),
  makeAheadDays: () => t('pm.repeat.err.makeAheadDays', { min: REPEAT_LIMITS.makeAheadDays.min, max: REPEAT_LIMITS.makeAheadDays.max }),
  dailyUsd: () => t('pm.repeat.err.dailyUsd'),
};

/** `describedBy` points the reason at a notice already on screen instead of repeating it under the switch. */
function Switch({ checked, label, reason, describedBy, onChange }: { checked: boolean; label: string; reason: string | null; describedBy?: string; onChange: (v: boolean) => void }) {
  const id = useId();
  const own = reason && !describedBy;
  return (
    <div className="pm-switch-row">
      <label className="pm-switch-label" htmlFor={id}>
        {label}
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} className="ap-switch" disabled={!!reason} title={reason ?? undefined} aria-describedby={own ? `${id}-why` : reason ? describedBy : undefined} onClick={() => onChange(!checked)}>
        <span className="ap-knob" aria-hidden="true" />
      </button>
      {own ? (
        <span className="xs pm-muted pm-switch-why" id={`${id}-why`}>
          {reason}
        </span>
      ) : null}
    </div>
  );
}

export function RepeatDrawer({ pid, template, onClose, onSaved, automation: given }: { pid: string; template: TemplateSummary; onClose: () => void; onSaved: () => void; automation?: { repeat: boolean; trusted: boolean } }) {
  const id = useId();
  const [form, setForm] = useState<RepeatForm>(() => repeatForm(template.repeat));
  const [touched, setTouched] = useState(false);
  const [gates, setGates] = useState<{ repeat: boolean; trusted: boolean }>(given ?? { repeat: false, trusted: false });
  const rows = [{ id: null as string | null, label: t('pm.proven.original'), on: template.skipProofForRepeats, allowed: template.skipProofAllowed }, ...template.variants.map((v) => ({ id: v.id as string | null, label: v.label, on: v.skipProofForRepeats, allowed: v.skipProofAllowed }))];
  const [skip, setSkip] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.id ?? '', r.on])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (given) return;
    let alive = true;
    studioApi
      .automation(pid)
      .then((g) => alive && setGates(g))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, given]);

  const moved = isMoved(template);
  const errors = repeatErrors(form, { moved });
  const shown = (f: RepeatField) => (touched || f === 'times' || f === 'days') && errors[f];
  const set = (p: Partial<RepeatForm>) => setForm((f) => ({ ...f, ...p }));
  const proven = template.status === 'proven';
  const switchReason = !proven ? t('pm.repeat.needsProven') : !gates.repeat ? t('pm.repeat.needsApproval') : null;
  const gateId = `${id}-gate`;
  const save = async () => {
    setTouched(true);
    const input = repeatInput(form, { moved });
    if (!input || busy) return;
    setBusy(true);
    setError('');
    try {
      await pmApi.action(pid, { action: 'template.repeat.set', templateId: template.id, repeat: input });
      for (const r of rows) {
        const want = skip[r.id ?? ''] ?? false;
        if (want !== r.on) await pmApi.action(pid, { action: 'template.skip-proof.set', templateId: template.id, variantId: r.id, on: want });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const field = (f: RepeatField, label: string, value: string, onChange: (v: string) => void, inputMode: 'numeric' | 'decimal') => (
    <div className="pm-field">
      <label className="pm-label" htmlFor={`${id}-${f}`}>
        {label}
      </label>
      <input id={`${id}-${f}`} className="pm-input pm-num" inputMode={inputMode} value={value} aria-invalid={shown(f) ? true : undefined} aria-describedby={shown(f) ? `${id}-${f}-err` : undefined} onBlur={() => setTouched(true)} onChange={(e) => onChange(e.target.value)} />
      {shown(f) ? (
        <span className="pm-error xs" id={`${id}-${f}-err`} role="alert">
          {f === 'dailyUsd' && moved ? t('pm.repeat.err.dailyUsdMoved') : FIELD_ERROR[f]()}
        </span>
      ) : null}
    </div>
  );
  return (
    <Drawer
      open
      title={t('pm.repeat.title')}
      onClose={onClose}
      primary={
        <Button level="primary" busy={busy} disabled={Object.keys(errors).length > 0} reason={t('pm.repeat.fixFields')} onClick={() => void save()}>
          {t('pm.repeat.save')}
        </Button>
      }
    >
      <div className="pm-form">
        {/* One gate line: while repeating by itself is not approved, the notice is the reason for the
            switch and the "Post by itself" option; they keep it as their title and point at the notice. */}
        <Switch checked={form.enabled} label={t('pm.repeat.switch')} reason={switchReason} describedBy={proven && !gates.repeat ? gateId : undefined} onChange={(v) => set({ enabled: v })} />
        {!gates.repeat ? (
          <div id={gateId}>
            <Notice kind="not-allowed" title={t('pm.repeat.gate')} why={t('pm.repeat.gateWhy')} />
          </div>
        ) : null}
        <div className="pm-form-grid">
          {field('perWeek', t('pm.repeat.perWeek'), form.perWeek, (v) => set({ perWeek: v }), 'numeric')}
          {field('makeAheadDays', t('pm.repeat.makeAhead'), form.makeAheadDays, (v) => set({ makeAheadDays: v }), 'numeric')}
          {field('dailyUsd', t('pm.repeat.budget'), form.dailyUsd, (v) => set({ dailyUsd: v }), 'decimal')}
        </div>
        <div className="pm-field">
          <span className="pm-label">{t('pm.repeat.days')}</span>
          <ChipRow label={t('pm.repeat.days')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <Chip key={d} selected={form.days.includes(d)} onClick={() => set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d].sort((a, b) => a - b) })}>
                {t(`pm.day.${d}` as 'pm.day.0')}
              </Chip>
            ))}
          </ChipRow>
          {shown('days') ? (
            <span className="pm-error xs" role="alert">
              {FIELD_ERROR.days()}
            </span>
          ) : null}
        </div>
        <div className="pm-field">
          <span className="pm-label">{t('pm.repeat.times')}</span>
          <div className="pm-times">
            {form.times.map((tm, i) => (
              <span key={i} className="pm-time">
                <input className="pm-input pm-num" aria-label={t('pm.repeat.time', { n: i + 1 })} value={tm} inputMode="numeric" maxLength={5} aria-invalid={shown('times') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm) ? true : undefined} onChange={(e) => set({ times: form.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                {form.times.length > 1 ? (
                  <Button dense level="tertiary" aria-label={t('pm.repeat.removeTime', { time: tm })} onClick={() => set({ times: form.times.filter((_, j) => j !== i) })}>
                    ×
                  </Button>
                ) : null}
              </span>
            ))}
            {form.times.length < REPEAT_LIMITS.times ? (
              <Button dense level="tertiary" onClick={() => set({ times: [...form.times, '12:00'] })}>
                {t('pm.repeat.addTime')}
              </Button>
            ) : null}
          </div>
          {shown('times') ? (
            <span className="pm-error xs" role="alert">
              {FIELD_ERROR.times()}
            </span>
          ) : null}
        </div>
        <fieldset className="pm-field pm-radios">
          <legend className="pm-label">{t('pm.repeat.approve')}</legend>
          <label className="pm-check">
            <input type="radio" name={`${id}-approve`} checked={form.approve === 'ask'} onChange={() => set({ approve: 'ask' })} />
            <span>{t('pm.repeat.ask')}</span>
          </label>
          <label className="pm-check" title={gates.trusted ? undefined : t('pm.repeat.trustedOff')}>
            <input
              type="radio"
              name={`${id}-approve`}
              checked={form.approve === 'trusted'}
              disabled={!gates.trusted && form.approve !== 'trusted'}
              aria-describedby={gates.trusted ? undefined : gates.repeat ? `${id}-trusted-why` : gateId}
              onChange={() => set({ approve: 'trusted' })}
            />
            <span>{t('pm.repeat.trusted')}</span>
          </label>
          {!gates.trusted && gates.repeat ? (
            <span className="xs pm-muted" id={`${id}-trusted-why`}>
              {t('pm.repeat.trustedOff')}
            </span>
          ) : null}
        </fieldset>
        <div className="pm-field" data-testid="pm-skip-proof">
          <span className="pm-label">{t('pm.repeat.skip')}</span>
          {rows.map((r) => (
            <Switch key={r.id ?? 'original'} checked={skip[r.id ?? ''] ?? false} label={r.label} reason={r.allowed || skip[r.id ?? ''] ? null : t('pm.repeat.skipLocked')} onChange={(v) => setSkip((s) => ({ ...s, [r.id ?? '']: v }))} />
          ))}
        </div>
        {error ? <Notice kind="error" title={t('pm.repeat.couldNotSave')} details={error} /> : null}
      </div>
    </Drawer>
  );
}
