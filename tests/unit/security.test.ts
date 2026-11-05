import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSameOrigin, isSafeSegment } from '@/lib/server/security';
import { shouldUseSecureCookie } from '@/lib/server/session';
import { buildCsp } from '@/proxy';

const url = 'http://localhost:3000/api/v1/x';

function headers(h: Record<string, string>) {
  return new Headers(h);
}

describe('cross-origin protection for mutating requests', () => {
  it('allows safe methods without checks', () => {
    expect(checkSameOrigin({ method: 'GET', url, headers: headers({ origin: 'https://evil.test' }) }).ok).toBe(true);
  });
  it('allows same-origin POSTs', () => {
    expect(checkSameOrigin({ method: 'POST', url, headers: headers({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }) }).ok).toBe(true);
  });
  it('rejects cross-site and same-site-but-different-origin requests', () => {
    expect(checkSameOrigin({ method: 'POST', url, headers: headers({ origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }) }).ok).toBe(false);
    expect(checkSameOrigin({ method: 'PATCH', url, headers: headers({ 'sec-fetch-site': 'same-site' }) }).ok).toBe(false);
    expect(checkSameOrigin({ method: 'DELETE', url, headers: headers({ origin: 'http://localhost:4000' }) }).ok).toBe(false);
  });
  it('rejects mutating requests with neither Origin nor Sec-Fetch-Site', () => {
    expect(checkSameOrigin({ method: 'PUT', url, headers: headers({}) }).ok).toBe(false);
  });
  it('honours SIGNAL_WEB_ORIGIN behind a proxy', () => {
    const allowedOrigin = 'https://signal.example.test';
    expect(checkSameOrigin({ method: 'POST', url: 'http://0.0.0.0:3000/api/v1/x', headers: headers({ origin: allowedOrigin }), allowedOrigin }).ok).toBe(true);
    expect(checkSameOrigin({ method: 'POST', url: 'http://0.0.0.0:3000/api/v1/x', headers: headers({ origin: 'http://0.0.0.0:3000' }), allowedOrigin }).ok).toBe(false);
  });
  it('accepts the forwarded host when no explicit origin is configured', () => {
    expect(
      checkSameOrigin({ method: 'POST', url: 'http://10.0.0.5:3000/x', headers: headers({ origin: 'https://signal.example.test', 'x-forwarded-host': 'signal.example.test', 'x-forwarded-proto': 'https' }) }).ok,
    ).toBe(true);
  });
});

describe('path guards', () => {
  it('rejects traversal and control characters', () => {
    expect(isSafeSegment('content')).toBe(true);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('.')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('a\\b')).toBe(false);
    expect(isSafeSegment('')).toBe(false);
  });
});

describe('session cookie', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is not Secure in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(shouldUseSecureCookie('https://signal.example.test/api/session')).toBe(false);
  });
  it('is Secure in production except plain-http loopback', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(shouldUseSecureCookie('https://signal.example.test/api/session')).toBe(true);
    expect(shouldUseSecureCookie('http://localhost:3000/api/session')).toBe(false);
    expect(shouldUseSecureCookie('http://127.0.0.1:3000/api/session')).toBe(false);
    expect(shouldUseSecureCookie('http://10.0.0.5:3000/api/session', new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
  });
});

describe('content security policy', () => {
  it('uses a nonce with strict-dynamic and blocks framing, objects and foreign connections', () => {
    const csp = buildCsp('abc123', false, 'http://localhost:8080', true);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("style-src 'self' 'nonce-abc123'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('media-src \'self\' blob: http://localhost:8080');
    expect(csp).toContain('upgrade-insecure-requests');
  });
  it('relaxes only what Next.js development needs', () => {
    const csp = buildCsp('n', true, '', false);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
