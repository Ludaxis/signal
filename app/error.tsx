'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="login-wrap" id="main">
      <div className="card login-card stack" role="alert">
        <h1>Something broke on this screen</h1>
        <p className="muted">Try again. If it keeps happening, send feedback and mention code {error.digest ?? 'n/a'}.</p>
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
