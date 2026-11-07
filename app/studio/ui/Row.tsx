// Row: leading slot, title, one state line (at most 8 words), a status pill and ONE trailing action.
import type { ReactNode } from 'react';

export interface RowProps {
  leading?: ReactNode;
  title: ReactNode;
  line?: ReactNode;
  status?: ReactNode;
  /** One secondary or tertiary button, or a switch. */
  action?: ReactNode;
  className?: string;
}

export function Row({ leading, title, line, status, action, className }: RowProps) {
  return (
    <div className={['row', line ? 'row-2' : '', className ?? ''].filter(Boolean).join(' ')}>
      {leading ? <span className="row-leading">{leading}</span> : null}
      <span className="row-text">
        <span className="row-title">{title}</span>
        {line ? <span className="row-line">{line}</span> : null}
      </span>
      {status ? <span className="row-status">{status}</span> : null}
      {action ? <span className="row-action">{action}</span> : null}
    </div>
  );
}

/** Two-letter service mark for Connections rows, used where a real logo's terms do not allow it. */
export function ServiceMark({ name }: { name: string }) {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  return (
    <span className="service-mark" aria-hidden="true">
      {letters}
    </span>
  );
}
