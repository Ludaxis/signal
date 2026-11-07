// GET  /api/studio/connections?project=   every connection this project uses, with status only (never values or secrets)
// POST /api/studio/connections {project, action:'check', service}   read-only checks:
//   upload-post → reads the project's Upload-Post profile and its Instagram handle (no upload)
//   claude | codex → runs `<cli> --version` on this machine (no model call, no usage)
// POST {project, action:'connector.test', id}         a Post maker connector's free check (never a paid call)
// POST {project, action:'connector.switch', id, on, acceptTerms?}   a Post maker connector's own switch in
//   signal.config.json; turning a paid service on the first time answers 409 'terms-needed' until the request
//   carries acceptTerms: true (the acceptance is kept in signal.config.json).
// GET also returns `making` (one row per Post maker connector: state line, switch, cost model; never a key) and
// `postmaker.paused` (the Post maker kill switch).
// Instagram connect / test / disconnect stay on /api/studio/instagram.
import { spawn } from 'node:child_process';
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { igContext, igFeature, instagramApiAllowed, schedulerAllowed } from '@/lib/studio/meta';
import { describe, getConnection, unifiedLoginAllowed } from '@/lib/studio/ig-unified';
import { liveState, schedulingAllowed } from '@/lib/studio/dispatch';
import { analyticsAllowed } from '@/lib/studio/analytics';
import { r2Config } from '@/lib/studio/r2';
import { claudeAgentsAllowed } from '@/lib/studio/claude-agent';
import { codexImagesAllowed } from '@/lib/studio/codex';
import { publishingPaused } from '@/lib/studio/safety';
import { currentLimits } from '@/lib/studio/content';
import { loadBrand } from '@/lib/studio/brand';
import { UploadPostError, getUpProfile, profileManagementAllowed, uploadQuota } from '@/lib/studio/uploadpost';
import { accountSettings, markVerified } from '@/lib/studio/projects';
import { cliBin } from '@/lib/studio/tools';
import { projectTimeZone } from '@/lib/studio/time';
import { connectorById, connectorRow, connectorRows, connectorStatus, switchConnector, testConnector } from '@/lib/studio/postmaker/connectors';
import { postmakerPaused } from '@/lib/studio/postmaker/connectors/features';
import { PostmakerError } from '@/lib/studio/postmaker/errors';
import { SettingsError } from '@/lib/studio/app-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const t = setTimeout(() => p.kill('SIGTERM'), 10_000);
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? out.trim().slice(0, 80) : null);
    });
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async (project) => {
    const r2 = r2Config();
    const ctx = await igContext(project);
    const lim = await currentLimits();
    const brand = await loadBrand(project);
    const account = await accountSettings(project.id);
    const body = {
      project: { id: project.id, name: project.name, handle: project.handle, timeZone: projectTimeZone(project) },
      account: { ready: lim.open, reason: lim.reason, expiresAt: Number.isFinite(lim.expiresAt) && lim.expiresAt ? lim.expiresAt : null, maxPerDay: lim.maxPerDay, automaticPosting: lim.dispatch },
      paused: publishingPaused(),
      instagram: {
        unifiedLogin: await unifiedLoginAllowed(),
        api: await instagramApiAllowed(),
        mode: 'error' in ctx ? null : ctx.mode,
        connection: describe(await getConnection(project.id)),
        publish: await igFeature('publish'),
        comments: await igFeature('comments'),
        insights: await igFeature('insights'),
      },
      uploadPost: {
        profile: project.uploadPostProfile || null,
        // The Instagram handle seen at the last link or check (never a live call here).
        instagram: project.uploadPostProfile && account?.verified?.instagram ? `@${account.verified.instagram.replace(/^@/, '')}` : null,
        verifiedAt: project.uploadPostProfile && account?.verified ? account.verified.at : null,
        keySet: Boolean(process.env.UPLOAD_POST_API_KEY),
        posting: await liveState(),
        scheduling: await schedulingAllowed(),
        results: await analyticsAllowed(),
        profileSetup: await profileManagementAllowed(),
        // Monthly uploads as last seen in an Upload-Post answer, plus schedules still to go out; null until seen.
        quota: await uploadQuota()
          .then((q) => (q ? { used: q.used, limit: q.limit, resetsAt: q.resetsAt, scheduled: q.scheduled, seenAt: q.seenAt, stale: q.stale } : null))
          .catch(() => null),
      },
      mediaHost: r2.ok ? { enabled: true, reason: '', publicHost: new URL(r2.publicBase).host } : { enabled: false, reason: r2.reason, publicHost: null },
      scheduler: await schedulerAllowed(),
      agents: await claudeAgentsAllowed(),
      codex: await codexImagesAllowed(),
      brand: brand ? { name: brand.name, website: brand.website, sources: brand.sources.map((s) => s.type), updatedAt: brand.updatedAt } : null,
      postmaker: { paused: postmakerPaused() },
      making: await connectorRows(),
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { project?: unknown; action?: unknown; service?: unknown; id?: unknown; on?: unknown; acceptTerms?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async (project) => {
    if (typeof b.action === 'string' && b.action.startsWith('connector.')) return makingAction(b.action, b.id, b.on, b.acceptTerms === true);
    if (b.action !== 'check') return jsonError(400, 'validation', 'Unknown action.');
    if (b.service === 'claude' || b.service === 'codex') {
      const bin = await cliBin(b.service);
      const v = await version(bin);
      return v ? NextResponse.json({ ok: true, message: `${b.service === 'claude' ? 'Claude Code' : 'Codex CLI'} found: ${v}` }) : jsonError(503, 'unavailable', `${b.service === 'claude' ? 'Claude Code' : 'Codex CLI'} was not found on this machine. Install it, or set its path in Connections.`);
    }
    if (b.service === 'upload-post') {
      if (!project.uploadPostProfile) return jsonError(409, 'conflict', 'This project has no Upload-Post profile.');
      try {
        const p = await getUpProfile(project.uploadPostProfile);
        if (!p) return jsonError(404, 'not_found', `Upload-Post has no profile named “${project.uploadPostProfile}”.`);
        const ig = p.instagram?.handle ?? null;
        const match = ig && ig.toLowerCase() === project.handle.toLowerCase();
        await markVerified(project.id, ig ? ig.replace(/^@/, '') : null);
        return NextResponse.json({ ok: Boolean(match), message: ig ? `Profile “${p.username}” is connected to ${ig}${match ? '' : `, not ${project.handle}`}${p.instagram?.reauth ? ' (needs to reconnect in Upload-Post)' : ''}.` : `Profile “${p.username}” has no Instagram connected.` });
      } catch (e) {
        return jsonError(e instanceof UploadPostError ? Math.min(Math.max(e.status, 400), 599) : 502, 'upstream', (e as Error).message);
      }
    }
    return jsonError(400, 'validation', 'Unknown service.');
  });
}

const pmError = (e: unknown): Response => {
  if (e instanceof PostmakerError) return jsonError(e.status, e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : e.status === 400 ? 'validation' : e.code, e.message);
  if (e instanceof SettingsError) return jsonError(e.status, e.status === 409 ? 'conflict' : 'validation', e.message);
  throw e;
};

/** Post maker connector actions. Nothing here calls a paid service. */
async function makingAction(action: string, id: unknown, on: unknown, acceptTerms: boolean): Promise<Response> {
  if (typeof id !== 'string' || !/^[a-z0-9:-]{2,60}$/.test(id)) return jsonError(400, 'validation', 'Unknown service.');
  try {
    if (action === 'connector.test') {
      const r = await testConnector(id);
      const c = connectorById(id)!;
      return NextResponse.json({ ok: r.ok, message: r.text, row: await connectorRow(c, await connectorStatus(c)) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'connector.switch') {
      if (typeof on !== 'boolean') return jsonError(400, 'validation', 'Bad switch.');
      const c = await switchConnector(id, on, { acceptTerms });
      return NextResponse.json({ ok: true, row: await connectorRow(c, await connectorStatus(c)) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return jsonError(400, 'validation', 'Unknown action.');
  } catch (e) {
    return pmError(e);
  }
}
