'use client';
// Drawer: a native <dialog> that slides in from the inline-end edge, 480 px standard or 720 px wide.
// Header (title, optional status pill, Close), scrollable body, sticky footer: the single primary inline-end and
// secondary buttons inline-start. Escape closes; unsaved edits ask "Discard changes?" first.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { t } from '../copy/en';
import { IconButton } from './Button';
import { Dialog, closeModal, openModal } from './Dialog';
import { useFocusTrap, useScrollLock } from './focus';

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  status?: ReactNode;
  width?: 'standard' | 'wide';
  /** When true, closing asks "Discard changes?" first. */
  dirty?: boolean;
  onClose: () => void;
  /** Shows a Back button: a drawer never opens a second drawer, it replaces its content. */
  onBack?: () => void;
  /** The drawer's one primary action, placed inline-end in the footer. */
  primary?: ReactNode;
  /** Secondary actions, inline-start in the footer. */
  secondary?: ReactNode;
  children?: ReactNode;
}

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const BackIcon = (
  <svg className="icon-mirror" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export function Drawer(props: DrawerProps) {
  return props.open ? <DrawerPanel {...props} /> : null;
}

function DrawerPanel({ title, status, width = 'standard', dirty = false, onClose, onBack, primary, secondary, children }: DrawerProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setAsking(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const d = ref.current;
    openModal(d);
    return () => closeModal(d);
  }, []);
  useFocusTrap(ref, requestClose);
  useScrollLock();

  return (
    <dialog
      ref={ref}
      className={`ui-drawer ui-drawer-${width}`}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
    >
      <div className="drawer-head">
        {onBack ? <IconButton aria-label={t('drawer.back')} icon={BackIcon} onClick={onBack} /> : null}
        <h2 id={titleId} className="drawer-title">
          {title}
        </h2>
        {status ? <span className="drawer-status">{status}</span> : null}
        <IconButton aria-label={t('drawer.close')} icon={CloseIcon} onClick={requestClose} />
      </div>
      <div className="drawer-body">{children}</div>
      {primary || secondary ? (
        <div className="drawer-foot">
          <span className="drawer-foot-secondary">{secondary}</span>
          <span className="drawer-foot-primary">{primary}</span>
        </div>
      ) : null}
      <Dialog
        open={asking}
        title={t('drawer.discardTitle')}
        body={t('drawer.discardBody')}
        confirmLabel={t('drawer.discardConfirm')}
        destructive
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
      />
    </dialog>
  );
}
