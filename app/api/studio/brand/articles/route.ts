// GET /api/studio/brand/articles?project= — pages found on the project's website (sitemap or feed).
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { BrandError, discoverArticles } from '@/lib/studio/brand';
import { listPackages } from '@/lib/studio/content';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async () => {
    try {
      const urls = await discoverArticles();
      const used = new Set((await listPackages()).map((p) => p.source?.category));
      return NextResponse.json({ pages: urls.map((u) => ({ url: u, used: used.has(u) })) });
    } catch (e) {
      if (e instanceof BrandError) return jsonError(e.status, 'validation', e.message);
      return jsonError(500, 'internal', 'Could not read the website.');
    }
  });
}
