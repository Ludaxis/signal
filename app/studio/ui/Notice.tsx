'use client';
// The five state patterns: empty, loading, error, success and paused/gated. The gated pattern has
// three kinds that are never mixed: paused (switched off in Signal), off (a service switch or key), and
// not allowed yet (needs an approval that cannot be given inside the app).
import { useId, useState, type ReactNode } from 'react';
import { t } from '../copy/en';
import { Button } from './Button';

export type NoticeKind = 'empty' | 'loading' | 'error' | 'success' | 'paused' | 'off' | 'not-allowed';

export interface NoticeProps {
  kind: NoticeKind;
  /** One line. Empty: "No ‹things› yet."; error: "‹Thing› could not load."; loading: the screen-reader label. */
  title: string;
  /** Empty: one button that makes the thing. Paused / off: at most one secondary button. */
  action?: ReactNode;
  /** Error only: the server message, shown behind "Details", never as the main line. */
  details?: string;
  /** Error only: renders "Try again". */
  onRetry?: () => void;
  /** Not allowed yet only: one more line behind "Why?". */
  why?: string;
  /** Loading only: number of skeleton lines (default 3). */
  lines?: number;
}

const LockIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const PauseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
    <path d="M9 6v12M15 6v12" />
  </svg>
);

function Disclosure({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="notice-disclosure">
      <button type="button" className="btn btn-tertiary btn-dense" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      <span id={id} className="notice-more" hidden={!open}>
        {text}
      </span>
    </span>
  );
}

export function Notice({ kind, title, action, details, onRetry, why, lines = 3 }: NoticeProps) {
  if (kind === 'loading') {
    return (
      <div className="notice notice-loading" role="status" aria-busy="true" aria-label={title}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="notice-skeleton" />
        ))}
      </div>
    );
  }
  if (kind === 'empty') {
    return (
      <div className="notice notice-empty">
        <p className="notice-title">{title}</p>
        {action ? <div className="notice-action">{action}</div> : null}
      </div>
    );
  }
  if (kind === 'error') {
    return (
      <div className="notice notice-error" role="alert">
        <p className="notice-title">{title}</p>
        <div className="notice-action">
          {onRetry ? (
            <Button level="secondary" dense onClick={onRetry}>
              {t('notice.tryAgain')}
            </Button>
          ) : null}
          {details ? <Disclosure label={t('notice.details')} text={details} /> : null}
        </div>
      </div>
    );
  }
  if (kind === 'success') {
    return (
      <div className="notice notice-success" role="status">
        <span className="notice-dot" aria-hidden="true" />
        <p className="notice-title">{title}</p>
      </div>
    );
  }
  // Gated: paused, off, not allowed yet. A neutral notice with a lock or pause icon and one line.
  return (
    <div className={`notice notice-gated notice-${kind}`} role="note">
      <span className="notice-icon">{kind === 'paused' ? PauseIcon : LockIcon}</span>
      <p className="notice-title">{title}</p>
      {kind === 'not-allowed' ? why ? <Disclosure label={t('notice.why')} text={why} /> : null : action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}
