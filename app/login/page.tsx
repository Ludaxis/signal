import type { Metadata } from 'next';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/fraunces/400-italic.css';
import './login.css';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in · Signal' };

export default function LoginPage() {
  return (
    <main className="lg-root" id="main">
      <section className="lg-brand" aria-hidden="false">
        <div className="lg-logo">
          <span className="lg-tube" aria-hidden="true">
            <i />
          </span>
          <span className="lg-word">Signal</span>
        </div>
        <div className="lg-hero">
          <h1>
            Content that ships itself,
            <br />
            <em>with you in the loop.</em>
          </h1>
          <p>One studio for every brand: make posts from what you already have, approve them in one tap, and post to Instagram.</p>
          <ol className="lg-flow" aria-label="How Signal works">
            <li>
              <span>1</span>Brand
            </li>
            <li>
              <span>2</span>Create
            </li>
            <li>
              <span>3</span>Approve
            </li>
            <li>
              <span>4</span>Post
            </li>
          </ol>
        </div>
        <div className="lg-tubes" aria-hidden="true">
          {[72, 38, 90, 56, 24].map((h, i) => (
            <span key={i} className="lg-tubebar" style={{ animationDelay: `${i * 0.35}s` }}>
              <i style={{ height: `${h}%` }} />
            </span>
          ))}
        </div>
        <p className="lg-foot">Self-hosted · runs on your machine</p>
      </section>
      <section className="lg-panel">
        <LoginForm />
      </section>
    </main>
  );
}
