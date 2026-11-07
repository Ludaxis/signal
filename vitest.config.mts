import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // The Post maker compositions import Remotion, which only the optional render workspace installs. Unit tests
      // render them to static HTML against a stub; real renders go through the render child.
      remotion: path.resolve(__dirname, 'tests/unit/postmaker/render/remotion-stub.tsx'),
    },
  },
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
    // The fixtures assume a European zone with daylight saving (DST weeks are part of the tests).
    env: { TZ: 'UTC', NEXT_PUBLIC_SIGNAL_TIME_ZONE: 'Europe/Berlin' },
  },
});
