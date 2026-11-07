'use client';
// Versions drawer: v1…vn with time, source (Run, Regenerate, Edited by you), cost and the note's first line.
// "Use this version" makes vN current again by pointer. Media compare in A/B (two players kept in sync); text in a
// word-level diff of the JSON outputs. Versions are never deleted here (data deletion is gated, not in v1).
import { useEffect, useRef, useState } from 'react';
import { formatWhenIn } from '@/lib/studio/time';
import type { ArtifactRef, RecipeViewNode } from '@/lib/studio/postmaker/types';
import { t } from '../copy/en';
import { Button, Drawer } from '../ui';
import { pmApi } from './api';
import { laneTitle, money, textOf, wordDiff, type DiffPart } from './model';

type V = RecipeViewNode['versions'][number];

export interface VersionsDrawerProps {
  pid: string;
  recipeId: string;
  node: RecipeViewNode;
  /** The project's time zone (dates as "Wed 18 Nov, 18:00"). */
  timeZone?: string | null;
  onClose: () => void;
  onUse: (n: number) => void;
  busy: boolean;
}

const media = (v: V | undefined) => v?.outputs.find((o) => o.kind === 'video' || o.kind === 'audio') ?? null;

function Player({ src, kind, label }: { src: string; kind: ArtifactRef['kind']; label: string }) {
  return kind === 'video' ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- generated proof media has no caption track yet; captions are burned in.
    <video className="pm-ab-player" src={src} controls preload="metadata" aria-label={label} />
  ) : (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- generated narration; its text is the narration-text step.
    <audio className="pm-ab-audio" src={src} controls preload="metadata" aria-label={label} />
  );
}

export function VersionsDrawer({ pid, recipeId, node, timeZone = null, onClose, onUse, busy }: VersionsDrawerProps) {
  const list = [...node.versions].sort((a, b) => b.n - a.n);
  const current = node.head.current;
  const [b, setB] = useState<number | null>(current);
  const [a, setA] = useState<number | null>(list.find((v) => v.n !== current)?.n ?? null);
  const [diffState, setDiff] = useState<{ key: string; parts: DiffPart[] | null } | null>(null);
  const va = list.find((v) => v.n === a);
  const vb = list.find((v) => v.n === b);
  const diff = va && vb && diffState?.key === `${va.n}:${vb.n}` ? diffState.parts : null;

  useEffect(() => {
    let alive = true;
    const textOfVersion = async (v: V | undefined) => {
      const refs = v?.outputs.filter((o) => o.kind === 'json' || o.kind === 'text') ?? [];
      const parts = await Promise.all(refs.map((r) => pmApi.json(pid, recipeId, r.sha256).catch(() => null)));
      return textOf(parts);
    };
    if (!va || !vb) return;
    const key = `${va.n}:${vb.n}`;
    void Promise.all([textOfVersion(va), textOfVersion(vb)]).then(([x, y]) => alive && setDiff({ key, parts: x || y ? wordDiff(x, y) : null }));
    return () => {
      alive = false;
    };
  }, [pid, recipeId, va, vb]);

  // A/B: playing, pausing or seeking one player moves the other (two players in sync).
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const els = Array.from(box.current?.querySelectorAll<HTMLMediaElement>('video, audio') ?? []);
    if (els.length !== 2) return;
    const offs = els.map((el, i) => {
      const o = els[1 - i]!;
      const play = () => void (o.paused ? o.play().catch(() => undefined) : undefined);
      const pause = () => (o.paused ? undefined : o.pause());
      const seeked = () => {
        if (Math.abs(o.currentTime - el.currentTime) > 0.05) o.currentTime = el.currentTime;
      };
      el.addEventListener('play', play);
      el.addEventListener('pause', pause);
      el.addEventListener('seeked', seeked);
      return () => {
        el.removeEventListener('play', play);
        el.removeEventListener('pause', pause);
        el.removeEventListener('seeked', seeked);
      };
    });
    return () => offs.forEach((f) => f());
  });
  const ma = media(va);
  const mb = media(vb);
  const sourceWord = (s: V['source']) => t(`pm.ver.source.${s}`);

  return (
    <Drawer open width="wide" title={t('pm.ver.title', { step: laneTitle(node) })} onClose={onClose}>
      <div className="pm-ver-body">
        <ul className="pm-ver-list">
          {list.map((v) => (
            <li key={v.n} className="pm-ver-row">
              <span className="pm-ver-n" data-content>
                v{v.n}
              </span>
              <span className="pm-ver-meta xs">
                <span>{sourceWord(v.source)}</span>
                <span data-content>
                  {' '}
                  · {formatWhenIn(timeZone, v.at)} · {money(v.usd ?? 0)}
                  {v.mode === 'mock' ? ' · mock' : ''}
                  {v.note ? ` · ${v.note.split('\n')[0]!.slice(0, 80)}` : ''}
                </span>
              </span>
              <span className="pm-ver-actions">
                <label className="pm-ab-pick">
                  <input type="radio" name="pm-ver-a" checked={a === v.n} onChange={() => setA(v.n)} aria-label={`${t('pm.ver.a')} v${v.n}`} />
                  {t('pm.ver.a')}
                </label>
                <label className="pm-ab-pick">
                  <input type="radio" name="pm-ver-b" checked={b === v.n} onChange={() => setB(v.n)} aria-label={`${t('pm.ver.b')} v${v.n}`} />
                  {t('pm.ver.b')}
                </label>
                {v.n === current ? (
                  <span className="xs pm-muted">{t('pm.ver.current')}</span>
                ) : (
                  <Button dense level="secondary" busy={busy} onClick={() => onUse(v.n)}>
                    {t('pm.ver.use')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {ma && mb ? (
          <div className="pm-ab" ref={box}>
            <Player src={pmApi.mediaUrl(pid, recipeId, ma.sha256)} kind={ma.kind} label={`${t('pm.ver.a')} v${a}`} />
            <Player src={pmApi.mediaUrl(pid, recipeId, mb.sha256)} kind={mb.kind} label={`${t('pm.ver.b')} v${b}`} />
          </div>
        ) : null}
        {diff ? (
          <section className="pm-diff" aria-label={t('pm.ver.diff')}>
            <h3 className="pm-h">{t('pm.ver.diff')}</h3>
            <p className="pm-diff-text" dir="auto" data-content>
              {diff.map((d, i) =>
                d.op === 'same' ? <span key={i}>{d.text} </span> : d.op === 'add' ? <ins key={i}>{d.text} </ins> : <del key={i}>{d.text} </del>,
              )}
            </p>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}
