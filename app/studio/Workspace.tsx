'use client';
// Workspace pieces used by Connections: project folders (read-only), Figma (your personal access
// token, read-only) and the Claude Code / Codex CLIs. Panels and a data hook; Connections lays them out.
// Tokens and file contents never leave this machine.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { notifyChanged, useOnChanged } from './sync';
import { getProjectId, useFocusTrap, useProjectId, useScrollLock } from './Projects';
import { formatDateTime } from '@/lib/time';
import { More } from './More';
import { desktop, openLink } from './desktop';

interface Folder { id: string; path: string; label: string; addedAt: string }
interface FFile { rel: string; kind: 'image' | 'video' | 'design' | 'doc' | 'font'; size: number; mtime: string }
interface FigFile { key: string; name: string; url: string; addedAt: string }
interface Frame { id: string; name: string; page: string; type: string }
export interface Tool { cli: 'claude' | 'codex'; label: string; found: boolean; path: string | null; version: string | null; source: 'env' | 'saved' | 'path'; signedIn: boolean | null }
export interface WorkspaceData {
  folders: Folder[];
  figma: { ready: boolean; reason: string; connected: boolean; user: string | null; files: FigFile[]; imports: { name: string; size: number; at: string }[] };
  tools: { claude: Tool; codex: Tool };
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}
const act = <T,>(action: string, extra: Record<string, unknown> = {}) => call<T & { message?: string }>('/api/studio/workspace', { project: getProjectId(), action, ...extra });
const fileUrl = (q: Record<string, string>) => `/api/studio/workspace/file?${new URLSearchParams({ project: getProjectId() ?? '', ...q }).toString()}`;
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollLock();
  useFocusTrap(ref, onClose);
  const host = typeof document !== 'undefined' ? document.querySelector('.studio') : null;
  const node = (
    <div className="proj-overlay" role="presentation">
      <div className="proj-panel st-stack" style={{ gap: 14 }} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 className="section-title" style={{ fontSize: 18 }}>{title}</h2>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}

/** Linked folders, Figma and the CLIs for the selected project (GET /api/studio/workspace). */
export function useWorkspace(say: (t: string) => void) {
  const pid = useProjectId();
  const [d, setD] = useState<WorkspaceData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      setD(await call<WorkspaceData>(`/api/studio/workspace?project=${encodeURIComponent(pid)}`));
    } catch {
      /* the Connections screen shows the main error */
    }
  }, [pid]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['connections', 'workspace'], load);
  const run: Run = async (key, fn) => {
    setBusy(key);
    try {
      const m = await fn();
      if (m) say(m);
      notifyChanged('workspace', 'brand');
      await load();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { d, busy, run, load };
}

export type Run = (key: string, fn: () => Promise<string | void>) => Promise<void>;

export function FoldersPanel({ folders, busy, run, onClose }: { folders: Folder[]; busy: string | null; run: Run; onClose: () => void }) {
  const dk = desktop();
  const [typed, setTyped] = useState('');
  const [sel, setSel] = useState<string | null>(folders[0]?.id ?? null);
  const [files, setFiles] = useState<{ files: FFile[]; truncated: boolean; missing: boolean } | null>(null);
  const [kind, setKind] = useState<FFile['kind'] | 'all'>('image');
  const current = folders.find((f) => f.id === sel) ?? null;
  useEffect(() => {
    if (!sel) return;
    let live = true;
    void (async () => {
      setFiles(null);
      try {
        const j = await act<{ files: FFile[]; truncated: boolean; missing: boolean }>('folder-files', { id: sel });
        if (live) setFiles(j);
      } catch {
        if (live) setFiles({ files: [], truncated: false, missing: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [sel]);
  const link = (p: string) =>
    run('folder-link', async () => {
      const j = await act<{ folder: Folder }>('folder-link', { path: p });
      setSel(j.folder.id);
      setTyped('');
      return j.message;
    });
  const shown = useMemo(() => (files?.files ?? []).filter((f) => kind === 'all' || f.kind === kind).slice(0, 120), [files, kind]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of files?.files ?? []) c[f.kind] = (c[f.kind] ?? 0) + 1;
    return c;
  }, [files]);
  return (
    <Panel title="Project folders" onClose={onClose}>
      <span className="st-small st-muted">Signal only reads these folders. It never changes, moves or deletes files in them.</span>
      <div className="row-wrap" style={{ gap: 8 }}>
        {dk ? (
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            aria-busy={busy === 'folder-link'}
            disabled={!!busy}
            onClick={() =>
              void (async () => {
                const p = await dk.pickFolder();
                if (p) await link(p);
              })()
            }
          >
            Choose folder…
          </button>
        ) : (
          <>
            <input className="st-input" style={{ flex: '1 1 260px' }} placeholder="~/Projects/my-game" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" />
            <button type="button" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'folder-link'} disabled={!!busy || !typed.trim()} onClick={() => void link(typed)}>Link</button>
          </>
        )}
      </div>
      {folders.length ? (
        <div className="st-chip-row" aria-label="Linked folders">
          {folders.map((f) => (
            <button key={f.id} type="button" className="st-chip" aria-pressed={f.id === sel} onClick={() => setSel(f.id)}>{f.label}</button>
          ))}
        </div>
      ) : null}
      {current ? (
        <div className="st-stack" style={{ gap: 10 }}>
          <span className="xs st-muted" style={{ overflowWrap: 'anywhere' }}>{current.path}</span>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'folder-brand'} disabled={!!busy} onClick={() => void run('folder-brand', async () => (await act('folder-brand', { id: current.id })).message)}>Import brand from here</button>
            {dk ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => void dk.reveal(current.path)}>Show in Finder</button> : null}
            <button
              type="button"
              className="st-btn st-btn-ghost st-btn-sm"
              disabled={!!busy}
              onClick={() =>
                void run('folder-unlink', async () => {
                  const m = (await act('folder-unlink', { id: current.id })).message;
                  setSel(folders.find((f) => f.id !== current.id)?.id ?? null);
                  return m;
                })
              }
            >
              Unlink
            </button>
          </div>
          {!files ? (
            <span className="st-small st-muted">Reading the folder…</span>
          ) : files.missing ? (
            <span className="st-small real-error">This folder is missing or not readable now.</span>
          ) : (
            <>
              <div className="st-chip-row" aria-label="File types">
                {(['image', 'video', 'design', 'doc', 'font', 'all'] as const).map((k) => (
                  <button key={k} type="button" className="st-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                    {k === 'all' ? `All ${files.files.length}` : `${k[0]!.toUpperCase()}${k.slice(1)}s ${counts[k] ?? 0}`}
                  </button>
                ))}
              </div>
              {kind === 'image' ? (
                <div className="ws-thumbs">
                  {shown.map((f) => (
                    <figure key={f.rel} className="ws-thumb" title={f.rel}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fileUrl({ folder: current.id, rel: f.rel })} alt={f.rel} loading="lazy" />
                      <figcaption className="xs">{f.rel.split('/').pop()}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <ul className="ws-list xs">
                  {shown.map((f) => (
                    <li key={f.rel}>
                      <span style={{ overflowWrap: 'anywhere' }}>{f.rel}</span>
                      <span className="st-muted"> · {size(f.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!shown.length ? <span className="st-small st-muted">Nothing of this type here.</span> : null}
              {files.truncated || shown.length === 120 ? <span className="xs st-muted">Showing the newest files only.</span> : null}
            </>
          )}
        </div>
      ) : (
        <span className="st-small st-muted">Link a folder with the art, screenshots or notes for this project.</span>
      )}
    </Panel>
  );
}

export function FigmaPanel({ figma, busy, run, say, onClose }: { figma: WorkspaceData['figma']; busy: string | null; run: Run; say: (t: string) => void; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<string | null>(figma.files[0]?.key ?? null);
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [loadingFrames, setLoadingFrames] = useState(false);
  useEffect(() => {
    if (!file || !figma.connected) return;
    let live = true;
    void (async () => {
      setFrames(null);
      setPick(new Set());
      setLoadingFrames(true);
      try {
        const j = await act<{ frames: Frame[] }>('figma-frames', { key: file });
        if (live) setFrames(j.frames);
      } catch (e) {
        if (live) {
          setFrames([]);
          say((e as Error).message);
        }
      } finally {
        if (live) setLoadingFrames(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [file, figma.connected, say]);

  if (!figma.connected)
    return (
      <Panel title="Connect Figma" onClose={onClose}>
        <span className="st-small st-muted">Use a personal access token with the <b>file_content:read</b> scope. It is stored encrypted on this machine and never shown again.</span>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => openLink('https://www.figma.com/settings')}>Open Figma settings</button>
        <More label="How?">
          <span>Figma → Settings → Security → Personal access tokens → Generate new token. Set “File content” to read-only, copy the token and paste it here.</span>
        </More>
        <form
          className="row-wrap"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run('figma-connect', async () => {
              const m = (await act('figma-connect', { token })).message;
              setToken('');
              return m;
            });
          }}
        >
          <input className="st-input" style={{ flex: '1 1 260px' }} type="password" autoComplete="off" spellCheck={false} placeholder="figd_…" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Figma personal access token" />
          <button type="submit" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'figma-connect'} disabled={!!busy || token.trim().length < 20}>Connect</button>
        </form>
      </Panel>
    );

  return (
    <Panel title="Figma" onClose={onClose}>
      <div className="row-wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="st-small st-muted">Connected as {figma.user}. Read-only.</span>
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => void run('figma-disconnect', async () => (await act('figma-disconnect')).message)}>Disconnect</button>
      </div>
      <form
        className="row-wrap"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run('figma-link', async () => {
            const j = await act<{ file: FigFile }>('figma-link', { url });
            setUrl('');
            setFile(j.file.key);
            return j.message;
          });
        }}
      >
        <input className="st-input" style={{ flex: '1 1 260px' }} placeholder="https://www.figma.com/design/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Figma file link" />
        <button type="submit" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'figma-link'} disabled={!!busy || !url.trim()}>Link file</button>
      </form>
      {figma.files.length ? (
        <div className="st-chip-row" aria-label="Linked Figma files">
          {figma.files.map((f) => (
            <button key={f.key} type="button" className="st-chip" aria-pressed={f.key === file} onClick={() => setFile(f.key)}>{f.name}</button>
          ))}
        </div>
      ) : (
        <span className="st-small st-muted">Link a Figma file to export its frames.</span>
      )}
      {file ? (
        <div className="st-stack" style={{ gap: 8 }}>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              aria-busy={busy === 'figma-import'}
              disabled={!!busy || !pick.size}
              onClick={() =>
                void run('figma-import', async () => {
                  const m = (await act('figma-import', { key: file, ids: [...pick] })).message;
                  setPick(new Set());
                  return m;
                })
              }
            >
              Export {pick.size || ''} frame{pick.size === 1 ? '' : 's'}
            </button>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => openLink(figma.files.find((f) => f.key === file)?.url ?? 'https://www.figma.com')}>Open in Figma</button>
            <button
              type="button"
              className="st-btn st-btn-ghost st-btn-sm"
              disabled={!!busy}
              onClick={() =>
                void run('figma-unlink', async () => {
                  const m = (await act('figma-unlink', { key: file })).message;
                  setFile(figma.files.find((f) => f.key !== file)?.key ?? null);
                  return m;
                })
              }
            >
              Unlink
            </button>
          </div>
          {loadingFrames ? <span className="st-small st-muted">Reading frames…</span> : null}
          {frames && !frames.length && !loadingFrames ? <span className="st-small st-muted">No frames found on this file&apos;s pages.</span> : null}
          {frames?.length ? (
            <ul className="ws-list xs" aria-label="Frames">
              {frames.map((f) => (
                <li key={f.id}>
                  <label className="row-wrap" style={{ gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={pick.has(f.id)}
                      disabled={!pick.has(f.id) && pick.size >= 12}
                      onChange={(e) => {
                        const n = new Set(pick);
                        if (e.target.checked) n.add(f.id);
                        else n.delete(f.id);
                        setPick(n);
                      }}
                    />
                    <span>{f.name}</span>
                    <span className="st-muted">· {f.page}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {figma.imports.length ? (
        <>
          <span className="label">Exported to this project</span>
          <div className="ws-thumbs">
            {figma.imports.slice(0, 60).map((i) => (
              <figure key={i.name} className="ws-thumb" title={`${i.name} · ${formatDateTime(i.at)}`}>
                <a href={fileUrl({ figma: i.name, full: '1' })} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl({ figma: i.name })} alt={i.name} loading="lazy" />
                </a>
                <figcaption className="xs">{i.name}</figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

/** One CLI: where it was found, its version, and a path you can set if it lives somewhere else. */
export function ToolBlock({ tool: t, busy, run }: { tool: Tool; busy: string | null; run: Run }) {
  const [path, setPath] = useState('');
  return (
    <div className="st-stack" style={{ gap: 8 }}>
      <span className="xs st-muted" style={{ overflowWrap: 'anywhere' }}>
        {t.path ? `${t.path}${t.source === 'env' ? ' (saved outside Signal)' : t.source === 'saved' ? ' (set here)' : ''}` : t.cli === 'claude' ? 'Not found. Install: npm install -g @anthropic-ai/claude-code, then run claude once to sign in.' : 'Not found. Install: npm install -g @openai/codex, then run codex login.'}
      </span>
      <div className="row-wrap" style={{ gap: 8 }}>
        <input className="st-input" style={{ flex: '1 1 220px' }} placeholder={t.cli === 'claude' ? '/opt/homebrew/bin/claude' : '/opt/homebrew/bin/codex'} value={path} onChange={(e) => setPath(e.target.value)} aria-label={`${t.label} path`} disabled={t.source === 'env'} />
        <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === `path-${t.cli}`} disabled={!!busy || t.source === 'env' || !path.trim()} onClick={() => void run(`path-${t.cli}`, async () => (await act('tool-path', { cli: t.cli, path })).message)}>Use this path</button>
        {t.source === 'saved' ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => void run(`path-${t.cli}`, async () => (await act('tool-path', { cli: t.cli, path: '' })).message)}>Reset</button> : null}
      </div>
    </div>
  );
}
