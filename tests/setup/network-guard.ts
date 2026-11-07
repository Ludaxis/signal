// Network guard for offline tests (quality acceptance): global fetch, raw sockets and every child process
// (so every vendor binary: claude, codex, ffmpeg…) throw unless a test injects a fake through `deps`. An accidental
// live call fails the test instead of reaching a vendor. Install it per suite (Post maker tests import
// tests/unit/postmaker/guard.ts, which installs it for the whole file). Every blocked attempt is also recorded, so a
// test can assert that nothing tried ("network guard log empty"), even where a caller swallowed the error.
import child_process from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export class NetworkBlocked extends Error {
  constructor(what: string) {
    super(`Network guard: ${what} is not allowed in Post maker tests.`);
  }
}

type Patch = [object, string, unknown];
const patches: Patch[] = [
  [globalThis, 'fetch', globalThis.fetch],
  [http, 'request', http.request],
  [http, 'get', http.get],
  [https, 'request', https.request],
  [https, 'get', https.get],
  [net, 'connect', net.connect],
  [net, 'createConnection', net.createConnection],
  [tls, 'connect', tls.connect],
  [child_process, 'spawn', child_process.spawn],
  [child_process, 'exec', child_process.exec],
  [child_process, 'execFile', child_process.execFile],
  [child_process, 'fork', child_process.fork],
];

const attempts: { what: string; at: string }[] = [];

/** The attempts blocked since the guard was last installed (or cleared). */
export const networkGuardLog = (): readonly { what: string; at: string }[] => [...attempts];
export const clearNetworkGuardLog = () => void attempts.splice(0);

/**
 * Installs the guard. `processes: false` leaves child processes alone (the local slice run starts the render child,
 * Chrome and ffmpeg itself) and still blocks fetch and every socket in this process.
 */
export function installNetworkGuard(o: { processes?: boolean } = {}): void {
  attempts.splice(0);
  for (const [obj, key] of patches) {
    if (o.processes === false && obj === child_process) continue;
    (obj as Record<string, unknown>)[key] = () => {
      attempts.push({ what: key, at: new Date().toISOString() });
      throw new NetworkBlocked(key);
    };
  }
  module.syncBuiltinESMExports();
}

export function removeNetworkGuard(): void {
  for (const [obj, key, original] of patches) (obj as Record<string, unknown>)[key] = original;
  module.syncBuiltinESMExports();
}

