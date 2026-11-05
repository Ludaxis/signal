'use client';
// Instagram: connection status for the project and comments on the latest posts,
// with reply, hide and delete. Everything here runs only when the owner opens it or presses a button.
import { useCallback, useEffect, useState } from 'react';
import { useOnChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { formatDateTime } from '@/lib/time';
import { ScreenSkeleton } from './loaders';

interface Gate { enabled: boolean; reason: string }
interface ConnInfo { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
interface Setup { api: Gate; unifiedLogin: Gate; connection: ConnInfo | null; mode: 'unified' | 'instagram-login' | null; scheduler: Gate; mediaHost: Gate; paused: { paused: boolean; reason: string }; comments: Gate; insights: Gate; publish: Gate; tokenEnv: string }
interface Account { userId: string; username: string; accountType: string | null; followers: number | null; mediaCount: number | null }
interface Comment { id: string; text: string; username: string; timestamp: string | null; hidden: boolean; likes: number | null; replies: Comment[] }
interface Post { id: string; permalink: string | null; timestamp: string | null; caption: string; mediaType: string | null; likes: number | null; comments: number | null; thumb: string | null; commentList: Comment[] }
interface Payload { setup: Setup; account: Account | null; handleOk?: boolean; posts?: Post[]; quota?: { used: number; total: number } | null }

async function post(body: unknown): Promise<void> {
  const r = await fetch('/api/studio/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  }
}

export function Comments({ say, onManage }: { say: (t: string) => void; onManage?: () => void }) {
  const pid = useProjectId();
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!pid) return;
    const r = await fetch(`/api/studio/instagram?project=${encodeURIComponent(pid)}&view=comments`, { cache: 'no-store' });
    const j = (await r.json().catch(() => ({}))) as Payload & { error?: { message?: string } };
    if (!r.ok) {
      setErr(j.error?.message ?? 'Could not reach Instagram.');
      return;
    }
    setErr('');
    setData(j);
  }, [pid]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['connections'], load);

  const act = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await post({ project: getProjectId(), ...body });
      say(done);
      await load();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const row = (c: Comment, depth: number) => (
    <div key={c.id} className={`ig-comment ${c.hidden ? 'hidden' : ''}`} style={{ marginLeft: depth * 22 }}>
      <div className="row-wrap" style={{ gap: 8, alignItems: 'baseline' }}>
        <b>@{c.username || 'someone'}</b>
        <span className="xs st-muted">
          {c.timestamp ? formatDateTime(c.timestamp) : ''}
          {c.hidden ? ' · hidden' : ''}
        </span>
      </div>
      <p className="st-small" style={{ margin: '2px 0 6px', whiteSpace: 'pre-wrap' }}>
        {c.text}
      </p>
      {depth === 0 ? (
        <div className="row-wrap" style={{ gap: 6, alignItems: 'center' }}>
          <input
            className="st-input ig-reply"
            value={drafts[c.id] ?? ''}
            onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
            placeholder="Reply…"
            aria-label={`Reply to @${c.username}`}
            maxLength={2200}
          />
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            aria-busy={busy === c.id}
            disabled={!!busy || !(drafts[c.id] ?? '').trim()}
            onClick={() => {
              if (window.confirm(`Post this reply publicly as ${data?.account ? `@${data.account.username}` : 'the account'}?`))
                void act(c.id, { action: 'reply', commentId: c.id, text: drafts[c.id] }, 'Reply posted').then(() => setDrafts((d) => ({ ...d, [c.id]: '' })));
            }}
          >
            {busy === c.id ? 'Sending' : 'Reply'}
          </button>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === `h${c.id}`} disabled={!!busy} onClick={() => void act(`h${c.id}`, { action: 'hide', commentId: c.id, hide: !c.hidden }, c.hidden ? 'Comment shown' : 'Comment hidden')}>
            {c.hidden ? 'Show' : 'Hide'}
          </button>
          <button
            type="button"
            className="st-btn st-btn-ghost st-btn-sm"
            aria-busy={busy === `d${c.id}`}
            disabled={!!busy}
            onClick={() => {
              if (window.confirm(`Delete this comment by @${c.username} for good? This can't be undone.`)) void act(`d${c.id}`, { action: 'delete', commentId: c.id }, 'Comment deleted');
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
      {c.replies.map((r) => row(r, depth + 1))}
    </div>
  );

  if (err) return <section className="screen"><p className="real-error st-small" role="alert">{err}</p></section>;
  if (!data) return <ScreenSkeleton variant="list" count={4} label="Loading comments" />;
  const { setup, account } = data;
  return (
    <section className="screen st-stack" style={{ gap: 18 }} aria-label="Comments">
      <div className="st-card row-wrap" style={{ padding: 14, gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="st-small">
          {account ? (
            <>
              <b>@{account.username}</b>
              {account.followers != null ? ` · ${account.followers.toLocaleString()} followers` : ''}
              {setup.connection ? ' · Meta' : setup.mode === 'instagram-login' ? ' · legacy token' : ''}
            </>
          ) : (
            <span className="st-muted">{setup.api.reason || 'Instagram is not connected.'}</span>
          )}
        </span>
        {onManage ? (
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={onManage}>
            Connections
          </button>
        ) : null}
      </div>
      {account && data.handleOk === false ? <p className="real-error st-small">Connected to @{account.username}, not this project&apos;s account. Posting is blocked.</p> : null}
      {account && !setup.comments.enabled ? <span className="st-small st-muted">{setup.comments.reason}</span> : null}
      {account && setup.comments.enabled ? (
        <div className="st-stack" style={{ gap: 12 }}>
          <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="label">Latest posts</span>
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => void load()}>
              Refresh
            </button>
          </div>
          {(data.posts ?? []).length === 0 ? <span className="st-small st-muted">No posts yet.</span> : null}
          {(data.posts ?? []).map((p) => (
            <div key={p.id} className="st-card st-stack" style={{ padding: 14, gap: 10 }}>
              <div className="row-wrap" style={{ gap: 12, alignItems: 'center' }}>
                <span className="ig-type">{p.mediaType === 'VIDEO' ? 'Reel' : p.mediaType === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Photo'}</span>
                <div className="st-stack" style={{ gap: 2, flex: '1 1 200px', minWidth: 0 }}>
                  <span className="st-small ig-caption">{p.caption.split('\n')[0] || '(no caption)'}</span>
                  <span className="xs st-muted">
                    {p.timestamp ? formatDateTime(p.timestamp) : ''} · {p.likes ?? 0} likes · {p.comments ?? 0} comments
                  </span>
                </div>
                {p.permalink ? (
                  <a className="st-btn st-btn-ghost st-btn-sm" href={p.permalink} target="_blank" rel="noreferrer">
                    Open
                  </a>
                ) : null}
              </div>
              {p.commentList.length ? p.commentList.map((c) => row(c, 0)) : <span className="xs st-muted">No comments.</span>}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
