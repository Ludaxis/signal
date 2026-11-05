// GET /api/studio/brand/file/:name?project= — the brand kit's logo or hero image.
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { brandFile } from '@/lib/studio/brand';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { name } = await ctx.params;
  if (!/^(logo|og)\.png$/.test(name)) return jsonError(404, 'not_found', 'Not found.');
  return inProject(req, null, async () => {
    try {
      return new Response(new Uint8Array(await brandFile(name)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return jsonError(404, 'not_found', 'Not found.');
    }
  });
}
