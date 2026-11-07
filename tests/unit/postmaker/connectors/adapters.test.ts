// @vitest-environment node
// Request building and response parsing of every vendor adapter against the fixtures written from the vendors'
// documentation (fixtures/vendors.json; never recorded traffic), the mocks and redaction.
import '../guard';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAzureTts, parseAzureTts, azureSpeech } from '@/lib/studio/postmaker/connectors/azure-speech';
import { estimateCost, publicHttpsUrl, redactor } from '@/lib/studio/postmaker/connectors/base';
import { buildElevenlabsTts, elevenlabs, parseElevenlabsTts } from '@/lib/studio/postmaker/connectors/elevenlabs';
import { buildBrollSubmit, higgsfieldVideo, parseSubmit } from '@/lib/studio/postmaker/connectors/higgsfield';
import { buildHedraGenerate, buildSyncGenerate, hedra, HEDRA_SHAPE, parseJob, sync, SYNC_SHAPE } from '@/lib/studio/postmaker/connectors/lipsync';
import { loudnormArgs, makeFfmpeg, parseLoudnorm } from '@/lib/studio/postmaker/connectors/local';
import { beatTimesMs, clickTrackWav, mockSpeech, wavDurationMs } from '@/lib/studio/postmaker/connectors/mock/audio';
import { mockCardPng, mockCardText } from '@/lib/studio/postmaker/connectors/mock/image';
import { kenBurnsArgs, mouthBoxArgs } from '@/lib/studio/postmaker/connectors/mock/video';
import { buildElevenlabsMusic, checkTempo, customerUpload, elevenlabsMusic, packMusic, uploadAsset } from '@/lib/studio/postmaker/connectors/music';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { tmp } from '../guard';
import { setKeys } from './env';
import { ctxOf, FAKE_KEYS, fakeFetch, fakeSpawn, FIXTURES } from './fakes';

const asCall = (c: { method: string; url: string; headers: Record<string, string>; body?: string }) => ({ ...c, body: c.body && c.body.startsWith('{') ? JSON.parse(c.body) : c.body });
const fx = (k: string) => FIXTURES[k]! as Record<string, unknown> & { call: { method: string; url: string; headers: Record<string, string>; body: unknown }; request: never };

describe('ElevenLabs TTS (fixture from the convert-with-timestamps docs)', () => {
  it('builds the documented request without any key', () => {
    const f = fx('elevenlabs-tts');
    expect(asCall(buildElevenlabsTts(f.request))).toEqual(f.call);
    expect(JSON.stringify(buildElevenlabsTts(f.request))).not.toMatch(/xi-api-key/i);
  });

  it('a fa call without model_id, or with a model that has no Persian, is refused before any fetch', async () => {
    setKeys(['ELEVENLABS_API_KEY']);
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const base = { lang: 'fa' as const, text: 'سلام', voiceId: 'FixtureVoice0001' };
    await expect(elevenlabs.invoke(base, ctxOf({ deps: { fetch } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'model_required'));
    await expect(elevenlabs.invoke({ ...base, modelId: '  ' }, ctxOf({ deps: { fetch } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'model_required'));
    await expect(elevenlabs.invoke({ ...base, modelId: 'eleven_multilingual_v2' }, ctxOf({ deps: { fetch } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'model_unsupported'));
    expect(calls).toEqual([]);
    // …and the global fetch is the network guard, so a missing injection could not have gone out either.
    await expect(elevenlabs.invoke(base, ctxOf())).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'model_required'));
  });

  it('invoke sends the key only as the auth header and parses the documented answer', async () => {
    setKeys(['ELEVENLABS_API_KEY']);
    const f = fx('elevenlabs-tts');
    const { fetch, calls } = fakeFetch(() => ({ json: f.response, headers: f.responseHeaders as Record<string, string> }));
    const r = await elevenlabs.invoke(f.request, ctxOf({ deps: { fetch } }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['xi-api-key']).toBe(FAKE_KEYS.ELEVENLABS_API_KEY);
    expect(calls[0]!.url).toBe(f.call.url);
    const e = f.expect as { audioText: string; durationMs: number; requestId: string; mime: string };
    expect(r).toMatchObject({ mime: e.mime, durationMs: e.durationMs, requestId: e.requestId, timing: 'vendor', mode: 'live' });
    expect(r.audio.toString()).toBe(e.audioText);
    expect(r.alignment!.characters).toEqual(['س', 'ل', 'ا', 'م']);
  });

  it('rejects malformed answers and redacts vendor errors', async () => {
    expect(() => parseElevenlabsTts({})).toThrow(/no audio/);
    expect(parseElevenlabsTts({ audio_base64: 'AA==', alignment: { characters: ['a'], character_start_times_seconds: [0, 1], character_end_times_seconds: [1] } }).alignment).toBeNull();
    setKeys(['ELEVENLABS_API_KEY']);
    const f = fx('elevenlabs-tts');
    const { fetch } = fakeFetch(() => ({ status: 500, json: { detail: `bad key ${FAKE_KEYS.ELEVENLABS_API_KEY}` } }));
    const err = await elevenlabs.invoke(f.request, ctxOf({ deps: { fetch } })).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(FAKE_KEYS.ELEVENLABS_API_KEY);
    const { fetch: f401 } = fakeFetch(() => ({ status: 401, json: {} }));
    await expect(elevenlabs.invoke(f.request, ctxOf({ deps: { fetch: f401 } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'vendor_auth'));
  });

  it('estimates from the cost model: characters × $0.00008 (volatile, unverified)', () => {
    expect(elevenlabs.estimate({ lang: 'fa', text: 'x'.repeat(900), voiceId: 'FixtureVoice0001', modelId: 'eleven_v4' })).toMatchObject({ usdLow: 0.072, usdHigh: 0.072 });
    expect(elevenlabs.costModel).toMatchObject({ verified: false, source: 'https://elevenlabs.io/pricing/api', readAt: '2026-11-06', perCallCeilingUsd: 2 });
  });
});

describe('Azure Speech (fa-IR voices from the language-support page; REST shape unverified)', () => {
  it('builds SSML with the escaped spoken text and one of the two fa-IR voices', () => {
    const f = fx('azure-tts');
    expect(asCall(buildAzureTts(f.request, String(f.region)))).toEqual(f.call);
    expect(() => buildAzureTts({ lang: 'fa', text: 'x', voiceId: 'en-US-Someone' }, 'westeurope')).toThrow(/Persian/);
    expect(() => buildAzureTts({ lang: 'fa', text: 'x', voiceId: 'fa-IR-FaridNeural' }, 'West Europe')).toThrow(/region/);
  });

  it('parses RIFF audio, with approximate timing (no alignment)', async () => {
    const wav = mockSpeech('سلام', 'fa').wav;
    expect(parseAzureTts(wav)).toMatchObject({ mime: 'audio/wav', alignment: null, timing: 'approximate', durationMs: 240 });
    expect(() => parseAzureTts(Buffer.from('nope'))).toThrow(/no audio/);
    setKeys(['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION']);
    const { fetch, calls } = fakeFetch(() => ({ bytes: wav }));
    const r = await azureSpeech.invoke(fx('azure-tts').request, ctxOf({ deps: { fetch } }));
    expect(r.timing).toBe('approximate');
    expect(calls[0]!.headers['Ocp-Apim-Subscription-Key']).toBe(FAKE_KEYS.AZURE_SPEECH_KEY);
  });
});

describe('Lip-sync: Sync and Hedra (async submit → poll → download)', () => {
  for (const [key, c, build] of [
    ['sync-generate', sync, buildSyncGenerate],
    ['hedra-generate', hedra, buildHedraGenerate],
  ] as const) {
    it(`${c.id}: builds the documented request and follows the job to the download`, async () => {
      const f = fx(key) as ReturnType<typeof fx> & { submit: unknown; polls: Record<string, unknown>[]; pollUrl: string; authHeader: string };
      expect(asCall(build(f.request))).toEqual(f.call);
      setKeys(['SYNC_API_KEY', 'HEDRA_API_KEY']);
      let poll = 0;
      const { fetch, calls } = fakeFetch((url, method) => {
        if (method === 'POST') return { json: f.submit };
        if (url === f.pollUrl) return { json: f.polls[Math.min(poll++, f.polls.length - 1)] };
        if (url.startsWith('https://cdn.example.test/')) return { bytes: Buffer.from('mp4-bytes') };
        return undefined;
      });
      const r = await c.invoke(f.request, ctxOf({ deps: { fetch } }));
      expect(r).toMatchObject({ mime: 'video/mp4', mode: 'live' });
      expect(r.video.toString()).toBe('mp4-bytes');
      expect(calls[0]!.headers[f.authHeader]).toBeTruthy();
      expect(calls.at(-1)!.headers[f.authHeader]).toBeUndefined(); // the download link gets no key
    });
  }

  it('a live call needs public https links; a failed job stops with the vendor status', async () => {
    expect(() => buildSyncGenerate({ imageFile: '/a.png', audioFile: '/a.wav', durationMs: 1000, width: 10, height: 10 })).toThrow(/public links/);
    expect(() => buildSyncGenerate({ imageFile: '/a.png', audioFile: '/a.wav', durationMs: 1000, width: 10, height: 10, imageUrl: 'http://x/a.png', audioUrl: 'https://x/a.wav' })).toThrow(/public links/);
    expect(parseJob({ id: 'job-1234', status: 'FAILED', error: 'face not found' }, 'Sync')).toMatchObject({ status: 'failed', error: 'face not found' });
    expect(() => parseJob({ status: 'ok' }, 'Sync')).toThrow(/job id/);
    setKeys(['SYNC_API_KEY']);
    const f = fx('sync-generate');
    const { fetch } = fakeFetch((url, method) => (method === 'POST' ? { json: { id: 'job-1234', status: 'PENDING' } } : { json: { id: 'job-1234', status: 'FAILED', error: 'face not found' } }));
    await expect(sync.invoke(f.request, ctxOf({ deps: { fetch } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e, 'vendor_failed') && /face not found/.test((e as Error).message));
  });

  it('a result link must be a public https host: no IP literal, localhost, local suffix or user:password part', async () => {
    for (const bad of ['http://cdn.example.test/v.mp4', 'https://127.0.0.1/v.mp4', 'https://169.254.169.254/latest', 'https://[::1]/v.mp4', 'https://0x7f000001/v.mp4', 'https://localhost/v.mp4', 'https://box.local/v.mp4', 'https://svc.internal/v.mp4', 'https://intranet/v.mp4', 'https://u:p@cdn.example.test/v.mp4', 'not a url', 42]) {
      expect(publicHttpsUrl(bad), String(bad)).toBeNull();
      expect(parseJob({ id: 'job-1234', status: 'completed', outputUrl: bad }, 'Sync').outputUrl, String(bad)).toBeNull();
    }
    expect(publicHttpsUrl('https://cdn.example.test/v.mp4')).toBe('https://cdn.example.test/v.mp4');
    // A finished job whose only link is private never reaches a download: the poll keeps waiting and then stops.
    setKeys(['SYNC_API_KEY']);
    const f = fx('sync-generate');
    const { fetch, calls } = fakeFetch((url, method) => (method === 'POST' ? { json: { id: 'job-1234', status: 'PENDING' } } : { json: { id: 'job-1234', status: 'COMPLETED', outputUrl: 'https://127.0.0.1/v.mp4' } }));
    await expect(sync.invoke(f.request, ctxOf({ deps: { fetch } }))).rejects.toSatisfy((e: unknown) => isPostmakerError(e));
    expect(calls.some((c) => c.url.includes('127.0.0.1'))).toBe(false);
    expect(SYNC_SHAPE.unverified).toContain('result download hosts (CDN) to allow-list');
    expect(HEDRA_SHAPE.unverified).toContain('result download hosts (CDN) to allow-list');
  });

  it('estimates: Sync $0.13325/s, Hedra unknown → its per-call ceiling ("~$?")', () => {
    const r = { imageFile: '/a', audioFile: '/b', durationMs: 17_000, width: 1080, height: 1920 };
    expect(sync.estimate(r).usdHigh).toBeCloseTo(2.2653, 4);
    expect(hedra.estimate(r)).toMatchObject({ usdLow: 0, usdHigh: 5 });
  });
});

describe('Higgsfield b-roll (Seedance 2.0 image-to-video)', () => {
  it('builds the documented submit with the run’s Idempotency-Key and parses the answer', async () => {
    const f = fx('higgsfield-broll') as ReturnType<typeof fx> & { idempotencyKey: string; submit: Record<string, unknown>; status: Record<string, unknown> };
    expect(asCall(buildBrollSubmit(f.request, f.idempotencyKey))).toEqual(f.call);
    expect(parseSubmit(f.submit)).toMatchObject({ requestId: 'fixture-hf-req-01', statusUrl: 'https://api.higgsfield.ai/requests/fixture-hf-req-01/status' });
    expect(parseSubmit({ request_id: 'abcd1234', status_url: 'https://evil.example/x' }).statusUrl).toBe('https://api.higgsfield.ai/requests/abcd1234/status');
    expect(() => buildBrollSubmit({ ...(f.request as object), durationSec: 20 } as never, f.idempotencyKey)).toThrow(/4 to 15/);
    setKeys(['HF_API_KEY_ID', 'HF_API_KEY_SECRET']);
    const { fetch, calls } = fakeFetch((url, method) => {
      if (method === 'POST') return { json: f.submit };
      if (url.endsWith('/status')) return { json: f.status };
      if (url.startsWith('https://cdn.example.test/')) return { bytes: Buffer.alloc(200, 1), headers: { 'content-type': 'video/mp4' } };
      return undefined;
    });
    const r = await higgsfieldVideo.invoke(f.request, ctxOf({ idempotencyKey: f.idempotencyKey, deps: { fetch, sleep: async () => undefined } }));
    expect(r).toMatchObject({ requestId: 'fixture-hf-req-01', mode: 'live' });
    expect(calls[0]!.headers.Authorization).toBe(`Key ${FAKE_KEYS.HF_API_KEY_ID}:${FAKE_KEYS.HF_API_KEY_SECRET}`);
    expect(calls[0]!.headers['Idempotency-Key']).toBe(f.idempotencyKey);
  });
});

describe('Music', () => {
  it('ElevenLabs Music: documented body with the declared BPM written in the prompt', () => {
    const f = fx('elevenlabs-music');
    expect(asCall(buildElevenlabsMusic(f.request))).toEqual(f.call);
    expect(() => buildElevenlabsMusic({ ...(f.request as object), lengthMs: 1000 } as never)).toThrow(/3 s to 10 min/);
    expect(() => buildElevenlabsMusic({ ...(f.request as object), tempo: null } as never)).toThrow(/BPM/);
    expect(() => buildElevenlabsMusic({ ...(f.request as object), sections: [{ name: 'a', durationMs: 1000 }] } as never)).toThrow(/section/);
    expect(elevenlabsMusic.gates).toContain('terms:elevenlabs-music-studio-games');
    expect(elevenlabsMusic.estimate(f.request)).toMatchObject({ usdHigh: 0.075 });
  });

  it('every music source must declare its tempo; no detection', () => {
    expect(checkTempo({ bpm: 96, downbeatMs: 120 })).toEqual({ bpm: 96, downbeatMs: 120 });
    expect(() => checkTempo(null)).toThrow(/BPM/);
    expect(() => checkTempo({ bpm: 300, downbeatMs: 0 })).toThrow(/BPM/);
    expect(() => checkTempo({ bpm: 100 })).toThrow(/first beat/);
  });

  it('pack music needs the policy, a complete licence, the declared tempo and the locked hash', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    mkdirSync(tmp.dir, { recursive: true });
    const file = path.join(tmp.dir, 'track.wav');
    const audio = clickTrackWav({ bpm: 100, ms: 500 });
    writeFileSync(file, audio);
    const asset = { id: 'm1', kind: 'music' as const, file: 'music/track.wav', sha256: createHash('sha256').update(audio).digest('hex'), tags: [], status: 'approved' as const, approvedBy: 'Example Editor', licence: { type: 'owned' as const, holder: 'Example Studio', source: 'in-house', author: null, acquiredAt: '2026-11-01', proof: null, allowedUses: ['organic' as const], territories: 'worldwide' as const, expiresAt: null, attribution: null, aiGenerated: false } };
    const req = { asset, file, tempo: { bpm: 100, downbeatMs: 0 }, policy: { sources: ['library' as const] }, lengthMs: 500 };
    expect((await packMusic.invoke(req, ctxOf())).sha256).toBe(asset.sha256);
    await expect(packMusic.invoke({ ...req, policy: { sources: ['owner-upload'] } }, ctxOf())).rejects.toThrow(/does not allow/);
    await expect(packMusic.invoke({ ...req, asset: { ...asset, licence: { ...asset.licence, holder: ' ' } } }, ctxOf())).rejects.toThrow(/licence/);
    await expect(packMusic.invoke({ ...req, tempo: null }, ctxOf())).rejects.toThrow(/BPM/);
    await expect(packMusic.invoke({ ...req, asset: { ...asset, sha256: '0'.repeat(64) } }, ctxOf())).rejects.toThrow(/changed/);
  });

  it('owner upload: audio only, under 50 MB, tempo and licence typed; becomes a draft asset with the plan tier', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = path.join(tmp.dir, 'made-by-hand.mp3');
    writeFileSync(file, Buffer.from('ID3 fake mp3'));
    const req = { file, mime: 'audio/mpeg', tempo: { bpm: 120, downbeatMs: 40 }, lengthMs: 30_000, licence: { type: 'vendor-output' as const, holder: 'owner', source: 'a music app (made by hand)', planTier: 'Pro', downloadedAt: '2026-11-05', allowedUses: ['organic' as const] } };
    const r = await customerUpload.invoke(req, ctxOf());
    expect(r.asset).toMatchObject({ kind: 'music', status: 'draft', licence: { type: 'vendor-output', aiGenerated: true } });
    expect(r.asset!.licence.proof).toMatch(/^plan: Pro; recorded \d{4}-\d{2}-\d{2}$/);
    await expect(customerUpload.invoke({ ...req, mime: 'video/mp4' }, ctxOf())).rejects.toThrow(/audio file/);
    await expect(customerUpload.invoke({ ...req, licence: { ...req.licence, downloadedAt: 'yesterday' } }, ctxOf())).rejects.toThrow(/where the track is from/);
    expect(uploadAsset(req, 'a'.repeat(64)).file).toBe(`uploads/${'a'.repeat(64)}.mp3`);
  });
});

describe('ffmpeg loudness (fixture captured from a local run on a synthetic tone)', () => {
  it('parses the loudnorm JSON report and runs with a PATH-only environment', async () => {
    const report = readFileSync(path.join(__dirname, 'fixtures/ffmpeg-loudnorm.txt'), 'utf8');
    expect(parseLoudnorm(report)).toEqual({ inputI: -22.05, inputTp: -18.06, inputLra: 0, inputThresh: -32.05, targetOffset: -0.05 });
    expect(() => parseLoudnorm('no json')).toThrow(/loudness/);
    expect(loudnormArgs('/a.wav')).toEqual(['-hide_banner', '-nostats', '-i', '/a.wav', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
    setKeys();
    const { spawn, calls } = fakeSpawn({ stderr: report, code: 0 });
    const ff = makeFfmpeg({ bin: '/fake/ffmpeg' });
    const r = await ff.invoke({ file: '/a.wav' }, ctxOf({ deps: { spawn } }));
    expect(r.loudness.inputI).toBe(-22.05);
    expect(Object.keys(calls[0]!.env)).toEqual(['PATH']);
  });
});

describe('Mocks', () => {
  it('speech: 220 Hz sine, 60 ms per character (fa) / 55 ms (en), synthetic alignment', () => {
    const fa = mockSpeech('سلام دنیا', 'fa');
    expect(fa.durationMs).toBe(9 * 60);
    expect(wavDurationMs(fa.wav)).toBe(540);
    expect(fa.alignment.characters).toHaveLength(9);
    expect(fa.alignment.character_end_times_seconds.at(-1)).toBe(0.54);
    expect(mockSpeech('hello', 'en').durationMs).toBe(275);
    // 220 Hz: count rising zero crossings over the first second of a longer tone
    const long = mockSpeech('x'.repeat(20), 'fa').wav;
    let rising = 0;
    for (let i = 1; i < 48_000; i++) if (long.readInt16LE(44 + (i - 1) * 2) < 0 && long.readInt16LE(44 + i * 2) >= 0) rising++;
    expect(Math.abs(rising - 220)).toBeLessThanOrEqual(1);
  });

  it('music: a click track at the declared BPM from the declared downbeat', () => {
    expect(beatTimesMs(120, 2_000, 250)).toEqual([250, 750, 1250, 1750]);
    const wav = clickTrackWav({ bpm: 120, ms: 2_000, downbeatMs: 250 });
    const at = (ms: number) => Math.abs(wav.readInt16LE(44 + Math.round((ms / 1000) * 48_000 + 12) * 2));
    expect(at(250)).toBeGreaterThan(1000);
    expect(at(500)).toBe(0);
    expect(wavDurationMs(clickTrackWav({ ms: 1000 }))).toBe(1000);
  });

  it('image: a flat card with the first 60 characters of the prompt', async () => {
    expect(mockCardText(`  ${'a'.repeat(80)}  `)).toBe('a'.repeat(60));
    const png = await mockCardPng('A <calm> & bright card', 320, 400);
    const sharp = (await import('sharp')).default;
    expect(await sharp(png).metadata()).toMatchObject({ width: 320, height: 400, format: 'png' });
  });

  it('lip-sync and b-roll mocks are exact ffmpeg argument lists (mouth box pulse, Ken-Burns pan)', () => {
    const m = mouthBoxArgs({ image: '/s.png', durationMs: 1500, out: '/o.mp4', w: 1080, h: 1920, box: { x: 400, y: 1000, w: 200, h: 60 } });
    expect(m.join(' ')).toContain("drawbox=x=400:y=1000:w=200:h=60:color=black@0.6:t=fill:enable='lt(mod(t,0.24),0.12)'");
    expect(m).toContain('1.500');
    const k = kenBurnsArgs({ image: '/s.png', durationMs: 2000, out: '/o.mp4', w: 1080, h: 1920 });
    expect(k.join(' ')).toMatch(/zoompan=z='min\(zoom\+0\.002000,1\.12\)':d=60:.*s=1080x1920:fps=30/);
  });
});

describe('redaction', () => {
  it('removes saved key values, auth headers, sk-ant- tokens and Key id:secret pairs', () => {
    setKeys();
    const r = redactor(Object.keys(FAKE_KEYS));
    const text = `xi-api-key: ${FAKE_KEYS.ELEVENLABS_API_KEY} Authorization: Key ${FAKE_KEYS.HF_API_KEY_ID}:${FAKE_KEYS.HF_API_KEY_SECRET} ${FAKE_KEYS.SIGNAL_ANTHROPIC_API_KEY} sk-ant-other-abcdef Bearer abcdefghijkl ${encodeURIComponent(FAKE_KEYS.SYNC_API_KEY)}`;
    const out = r(text);
    for (const v of Object.values(FAKE_KEYS)) if (v.length > 12) expect(out).not.toContain(v);
    expect(out).not.toMatch(/sk-ant-/);
    expect(out).not.toMatch(/Bearer abc/);
  });

  it('estimateCost: unknown price → minimum…ceiling; none → 0', () => {
    expect(estimateCost(hedra.costModel, 10, 1, 'x')).toMatchObject({ usdLow: 0, usdHigh: 5 });
    expect(estimateCost(packMusic.costModel, 10, 1, 'x')).toMatchObject({ usdLow: 0, usdHigh: 0 });
  });
});
