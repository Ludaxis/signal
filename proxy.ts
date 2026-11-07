// Next.js proxy (formerly middleware): per-request CSP nonce and the login redirect.
// The redirect only checks that a session cookie exists; every API route verifies its signature.
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIES = ['__Host-signal_session', 'signal_session'];
const PUBLIC_PAGES = new Set(['/login']);

/** Extra origin allowed for images and media in the CSP (e.g. a CDN for Instagram thumbnails); empty by default. */
function mediaOrigin(): string {
  const raw = process.env.SIGNAL_MEDIA_ORIGIN || '';
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

export function buildCsp(nonce: string, isDev: boolean, media: string, https = false): string {
  const mediaSrc = ["'self'", 'blob:', media].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Element styles need the nonce; style attributes (progress widths, chart sizes) are allowed.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src ${mediaSrc} data:`,
    `media-src ${mediaSrc}`,
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(https && !isDev ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = SESSION_COOKIES.some((n) => request.cookies.get(n)?.value);
  if (!hasSession && !PUBLIC_PAGES.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || request.nextUrl.protocol.replace(':', '');
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development', mediaOrigin(), proto === 'https');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // fonts/: the bundled OFL faces in public/fonts (app/studio/fonts.css) are static, public files.
      source: '/((?!api|_next/static|_next/image|fonts/|favicon.ico|icon.svg|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
