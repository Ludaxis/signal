'use client';
// Choice chip: filters and options, never status. Selected = ink fill, with aria-pressed.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'aria-pressed'> {
  selected: boolean;
}

export function Chip({ selected, className, type = 'button', ...rest }: ChipProps) {
  return <button type={type} className={['chip', className ?? ''].filter(Boolean).join(' ')} aria-pressed={selected} {...rest} />;
}

export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="chip-row" role="group" aria-label={label}>
      {children}
    </div>
  );
}
