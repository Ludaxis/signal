'use client';
// More: the Studio's one small disclosure. Cards keep one short line; anything longer (why, how,
// details) sits behind this button so the screen stays quiet. Accessible: a real button with
// aria-expanded and aria-controls; the panel stays in the DOM (hidden) so the id always resolves.
import { useId, useState, type ReactNode } from 'react';

export function More({
  label = 'More',
  openLabel,
  defaultOpen = false,
  children,
  className = '',
  tone = 'link',
  onToggle,
}: {
  /** Button text while closed, e.g. "More", "Why?", "How?", "Show strategy". */
  label?: string;
  /** Button text while open (defaults to "Hide" for short labels, or "Hide …" for "Show …"). */
  openLabel?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  /** 'link' is a quiet inline text button; 'button' is a small ghost button. */
  tone?: 'link' | 'button';
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const shown = open ? (openLabel ?? (label.startsWith('Show ') ? `Hide ${label.slice(5)}` : 'Hide')) : label;
  return (
    <div className={`more ${open ? 'is-open' : ''} ${className}`.trim()}>
      <button
        type="button"
        className={tone === 'button' ? 'st-btn st-btn-ghost st-btn-sm' : 'more-btn'}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          const next = !open;
          setOpen(next);
          onToggle?.(next);
        }}
      >
        {shown}
        <span className="more-chev" aria-hidden="true" />
      </button>
      <div id={id} className="more-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
