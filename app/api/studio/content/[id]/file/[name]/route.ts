// GET /api/studio/content/:id/file/:name — serve a file listed in the package (preview/download).
import type { NextRequest } from 'next/server';
import { ContentError, downloadName, isPackageId, readPackageFile } from '@/lib/studio/content';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { inProject } from '@/lib/server/studioProject';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; name: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { id, name } = await ctx.params;
  if (!isPackageId(id)) return jsonError(404, 'not_found', 'Not found.');
  return inProject(req, null, async (project) => {
    try {
      const f = await readPackageFile(id, name);
      const download = new URL(req.url).searchParams.get('download') === '1';
      return new Response(new Uint8Array(f.body), {
        headers: {
          'Content-Type': f.type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(download ? { 'Content-Disposition': `attachment; filename="${downloadName(project.id, id, name)}"` } : {}),
        },
      });
    } catch (e) {
      if (e instanceof ContentError) return jsonError(e.status, 'not_found', e.message);
      return jsonError(500, 'internal', 'Could not read the file.');
    }
  });
}
