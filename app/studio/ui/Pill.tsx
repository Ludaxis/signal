// Status pill: not interactive, and its text is always a word from the status dictionary.
import { STATUS_TONE, type StatusWord } from './status';

export function Pill({ status, className }: { status: StatusWord; className?: string }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={['pill', 'pill-status', `pill-${tone}`, className ?? ''].filter(Boolean).join(' ')} data-status={status}>
      <span className="pill-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

/**
 * Nav count badge: amber fill, ink text, with a spoken label. ARIA 1.2 does not allow aria-label on a
 * plain span, so the label is a visually hidden child and the bare number is hidden from assistive tech: the nav
 * button then reads as "Posts 3 need you".
 */
export function CountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="count-badge">
      <span aria-hidden="true">{count}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
