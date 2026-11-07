'use client';
// Dialog: a native <dialog> opened with showModal(). Title is a question naming the object, at most
// one line of consequence, Cancel plus a confirm that repeats the verb. It replaces every native browser confirm box.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { t } from '../copy/en';
import { Button } from './Button';
import { useFocusTrap } from './focus';

/** Opens a <dialog> as a modal where the browser supports it; otherwise (tests, old engines) just marks it open. */
export function openModal(d: HTMLDialogElement | null): void {
  if (!d || d.open) return;
  if (typeof d.showModal === 'function') {
    try {
      d.showModal();
      return;
    } catch {
      /* not connected yet, or already open */
    }
  }
  d.setAttribute('open', '');
}

export function closeModal(d: HTMLDialogElement | null): void {
  if (!d) return;
  if (typeof d.close === 'function' && d.open) d.close();
  else d.removeAttribute('open');
}

export interface DialogProps {
  open: boolean;
  /** A question that names the object: "Reject post 12?". */
  title: string;
  /** At most one line of consequence: "It will not be posted." */
  body?: ReactNode;
  /** Repeats the verb: "Reject post". Never "OK" or "Yes". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Focus starts on Cancel and the confirm is filled red. */
  destructive?: boolean;
  busy?: boolean;
  /** Set while the form cannot be confirmed: the one-line reason shown under the confirm. */
  confirmDisabled?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** `alertdialog` for confirms that interrupt a flow (the default), `dialog` for forms. */
  role?: 'alertdialog' | 'dialog';
  /** A form dialog whose confirm starts disabled: focus starts in this field instead. */
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

export function Dialog(props: DialogProps) {
  return props.open ? <DialogPanel {...props} /> : null;
}

function DialogPanel({ title, body, confirmLabel, cancelLabel, destructive = false, busy = false, confirmDisabled = null, onConfirm, onCancel, role = 'alertdialog', initialFocus, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const cancelBtn = useRef<HTMLButtonElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  // Escape reaches us twice in a browser (the key and the native cancel event): answer once.
  const answered = useRef(false);
  const cancel = useCallback(() => {
    if (answered.current) return;
    answered.current = true;
    onCancel();
  }, [onCancel]);
  const confirm = useCallback(() => {
    if (answered.current || busy || confirmDisabled) return;
    answered.current = true;
    onConfirm();
  }, [onConfirm, busy, confirmDisabled]);

  useEffect(() => {
    const d = ref.current;
    openModal(d);
    return () => closeModal(d);
  }, []);
  useFocusTrap(ref, cancel);
  // Read once, on open: later renders must not pull focus back.
  const firstFocus = useRef(initialFocus);
  useEffect(() => {
    ((destructive ? null : firstFocus.current?.current) ?? (destructive ? cancelBtn : confirmBtn).current)?.focus({ preventScroll: true });
  }, [destructive]);

  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      {body ? (
        <p id={bodyId} className="dialog-body">
          {body}
        </p>
      ) : null}
      {children}
      <div className="dialog-actions">
        <Button ref={cancelBtn} level="secondary" onClick={cancel}>
          {cancelLabel ?? t('dialog.cancel')}
        </Button>
        <Button ref={confirmBtn} level={destructive ? 'danger' : 'primary'} busy={busy} disabled={!!confirmDisabled} reason={confirmDisabled ?? ''} onClick={confirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * A plain question string becomes a request: the text up to the first "?" is the title and the rest is the
 * consequence line, so existing question builders keep working while the look follows the dialog pattern.
 */
export function toConfirmRequest(q: string | ConfirmRequest, confirmLabel?: string): ConfirmRequest {
  if (typeof q !== 'string') return confirmLabel ? { ...q, confirmLabel } : q;
  const i = q.indexOf('?');
  const title = i >= 0 ? q.slice(0, i + 1).trim() : q.trim();
  const body = i >= 0 ? q.slice(i + 1).trim() : '';
  return { title, body: body || undefined, confirmLabel };
}

export type ConfirmFn = (q: string | ConfirmRequest, confirmLabel?: string) => Promise<boolean>;

/** A confirm as a promise, shown in the Studio's Dialog. Render `node` somewhere inside `.studio`. */
export function useConfirm(): { confirm: ConfirmFn; node: ReactNode } {
  const [req, setReq] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((q, label) => new Promise<boolean>((resolve) => setReq({ ...toConfirmRequest(q, label), resolve })), []);
  const answer = useCallback((ok: boolean) => {
    setReq((r) => {
      r?.resolve(ok);
      return null;
    });
  }, []);
  // A request still open when the screen goes away answers "no", so nothing waits forever.
  const live = useRef(req);
  useEffect(() => {
    live.current = req;
  }, [req]);
  useEffect(() => () => live.current?.resolve(false), []);
  const node = req ? (
    <Dialog
      open
      title={req.title}
      body={req.body}
      confirmLabel={req.confirmLabel ?? t('dialog.continue')}
      cancelLabel={req.cancelLabel}
      destructive={req.destructive}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  ) : null;
  return { confirm, node };
}
