import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="login-wrap" id="main">
      <div className="card login-card stack">
        <h1>Page not found</h1>
        <p className="muted">The link may be old, or you may not have access.</p>
        <Link href="/" className="btn btn-primary">
          Go to Today
        </Link>
      </div>
    </main>
  );
}
