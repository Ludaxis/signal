// `music.upload` (pack): the owner drops a track they made elsewhere under
// their own plan (for example by hand in a music app) on the music step, and types its BPM, where its first beat
// starts, their plan tier and the download date. Signal never detects the tempo and never runs a browser agent
// for music.
//
// The upload reuses the reference upload rules (references.ts): the declared Content-Length is checked first, the body
// is streamed to a temp file with a running byte count that is the real limit, the type is read from the first bytes,
// and a form upload is limited to 20 MB. Audio only (WAV, MP3, M4A, OGG, FLAC), up to the owner-upload connector's
// 50 MB. The track enters the project library (`postmaker/assets/library.json`) as a `draft` music asset tagged
// `owner-upload` with its declared grid (`declaredBy: 'user'`) and a complete licence record (holder, source,
// download date, plan tier, allowed uses); the final render refuses it until a person approves it.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { UPLOAD_MAX_BYTES, uploadAsset } from './connectors/music';
import { PostmakerError } from './errors';
import { updateProjectLibrary } from './executors/art-assets';
import type { LibraryAsset } from './pack/load';
import { decodeWav, durationMsOf } from './render/pcm';
import { ensureDir, FILE_MODE } from './store/fs';
import { projectAssetsDir } from './store/paths';
import type { AssetUse, MusicMeta } from './types';

export const MUSIC_UPLOAD_MAX_BYTES = UPLOAD_MAX_BYTES;
export const MUSIC_FORM_MAX_BYTES = 20 * 1024 * 1024;

const bad = (message: string) => new PostmakerError(400, 'validation', message);
export const notAudio = () => bad('This file could not be read. Use a WAV, MP3, M4A, OGG or FLAC track.');

/** The audio type from the first bytes (never from a name or a header the client sends). */
export function sniffAudio(h: Uint8Array): { ext: string; mime: string } | null {
  const b = Buffer.from(h);
  const s = (a: number, z: number) => b.subarray(a, z).toString('latin1');
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { ext: '.wav', mime: 'audio/wav' };
  if (b.length >= 4 && s(0, 4) === 'fLaC') return { ext: '.flac', mime: 'audio/flac' };
  if (b.length >= 4 && s(0, 4) === 'OggS') return { ext: '.ogg', mime: 'audio/ogg' };
  if (b.length >= 12 && s(4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom|dash)$/.test(s(8, 12))) return { ext: '.m4a', mime: 'audio/mp4' };
  if (b.length >= 3 && s(0, 3) === 'ID3') return { ext: '.mp3', mime: 'audio/mpeg' };
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return { ext: '.mp3', mime: 'audio/mpeg' };
  return null;
}

export interface MusicUploadFields {
  tempo: { bpm: number; downbeatMs: number; beatsPerBar: 3 | 4 };
  loopable: boolean;
  licence: { type: 'owned' | 'vendor-output' | 'stock'; holder: string; source: string; planTier: string; downloadedAt: string; allowedUses: AssetUse[] };
}

const USES = new Set<AssetUse>(['organic', 'paid-ads', 'store-listing']);

/** The typed fields of an upload (query parameters or form fields); a plain 400 for the first missing one. */
export function parseUploadFields(get: (k: string) => string | null): MusicUploadFields {
  const num = (k: string) => {
    const v = get(k);
    return v === null || v.trim() === '' ? null : Number(v);
  };
  const bpm = num('bpm');
  if (bpm === null || !Number.isFinite(bpm) || bpm < 60 || bpm > 200) throw bad('Type the track’s BPM (60 to 200).');
  const downbeatMs = num('downbeatMs');
  if (downbeatMs === null || !Number.isFinite(downbeatMs) || downbeatMs < 0 || downbeatMs >= 10_000) throw bad('Type where the first beat starts (0 to 10 s, in ms).');
  const bpb = num('beatsPerBar') ?? 4;
  if (bpb !== 3 && bpb !== 4) throw bad('Beats per bar must be 3 or 4.');
  const plan = (get('plan') ?? '').trim();
  if (!plan || plan.length > 60) throw bad('Type the plan you made the track under.');
  const date = (get('downloadedAt') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date))) throw bad('Type the date you downloaded the track.');
  const type = (get('type') ?? 'vendor-output').trim();
  if (type !== 'owned' && type !== 'vendor-output' && type !== 'stock') throw bad('The licence type must be owned, vendor-output or stock.');
  const holder = (get('holder') ?? '').trim() || 'owner';
  const source = (get('source') ?? '').trim() || 'owner upload';
  if (holder.length > 120 || source.length > 200) throw bad('Keep the holder and the source short.');
  const uses = (get('uses') ?? 'organic').split(',').map((x) => x.trim()).filter(Boolean) as AssetUse[];
  if (!uses.length || uses.some((u) => !USES.has(u))) throw bad('Allowed uses are organic, paid-ads and store-listing.');
  const loop = get('loopable');
  return { tempo: { bpm, downbeatMs, beatsPerBar: bpb }, loopable: loop === '1' || loop === 'true', licence: { type, holder, source, planTier: plan, downloadedAt: date, allowedUses: [...new Set(uses)] } };
}

/**
 * Streams `body` into the project library as a draft music asset. `declaredBytes` (Content-Length) is checked first
 * when present; the running count is the real limit. The same bytes twice give the same asset (nothing is added).
 */
export async function addMusicUpload(root: string, body: ReadableStream<Uint8Array> | null, o: { fields: MusicUploadFields; declaredBytes?: number | null; now?: number }): Promise<LibraryAsset> {
  if (!body) throw notAudio();
  if (o.declaredBytes != null && o.declaredBytes > MUSIC_UPLOAD_MAX_BYTES) throw bad('Tracks can be up to 50 MB.');
  const dir = projectAssetsDir(root);
  const incoming = path.join(dir, '.incoming');
  await ensureDir(incoming);
  const tmp = path.join(incoming, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const out = createWriteStream(/* turbopackIgnore: true */ tmp, { flags: 'wx', mode: FILE_MODE });
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  done.catch(() => undefined);
  const hash = createHash('sha256');
  let total = 0;
  let head = Buffer.alloc(0);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (out.errored || out.destroyed) throw out.errored ?? new Error('The upload file was closed.');
      if (!value?.length) continue;
      total += value.length;
      if (total > MUSIC_UPLOAD_MAX_BYTES) throw bad('Tracks can be up to 50 MB.');
      if (head.length < 16) head = Buffer.concat([head, Buffer.from(value.subarray(0, 16))]).subarray(0, 16);
      if (head.length >= 16 && !sniffAudio(head)) throw notAudio();
      hash.update(value);
      if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once('drain', r)), done]);
    }
    out.end();
    await done;
    const type = sniffAudio(head);
    if (!type || total === 0) throw notAudio();
    const sha = hash.digest('hex');
    const bytes = type.ext === '.wav' ? await fs.readFile(/* turbopackIgnore: true */ tmp) : null;
    const pcm = bytes ? decodeWav(bytes) : null;
    const now = new Date(o.now ?? Date.now());
    const base = uploadAsset({ file: `x${type.ext}`, mime: type.mime, tempo: o.fields.tempo, lengthMs: 0, licence: o.fields.licence }, sha, now);
    const music: MusicMeta = { bpm: o.fields.tempo.bpm, firstDownbeatMs: o.fields.tempo.downbeatMs, beatsPerBar: o.fields.tempo.beatsPerBar, declaredBy: 'user', loopable: o.fields.loopable };
    const asset: LibraryAsset = {
      ...base,
      file: `files/${base.id}${type.ext}`,
      ...(pcm ? { durationMs: Math.round(durationMsOf(pcm)) } : {}),
      licence: { ...base.licence, plan: o.fields.licence.planTier, proof: `plan: ${o.fields.licence.planTier}; recorded ${now.toISOString().slice(0, 10)}` },
      music,
    };
    const dest = path.join(dir, asset.file);
    return await updateProjectLibrary(root, async (all) => {
      const same = all.find((a) => a.id === asset.id);
      if (same) return { ...same };
      await ensureDir(path.dirname(dest));
      await fs.rename(/* turbopackIgnore: true */ tmp, dest);
      all.push(asset);
      return { ...asset };
    });
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    out.destroy();
    throw e;
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ tmp).catch(() => undefined);
  }
}
