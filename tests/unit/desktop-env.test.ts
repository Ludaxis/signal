// Mac app environment (desktop/env.cjs): signal.env parsing and what the app owns for each launch.
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const req = createRequire(import.meta.url);
const { mergePath, parseEnvFile, serverEnv } = req(path.resolve(__dirname, '../../desktop/env.cjs')) as {
  mergePath: (...p: string[]) => string;
  parseEnvFile: (t: string) => Record<string, string>;
  serverEnv: (o: Record<string, unknown>) => Record<string, string | undefined>;
};

describe('desktop env', () => {
  it('parses signal.env lines', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=v # note\n bad line\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'v' });
  });

  it('merges PATH without duplicates', () => {
    expect(mergePath('/a:/b', '/b:/c', '')).toBe('/a:/b:/c');
  });

  it('binds to loopback, owns the login and keeps user data paths', () => {
    const env = serverEnv({
      base: { HOME: '/Users/a', SIGNAL_LOCAL_ONLY_NO_PASSWORD: '1', ELECTRON_RUN_AS_NODE: '1' },
      user: { UPLOAD_POST_API_KEY: 'k', SIGNAL_OWNER_PASSWORD: 'mine', SIGNAL_DATA_DIR: '/Users/a/signal-data' },
      userData: '/Users/a/Library/Application Support/Signal',
      serverDir: '/App/Resources/server',
      port: 4321,
      ownerPassword: 'once',
      sessionSecret: 's'.repeat(32),
      tokenKey: 'tk',
      pathValue: '/opt/homebrew/bin:/usr/bin',
    });
    expect(env).toMatchObject({ HOSTNAME: '127.0.0.1', PORT: '4321', SIGNAL_WEB_ORIGIN: 'http://127.0.0.1:4321', SIGNAL_OWNER_PASSWORD: 'once', UPLOAD_POST_API_KEY: 'k', SIGNAL_DATA_DIR: '/Users/a/signal-data', SIGNAL_TOKEN_KEY: 'tk', SIGNAL_PROMPTS_DIR: '/App/Resources/server/agents', NODE_ENV: 'production' });
    expect(env.SIGNAL_CONFIG_FILE).toBe('/Users/a/Library/Application Support/Signal/signal.config.json');
    expect(env.SIGNAL_LOCAL_ONLY_NO_PASSWORD).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('checkout mode keeps the folder\'s own paths and token key', () => {
    const env = serverEnv({ base: {}, user: {}, userData: '/U', serverDir: '/repo/apps/web', port: 1, ownerPassword: 'o', sessionSecret: 's', tokenKey: 'keychain', pathValue: '/bin', mode: 'checkout', appEnvNames: new Set(['SIGNAL_TOKEN_KEY']) });
    expect(env.SIGNAL_DATA_DIR).toBeUndefined();
    expect(env.SIGNAL_PROMPTS_DIR).toBeUndefined();
    expect(env.SIGNAL_TOKEN_KEY).toBeUndefined();
    expect(env.SIGNAL_OWNER_PASSWORD).toBeUndefined(); // a checkout keeps its own sign-in
    const env2 = serverEnv({ base: {}, user: {}, userData: '/U', serverDir: '/r', port: 1, ownerPassword: 'o', sessionSecret: 's', tokenKey: 'keychain', pathValue: '/bin', mode: 'checkout', appEnvNames: new Set() });
    expect(env2.SIGNAL_TOKEN_KEY).toBe('keychain');
  });

  const checkout = (o: Record<string, unknown> = {}) => serverEnv({ base: {}, user: {}, userData: '/U', serverDir: '/r', port: 1, ownerPassword: 'o', sessionSecret: 's', tokenKey: 'kc', pathValue: '/bin', mode: 'checkout', ...o });

  it('checkout mode sets no password or session; user values pass through untouched', () => {
    const env = checkout({ user: { SIGNAL_OWNER_PASSWORD: 'mine' } });
    expect(env.SIGNAL_OWNER_PASSWORD).toBe('mine');
    expect(env.SIGNAL_SESSION_SECRET).toBeUndefined();
  });

  it('creates the Keychain token key lazily, only when nothing provides one', () => {
    let calls = 0;
    const lazy = () => (calls++, 'made');
    expect(checkout({ tokenKey: lazy, user: { SIGNAL_TOKEN_KEY: 'mine' } }).SIGNAL_TOKEN_KEY).toBe('mine');
    expect(checkout({ tokenKey: lazy, defaults: { SIGNAL_TOKEN_KEY: 'cfg' } }).SIGNAL_TOKEN_KEY).toBe('cfg');
    expect(checkout({ tokenKey: lazy, base: { SIGNAL_TOKEN_KEY: 'shell' } }).SIGNAL_TOKEN_KEY).toBe('shell');
    expect(checkout({ tokenKey: lazy, appEnvNames: new Set(['SIGNAL_TOKEN_KEY']) }).SIGNAL_TOKEN_KEY).toBeUndefined();
    expect(calls).toBe(0);
    expect(checkout({ tokenKey: lazy }).SIGNAL_TOKEN_KEY).toBe('made');
    expect(calls).toBe(1);
    expect(checkout({ tokenKey: () => '' }).SIGNAL_TOKEN_KEY).toBeUndefined();
  });
});
