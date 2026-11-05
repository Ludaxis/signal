'use client';
// Brand: import a website and/or a project folder into the project's brand kit, review and edit it,
import { notifyChanged } from './sync';
// and make posts from pages found on the website.
import { useCallback, useEffect, useState } from 'react';
import { getProjectId, useProjectId } from './Projects';
import { ScreenSkeleton, TaskProgress } from './loaders';
import { More } from './More';

interface Kit {
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
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

export function Brand({ say, onMade }: { say: (t: string) => void; onMade: () => void }) {
  const pid = useProjectId();
  const [kit, setKit] = useState<Kit | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [website, setWebsite] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<{ name: string; tagline: string; voice: string; colors: Kit['colors'] } | null>(null);
  const [pages, setPages] = useState<{ url: string; used: boolean }[] | null>(null);
  const [stamp, setStamp] = useState(0);

  const load = useCallback(async () => {
    if (!pid) return;
    const j = await call<{ kit: Kit | null }>(`/api/studio/brand?project=${encodeURIComponent(pid)}`).catch(() => ({ kit: null }));
    setKit(j.kit);
    setLoaded(true);
    setStamp(Date.now());
    setEdit(j.kit ? { name: j.kit.name, tagline: j.kit.tagline, voice: j.kit.voice.join(', '), colors: j.kit.colors } : null);
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
  const importWebsite = () =>
    run('website', async () => {
      await call('/api/studio/brand', { project: getProjectId(), action: 'import-website', url: website });
      await load();
      notifyChanged('brand', 'connections');
      say('Website imported');
    });
  const importFolder = () =>
    run('folder', async () => {
      await call('/api/studio/brand', { project: getProjectId(), action: 'import-folder', dir: folder });
      await load();
      notifyChanged('brand', 'connections');
      say('Folder imported');
    });
  const save = () =>
    run('save', async () => {
      if (!edit) return;
      await call('/api/studio/brand', {
        project: getProjectId(),
        action: 'update',
        patch: { name: edit.name, tagline: edit.tagline, voice: edit.voice.split(',').map((v) => v.trim()).filter(Boolean), colors: edit.colors },
      });
      await load();
      notifyChanged('brand', 'connections');
      say('Brand saved');
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
      say(`Post ${j.package.id} is ready for your approval`);
      onMade();
    });

  const img = (name: string) => `/api/studio/brand/file/${name}?project=${encodeURIComponent(pid ?? '')}&v=${stamp}`;

  return (
    <section className="screen st-stack" style={{ gap: 18 }} aria-label="Brand">
      <div className="st-card st-stack" style={{ padding: 18, gap: 12 }}>
        <span className="label">Bring your brand</span>
        <div className="brand-import">
          <label className="wiz-field">
            Website
            <input className="st-input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" />
          </label>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'website'} disabled={!!busy || !website.trim()} onClick={() => void importWebsite()}>
            {busy === 'website' ? 'Reading the website' : 'Import website'}
          </button>
        </div>
        <div className="brand-import">
          <label className="wiz-field">
            Folder on this machine <span className="st-muted" style={{ fontWeight: 400 }}>(optional)</span>
            <input className="st-input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/projects/my-website" />
          </label>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'folder'} disabled={!!busy || !folder.trim()} onClick={() => void importFolder()}>
            {busy === 'folder' ? 'Reading the folder' : 'Import folder'}
          </button>
        </div>
        <More label="What is read?">
          <span>Public pages of the website; from a folder, fonts, logo and colour tokens. Nothing is posted. You can edit everything below.</span>
        </More>
      </div>

      {err ? (
        <p className="real-error st-small" role="alert">
          {err}
        </p>
      ) : null}

      {busy === 'website' || busy === 'folder' ? <TaskProgress active title={busy === 'website' ? 'Reading the website' : 'Reading the folder'} steps={busy === 'website' ? ['Fetching the page', 'Reading styles and colours', 'Saving logo and images', 'Building the brand kit'] : ['Scanning files', 'Reading colour tokens', 'Copying fonts and logo', 'Building the brand kit']} expectedSeconds={busy === 'website' ? 12 : 6} /> : null}
      {!loaded ? <ScreenSkeleton variant="form" count={2} label="Loading the brand" /> : null}
      {loaded && !kit ? <span className="st-small st-muted">No brand kit yet.</span> : null}

      {kit && edit ? (
        <>
          <div className="grid2">
            <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
              <span className="label">Identity</span>
              <div className="row-wrap" style={{ gap: 14, alignItems: 'center' }}>
                {kit.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="brand-logo" src={img('logo.png')} alt="Logo" />
                ) : (
                  <span className="brand-logo empty">No logo</span>
                )}
                <div className="st-stack" style={{ gap: 6, flex: '1 1 200px' }}>
                  <input className="st-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Brand name" />
                  <span className="xs st-muted">
                    {kit.website ?? 'no website'}
                    {kit.instagram ? ` · ${kit.instagram}` : ''}
                  </span>
                </div>
              </div>
              <label className="wiz-field">
                Tagline
                <textarea className="st-input gen-text" rows={2} value={edit.tagline} onChange={(e) => setEdit({ ...edit, tagline: e.target.value })} />
              </label>
            </div>
            <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
              <span className="label">Colours</span>
              <div className="brand-colors">
                {(['primary', 'accent', 'background', 'text'] as const).map((k) => (
                  <label key={k} className="brand-color">
                    <input type="color" value={edit.colors[k]} onChange={(e) => setEdit({ ...edit, colors: { ...edit.colors, [k]: e.target.value } })} aria-label={`${k} colour`} />
                    <span className="st-stack" style={{ gap: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, textTransform: 'capitalize' }}>{k}</span>
                      <span className="xs st-muted">{edit.colors[k]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {kit.palette.length ? (
                <div className="brand-palette" aria-label="Colours found">
                  {kit.palette.map((c) => (
                    <button key={c} type="button" title={`Use ${c} as primary`} style={{ background: c }} onClick={() => setEdit({ ...edit, colors: { ...edit.colors, primary: c } })}>
                      <span className="st-vh">Use {c} as primary</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="brand-preview" style={{ background: `linear-gradient(170deg, ${edit.colors.primary}, ${edit.colors.accent})` }}>
                <span style={{ fontWeight: 600 }}>{edit.name}</span>
                <span className="xs">{edit.tagline.slice(0, 80)}</span>
              </div>
            </div>
          </div>

          <div className="grid2">
            <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
              <span className="label">Typography</span>
              <span className="st-small">{kit.fonts.length ? kit.fonts.join(' · ') : 'No fonts found'}</span>
              <span className="xs st-muted">
                {kit.fontFile ? `Templates use ${kit.fontFile}.` : 'Templates use Instrument Sans; import a folder with your fonts to change it.'}
              </span>
            </div>
            <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
              <span className="label">Voice</span>
              <input className="st-input" value={edit.voice} onChange={(e) => setEdit({ ...edit, voice: e.target.value })} aria-label="Voice words, comma separated" placeholder="calm, clear, no emojis" />
              {kit.copy.length ? <span className="xs st-muted">From the site: “{kit.copy.slice(0, 3).join('” · “')}”</span> : null}
            </div>
          </div>

          <div className="row-wrap" style={{ gap: 10, alignItems: 'center' }}>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'save'} disabled={!!busy} onClick={() => void save()}>
              {busy === 'save' ? 'Saving' : 'Save brand'}
            </button>
            <span className="xs st-muted">
              Updated {new Date(kit.updatedAt).toLocaleString()}
            </span>
            <More label="Sources">
              <span>{kit.sources.map((s) => `${s.type} ${s.value}`).join(' · ') || 'none'}</span>
            </More>
          </div>

          {kit.website ? (
            <div className="st-card st-stack" style={{ padding: 18, gap: 10 }}>
              <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span className="label">Pages on {new URL(kit.website).hostname}</span>
                <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'pages'} disabled={!!busy} onClick={() => void findPages()}>
                  {busy === 'pages' ? 'Looking' : pages ? 'Look again' : 'Find pages to post'}
                </button>
              </div>
              {pages && pages.length === 0 ? <span className="st-small st-muted">No sitemap or feed found.</span> : null}
              {pages?.slice(0, 20).map((p) => (
                <div key={p.url} className="row-wrap brand-page" style={{ gap: 8, alignItems: 'center' }}>
                  <a className="real-link st-small" href={p.url} target="_blank" rel="noreferrer">
                    {new URL(p.url).pathname}
                  </a>
                  {p.used ? (
                    <span className="xs st-muted">has a post</span>
                  ) : (
                    <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === p.url} disabled={!!busy} onClick={() => void makeFrom(p.url)}>
                      {busy === p.url ? 'Making' : 'Make a post'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
