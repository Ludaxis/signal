// Persian content block: lang="fa" dir="rtl", the Persian face, letter-spacing 0 and the Persian
// line heights. Used for content (captions, scripts, comments) inside the English UI.
import type { ReactNode } from 'react';

export type FaVariant = 'xs' | 'sm' | 'md' | 'lg' | 'h3' | 'h2' | 'h1' | 'display';

export interface FaTextProps {
  as?: 'p' | 'span' | 'div' | 'h2' | 'h3' | 'li' | 'blockquote';
  variant?: FaVariant;
  /** The display face (hooks and titles in previews). UI chrome never uses it. */
  display?: boolean;
  className?: string;
  children: ReactNode;
}

export function FaText({ as: Tag = 'p', variant = 'md', display = false, className, children }: FaTextProps) {
  return (
    <Tag lang="fa" dir="rtl" className={[`t-${variant}`, 'fa', display ? 'fa-display' : '', className ?? ''].filter(Boolean).join(' ')}>
      {children}
    </Tag>
  );
}

/** Isolates a Latin run (handle, URL, price, version, timecode) inside running text. */
export function Bdi({ children }: { children: ReactNode }) {
  return <bdi>{children}</bdi>;
}
