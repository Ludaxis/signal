// GET /api/studio/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — every project's planned and posted
// packages in the range, plus packages that are not planned yet. Days are counted in the calendar's
// time zone: the project's own (with ?project=), or the zone all shown projects share; projects
// without a time zone use the default zone, so older projects see exactly the days they saw before.
// The Studio's "All accounts" grid sends ?scope=all: its days are always counted in the default zone, and each
// project's chips are labelled in that project's own zone.
// `repeats` lists the open slots Repeat templates will fill (only while Repeat is on).
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { jsonError } from '@/lib/server/security';
import { ContentError, IN_FLIGHT, goesOutAt, listPackages, type PackageView } from '@/lib/studio/content';
import { listProjects, withProject } from '@/lib/studio/projects';
import { listCampaigns } from '@/lib/studio/campaigns';
import { isValidDate } from '@/lib/time';
import { comparePackageIds } from '@/lib/studio/package-id';
import { DEFAULT_TIME_ZONE, partsIn, projectTimeZone, timeZoneLabel } from '@/lib/studio/time';
import { addDays } from '@/lib/time';
import { repeatSlotsIn } from '@/lib/studio/postmaker/repeat-calendar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CalendarItem {
  project: string;
  id: string;
  title: string;
  status: PackageView['status'];
  format: PackageView['format'];
  when: string | null; // ISO: posted time, else planned time
  kind: 'posted' | 'planned' | 'unplanned';
  thumb: string | null;
  url: string | null;
  /** The campaign the post was made for (Calendar's `?campaign=<id>` filter). */
  campaign: { id: string; name: string } | null;
}

/** An open slot a Repeat template will fill (read only; listed only while Repeat is on). */
interface CalendarRepeat {
  project: string;
  template: string;
  name: string;
  when: string;
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
  const allGrid = !only && q.get('scope') === 'all';
  try {
    return await build(from, to, only, allGrid);
  } catch (e) {
    // A plain JSON error (never a bare 500) so the Calendar and Today can say what went wrong.
    return jsonError(500, 'internal', e instanceof ContentError ? `Could not load the calendar: ${e.message}` : 'Could not load the calendar. Try again.');
  }
}

async function build(from: string, to: string, only: string | null, allGrid = false): Promise<Response> {
  const projects = (await listProjects()).filter((p) => !only || p.id === only);
  const zones = [...new Set(projects.map((p) => projectTimeZone(p)))];
  // Mixed zones across accounts, or the "All accounts" grid: the default zone (each project still lists its own).
  const timezone = !allGrid && zones.length === 1 ? zones[0]! : DEFAULT_TIME_ZONE;
  const items: CalendarItem[] = [];
  const unplanned: CalendarItem[] = [];
  // Campaign names for the filter chip, even in a week where the campaign has no post (a broken store lists none).
  const campaigns: { id: string; project: string; name: string }[] = [];
  const repeats: CalendarRepeat[] = [];
  for (const p of projects) {
    for (const c of await withProject(p, () => listCampaigns()).catch(() => [])) campaigns.push({ id: c.id, project: p.id, name: c.name });
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
        campaign: k.campaign ? { id: k.campaign.id, name: k.campaign.name } : null,
      };
      // Same day rule as the one-post-per-day limit (goesOutAt): posted time; scheduled time while scheduled
      // or in flight from a schedule; else when it was sent. Otherwise: its planned time.
      const inFlight = IN_FLIGHT.includes(k.status) && Boolean(k.dispatch);
      const when = goesOutAt(k) ?? k.plannedFor;
      if (!when) {
        if (k.status !== 'failed') unplanned.push({ ...base, when: null, kind: 'unplanned' });
        continue;
      }
      const day = partsIn(timezone, when).date;
      if (day >= from && day <= to) items.push({ ...base, when, kind: k.posted || inFlight ? 'posted' : 'planned' });
    }
    // Repeat templates' open slots (a day either side: the grid's zone may differ from the project's own).
    const open = await withProject(p, () => repeatSlotsIn(p, addDays(from, -1), addDays(to, 1), pkgs)).catch(() => []);
    for (const r of open) {
      const day = partsIn(timezone, r.at).date;
      if (day >= from && day <= to) repeats.push({ project: p.id, template: r.template, name: r.name, when: r.at });
    }
  }
  // Same instant: by project, then package number (numeric, so 99 comes before 100).
  items.sort((a, b) => (a.when! < b.when! ? -1 : a.when! > b.when! ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : comparePackageIds(a.id, b.id)));
  return NextResponse.json(
    { timezone, timeZoneLabel: timeZoneLabel(timezone), projects: projects.map((p) => ({ id: p.id, name: p.name, handle: p.handle, timeZone: projectTimeZone(p) })), items, unplanned, campaigns, repeats },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
