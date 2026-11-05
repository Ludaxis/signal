// GET /api/studio/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — every project's planned and posted
// packages in the range (Studio time-zone days), plus packages that are not planned yet.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { listPackages, type PackageView } from '@/lib/studio/content';
import { listProjects, withProject } from '@/lib/studio/projects';
import { TIMEZONE, zonedParts, isValidDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface CalendarItem {
  project: string;
  id: string;
  title: string;
  status: PackageView['status'];
  format: PackageView['format'];
  when: string | null; // ISO: posted time, else planned time
  kind: 'posted' | 'planned' | 'unplanned';
  thumb: string | null;
  url: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const q = new URL(req.url).searchParams;
  const from = q.get('from');
  const to = q.get('to');
  if (!isValidDate(from) || !isValidDate(to) || from > to) return jsonError(400, 'validation', 'Use from/to as YYYY-MM-DD.');
  // ?project=<id> limits the calendar to one account; without it, every account is shown.
  const only = q.get('project');
  const projects = (await listProjects()).filter((p) => !only || p.id === only);
  const items: CalendarItem[] = [];
  const unplanned: CalendarItem[] = [];
  for (const p of projects) {
    const pkgs = await withProject(p, () => listPackages());
    for (const k of pkgs) {
      if (k.status === 'discarded' || k.status === 'invalid') continue;
      const media = k.files.find((f) => f.role === 'cover') ?? k.files.find((f) => f.role === 'slide');
      const base: Omit<CalendarItem, 'when' | 'kind'> = {
        project: p.id,
        id: k.id,
        title: k.title,
        status: k.status,
        format: k.format,
        thumb: media ? `/api/studio/content/${k.id}/file/${encodeURIComponent(media.name)}?project=${encodeURIComponent(p.id)}` : null,
        url: k.posted?.url ?? null,
      };
      // Posted: when it went out. Being sent: when it was sent. Otherwise: its planned time.
      const inFlight = ['sending', 'submitted', 'uncertain'].includes(k.status) ? k.dispatch?.claimed_at : undefined;
      const when = k.posted?.posted_at ?? inFlight ?? k.plannedFor;
      if (!when) {
        if (k.status !== 'failed') unplanned.push({ ...base, when: null, kind: 'unplanned' });
        continue;
      }
      const day = zonedParts(when).date;
      if (day >= from && day <= to) items.push({ ...base, when, kind: k.posted || inFlight ? 'posted' : 'planned' });
    }
  }
  items.sort((a, b) => (a.when! < b.when! ? -1 : 1));
  return NextResponse.json(
    { timezone: TIMEZONE, projects: projects.map((p) => ({ id: p.id, name: p.name, handle: p.handle })), items, unplanned },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
