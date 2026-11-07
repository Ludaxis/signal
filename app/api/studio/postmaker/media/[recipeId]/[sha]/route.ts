// GET /api/studio/postmaker/media/[recipeId]/[sha256]?project=   streams an object referenced by that recipe.
// 400 for a malformed recipe id or a value that is not 64 lowercase hex (so `..`, separators and encodings never
// reach the file system); 404 for a hash that this recipe does not reference (also when another recipe does).
// Range requests (one range) answer 206; the type comes from the ArtifactRef, and only media and JSON types are sent
// inline (everything else is a download); nosniff, no-store.
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { parseRange, pmError, pmFail } from '@/lib/studio/postmaker/api/http';
import { recipeObject } from '@/lib/studio/postmaker/service';
import { RECIPE_ID_RE, SHA_RE } from '@/lib/studio/postmaker/store/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ recipeId: string; sha: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { recipeId, sha } = await ctx.params;
  if (typeof recipeId !== 'string' || !RECIPE_ID_RE.test(recipeId)) return pmError(400, 'validation', 'Unknown recipe.');
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return pmError(400, 'validation', 'Not a file id.');
  return inProject(req, null, async (project) => {
    try {
      const obj = await recipeObject(project, recipeId, sha);
      let size: number;
      try {
        size = (await fs.stat(/* turbopackIgnore: true */ obj.file)).size;
      } catch {
        return pmError(404, 'not_found', 'Not found.');
      }
      const headers: Record<string, string> = {
        'Content-Type': obj.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': obj.inline ? 'inline' : 'attachment',
      };
      const range = parseRange(req.headers.get('range'), size);
      if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
      const { start, end } = range ?? { start: 0, end: size - 1 };
      const body = size === 0 ? null : (Readable.toWeb(createReadStream(/* turbopackIgnore: true */ obj.file, { start, end })) as ReadableStream<Uint8Array>);
      headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (e) {
      return pmFail(e, 'media');
    }
  });
}
