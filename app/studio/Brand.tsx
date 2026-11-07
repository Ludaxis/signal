'use client';
// Brand: import a website and/or a project folder into the project's brand kit, review and edit it, and make
// posts from pages found on the website. Fonts and voice are per language: Latin, Persian
// (Vazirmatn) and Display (Estedad) rows with previews; English voice words; the Persian register, and the
// pack's pronunciation list when the project has a pack. The core names no game.
import { useCallback, useEffect, useState } from 'react';
import { notifyChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { ScreenSkeleton, TaskProgress } from './loaders';
import { More } from './More';
import { formatIn } from '@/lib/studio/time';
import { t } from './copy/en';
import { Button, Chip, ChipRow, Drawer, FaText, Notice } from './ui';

export type FaRegister = 'colloquial' | 'formal';
export interface Kit {
  name: string;
  tagline: string;
  website: string | null;
  colors: { primary: string; background: string; text: string; accent: string };
  palette: string[];
  fonts: string[];
  fontFile: string | null;
  logo: string | null;
  ogImage: string | null;
  voice: string[];
  copy: string[];
  instagram: string | null;
  sources: { type: 'website' | 'folder'; value: string; at: string }[];
  updatedAt: string;
  faRegister?: FaRegister;
}
export interface BrandPayload { kit: Kit | null; pack?: { lexicon: { count: number } | null }; timeZone?: string }
interface LexiconRow { id: string; display: string; roman: string; status: 'proposed' | 'approved' }

/** The faces each language uses (Vazirmatn and Estedad ship with the core). */
export const PERSIAN_FACE = 'Vazirmatn';
export const DISPLAY_FACE = 'Estedad';
const LATIN_FALLBACK = 'Instrument Sans';

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

const COLOURS = ['primary', 'accent', 'background', 'text'] as const;

function LexiconDrawer({ onClose }: { onClose: () => void }) {
  const pid = useProjectId();
  const [rows, setRows] = useState<LexiconRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    void call<{ lexicon: { rows: LexiconRow[] } | null }>(`/api/studio/brand?project=${encodeURIComponent(pid ?? '')}&view=lexicon`)
      .then((j) => alive && setRows(j.lexicon?.rows ?? []))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [pid]);
  return (
    <Drawer open title={t('brand.lexicon.title')} onClose={onClose}>
      {err ? <Notice kind="error" title={t('notice.couldNotLoad', { thing: t('brand.lexicon.title') })} details={err} /> : null}
      {!rows && !err ? <Notice kind="loading" title={t('notice.loading', { thing: t('brand.lexicon.title').toLowerCase() })} /> : null}
      {rows && rows.length === 0 ? <Notice kind="empty" title={t('brand.lexicon.empty')} /> : null}
      {rows && rows.length ? (
        <ul className="brand-lex-list">
          {rows.map((r) => (
            <li key={r.id} className="brand-lex-item">
              <FaText as="span" variant="lg">
                {r.display}
              </FaText>
              <span className="st-small" data-content>
                {r.roman}
              </span>
              <span className="xs st-muted">{r.status === 'approved' ? t('brand.lexicon.approved') : t('brand.lexicon.proposed')}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}

export function Brand({ say, onMade }: { say: (t: string) => void; onMade: () => void }) {
  const pid = useProjectId();
  const [kit, setKit] = useState<Kit | null>(null);
  const [lexicon, setLexicon] = useState<{ count: number } | null>(null);
  const [zone, setZone] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [website, setWebsite] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<{ name: string; tagline: string; voice: string; colors: Kit['colors']; faRegister: FaRegister } | null>(null);
  const [pages, setPages] = useState<{ url: string; used: boolean }[] | null>(null);
  const [stamp, setStamp] = useState(0);
  const [lexOpen, setLexOpen] = useState(false);

  const load = useCallback(async () => {
    if (!pid) return;
    const j = await call<BrandPayload>(`/api/studio/brand?project=${encodeURIComponent(pid)}`).catch(() => ({ kit: null }) as BrandPayload);
    setKit(j.kit);
    setLexicon(j.pack?.lexicon ?? null);
    setZone(j.timeZone);
    setLoaded(true);
    setStamp(Date.now());
    setEdit(j.kit ? { name: j.kit.name, tagline: j.kit.tagline, voice: j.kit.voice.join(', '), colors: j.kit.colors, faRegister: j.kit.faRegister ?? 'colloquial' } : null);
    setWebsite((w) => w || j.kit?.website || '');
  }, [pid]);
  // The screen is keyed by project in Studio, so a project switch remounts it with empty state.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const importFrom = (kind: 'website' | 'folder') =>
    run(kind, async () => {
      const value = (kind === 'website' ? website : folder).trim();
      if (!value) throw new Error(kind === 'website' ? t('brand.needWebsite') : t('brand.needFolder'));
      await call('/api/studio/brand', kind === 'website' ? { project: getProjectId(), action: 'import-website', url: value } : { project: getProjectId(), action: 'import-folder', dir: value });
      await load();
      notifyChanged('brand', 'connections');
      say(t('brand.imported'));
    });
  const save = () =>
    run('save', async () => {
      if (!edit) return;
      await call('/api/studio/brand', {
        project: getProjectId(),
        action: 'update',
        patch: { name: edit.name, tagline: edit.tagline, voice: edit.voice.split(',').map((v) => v.trim()).filter(Boolean), colors: edit.colors, faRegister: edit.faRegister },
      });
      await load();
      notifyChanged('brand', 'connections');
      say(t('brand.saved'));
    });
  const findPages = () =>
    run('pages', async () => {
      const j = await call<{ pages: { url: string; used: boolean }[] }>(`/api/studio/brand/articles?project=${encodeURIComponent(getProjectId() ?? '')}`);
      setPages(j.pages);
    });
  const makeFrom = (url: string) =>
    run(url, async () => {
      const j = await call<{ package: { id: string } }>('/api/studio/content/generate', { project: getProjectId(), format: 'website-card', articleUrl: url });
      notifyChanged('content', 'calendar');
      say(t('brand.pageMade', { id: j.package.id }));
      onMade();
    });

  const img = (name: string) => `/api/studio/brand/file/${name}?project=${encodeURIComponent(pid ?? '')}&v=${stamp}`;
  const latinFace = kit?.fonts[0] ?? LATIN_FALLBACK;
  // One primary per screen: Import until there is a kit, then Save brand.
  const importLevel = kit ? 'secondary' : 'primary';

  return (
    <section className="screen u-stack u-gap-4" aria-label="Brand">
      <div className="card brand-card">
        <p className="st-small u-m0">{t('brand.import')}</p>
        <div className="brand-import">
          <label className="wiz-field">
            {t('brand.website')}
            <input className="st-input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" />
          </label>
          <Button level={importLevel} dense busy={busy === 'website'} disabled={!!busy} reason={t('common.busy')} onClick={() => void importFrom('website')}>
            {t('brand.importWebsite')}
          </Button>
        </div>
        <div className="brand-import">
          <label className="wiz-field">
            {t('brand.folder')}
            <input className="st-input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/Workspace/my-brand" />
          </label>
          <Button dense busy={busy === 'folder'} disabled={!!busy} reason={t('common.busy')} onClick={() => void importFrom('folder')}>
            {t('brand.importFolder')}
          </Button>
        </div>
      </div>

      {err ? <Notice kind="error" title={t('common.couldNotChange', { thing: t('connections.brand').toLowerCase() })} details={err} /> : null}

      {busy === 'website' || busy === 'folder' ? (
        <TaskProgress
          active
          title={busy === 'website' ? t('brand.readingWebsite') : t('brand.readingFolder')}
          steps={busy === 'website' ? ['Fetching the page', 'Reading styles and colours', 'Saving logo and images', 'Building the brand kit'] : ['Scanning files', 'Reading colour tokens', 'Copying fonts and logo', 'Building the brand kit']}
          expectedSeconds={busy === 'website' ? 12 : 6}
        />
      ) : null}
      {!loaded ? <ScreenSkeleton variant="form" count={2} label={t('brand.loading')} /> : null}
      {loaded && !kit ? <Notice kind="empty" title={t('brand.empty')} /> : null}

      {/* Fonts per language: shown with or without a kit, since Persian and Display come with Signal. */}
      {loaded ? (
        <section className="card brand-card" aria-label={t('brand.fonts')}>
          <h2 className="card-title">{t('brand.fonts')}</h2>
          <div className="brand-font-row" data-font-row="latin">
            <span className="brand-font-name">{t('brand.font.latin')}</span>
            <span className="brand-font-face" data-content>
              {latinFace}
            </span>
            <p className="brand-font-preview" lang="en" data-content>
              {t('brand.font.sampleLatin')}
            </p>
          </div>
          <div className="brand-font-row" data-font-row="persian">
            <span className="brand-font-name">{t('brand.font.persian')}</span>
            <span className="brand-font-face" data-content>
              {PERSIAN_FACE}
            </span>
            <div data-content className="brand-font-preview-wrap">
              <FaText className="brand-font-preview">{t('brand.font.sampleFa')}</FaText>
            </div>
          </div>
          <div className="brand-font-row" data-font-row="display">
            <span className="brand-font-name">{t('brand.font.display')}</span>
            <span className="brand-font-face" data-content>
              {DISPLAY_FACE}
            </span>
            <div data-content className="brand-font-preview-wrap">
              <FaText display className="brand-font-preview is-display">
                {t('brand.font.sampleFa')}
              </FaText>
            </div>
          </div>
        </section>
      ) : null}

      {kit && edit ? (
        <>
          <div className="grid2">
            <div className="card brand-card">
              <h2 className="card-title">{t('brand.identity')}</h2>
              <div className="u-row u-gap-3">
                {kit.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="brand-logo" src={img('logo.png')} alt="" />
                ) : (
                  <span className="brand-logo empty">{t('brand.noLogo')}</span>
                )}
                <div className="u-stack u-gap-2 u-fill">
                  <input className="st-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label={t('brand.name')} dir="auto" />
                  <span className="xs st-muted" data-content>
                    {[kit.website, kit.instagram].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
              <label className="wiz-field">
                {t('brand.tagline')}
                <textarea className="st-input gen-text" rows={2} value={edit.tagline} onChange={(e) => setEdit({ ...edit, tagline: e.target.value })} dir="auto" />
              </label>
            </div>
            <div className="card brand-card">
              <h2 className="card-title">{t('brand.colours')}</h2>
              <div className="brand-colors">
                {COLOURS.map((k) => (
                  <label key={k} className="brand-color">
                    <input type="color" value={edit.colors[k]} onChange={(e) => setEdit({ ...edit, colors: { ...edit.colors, [k]: e.target.value } })} aria-label={t('brand.colour', { name: t(`brand.colour.${k}`) })} />
                    <span className="u-stack">
                      <span className="brand-colour-name">{t(`brand.colour.${k}`)}</span>
                      <span className="xs st-muted" data-content>
                        {edit.colors[k]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {kit.palette.length ? (
                <div className="brand-palette" data-content>
                  {kit.palette.map((c) => (
                    <button key={c} type="button" className="brand-swatch" title={t('brand.useColour', { colour: c })} style={{ '--swatch': c } as React.CSSProperties} onClick={() => setEdit({ ...edit, colors: { ...edit.colors, primary: c } })}>
                      <span className="st-vh">{t('brand.useColour', { colour: c })}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="brand-preview" data-content style={{ '--from': edit.colors.primary, '--to': edit.colors.accent } as React.CSSProperties}>
                <b>{edit.name}</b>
                <span className="xs">{edit.tagline.slice(0, 80)}</span>
              </div>
            </div>
          </div>

          <section className="card brand-card" aria-label={t('brand.voice')}>
            <h2 className="card-title">{t('brand.voice')}</h2>
            <div className="brand-voice-row">
              <span className="brand-voice-lang">{t('brand.voice.english')}</span>
              <input className="st-input u-fill" value={edit.voice} onChange={(e) => setEdit({ ...edit, voice: e.target.value })} aria-label={t('brand.voice.englishLabel')} placeholder="calm, clear, no emojis" />
            </div>
            <div className="brand-voice-row">
              <span className="brand-voice-lang">{t('brand.voice.persian')}</span>
              <ChipRow label={t('brand.voice.persian')}>
                {(['colloquial', 'formal'] as const).map((r) => (
                  <Chip key={r} selected={edit.faRegister === r} onClick={() => setEdit({ ...edit, faRegister: r })}>
                    {t(`brand.voice.${r}`)}
                  </Chip>
                ))}
              </ChipRow>
              {lexicon ? (
                <Button dense level="tertiary" onClick={() => setLexOpen(true)}>
                  {t('brand.lexicon')} · {t('brand.lexicon.count', { count: lexicon.count })}
                </Button>
              ) : null}
            </div>
          </section>

          <div className="u-row u-gap-3">
            <Button level="primary" dense busy={busy === 'save'} disabled={!!busy} reason={t('common.busy')} onClick={() => void save()}>
              {t('brand.save')}
            </Button>
            <span className="xs st-muted" data-content>
              {t('brand.updated', { when: formatIn(zone, kit.updatedAt) })}
            </span>
            <More label={t('brand.sources')}>
              <span>{kit.sources.map((s) => `${s.type} ${s.value}`).join(' · ') || '—'}</span>
            </More>
          </div>

          {kit.website ? (
            <div className="card brand-card">
              <div className="u-between u-gap-2">
                <span className="label" data-content>
                  {new URL(kit.website).hostname}
                </span>
                <Button dense busy={busy === 'pages'} disabled={!!busy} reason={t('common.busy')} onClick={() => void findPages()}>
                  {pages ? t('brand.pagesAgain') : t('brand.pages')}
                </Button>
              </div>
              {pages && pages.length === 0 ? <span className="st-small st-muted">{t('brand.pagesNone')}</span> : null}
              {pages?.slice(0, 20).map((p) => (
                <div key={p.url} className="u-row u-gap-2 brand-page">
                  <a className="real-link st-small" href={p.url} target="_blank" rel="noreferrer" data-content>
                    {new URL(p.url).pathname}
                  </a>
                  {p.used ? (
                    <span className="xs st-muted">{t('brand.pageUsed')}</span>
                  ) : (
                    <Button dense busy={busy === p.url} disabled={!!busy} reason={t('common.busy')} onClick={() => void makeFrom(p.url)}>
                      {t('brand.makeFromPage')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {lexOpen ? <LexiconDrawer onClose={() => setLexOpen(false)} /> : null}
    </section>
  );
}
