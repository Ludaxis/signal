// POST /api/studio/postmaker/uploads?project=
//   body = the file itself (any Content-Type; the type is read from its first bytes): MP4/MOV ≤ 500 MB and ≤ 300 s,
//          PNG/JPG/WebP ≤ 20 MB, WAV ≤ 100 MB; streamed to disk, never buffered whole
//   multipart/form-data with one `file` field: the same rules, for files up to 20 MB (larger files go as the body)
// Answers `{ upload: { id, kind, mime, bytes, meta } }`; the id goes into `step.edit` `output.replaceFile` (
// "Replace file"). Same transport as the reference route; session and same-origin checks first, then
// the `postmaker` feature switch.
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { pmError, pmFail, pmJson, postmakerOffRefusal } from '@/lib/studio/postmaker/api/http';
import { IMAGE_MAX_BYTES } from '@/lib/studio/postmaker/media-probe';
import { rootOf } from '@/lib/studio/postmaker/service';
import { addUpload } from '@/lib/studio/postmaker/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const off = await postmakerOffRefusal('step.upload'); // an upload writes to the store
  if (off) return off;
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('application/json')) return pmError(400, 'validation', 'Drop a video, an image or a sound.');
  const declaredHeader = req.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  return inProject(req, null, async (project) => {
    try {
      let body: ReadableStream<Uint8Array> | null = req.body;
      let size = declared !== null && Number.isFinite(declared) ? declared : null;
      if (type.startsWith('multipart/form-data')) {
        if (size === null || size > IMAGE_MAX_BYTES + 64 * 1024) return pmError(400, 'validation', 'Send large files as the file itself, not as a form.');
        const form = await req.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') return pmError(400, 'validation', 'Drop a video, an image or a sound.');
        body = file.stream();
        size = file.size;
      }
      const up = await addUpload(rootOf(project), body, { declaredBytes: size, by: user.email });
      return pmJson({ upload: { id: up.id, kind: up.kind, mime: up.mime, bytes: up.bytes, meta: up.meta } });
    } catch (e) {
      return pmFail(e, 'upload');
    }
  });
}
