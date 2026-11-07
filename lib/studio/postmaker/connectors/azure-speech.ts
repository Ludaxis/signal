// Azure AI Speech, the Persian (fa-IR) voice fallback (voice row; vendor documentation read 2026-11-06; volatile). SSML with one of the two Standard neural fa-IR voices; the docs say phonemes, custom
// lexicon and visemes are not supported for fa-IR, so Signal's own `pron` respelling is the only lever. Word timings
// are not documented for fa-IR: the result says timing 'approximate' and captions use proportional timing.
// The REST endpoint and headers below are unverified: check them against the vendor documentation before a live run.
import { PostmakerError } from '../errors';
import { estimateCost, READ_AT, send, type CallShape, type HttpCall, type RegisteredConnector } from './base';
import { defineConnector } from './define';
import type { TtsRequest, TtsResult } from './elevenlabs';
import { mockSpeech, wavDurationMs } from './mock/audio';

export const AZURE_KEY_ENV = 'AZURE_SPEECH_KEY';
export const AZURE_REGION_ENV = 'AZURE_SPEECH_REGION';
export const AZURE_FA_VOICES = ['fa-IR-DilaraNeural', 'fa-IR-FaridNeural'] as const;
export const AZURE_OUTPUT_FORMAT = 'riff-48khz-16bit-mono-pcm';

export const AZURE_TTS_SHAPE: CallShape = {
  source: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts',
  readAt: READ_AT,
  unverified: ['REST endpoint https://<region>.tts.speech.microsoft.com/cognitiveservices/v1', 'Ocp-Apim-Subscription-Key header', 'X-Microsoft-OutputFormat value', 'word-boundary timings', 'official price'],
};

const REGION_RE = /^[a-z0-9]{3,30}$/;
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export function buildAzureSsml(r: Pick<TtsRequest, 'lang' | 'text' | 'voiceId'>): string {
  const locale = r.lang === 'fa' ? 'fa-IR' : 'en-US';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${xml(r.voiceId)}">${xml(r.text.trim())}</voice></speak>`;
}

export function buildAzureTts(r: TtsRequest, region: string): HttpCall {
  if (!REGION_RE.test(region)) throw new PostmakerError(400, 'validation', 'The Azure region does not look right.');
  if (r.lang === 'fa' && !(AZURE_FA_VOICES as readonly string[]).includes(r.voiceId)) throw new PostmakerError(400, 'validation', 'That voice does not speak Persian.');
  if (!r.text.trim()) throw new PostmakerError(400, 'validation', 'The line is empty.');
  return {
    method: 'POST',
    url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    headers: { 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT },
    body: buildAzureSsml(r),
  };
}

/** The answer is the audio itself (RIFF WAV); no alignment. */
export function parseAzureTts(bytes: Buffer): TtsResult {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw new PostmakerError(502, 'upstream', 'Azure Speech sent no audio.');
  return { audio: bytes, mime: 'audio/wav', alignment: null, normalizedAlignment: null, durationMs: wavDurationMs(bytes), requestId: null, timing: 'approximate', mode: 'live' };
}

const COST = { unit: 'char', usdPerUnit: 0.000015, minimumUsd: 0, perCallCeilingUsd: 1, billing: 'vendor-key', verified: false, source: 'Azure Speech pricing (secondary source, not verified against the official page)', readAt: READ_AT } as const;

export const azureSpeech: RegisteredConnector<TtsRequest, TtsResult> = defineConnector<TtsRequest, TtsResult>({
  id: 'azure-speech',
  title: 'Azure Speech',
  kind: 'api',
  group: 'making',
  capabilities: [{ id: 'tts', langs: ['fa'], models: [...AZURE_FA_VOICES], limits: { phonemes: 'not supported for fa-IR' }, source: AZURE_TTS_SHAPE.source, readAt: READ_AT }],
  costModel: { ...COST },
  attendance: 'any',
  settingsGroup: 'azure-speech',
  feature: 'postmakerAzureSpeech',
  gates: ['vendor:azure-speech'],
  estimate: (r) => estimateCost(COST, [...r.text].length, Math.ceil([...r.text].length / 15), `${[...r.text].length} characters`),
  async invoke(r, ctx) {
    const call = buildAzureTts(r, (process.env[AZURE_REGION_ENV] ?? '').trim());
    const a = await send(ctx.deps.fetch ?? globalThis.fetch, call, { 'Ocp-Apim-Subscription-Key': (process.env[AZURE_KEY_ENV] ?? '').trim() }, { title: 'Azure Speech', redact: azureSpeech.redact, signal: ctx.signal });
    return parseAzureTts(a.bytes);
  },
  async mock(r) {
    const m = mockSpeech(r.text.trim() || ' ', r.lang);
    return { audio: m.wav, mime: 'audio/wav', alignment: null, normalizedAlignment: null, durationMs: m.durationMs, requestId: null, timing: 'approximate', mode: 'mock' };
  },
});
