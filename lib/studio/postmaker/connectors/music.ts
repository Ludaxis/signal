// Music connectors (chain: pack library → owner upload → ElevenLabs Music (switched) → mock; every source declares
// its BPM and first-downbeat offset, no detection in v1). Conform maths is in the mix step, not here.
//
// - pack-music: a track from the project pack's library with a complete licence record and declared tempo.
// - owner-upload: a file the owner made elsewhere under their own plan (for example by hand in a music app),
//   with the plan tier and download date they type; Signal hashes it and records the licence as a draft asset.
// - elevenlabs-music: POST /v1/music (vendor documentation read 2026-11-06; volatile). Behind its switch and its
//   accepted terms (including the vendor's music terms). BPM goes into the prompt.
// Mock: a click track at the declared BPM (or 100).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PostmakerError } from '../errors';
import type { Asset, AssetLicence, LicenceType, MusicSource } from '../types';
import { estimateCost, READ_AT, send, type CallShape, type HttpCall, type RegisteredConnector } from './base';
import { defineConnector } from './define';
import { ELEVENLABS_BASE, ELEVENLABS_KEY_ENV, mimeOfFormat } from './elevenlabs';
import { clickTrackWav } from './mock/audio';

export interface DeclaredTempo {
  bpm: number;
  downbeatMs: number;
}

export interface MusicResult {
  audio: Buffer;
  mime: string;
  sha256: string;
  durationMs: number | null;
  tempo: DeclaredTempo;
  licence: AssetLicence | null;
  requestId: string | null;
  mode: 'live' | 'mock';
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function checkTempo(t: Partial<DeclaredTempo> | null | undefined): DeclaredTempo {
  if (!t || typeof t.bpm !== 'number' || !(t.bpm >= 40 && t.bpm <= 240)) throw new PostmakerError(400, 'tempo_required', 'Type the track’s BPM (40 to 240).');
  const downbeatMs = typeof t.downbeatMs === 'number' && t.downbeatMs >= 0 && t.downbeatMs < 10_000 ? t.downbeatMs : null;
  if (downbeatMs === null) throw new PostmakerError(400, 'tempo_required', 'Type where the first beat starts.');
  return { bpm: t.bpm, downbeatMs };
}

/** A licence record is complete when it says who holds it, where it came from, when, and what it may be used for. */
export function licenceComplete(l: Partial<AssetLicence> | null | undefined): boolean {
  return Boolean(l && l.type && l.holder?.trim() && l.source?.trim() && l.acquiredAt && Number.isFinite(Date.parse(l.acquiredAt)) && Array.isArray(l.allowedUses) && l.allowedUses.length > 0);
}

const mockResult = (ms: number, tempo: Partial<DeclaredTempo> | null | undefined): MusicResult => {
  const t = { bpm: tempo?.bpm && tempo.bpm >= 40 && tempo.bpm <= 240 ? tempo.bpm : 100, downbeatMs: tempo?.downbeatMs ?? 0 };
  const audio = clickTrackWav({ bpm: t.bpm, ms, downbeatMs: t.downbeatMs });
  return { audio, mime: 'audio/wav', sha256: sha(audio), durationMs: ms, tempo: t, licence: null, requestId: null, mode: 'mock' };
};

const FREE = (source: string) => ({ unit: 'none', usdPerUnit: 0, minimumUsd: 0, perCallCeilingUsd: 0, billing: 'none', verified: false, source, readAt: READ_AT }) as const;

// ---- pack library ------------------------------------------------------------------------------------------------

export interface PackMusicRequest {
  /** The asset record from the pack library and its absolute file path (resolved by pack/resolve.ts). */
  asset: Asset;
  file: string;
  tempo: DeclaredTempo | null;
  policy: { sources: MusicSource[] };
  lengthMs: number;
}

export const packMusic: RegisteredConnector<PackMusicRequest, MusicResult> = defineConnector<PackMusicRequest, MusicResult>({
  id: 'pack-music',
  title: 'Pack music',
  kind: 'local',
  group: 'making',
  capabilities: [{ id: 'music.import', source: 'pack.json musicPolicy', readAt: READ_AT }],
  costModel: { ...FREE('project pack library (no vendor)') },
  attendance: 'any',
  settingsGroup: null,
  feature: 'postmaker',
  gates: [],
  estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'local file' }),
  test: async () => ({ ok: true, text: 'Each track is checked when used.', costUsd: 0 }),
  async invoke(r) {
    if (!r.policy.sources.includes('library')) throw new PostmakerError(403, 'forbidden', 'This pack does not allow library music.');
    if (r.asset.kind !== 'music') throw new PostmakerError(400, 'validation', 'That asset is not music.');
    if (!licenceComplete(r.asset.licence)) throw new PostmakerError(409, 'licence_incomplete', 'The track’s licence record is incomplete.');
    const tempo = checkTempo(r.tempo);
    const audio = await fs.readFile(/* turbopackIgnore: true */ r.file).catch(() => {
      throw new PostmakerError(404, 'not_found', 'The track file is missing.');
    });
    const h = sha(audio);
    if (h !== r.asset.sha256) throw new PostmakerError(409, 'files_changed', 'The track file changed since the pack was locked.');
    const mime = /\.wav$/i.test(r.file) ? 'audio/wav' : /\.mp3$/i.test(r.file) ? 'audio/mpeg' : 'application/octet-stream';
    return { audio, mime, sha256: h, durationMs: r.asset.durationMs ?? null, tempo, licence: r.asset.licence, requestId: null, mode: 'live' };
  },
  mock: async (r) => mockResult(r.lengthMs, r.tempo),
});

// ---- owner upload ---------------------------------------------------------------------------------------------

export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_MIME = /^audio\/(mpeg|mp3|wav|x-wav|wave|mp4|aac|x-m4a|ogg|flac)$/;

export interface CustomerUploadRequest {
  file: string;
  mime: string;
  tempo: DeclaredTempo | null;
  lengthMs: number;
  /** What the owner types on upload: where the track came from, their plan tier and the download date. */
  licence: { type: Extract<LicenceType, 'owned' | 'vendor-output' | 'stock'>; holder: string; source: string; planTier: string | null; downloadedAt: string; allowedUses: AssetLicence['allowedUses'] };
}

/** The draft asset record an upload becomes (enters the library as `draft`). Exported for tests. */
export function uploadAsset(r: CustomerUploadRequest, h: string, now = new Date()): Asset {
  return {
    id: `upload-${h.slice(0, 12)}`,
    kind: 'music',
    file: `uploads/${h}${path.extname(r.file).toLowerCase()}`,
    sha256: h,
    tags: ['owner-upload'],
    licence: {
      type: r.licence.type,
      holder: r.licence.holder.trim(),
      source: r.licence.source.trim(),
      author: null,
      acquiredAt: r.licence.downloadedAt,
      proof: r.licence.planTier ? `plan: ${r.licence.planTier.trim()}; recorded ${now.toISOString().slice(0, 10)}` : null,
      allowedUses: r.licence.allowedUses,
      territories: 'worldwide',
      expiresAt: null,
      attribution: null,
      aiGenerated: r.licence.type === 'vendor-output',
    },
    status: 'draft',
    approvedBy: null,
  };
}

export const customerUpload: RegisteredConnector<CustomerUploadRequest, MusicResult & { asset: Asset | null }> = defineConnector<CustomerUploadRequest, MusicResult & { asset: Asset | null }>({
  id: 'owner-upload',
  title: 'Your music',
  kind: 'local',
  group: 'making',
  capabilities: [{ id: 'music.import', limits: { maxBytes: UPLOAD_MAX_BYTES }, source: 'Post maker music step (a file you upload)', readAt: READ_AT }],
  costModel: { ...FREE('owner upload (their own plan, no vendor call)') },
  attendance: 'any',
  settingsGroup: null,
  feature: 'postmaker',
  gates: [],
  estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 1, basis: 'local file' }),
  test: async () => ({ ok: true, text: 'Drop a track on the music step.', costUsd: 0 }),
  async invoke(r) {
    if (!AUDIO_MIME.test(r.mime)) throw new PostmakerError(400, 'validation', 'Use an audio file (MP3, WAV, M4A, OGG or FLAC).');
    const tempo = checkTempo(r.tempo);
    const st = await fs.stat(/* turbopackIgnore: true */ r.file).catch(() => null);
    if (!st?.isFile()) throw new PostmakerError(404, 'not_found', 'The file is missing.');
    if (st.size === 0 || st.size > UPLOAD_MAX_BYTES) throw new PostmakerError(400, 'validation', 'The file must be under 50 MB.');
    const lic = r.licence;
    if (!lic?.holder?.trim() || !lic.source?.trim() || !Number.isFinite(Date.parse(lic.downloadedAt)) || !lic.allowedUses?.length) throw new PostmakerError(400, 'licence_incomplete', 'Say where the track is from and when you got it.');
    const audio = await fs.readFile(/* turbopackIgnore: true */ r.file);
    const h = sha(audio);
    const asset = uploadAsset(r, h);
    return { audio, mime: r.mime, sha256: h, durationMs: null, tempo, licence: asset.licence, requestId: null, mode: 'live', asset };
  },
  mock: async (r) => ({ ...mockResult(r.lengthMs, r.tempo), asset: null }),
});

// ---- ElevenLabs Music --------------------------------------------------------------------------------------------

export const ELEVENLABS_MUSIC_MODELS = ['music_v1', 'music_v2', 'music_v2_5'] as const;
export const ELEVENLABS_MUSIC_SHAPE: CallShape = {
  source: 'https://elevenlabs.io/docs/api-reference/music/compose',
  readAt: READ_AT,
  unverified: ['xi-api-key header name', 'output_format as a query parameter', 'answer is the audio bytes', 'composition_plan section field names'],
};

export interface ElevenlabsMusicRequest {
  prompt: string;
  lengthMs: number;
  tempo: DeclaredTempo;
  instrumental?: boolean;
  modelId?: (typeof ELEVENLABS_MUSIC_MODELS)[number];
  outputFormat?: string;
  /** Optional sections sized from the segments (3 s to 2 min each). */
  sections?: { name: string; durationMs: number }[];
}

export function buildElevenlabsMusic(r: ElevenlabsMusicRequest): HttpCall {
  if (!(r.lengthMs >= 3_000 && r.lengthMs <= 600_000)) throw new PostmakerError(400, 'validation', 'Music length must be 3 s to 10 min.');
  const tempo = checkTempo(r.tempo);
  const model = r.modelId ?? 'music_v1';
  if (!(ELEVENLABS_MUSIC_MODELS as readonly string[]).includes(model)) throw new PostmakerError(400, 'validation', 'Unknown music model.');
  for (const s of r.sections ?? []) if (!(s.durationMs >= 3_000 && s.durationMs <= 120_000)) throw new PostmakerError(400, 'validation', 'Each music section must be 3 s to 2 min.');
  const prompt = `${r.prompt.replace(/\s+/g, ' ').trim()} Tempo ${tempo.bpm} BPM.`.trim();
  const body: Record<string, unknown> = { prompt, music_length_ms: Math.round(r.lengthMs), model_id: model, force_instrumental: r.instrumental ?? true };
  if (r.sections?.length) body.composition_plan = { sections: r.sections.map((s) => ({ section_name: s.name, duration_ms: Math.round(s.durationMs) })) };
  const fmt = r.outputFormat ?? 'mp3_44100_192';
  return { method: 'POST', url: `${ELEVENLABS_BASE}/v1/music?output_format=${encodeURIComponent(fmt)}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const MUSIC_COST = { unit: 'minute', usdPerUnit: 0.15, minimumUsd: 0, perCallCeilingUsd: 2, billing: 'vendor-key', verified: false, source: 'https://elevenlabs.io/pricing/api', readAt: READ_AT } as const;

export const elevenlabsMusic: RegisteredConnector<ElevenlabsMusicRequest, MusicResult> = defineConnector<ElevenlabsMusicRequest, MusicResult>({
  id: 'elevenlabs-music',
  title: 'ElevenLabs Music',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'music.generate', models: [...ELEVENLABS_MUSIC_MODELS], limits: { minMs: 3_000, maxMs: 600_000 }, source: ELEVENLABS_MUSIC_SHAPE.source, readAt: READ_AT }],
  costModel: { ...MUSIC_COST },
  attendance: 'any',
  settingsGroup: 'elevenlabs',
  feature: 'postmakerElevenlabsMusic',
  gates: ['vendor:elevenlabs-music', 'terms:elevenlabs-music-studio-games'],
  estimate: (r) => estimateCost(MUSIC_COST, r.lengthMs / 60_000, 60, `${Math.round(r.lengthMs / 1000)} s of music`),
  async invoke(r, ctx) {
    const call = buildElevenlabsMusic(r);
    const a = await send(ctx.deps.fetch ?? globalThis.fetch, call, { 'xi-api-key': (process.env[ELEVENLABS_KEY_ENV] ?? '').trim() }, { title: 'ElevenLabs Music', redact: elevenlabsMusic.redact, signal: ctx.signal, timeoutMs: 300_000 });
    if (!a.bytes.length) throw new PostmakerError(502, 'upstream', 'ElevenLabs Music sent no audio.');
    const licence: AssetLicence = { type: 'vendor-output', holder: 'owner', source: 'elevenlabs-music', author: null, acquiredAt: new Date().toISOString(), proof: null, allowedUses: ['organic'], territories: 'worldwide', expiresAt: null, attribution: null, aiGenerated: true };
    return { audio: a.bytes, mime: mimeOfFormat(r.outputFormat ?? 'mp3_44100_192'), sha256: sha(a.bytes), durationMs: r.lengthMs, tempo: checkTempo(r.tempo), licence, requestId: a.headers.get('request-id'), mode: 'live' };
  },
  mock: async (r) => mockResult(r.lengthMs, r.tempo),
});
