// GET  /api/studio/projects — projects with their account posting settings.
// POST /api/studio/projects — create a project from the wizard ({check: true} only validates).
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { ProjectError, accountSettings, postingActive, checkNewProject, createProject, listProjects, slugify, type NewProject } from '@/lib/studio/projects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const tilde = (p?: string) => (p ? p.replace(process.env.HOME ?? '\u0000', '~') : p);

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const projects = await listProjects();
  const rows = await Promise.all(
    projects.map(async (p) => {
      const a = await accountSettings(p.id);
      return {
        id: p.id,
        name: p.name,
        handle: p.handle,
        uploadPostProfile: p.uploadPostProfile,
        contentDir: tilde(p.contentDir),
        account: a ? { active: postingActive(a), ends_at: a.ends_at, max_posts: a.max_posts, max_per_day: a.max_per_day, posting: a.posting, codex_images: a.codex_images, verified: a.verified ?? null } : null,
      };
    }),
  );
  return NextResponse.json({ projects: rows, uploadPostKey: Boolean(process.env.UPLOAD_POST_API_KEY) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: Partial<NewProject> & { check?: boolean };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  const input: NewProject = {
    name: String(b.name ?? '').slice(0, 80),
    id: b.id ? String(b.id).slice(0, 40) : slugify(String(b.name ?? '')),
    handle: String(b.handle ?? '').slice(0, 80),
    uploadPostProfile: String(b.uploadPostProfile ?? '').slice(0, 80),
    contentDir: b.contentDir ? String(b.contentDir).slice(0, 500) : undefined,
  };
  if (b.check) return NextResponse.json({ errors: await checkNewProject(input), id: input.id });
  try {
    const p = await createProject(input);
    return NextResponse.json({ project: { id: p.id, name: p.name, handle: p.handle } });
  } catch (e) {
    if (e instanceof ProjectError) return jsonError(e.status, 'validation', e.message);
    return jsonError(500, 'internal', 'Could not create the project.');
  }
}
