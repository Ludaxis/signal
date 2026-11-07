'use client';
// Comments: the connection status for the project and comments on the latest posts, with reply, hide and
// delete. Everything here runs only when the owner opens it or presses a button. Comment and reply text
// carry their own `lang` and `dir="auto"`, so Persian comments read right to left.
import { useCallback, useEffect, useState } from 'react';
import { useOnChanged } from './sync';
import { getProjectId, useProjectId } from './Projects';
import { formatIn } from '@/lib/studio/time';
import { ScreenSkeleton } from './loaders';
import { t } from './copy/en';
import { Button, Notice, useConfirm } from './ui';
import { detectLang } from './content-lang';

interface Gate { enabled: boolean; reason: string }
interface ConnInfo { username: string; scopes: string[]; expiresAt: string | null; expired: boolean; daysLeft: number | null; connectedAt: string; features: { publish: boolean; comments: boolean; insights: boolean } }
interface Setup { api: Gate; unifiedLogin: Gate; connection: ConnInfo | null; mode: 'unified' | 'instagram-login' | null; scheduler: Gate; mediaHost: Gate; paused: { paused: boolean; reason: string }; comments: Gate; insights: Gate; publish: Gate; tokenEnv: string }
interface Account { userId: string; username: string; accountType: string | null; followers: number | null; mediaCount: number | null }
export interface Comment { id: string; text: string; username: string; timestamp: string | null; hidden: boolean; likes: number | null; replies: Comment[] }
export interface IgPost { id: string; permalink: string | null; timestamp: string | null; caption: string; mediaType: string | null; likes: number | null; comments: number | null; thumb: string | null; commentList: Comment[] }
export interface CommentsPayload { setup: Setup; account: Account | null; handleOk?: boolean; posts?: IgPost[]; quota?: { used: number; total: number } | null; timeZone?: string }

async function post(body: unknown): Promise<void> {
  const r = await fetch('/api/studio/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  }
}

export function Comments({ say, onManage }: { say: (t: string) => void; onManage?: () => void }) {
  const confirmBox = useConfirm();
  const pid = useProjectId();
  const [data, setData] = useState<CommentsPayload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/instagram?project=${encodeURIComponent(pid)}&view=comments`, { cache: 'no-store' });
      const j = (await r.json().catch(() => ({}))) as CommentsPayload & { error?: { message?: string } };
      if (!r.ok) {
        setErr(j.error?.message ?? `HTTP ${r.status}`);
        return;
      }
      setErr('');
      setData(j);
    } catch (e) {
      setErr((e as Error).message);
    }
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
  const tz = data?.timeZone;
  const handle = (u: string) => `@${u || t('comments.someone')}`;

  const row = (c: Comment, depth: number) => {
    const lang = detectLang(c.text);
    const draft = drafts[c.id] ?? '';
    return (
      <div key={c.id} className={`ig-comment ig-comment-depth-${Math.min(depth, 2)} ${c.hidden ? 'hidden' : ''}`}>
        <div className="u-row u-gap-2">
          <b data-content>{handle(c.username)}</b>
          <span className="xs st-muted" data-content>
            {c.timestamp ? formatIn(tz, c.timestamp) : ''}
          </span>
          {c.hidden ? <span className="xs st-muted">{t('comments.isHidden')}</span> : null}
        </div>
        <p className="st-small ig-comment-text" lang={lang} dir="auto" data-content>
          {c.text}
        </p>
        {depth === 0 ? (
          <div className="ig-comment-actions">
            <input
              className="st-input ig-reply"
              value={draft}
              onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
              placeholder={t('comments.replyPlaceholder')}
              aria-label={t('comments.replyLabel', { who: handle(c.username) })}
              dir="auto"
              lang={detectLang(draft) ?? lang}
              maxLength={2200}
            />
            <Button
              dense
              busy={busy === c.id}
              disabled={!!busy}
              reason={t('common.busy')}
              onClick={() => {
                if (!draft.trim()) return;
                void confirmBox.confirm({ title: t('comments.replyTitle', { who: data?.account ? `@${data.account.username}` : t('comments.theAccount') }), body: t('comments.replyBody'), confirmLabel: t('comments.replyConfirm') }).then((ok) => {
                  if (ok) void act(c.id, { action: 'reply', commentId: c.id, text: draft }, t('comments.replied')).then(() => setDrafts((d) => ({ ...d, [c.id]: '' })));
                });
              }}
            >
              {t('comments.reply')}
            </Button>
            <Button dense level="tertiary" busy={busy === `h${c.id}`} disabled={!!busy} reason={t('common.busy')} onClick={() => void act(`h${c.id}`, { action: 'hide', commentId: c.id, hide: !c.hidden }, c.hidden ? t('comments.shown') : t('comments.hidden'))}>
              {c.hidden ? t('comments.show') : t('comments.hide')}
            </Button>
            <Button
              dense
              level="destructive"
              busy={busy === `d${c.id}`}
              disabled={!!busy}
              reason={t('common.busy')}
              onClick={() => {
                void confirmBox.confirm({ title: t('comments.deleteTitle', { who: handle(c.username) }), body: t('comments.deleteBody'), confirmLabel: t('comments.deleteConfirm'), destructive: true }).then((ok) => {
                  if (ok) void act(`d${c.id}`, { action: 'delete', commentId: c.id }, t('comments.deleted'));
                });
              }}
            >
              {t('comments.delete')}
            </Button>
          </div>
        ) : null}
        {c.replies.map((r) => row(r, depth + 1))}
      </div>
    );
  };

  if (err && !data) {
    return (
      <section className="screen" aria-label="Comments">
        <Notice kind="error" title={t('comments.couldNotLoad')} details={err} onRetry={() => void load()} />
      </section>
    );
  }
  if (!data) return <ScreenSkeleton variant="list" count={4} label={t('comments.loading')} />;
  const { setup, account } = data;
  const typeOf = (p: IgPost) => (p.mediaType === 'VIDEO' ? t('comments.type.video') : p.mediaType === 'CAROUSEL_ALBUM' ? t('comments.type.carousel') : t('comments.type.photo'));
  return (
    <section className="screen u-stack u-gap-4" aria-label="Comments">
      {confirmBox.node}
      {account ? (
        <div className="u-between u-gap-3">
          <span className="st-small" data-content>
            <b>@{account.username}</b>
            {account.followers != null ? ` · ${account.followers.toLocaleString('en-GB')}` : ''}
          </span>
          <Button dense level="tertiary" disabled={!!busy} reason={t('common.busy')} onClick={() => void load()}>
            {t('common.refresh')}
          </Button>
        </div>
      ) : (
        <Notice kind="off" title={t('comments.notConnected')} action={onManage ? <Button dense onClick={onManage}>{t('notice.openConnections')}</Button> : undefined} />
      )}
      {account && data.handleOk === false ? <Notice kind="paused" title={t('comments.otherAccount')} /> : null}
      {account && !setup.comments.enabled ? <Notice kind="off" title={t('notice.serviceOff', { service: t('connections.check.comments') })} action={onManage ? <Button dense onClick={onManage}>{t('notice.openConnections')}</Button> : undefined} /> : null}
      {account && setup.comments.enabled ? (
        <div className="u-stack u-gap-3">
          <h2 className="label u-m0">{t('comments.latest')}</h2>
          {(data.posts ?? []).length === 0 ? <Notice kind="empty" title={t('comments.noPosts')} /> : null}
          {(data.posts ?? []).map((p) => {
            const firstLine = p.caption.split('\n')[0] ?? '';
            return (
              <article key={p.id} className="card ig-post">
                <div className="u-row u-gap-3">
                  <span className="ig-type">{typeOf(p)}</span>
                  <div className="u-stack u-gap-1 u-fill">
                    <span className="st-small ig-caption" lang={detectLang(firstLine)} dir="auto" data-content>
                      {firstLine || '—'}
                    </span>
                    <span className="xs st-muted" data-content>
                      {p.timestamp ? formatIn(tz, p.timestamp) : ''}
                    </span>
                    <span className="xs st-muted">{t('comments.counts', { likes: p.likes ?? 0, comments: p.comments ?? 0 })}</span>
                  </div>
                  {p.permalink ? (
                    <a className="btn btn-secondary btn-dense" href={p.permalink} target="_blank" rel="noreferrer">
                      {t('common.open')}
                    </a>
                  ) : null}
                </div>
                {p.commentList.length ? p.commentList.map((c) => row(c, 0)) : <span className="xs st-muted">{t('comments.none')}</span>}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
