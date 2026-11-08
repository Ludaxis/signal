// POST /api/studio/postmaker/music?project=&bpm=&downbeatMs=&beatsPerBar=&plan=&downloadedAt=[&type=&holder=&source=&uses=&loopable=]
//   body = the track itself (any Content-Type; the type is read from its first bytes): WAV, MP3, M4A, OGG or FLAC up to
//          50 MB, streamed to disk, never buffered whole
//   multipart/form-data with one `file` field: the same rules, for files up to 20 MB
// The `music.upload` action: the track enters the project library as a draft music asset with its declared
// grid and licence record (lib/studio/postmaker/music-upload.ts). Session and same-origin checks first.
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { pmError, pmFail, pmJson, postmakerOffRefusal } from '@/lib/studio/postmaker/api/http';
import { PostmakerError } from '@/lib/studio/postmaker/errors';
import { addMusicUpload, MUSIC_FORM_MAX_BYTES, parseUploadFields, type MusicUploadFields } from '@/lib/studio/postmaker/music-upload';
import { rootOf } from '@/lib/studio/postmaker/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const off = await postmakerOffRefusal('music.upload');
  if (off) return off;
  const q = new URL(req.url).searchParams;
  let fields: MusicUploadFields;
  try {
    fields = parseUploadFields((k) => q.get(k));
  } catch (e) {
    return e instanceof PostmakerError ? pmError(e.status, e.code, e.message) : pmError(400, 'validation', 'Bad request.');
  }
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  const declaredHeader = req.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  return inProject(req, null, async (project) => {
    try {
      let body: ReadableStream<Uint8Array> | null = req.body;
      let size = declared !== null && Number.isFinite(declared) ? declared : null;
      if (type.startsWith('multipart/form-data')) {
        if (size === null || size > MUSIC_FORM_MAX_BYTES + 64 * 1024) return pmError(400, 'validation', 'Send large tracks as the file itself, not as a form.');
        const form = await req.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') return pmError(400, 'validation', 'Drop a track.');
        body = file.stream();
        size = file.size;
      }
      return pmJson({ asset: await addMusicUpload(rootOf(project), body, { fields, declaredBytes: size }) });
    } catch (e) {
      return pmFail(e, 'music-upload');
    }
  });
}
