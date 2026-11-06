'use client';
// Upload-Post profile picker, shared by the New project wizard (Posting step) and the Connections
// screen (Connect / Change profile). Lists the profiles on your plan with their Instagram, creates a
// new profile, and opens Upload-Post's own connect page for Instagram. Everything goes through
// /api/studio/upload-post; the API key never reaches the browser.
import { useCallback, useEffect, useState } from 'react';
import { More } from './More';
import { zonedParts, formatDateLabel } from '@/lib/time';

export interface UpProfile { username: string; displayName: string | null; instagram: { handle: string | null; name: string | null; reauth: boolean } | null }
export interface UpState { allowed: boolean; reason: string; plan?: string | null; limit?: number | null; profiles: UpProfile[] }

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

/** Loads your Upload-Post profiles (or why they can't be listed). */
export function useUpProfiles() {
  const [state, setState] = useState<UpState | null>(null);
  const load = useCallback(async () => {
    const r = await fetch('/api/studio/upload-post', { cache: 'no-store' });
    const j = (await r.json().catch(() => null)) as UpState & { error?: { message: string } };
    if (!r.ok || !j) {
      setState({ allowed: false, reason: j?.error?.message ?? 'Could not reach Upload-Post.', profiles: [] });
      return;
    }
    setState(j);
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);
  return { state, reload: load };
}

/** Upload-Post's monthly upload count for the whole plan (GET /api/studio/connections → uploadPost.quota, when the server knows it). */
export interface UpQuota { used: number; limit: number; resetsAt: string | null }
export function parseQuota(v: unknown): UpQuota | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as { used?: unknown; limit?: unknown; resetsAt?: unknown };
  if (typeof q.used !== 'number' || typeof q.limit !== 'number' || !Number.isFinite(q.used) || !Number.isFinite(q.limit) || q.limit <= 0) return null;
  const resets = typeof q.resetsAt === 'string' && Number.isFinite(Date.parse(q.resetsAt)) ? q.resetsAt : null;
  return { used: Math.max(0, Math.round(q.used)), limit: Math.round(q.limit), resetsAt: resets };
}
/** "3 of 10 Upload-Post uploads used this month · resets Tue 1 Dec" */
export function quotaText(q: UpQuota): string {
  return `${q.used} of ${q.limit} Upload-Post uploads used this month${q.resetsAt ? ` · resets ${formatDateLabel(zonedParts(q.resetsAt).date)}` : ''}`;
}

/**
 * Back from Upload-Post's connect page (/studio?connected=<profile>): reads the profile list again
 * (the same read-only call as "Check again") and says whether its Instagram is connected now.
 */
export async function connectedMessage(profile: string): Promise<string> {
  const name = profile.slice(0, 60);
  try {
    const r = await fetch('/api/studio/upload-post', { cache: 'no-store' });
    const j = (await r.json().catch(() => null)) as (UpState & { error?: { message: string } }) | null;
    if (!r.ok || !j) return `Back from Upload-Post, but Signal could not check “${name}”: ${j?.error?.message ?? `request failed (${r.status})`}.`;
    if (!j.allowed) return `Back from Upload-Post, but Signal could not check “${name}”: ${j.reason}`;
    const p = j.profiles.find((x) => x.username === name);
    if (!p) return `Back from Upload-Post, but “${name}” is not on your Upload-Post plan.`;
    if (p.instagram?.handle) return `Upload-Post “${name}” is connected to Instagram ${p.instagram.handle}${p.instagram.reauth ? ', but it needs reconnecting' : ''}.`;
    return `Upload-Post “${name}” has no Instagram connected yet. Open Upload-Post in Connections and press Connect Instagram again.`;
  } catch {
    return `Back from Upload-Post, but Signal could not check “${name}”. Press Check again in Connections.`;
  }
}

export const profileLine = (p: UpProfile) => (p.instagram?.handle ? `Instagram ${p.instagram.handle}${p.instagram.reauth ? ' · needs reconnecting' : ''}` : 'no Instagram yet');

/** Where to add the key when it is missing. */
export function KeyHowTo() {
  return (
    <More label="How?">
      <span>Add it in Connections → Upload-Post. The key is in Upload-Post → Settings → API keys. It stays on this machine, encrypted.</span>
    </More>
  );
}

export function UploadPostPicker({
  state,
  reload,
  value,
  onChange,
  slug,
  displayName,
  allowTyping = false,
  error,
}: {
  state: UpState;
  reload: () => Promise<void>;
  /** The chosen profile username ('' for none). */
  value: string;
  onChange: (username: string) => void;
  /** Suggested username for a new profile. */
  slug: string;
  /** Display name for a new profile. */
  displayName: string;
  /** When the list is unavailable, let the owner type a username (the wizard does; Connections does not). */
  allowTyping?: boolean;
  error?: string;
}) {
  const [newName, setNewName] = useState(slug.replace(/[^A-Za-z0-9_@-]/g, '-').slice(0, 40));
  const [work, setWork] = useState(false);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const chosen = state.profiles.find((p) => p.username === value) ?? null;

  const act = async (body: Record<string, unknown>) => {
    setWork(true);
    setNote('');
    try {
      return await post<{ profile?: UpProfile; url?: string; hosted?: boolean; note?: string }>('/api/studio/upload-post', body);
    } catch (e) {
      setNote((e as Error).message);
      return null;
    } finally {
      setWork(false);
    }
  };

  if (!state.allowed)
    return (
      <div className="st-stack" style={{ gap: 10 }}>
        <span className="st-small st-muted">{state.reason}</span>
        {/Upload-Post API key/.test(state.reason) ? <KeyHowTo /> : null}
        {allowTyping ? (
          <>
            <label className="wiz-field">
              Upload-Post profile username
              <input className="st-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. default" />
              {error ? <span className="real-error st-small">{error}</span> : null}
            </label>
            <More label="Where is it?">
              <ol className="real-steps" style={{ margin: 0 }}>
                <li>Upload-Post → Manage Users: create or pick a profile.</li>
                <li>Connect the Instagram account there.</li>
                <li>Paste its username (not the display name) above.</li>
              </ol>
            </More>
          </>
        ) : null}
      </div>
    );

  const free = state.limit != null ? Math.max(0, state.limit - state.profiles.length) : null;
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <span className="xs st-muted">
        {state.plan ? `${state.plan} plan · ` : ''}
        {state.profiles.length}
        {state.limit != null ? ` of ${state.limit}` : ''} profiles
      </span>
      {state.profiles.length ? (
        <div className="st-stack" role="radiogroup" aria-label="Upload-Post profiles" style={{ gap: 6 }}>
          {state.profiles.map((p) => (
            <label key={p.username} className="real-check">
              <input type="radio" name="upprofile" checked={value === p.username} onChange={() => onChange(p.username)} />
              <span>
                <strong>{p.username}</strong>
                {p.displayName && p.displayName !== p.username ? ` (${p.displayName})` : ''} · {profileLine(p)}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <span className="st-small st-muted">No profiles yet. Create one below.</span>
      )}
      <div className="row-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <input className="st-input" style={{ maxWidth: 220 }} value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New profile username" />
        <button
          type="button"
          className="st-btn st-btn-ghost st-btn-sm"
          disabled={work || !newName || free === 0}
          onClick={async () => {
            const j = await act({ action: 'create', username: newName, displayName: displayName || newName });
            if (j?.profile) {
              await reload();
              onChange(j.profile.username);
            }
          }}
        >
          New profile
        </button>
        {free === 0 ? <span className="xs real-error">No free slot on your plan.</span> : null}
      </div>
      {value ? (
        <div className="st-card st-stack" style={{ padding: 12, gap: 8 }}>
          <span className={`st-small ${chosen?.instagram?.handle ? 'proj-ok' : ''}`}>
            “{value}” · {chosen ? profileLine(chosen) : 'not on the list'}
          </span>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button
              type="button"
              className="st-btn st-btn-dark st-btn-sm"
              disabled={work}
              onClick={async () => {
                const j = await act({ action: 'connect', username: value });
                if (j?.url) {
                  setLink(j.url);
                  setNote(j.note ?? '');
                  window.open(j.url, '_blank', 'noopener');
                }
              }}
            >
              {chosen?.instagram?.handle ? 'Reconnect Instagram' : 'Connect Instagram'}
            </button>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={work} onClick={() => void reload()}>
              Check again
            </button>
          </div>
          {link ? (
            <a className="real-link st-small" href={link} target="_blank" rel="noreferrer">
              Open the connect page again
            </a>
          ) : null}
        </div>
      ) : null}
      {note ? <span className="st-small st-muted">{note}</span> : null}
      {error ? <span className="real-error st-small">{error}</span> : null}
    </div>
  );
}
