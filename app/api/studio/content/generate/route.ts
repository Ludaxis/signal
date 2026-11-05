// POST /api/studio/content/generate {format: Format, brief?, articleUrl?}
// Builds one package with the chosen generator. The package lands in Review as
// "Ready for your approval"; nothing is approved or posted here.
import { NextResponse, type NextRequest } from 'next/server';
import { ContentError, loadPackage } from '@/lib/studio/content';
import { FORMATS, generatePackage, type Format } from '@/lib/studio/generate';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { inProject } from '@/lib/server/studioProject';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

let running = false;

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let body: { format?: unknown; project?: unknown; articleUrl?: unknown; brief?: { prompt?: unknown; headline?: unknown; caption?: unknown } } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const f = body.format;
  if (!FORMATS.includes(f as Format)) return jsonError(400, 'validation', 'Unknown format.');
  if (running) return jsonError(409, 'conflict', 'A package is already being generated.');
  running = true;
  try {
    return await inProject(req, body.project, async () => {
      const b = body.brief;
      const brief = b ? { prompt: String(b.prompt ?? ''), headline: b.headline ? String(b.headline) : undefined, caption: b.caption ? String(b.caption) : undefined } : undefined;
      const articleUrl = typeof body.articleUrl === 'string' ? body.articleUrl.slice(0, 500) : undefined;
      const { id } = await generatePackage({ format: f as Format, brief, articleUrl });
      return NextResponse.json({ package: await loadPackage(id) });
    });
  } catch (e) {
    if (e instanceof ContentError) return jsonError(e.status, e.status === 409 ? 'conflict' : 'validation', e.message);
    return jsonError(500, 'internal', `Could not generate the package: ${String((e as Error).message ?? e).slice(0, 200)}`);
  } finally {
    running = false;
  }
}
