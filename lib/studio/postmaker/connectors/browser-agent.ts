// The generic browser-agent connector: one connector per site binding, id `browser-agent:<siteId>`, attended
// only, music.generate. A binding with `allowed: false` (Suno today) reports not-allowed and refuses invoke with
// 403 whatever the switches, keys or records say. Its mock is the click track like every music mock.
// An allowed binding would run through browser-agent/session.ts with a driver; none exists yet (driver.ts TODO).
import { PostmakerError } from '../errors';
import type { InvokeCtx } from '../types';
import type { SiteBinding } from '../browser-agent/sites/suno';
import { READ_AT, type RegisteredConnector } from './base';
import { defineConnector } from './define';
import { clickTrackWav } from './mock/audio';
import type { DeclaredTempo, MusicResult } from './music';
import { createHash } from 'node:crypto';

export interface BrowserMusicRequest {
  inputs: Record<string, string>;
  lengthMs: number;
  tempo: DeclaredTempo | null;
}

export type BrowserRun = (b: SiteBinding, r: BrowserMusicRequest, ctx: InvokeCtx) => Promise<MusicResult>;

export function browserAgentConnector(b: SiteBinding, deps: { run?: BrowserRun } = {}): RegisteredConnector<BrowserMusicRequest, MusicResult> {
  return defineConnector<BrowserMusicRequest, MusicResult>({
    id: `browser-agent:${b.siteId}`,
    title: b.title,
    kind: 'browser-agent',
    group: 'making',
    capabilities: [{ id: 'music.generate', limits: { downloads: b.expectDownloads.count }, source: `${b.origins[0]} (the site’s own terms)`, readAt: READ_AT }],
    costModel: { unit: 'request', usdPerUnit: 0, minimumUsd: 0, perCallCeilingUsd: 0, billing: 'owner-plan', verified: false, source: `${b.origins[0]} (the owner’s own plan; no API)`, readAt: READ_AT },
    attendance: 'attended-only',
    settingsGroup: null,
    feature: 'browserAgent',
    gates: [`terms:browser-agent-${b.siteId}`, `vendor:browser-agent-${b.siteId}`],
    keyPresent: async () => true, // the site sign-in lives only in its browser profile; Signal stores no password
    ...(b.allowed ? {} : { blocked: { state: 'not-allowed' as const, line: b.line, reason: b.reason } }),
    test: async () => (b.allowed ? { ok: false, text: 'Open the sign-in window to check.', costUsd: 0 } : { ok: false, text: b.line, costUsd: 0 }),
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 600, basis: 'your own plan' }),
    async invoke(r, ctx) {
      if (!b.allowed) throw new PostmakerError(403, 'forbidden', `${b.title}: ${b.reason}`);
      if (!deps.run) throw new PostmakerError(501, 'not_implemented', 'The browser agent is not available yet.');
      return deps.run(b, r, ctx);
    },
    async mock(r) {
      const t = { bpm: r.tempo?.bpm ?? 100, downbeatMs: r.tempo?.downbeatMs ?? 0 };
      const audio = clickTrackWav({ bpm: t.bpm, ms: r.lengthMs, downbeatMs: t.downbeatMs });
      return { audio, mime: 'audio/wav', sha256: createHash('sha256').update(audio).digest('hex'), durationMs: r.lengthMs, tempo: t, licence: null, requestId: null, mode: 'mock' };
    },
  });
}
