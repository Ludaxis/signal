// Test setup for the Post maker suite: a network guard (no fetch, no sockets, no child processes) installed for every
// test file that imports this module, plus a fresh temp store root per test. An accidental live call fails the test.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { installNetworkGuard, removeNetworkGuard } from '../../setup/network-guard';

export { NetworkBlocked, clearNetworkGuardLog, installNetworkGuard, networkGuardLog, removeNetworkGuard } from '../../setup/network-guard';

beforeAll(() => installNetworkGuard());
afterAll(removeNetworkGuard);

/** The current test's temp store root (`<tmp>/content/../postmaker` layout: root = <tmp>/postmaker). */
export const tmp = { dir: '', root: '', contentDir: '' };
beforeEach(() => {
  tmp.dir = mkdtempSync(path.join(os.tmpdir(), 'signal-pm-'));
  tmp.contentDir = path.join(tmp.dir, 'posts');
  tmp.root = path.join(tmp.dir, 'postmaker');
  // Switches and Post maker settings come from a per-test signal.config.json, never the developer's own file.
  process.env.SIGNAL_CONFIG_FILE = path.join(tmp.dir, 'signal.config.json');
});
afterEach(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});
