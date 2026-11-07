// Card: surface, hairline, 12 px radius, no shadow. Title, at most one meta line, body, footer.
import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Heading level for the title (default 3). */
  level?: 2 | 3 | 4;
  as?: 'section' | 'article' | 'div';
  'aria-label'?: string;
}

export function Card({ title, meta, footer, children, className, level = 3, as: Tag = 'div', ...rest }: CardProps) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <Tag className={['card', className ?? ''].filter(Boolean).join(' ')} aria-label={rest['aria-label']}>
      {title ? <H className="card-title">{title}</H> : null}
      {meta ? <p className="card-meta">{meta}</p> : null}
      {children ? <div className="card-body">{children}</div> : null}
      {footer ? <div className="card-footer">{footer}</div> : null}
    </Tag>
  );
}
