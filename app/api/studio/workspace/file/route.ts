// GET /api/studio/workspace/file?project=&folder=<id>&rel=<path>   thumbnail of an image in a linked folder (WebP, max 480 px)
// GET /api/studio/workspace/file?project=&figma=<name>[&full=1]    a frame exported from Figma (PNG)
// Images are always re-encoded, so SVG or other active content is never served as-is.
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { FolderError, getFolder, kindOf, resolveInside } from '@/lib/studio/folders';
import { FigmaError, readImport } from '@/lib/studio/figma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_SOURCE = 60_000_000;
const img = (buf: Buffer, type: string) => new Response(new Uint8Array(buf), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const q = new URL(req.url).searchParams;
  return inProject(req, null, async (project) => {
    try {
      const figma = q.get('figma');
      if (figma) {
        const png = await readImport(project, figma);
        if (q.get('full') === '1') return img(png, 'image/png');
        return img(await sharp(png).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(), 'image/webp');
      }
      const folder = await getFolder(project.id, q.get('folder') ?? '');
      const rel = q.get('rel') ?? '';
      if (kindOf(rel) !== 'image') return jsonError(415, 'validation', 'Previews are for images only.');
      const real = await resolveInside(folder, rel);
      const st = await fs.stat(/* turbopackIgnore: true */ real);
      if (st.size > MAX_SOURCE) return jsonError(413, 'validation', 'That image is too large to preview.');
      const thumb = await sharp(await fs.readFile(/* turbopackIgnore: true */ real), { limitInputPixels: 120_000_000 }).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      return img(thumb, 'image/webp');
    } catch (e) {
      if (e instanceof FolderError || e instanceof FigmaError) return jsonError(e.status, 'not_found', e.message);
      return jsonError(415, 'validation', 'This file cannot be previewed.');
    }
  });
}
