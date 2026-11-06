'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState, type KeyboardEvent } from 'react';

const HOME = '/studio';

/**
 * Where to go after signing in: only a path on this app's own origin, else the Studio.
 * Control characters (TAB, CR, LF are dropped by URL parsers, so "/<TAB>/evil.com" would become
 * "//evil.com"), backslashes (read as "/"), protocol-relative and absolute URLs are refused; what is
 * left is parsed against the app origin and must stay on it. Exported for tests.
 */
export function safeNext(next: string | null, appOrigin?: string): string {
  if (!next || next.length > 2048) return HOME;
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(next)) return HOME;
  if (!next.startsWith('/') || next.startsWith('//')) return HOME;
  let origin: string;
  try {
    origin = new URL(appOrigin ?? window.location.origin).origin;
  } catch {
    return HOME;
  }
  if (origin === 'null') return HOME;
  let u: URL;
  try {
    u = new URL(next, origin);
  } catch {
    return HOME;
  }
  if (u.origin !== origin) return HOME;
  return `${u.pathname}${u.search}${u.hash}`;
}

type Mode = 'password' | 'open' | 'unset' | 'unknown';

function Form() {
  const router = useRouter();
  const params = useSearchParams();
  const ids = useId();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('unknown');
  const [modeReason, setModeReason] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mode?: Mode; reason?: string } | null) => {
        if (!alive) return;
        setMode(d?.mode ?? 'unknown');
        setModeReason(d?.reason ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const signIn = async (pw: string) => {
    setError(null);
    if (mode !== 'open' && !pw) {
      setError('Enter the owner password.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(data?.error?.message || 'Sign-in failed. Try again.');
        setBusy(false);
        return;
      }
      setPassword('');
      router.replace(safeNext(params.get('next')));
    } catch {
      setError("Can't reach Signal. Check that the server is running and try again.");
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);

  return (
    <div className="lg-card">
      <div className="lg-card-head">
        <h2>Welcome back</h2>
        <p>Sign in to your content studio.</p>
      </div>
      {mode === 'open' ? (
        <div className="lg-demo" role="note">
          <span>
            <strong>Local mode.</strong> No password is set; sign-in works from this machine only.
          </span>
          <button type="button" className="lg-demo-btn" disabled={busy} onClick={() => void signIn('')}>
            Continue as owner
          </button>
          {error ? (
            <p id={`${ids}-error`} className="lg-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <form
          className="lg-form"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn(password);
          }}
          noValidate
        >
          <label className="lg-field" htmlFor={`${ids}-password`}>
            <span>Owner password</span>
            <span className="lg-pass">
              <input
                id={`${ids}-password`}
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={onKey}
                onKeyDown={onKey}
                required
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? `${ids}-error` : caps ? `${ids}-caps` : undefined}
              />
              <button type="button" className="lg-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                {show ? 'Hide' : 'Show'}
              </button>
            </span>
            {caps ? (
              <span id={`${ids}-caps`} className="lg-hint">
                Caps Lock is on
              </span>
            ) : null}
          </label>
          {error ? (
            <p id={`${ids}-error`} className="lg-error" role="alert">
              {error}
            </p>
          ) : null}
          {mode === 'unset' ? (
            <p className="lg-hint" role="status">
              {modeReason || 'Set SIGNAL_OWNER_PASSWORD in .env.local and restart the server.'}
            </p>
          ) : null}
          <button type="submit" className="lg-submit" disabled={busy || mode === 'unset'}>
            {busy ? <span className="lg-spin" aria-hidden="true" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
      <p className="lg-fine">Your session lives in a secure, http-only cookie signed by this server. Signal never stores your password in the browser.</p>
    </div>
  );
}

export function LoginForm() {
  return (
    <Suspense fallback={null}>
      <Form />
    </Suspense>
  );
}
