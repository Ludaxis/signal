import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
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
    env: { TZ: 'UTC', NEXT_PUBLIC_SIGNAL_TIME_ZONE: 'Europe/Amsterdam' },
  },
});
