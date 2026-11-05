'use client';
// Studio dropdown: replaces the native <select>, whose OS menu ignores the design and covers the field.
// Accessible listbox pattern: button + popover list, arrow keys, Home/End, Enter/Space, Escape,
// type-ahead, click outside to close, opens upward when there is no room below.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface SelectOption<V extends string | number> {
  value: V;
  label: ReactNode;
  text?: string; // plain text for type-ahead when label is not a string
  hint?: ReactNode;
  disabled?: boolean;
}

export function Select<V extends string | number>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  placeholder = 'Choose…',
  className = '',
}: {
  value: V | null;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  label: string; // accessible name
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const auto = useId();
  const baseId = id ?? `sel-${auto}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const textOf = (o: SelectOption<V>) => (o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))).toLowerCase();
  const enabledFrom = useCallback(
    (start: number, step: 1 | -1) => {
      for (let i = 0, j = start; i < options.length; i++, j = (j + step + options.length) % options.length) if (!options[j]?.disabled) return j;
      return start;
    },
    [options],
  );

  const show = () => {
    if (disabled) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) setUp(window.innerHeight - r.bottom < Math.min(300, options.length * 44 + 16) && r.top > window.innerHeight - r.bottom);
    setActive(selectedIndex >= 0 ? selectedIndex : enabledFrom(0, 1));
    setOpen(true);
  };
  const hide = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    hide();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) hide(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      hide(e.key === 'Escape');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => enabledFrom((a + 1) % options.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => enabledFrom((a - 1 + options.length) % options.length, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabledFrom(0, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabledFrom(options.length - 1, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = options.findIndex((o) => !o.disabled && textOf(o).startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className={`st-select ${open ? 'open' : ''} ${className}`} ref={wrap}>
      <button
        ref={btn}
        id={baseId}
        type="button"
        className="st-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${baseId}-list`}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKey}
      >
        <span className="st-select-value">{selected ? selected.label : <span className="st-muted">{placeholder}</span>}</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <ul
          ref={list}
          id={`${baseId}-list`}
          className={`st-select-list ${up ? 'up' : ''}`}
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${baseId}-opt-${active}`}
          tabIndex={-1}
        >
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              id={`${baseId}-opt-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`st-select-opt ${i === active ? 'active' : ''}`}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              // Keyboard is handled on the button (focus never leaves it); this keeps the option reachable by key events too.
              onKeyDown={onKey}
            >
              <span className="st-select-check" aria-hidden="true">
                {o.value === value ? '✓' : ''}
              </span>
              <span className="st-stack" style={{ gap: 1, minWidth: 0 }}>
                <span className="st-select-label">{o.label}</span>
                {o.hint ? <span className="xs st-muted">{o.hint}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
