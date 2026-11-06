import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Mac app (desktop/) runs a self-contained server: SIGNAL_STANDALONE=1 next build.
  ...(process.env.SIGNAL_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // Meta's documented token GETs contain sensitive query parameters; its callback carries
  // an authorization code. Disable Next's dev request/fetch logging, including cache-warning
  // URLs (fullUrl: false only truncates them). Application error reporting remains enabled.
  // This option does not control production proxy logs or third-party HTTP tracing.
  logging: false,
  // Content generators (lib/studio/render.ts, reel.ts): native image library, ffmpeg binary path and font parser stay external.
  serverExternalPackages: ['sharp', 'ffmpeg-static', 'opentype.js'],
  reactStrictMode: true,
  // Local HTTPS host for Meta's OAuth callback (Meta rejects plain localhost). Dev only; see docs/instagram-unified-login.md.
  ...(process.env.SIGNAL_DEV_HOST ? { allowedDevOrigins: [process.env.SIGNAL_DEV_HOST] } : {}),
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
