// GET  /api/studio/brand?project= — the project's brand kit, and whether its pack ships a Persian pronunciation list.
// GET  /api/studio/brand?project=&view=lexicon — that list (read-only).
// POST /api/studio/brand {project, action:'import-website', url} | {action:'import-folder', dir} | {action:'update', patch}
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { BrandError, importFolder, importWebsite, loadBrand, updateBrand } from '@/lib/studio/brand';
import { packLexiconFa } from '@/lib/studio/pack-lexicon';
import { projectTimeZone } from '@/lib/studio/time';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const view = new URL(req.url).searchParams.get('view');
  return inProject(req, null, async (project) => {
    const lexicon = await packLexiconFa(project);
    if (view === 'lexicon') return NextResponse.json({ lexicon }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ kit: await loadBrand(), pack: { lexicon: lexicon ? { count: lexicon.count } : null }, timeZone: projectTimeZone(project) }, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { project?: unknown; action?: unknown; url?: unknown; dir?: unknown; patch?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async () => {
    try {
      if (b.action === 'import-website' && typeof b.url === 'string') return NextResponse.json({ kit: await importWebsite(b.url.slice(0, 300)) });
      if (b.action === 'import-folder' && typeof b.dir === 'string') return NextResponse.json({ kit: await importFolder(b.dir.slice(0, 500)) });
      if (b.action === 'update' && b.patch && typeof b.patch === 'object') return NextResponse.json({ kit: await updateBrand(b.patch as Parameters<typeof updateBrand>[0]) });
      return jsonError(400, 'validation', 'Unknown action.');
    } catch (e) {
      if (e instanceof BrandError) return jsonError(e.status, 'validation', e.message);
      return jsonError(500, 'internal', `Import failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
    }
  });
}
