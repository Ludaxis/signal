// ElevenLabs text-to-speech with character timestamps (voice row; vendor documentation read 2026-11-06;
// volatile). Paid per character on the owner's own key, behind the postmakerElevenlabs switch and its accepted
// terms. No free account endpoint was verified, so test() never calls the vendor.
//
// Quality: the vendor's default model has no Persian, so a call without `model_id` (or with a model
// that does not list Persian) is refused before any request is built.
import { PostmakerError } from '../errors';
import type { Lang } from '../types';
import { estimateCost, jsonOf, num, READ_AT, send, str, type CallShape, type HttpCall, type RegisteredConnector } from './base';
import { defineConnector } from './define';
import { mockSpeech, type CharAlignment } from './mock/audio';

export const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_KEY_ENV = 'ELEVENLABS_API_KEY';
/** Models the vendor documentation lists with Persian. The default (eleven_multilingual_v2) is not one of them. */
export const ELEVENLABS_FA_MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational'] as const;
export const ELEVENLABS_DEFAULT_FORMAT = 'mp3_44100_128';

export const ELEVENLABS_TTS_SHAPE: CallShape = {
  source: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps',
  readAt: READ_AT,
  unverified: ['xi-api-key header name (not on the pages read)', 'output_format sent as a query parameter', 'request-id response header', 'previous_request_ids limit of 3'],
};

export interface TtsRequest {
  lang: Lang;
  /** The spoken text (the `tts` projection of the line), never the display text. */
  text: string;
  voiceId: string;
  /** Pinned per voice profile; required. */
  modelId?: string;
  outputFormat?: string;
  seed?: number;
  previousText?: string;
  nextText?: string;
  previousRequestIds?: string[];
}

export interface TtsResult {
  audio: Buffer;
  mime: string;
  alignment: CharAlignment | null;
  normalizedAlignment: CharAlignment | null;
  durationMs: number | null;
  requestId: string | null;
  /** 'approximate' when the vendor gives no timings (captions fall back to proportional timing). */
  timing: 'vendor' | 'approximate';
  mode: 'live' | 'mock';
}

const VOICE_ID_RE = /^[A-Za-z0-9]{8,64}$/;
const FORMAT_RE = /^(mp3|pcm|wav|opus|ulaw|alaw)_\d{4,5}(_\d{2,3})?$/;

/** The documented request, without the key. Refuses before building when model_id is missing. */
export function buildElevenlabsTts(r: TtsRequest): HttpCall {
  const model = (r.modelId ?? '').trim();
  if (!model) throw new PostmakerError(400, 'model_required', 'A voice call needs a pinned model.');
  if (r.lang === 'fa' && !(ELEVENLABS_FA_MODELS as readonly string[]).includes(model)) throw new PostmakerError(400, 'model_unsupported', 'That voice model does not list Persian.');
  if (!VOICE_ID_RE.test(r.voiceId)) throw new PostmakerError(400, 'validation', 'The voice id does not look right.');
  const text = r.text.trim();
  if (!text) throw new PostmakerError(400, 'validation', 'The line is empty.');
  const fmt = r.outputFormat ?? ELEVENLABS_DEFAULT_FORMAT;
  if (!FORMAT_RE.test(fmt)) throw new PostmakerError(400, 'validation', 'Unknown audio format.');
  const prev = r.previousRequestIds ?? [];
  if (prev.length > 3) throw new PostmakerError(400, 'validation', 'At most 3 earlier requests can be linked.');
  const body: Record<string, unknown> = { text, model_id: model, language_code: r.lang };
  if (r.seed !== undefined) body.seed = r.seed;
  if (r.previousText) body.previous_text = r.previousText;
  if (r.nextText) body.next_text = r.nextText;
  if (prev.length) body.previous_request_ids = prev;
  return {
    method: 'POST',
    url: `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(r.voiceId)}/with-timestamps?output_format=${encodeURIComponent(fmt)}`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  };
}

function alignmentOf(v: unknown): CharAlignment | null {
  const a = v as Partial<CharAlignment> | null;
  if (!a || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) return null;
  const n = a.characters.length;
  if (a.character_start_times_seconds.length !== n || a.character_end_times_seconds.length !== n) return null;
  if (![...a.character_start_times_seconds, ...a.character_end_times_seconds].every((x) => num(x) !== null)) return null;
  return { characters: a.characters.map(String), character_start_times_seconds: a.character_start_times_seconds, character_end_times_seconds: a.character_end_times_seconds };
}

export const mimeOfFormat = (fmt: string) => (fmt.startsWith('mp3') ? 'audio/mpeg' : fmt.startsWith('wav') ? 'audio/wav' : fmt.startsWith('opus') ? 'audio/ogg' : 'audio/L16');

/** Parses the documented JSON answer `{audio_base64, alignment, normalized_alignment}`. */
export function parseElevenlabsTts(j: Record<string, unknown>, o: { outputFormat?: string; requestId?: string | null } = {}): TtsResult {
  const b64 = str(j.audio_base64);
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new PostmakerError(502, 'upstream', 'ElevenLabs sent no audio.');
  const alignment = alignmentOf(j.alignment);
  const normalizedAlignment = alignmentOf(j.normalized_alignment);
  const ends = alignment?.character_end_times_seconds ?? [];
  return {
    audio: Buffer.from(b64, 'base64'),
    mime: mimeOfFormat(o.outputFormat ?? ELEVENLABS_DEFAULT_FORMAT),
    alignment,
    normalizedAlignment,
    durationMs: ends.length ? Math.round(Math.max(...ends) * 1000) : null,
    requestId: o.requestId ?? null,
    timing: alignment ? 'vendor' : 'approximate',
    mode: 'live',
  };
}

export const elevenlabs: RegisteredConnector<TtsRequest, TtsResult> = defineConnector<TtsRequest, TtsResult>({
  id: 'elevenlabs',
  title: 'ElevenLabs',
  kind: 'api',
  group: 'making',
  capabilities: [
    { id: 'tts', langs: ['fa', 'en'], models: [...ELEVENLABS_FA_MODELS], source: 'https://elevenlabs.io/docs/overview/models', readAt: READ_AT },
    { id: 'tts.timestamps', langs: ['fa', 'en'], source: ELEVENLABS_TTS_SHAPE.source, readAt: READ_AT },
  ],
  costModel: { unit: 'char', usdPerUnit: 0.00008, minimumUsd: 0, perCallCeilingUsd: 2, billing: 'vendor-key', verified: false, source: 'https://elevenlabs.io/pricing/api', readAt: READ_AT },
  attendance: 'any',
  settingsGroup: 'elevenlabs',
  feature: 'postmakerElevenlabs',
  gates: ['vendor:elevenlabs'],
  estimate: (r) => estimateCost(elevenlabs.costModel, [...r.text].length, Math.ceil([...r.text].length / 15), `${[...r.text].length} characters`),
  async invoke(r, ctx) {
    const call = buildElevenlabsTts(r); //: refused here, before any fetch
    const key = (process.env[ELEVENLABS_KEY_ENV] ?? '').trim();
    const a = await send(ctx.deps.fetch ?? globalThis.fetch, call, { 'xi-api-key': key }, { title: 'ElevenLabs', redact: elevenlabs.redact, signal: ctx.signal });
    return parseElevenlabsTts(jsonOf(a, 'ElevenLabs'), { outputFormat: r.outputFormat, requestId: a.headers.get('request-id') });
  },
  async mock(r) {
    const m = mockSpeech(r.text.trim() || ' ', r.lang);
    return { audio: m.wav, mime: 'audio/wav', alignment: m.alignment, normalizedAlignment: m.alignment, durationMs: m.durationMs, requestId: null, timing: 'vendor', mode: 'mock' };
  },
});
