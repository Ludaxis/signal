// POST /api/studio/postmaker/references?project=&rights=own|third-party-structure-only
//   body = the file itself (any Content-Type; the type is read from its first bytes): MP4/MOV ≤ 500 MB and ≤ 300 s,
//          PNG/JPG/WebP ≤ 20 MB; streamed to disk, never buffered whole
//   multipart/form-data with one `file` field: the same rules, for files up to 20 MB (larger videos go as the body)
//   JSON {project, url, rights?}: a page link, read once through getPublic; social-platform links are refused with
//          "Download it and drop the file"
// Answers the stored `Reference`. Session and same-origin checks first.
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { pmError, pmFail, pmJson, postmakerOffRefusal } from '@/lib/studio/postmaker/api/http';
import { IMAGE_MAX_BYTES } from '@/lib/studio/postmaker/media-probe';
import { addReferenceFile, addReferenceLink } from '@/lib/studio/postmaker/references';
import { rootOf } from '@/lib/studio/postmaker/service';
import type { Reference } from '@/lib/studio/postmaker/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const rightsOf = (v: unknown): Reference['rights'] | null => (v === undefined || v === null || v === '' ? 'third-party-structure-only' : v === 'own' || v === 'third-party-structure-only' ? v : null);

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const off = await postmakerOffRefusal('reference.add'); // adding a reference writes to the store
  if (off) return off;
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  const declaredHeader = req.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (type.startsWith('application/json')) {
    let b: { project?: unknown; url?: unknown; rights?: unknown };
    try {
      const raw = await req.text();
      if (raw.length > 10_000) return pmError(400, 'validation', 'Request too large.');
      b = JSON.parse(raw) as typeof b;
    } catch {
      return pmError(400, 'validation', 'Bad request.');
    }
    const rights = rightsOf(b.rights);
    if (typeof b.url !== 'string' || b.url.length > 2000 || !rights) return pmError(400, 'validation', 'Paste a full link, like https://example.com/page.');
    return inProject(req, b.project, async (project) => {
      try {
        return pmJson({ reference: await addReferenceLink(rootOf(project), project, b.url as string, { rights, by: user.email }) });
      } catch (e) {
        return pmFail(e, 'reference-link');
      }
    });
  }
  const q = new URL(req.url).searchParams;
  const rights = rightsOf(q.get('rights'));
  if (!rights) return pmError(400, 'validation', 'rights must be own or third-party-structure-only.');
  return inProject(req, null, async (project) => {
    try {
      let body: ReadableStream<Uint8Array> | null = req.body;
      let size = declared !== null && Number.isFinite(declared) ? declared : null;
      if (type.startsWith('multipart/form-data')) {
        if (size === null || size > IMAGE_MAX_BYTES + 64 * 1024) return pmError(400, 'validation', 'Send large videos as the file itself, not as a form.');
        const form = await req.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') return pmError(400, 'validation', 'Drop a video or an image.');
        body = file.stream();
        size = file.size;
      }
      return pmJson({ reference: await addReferenceFile(rootOf(project), project, body, { declaredBytes: size, rights, by: user.email }) });
    } catch (e) {
      return pmFail(e, 'reference-file');
    }
  });
}
