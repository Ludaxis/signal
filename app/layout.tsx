import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import './tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Signal', template: '%s · Signal' },
  description: 'Plan, approve, post and measure Instagram content with AI agents.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0E1116' },
    { media: '(prefers-color-scheme: light)', color: '#F6F7F9' },
  ],
};

const THEMES = new Set(['dark', 'light', 'system']);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading request headers makes every page dynamic, which the per-request CSP nonce requires.
  await headers();
  const theme = (await cookies()).get('signal_theme')?.value;
  return (
    <html lang="en-GB" data-theme={theme && THEMES.has(theme) ? theme : 'dark'}>
      <body>{children}</body>
    </html>
  );
}
