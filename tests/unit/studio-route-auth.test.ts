// Invariant: every route under app/api/studio/** refuses a request that has no session cookie.
// The routes are discovered with a glob, so a route added later is covered automatically; one that
// forgets requireStudioUser makes this file fail. Requests are same-origin so the 401 can only come
// from the session check, not from the cross-origin guard that runs before it.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:3000';
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;

// Vitest rewrites import.meta.glob at transform time; the cast only gives it a type.
const modules = (import.meta as unknown as { glob: (pattern: string) => Record<string, () => Promise<Record<string, unknown>>> }).glob('../../app/api/studio/**/route.ts');
const files = Object.keys(modules).sort();

/** Routes that answer an unauthenticated browser navigation with a redirect rather than a 401. */
const REDIRECTS: Record<string, { status: number; location: RegExp }> = {
  // OAuth return leg: a person's browser lands here, so it bounces back to the Studio with a message.
  // It still stops before any code exchange; the test asserts the "Sign in" message.
  '../../app/api/studio/instagram/callback/route.ts': { status: 303, location: /ig=error.*Sign(\+|%20)in/ },
};

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  // If a guard is ever removed the handler would run for real: keep it away from real folders, keys and the network.
  dir = mkdtempSync(path.join(os.tmpdir(), 'signal-route-auth-'));
  for (const k of Object.keys(process.env)) {
    if (/^(META_|INSTAGRAM_|UPLOAD_POST|UPLOADPOST_|ANTHROPIC_|HIGGSFIELD_|HF_|FIGMA_|OPENAI_|R2_|SIGNAL_(WEB_ORIGIN|API_URL|TOKEN_KEY|SECRETS_DIR|CONFIG_FILE|ACCOUNTS_FILE|PROJECTS_FILE|CONTENT_DIR|PROMPTS_DIR|OWNER_PASSWORD|LOCAL_ONLY_NO_PASSWORD|FEATURE_\w+))/.test(k)) delete process.env[k];
  }
  process.env.SIGNAL_PUBLISH_PAUSED = '1';
  process.env.SIGNAL_DATA_DIR = path.join(dir, 'data');
  process.env.SIGNAL_SECRETS_DIR = path.join(dir, 'secrets');
  process.env.SIGNAL_CONFIG_FILE = path.join(dir, 'signal.config.json');
  process.env.SIGNAL_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
  process.env.SIGNAL_TOKEN_KEY = Buffer.alloc(32, 9).toString('base64');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is not available in the route-auth test'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

function request(method: string, route: string): NextRequest {
  const url = `${ORIGIN}/api/studio/${route}`;
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return new NextRequest(url, {
    method,
    headers: mutating ? { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {},
    ...(mutating ? { body: '{}' } : {}),
  });
}
const params = Promise.resolve({ id: 'x', name: 'x', pid: 'x' });
const routeOf = (file: string) => file.replace('../../app/api/studio/', '').replace(/\/?route\.ts$/, '');

describe('studio routes need a session', () => {
  it('finds the routes (the glob did not silently break)', () => {
    expect(files.length).toBeGreaterThanOrEqual(22);
    expect(files).toContain('../../app/api/studio/content/[id]/route.ts');
    expect(files).toContain('../../app/api/studio/workspace/file/route.ts');
  });

  for (const file of files) {
    it(`${routeOf(file)}: every HTTP method answers 401 without a session cookie`, async () => {
      const mod = await modules[file]!();
      const exported = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(exported.length, `${file} exports no HTTP method`).toBeGreaterThan(0);
      for (const method of exported) {
        const res = await (mod[method] as Handler)(request(method, routeOf(file)), { params });
        const redirect = REDIRECTS[file];
        if (redirect) {
          expect(res.status, `${method} ${routeOf(file)}`).toBe(redirect.status);
          expect(res.headers.get('location') ?? '', `${method} ${routeOf(file)}`).toMatch(redirect.location);
        } else {
          expect(res.status, `${method} ${routeOf(file)} must call requireStudioUser first`).toBe(401);
        }
      }
    });
  }

  it('a cross-origin write is refused before anything else (403)', async () => {
    const mod = await modules['../../app/api/studio/projects/route.ts']!();
    const res = await (mod.POST as Handler)(
      new NextRequest(`${ORIGIN}/api/studio/projects`, { method: 'POST', headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }, body: '{}' }),
      { params },
    );
    expect(res.status).toBe(403);
  });
});
