// GET  /api/studio/connections?project=   every connection this project uses, with status only (never values or secrets)
// POST /api/studio/connections {project, action:'check', service}   read-only checks:
//   upload-post → reads the project's Upload-Post profile and its Instagram handle (no upload)
//   claude | codex → runs `<cli> --version` on this machine (no model call, no usage)
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
import { UploadPostError, getUpProfile, profileManagementAllowed } from '@/lib/studio/uploadpost';

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
    const body = {
      project: { id: project.id, name: project.name, handle: project.handle },
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
        keySet: Boolean(process.env.UPLOAD_POST_API_KEY),
        posting: await liveState(),
        scheduling: await schedulingAllowed(),
        results: await analyticsAllowed(),
        profileSetup: await profileManagementAllowed(),
      },
      mediaHost: r2.ok ? { enabled: true, reason: '', publicHost: new URL(r2.publicBase).host } : { enabled: false, reason: r2.reason, publicHost: null },
      scheduler: await schedulerAllowed(),
      agents: await claudeAgentsAllowed(),
      codex: await codexImagesAllowed(),
      brand: brand ? { name: brand.name, website: brand.website, sources: brand.sources.map((s) => s.type), updatedAt: brand.updatedAt } : null,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { project?: unknown; action?: unknown; service?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async (project) => {
    if (b.action !== 'check') return jsonError(400, 'validation', 'Unknown action.');
    if (b.service === 'claude' || b.service === 'codex') {
      const bin = b.service === 'claude' ? process.env.CLAUDE_BIN || 'claude' : process.env.CODEX_BIN || 'codex';
      const v = await version(bin);
      return v ? NextResponse.json({ ok: true, message: `${b.service === 'claude' ? 'Claude Code' : 'Codex CLI'} found: ${v}` }) : jsonError(503, 'unavailable', `${b.service === 'claude' ? 'Claude Code' : 'Codex CLI'} was not found on this machine. Install it or set ${b.service === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN'} in .env.local.`);
    }
    if (b.service === 'upload-post') {
      if (!project.uploadPostProfile) return jsonError(409, 'conflict', 'This project has no Upload-Post profile.');
      try {
        const p = await getUpProfile(project.uploadPostProfile);
        if (!p) return jsonError(404, 'not_found', `Upload-Post has no profile named “${project.uploadPostProfile}”.`);
        const ig = p.instagram?.handle ?? null;
        const match = ig && ig.toLowerCase() === project.handle.toLowerCase();
        return NextResponse.json({ ok: Boolean(match), message: ig ? `Profile “${p.username}” is connected to ${ig}${match ? '' : `, not ${project.handle}`}${p.instagram?.reauth ? ' (needs to reconnect in Upload-Post)' : ''}.` : `Profile “${p.username}” has no Instagram connected.` });
      } catch (e) {
        return jsonError(e instanceof UploadPostError ? Math.min(Math.max(e.status, 400), 599) : 502, 'upstream', (e as Error).message);
      }
    }
    return jsonError(400, 'validation', 'Unknown service.');
  });
}
