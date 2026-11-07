'use client';
// Button hierarchy: primary (one per screen, drawer or dialog), secondary, tertiary, destructive,
// and a square icon button. Disabled buttons always carry a visible reason.
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonLevel = 'primary' | 'secondary' | 'tertiary' | 'destructive' | 'danger';

interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'disabled'> {
  /** `danger` is the filled confirm inside a destructive Dialog; everywhere else use `destructive`. */
  level?: ButtonLevel;
  /** 36 px for rows and dense step cards; 44 px otherwise. */
  dense?: boolean;
  busy?: boolean;
  icon?: ReactNode;
}

/**
 * "A disabled button with no visible reason is not allowed." Enforced by the type: a button that can be
 * disabled (`disabled` is `true` or any boolean) must carry a non-empty `reason`, shown as a one-line hint under
 * the button and as its title. Only a button that is never disabled may leave `reason` out.
 */
export type ButtonProps = ButtonBaseProps & ({ disabled?: false; reason?: string } | { disabled: boolean; reason: string });

export function buttonClass(level: ButtonLevel = 'secondary', dense = false, extra?: string): string {
  return ['btn', `btn-${level}`, dense ? 'btn-dense' : '', extra ?? ''].filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { level = 'secondary', dense = false, busy = false, icon, reason, disabled, className, children, type = 'button', title, ...rest },
  ref,
) {
  const id = useId();
  if (process.env.NODE_ENV !== 'production' && disabled && !reason?.trim()) {
    console.warn('Button: a disabled button needs a visible reason.');
  }
  const hint = disabled && reason ? reason : undefined;
  const hintId = hint ? `${id}-reason` : undefined;
  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClass(level, dense, className)}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-describedby={hintId ?? rest['aria-describedby']}
      title={hint ?? title}
    >
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : icon ? <span className="btn-icon-slot" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
  if (!hint) return button;
  return (
    <span className="btn-with-reason">
      {button}
      <span className="btn-reason" id={hintId}>
        {hint}
      </span>
    </span>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'children'> {
  /** Required: the button has no visible text. */
  'aria-label': string;
  icon: ReactNode;
  /** 44 px toolbar size; the default is 36 px for rows. */
  large?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, large = false, className, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={['btn', 'btn-icon', large ? 'btn-icon-lg' : '', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      <span aria-hidden="true">{icon}</span>
    </button>
  );
});
