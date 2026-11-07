'use client';
// Toast: bottom centre, ink fill, at most 8 words plus an optional Undo. 3.8 s, or 8 s with Undo.
// Errors that need an action never use a toast; they stay on the page as a Notice.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../copy/en';

export const TOAST_MS = 3800;
export const TOAST_UNDO_MS = 8000;

export interface ToastMessage {
  text: string;
  onUndo?: () => void;
}

export function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="ui-toast" role="status">
      <span className="toast-dot" aria-hidden="true" />
      <span>{message.text}</span>
      {message.onUndo ? (
        <button
          type="button"
          className="toast-undo"
          onClick={() => {
            message.onUndo?.();
            onDismiss();
          }}
        >
          {t('toast.undo')}
        </button>
      ) : null}
    </div>
  );
}

/** One toast at a time: `say("Saved")` or `say("Approved", { onUndo })`. Render `node` inside `.studio`. */
export function useToast(): { say: (text: string, opts?: { onUndo?: () => void }) => void; node: ReactNode } {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(null);
  }, []);
  const say = useCallback((text: string, opts?: { onUndo?: () => void }) => {
    setMessage({ text, onUndo: opts?.onUndo });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), opts?.onUndo ? TOAST_UNDO_MS : TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { say, node: <Toast message={message} onDismiss={dismiss} /> };
}
