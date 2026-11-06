// GET  /api/studio/workspace?project=   linked folders, Figma (status, files, exports) and the CLIs on this machine
// POST /api/studio/workspace {project, action, ...}
//   folder-link {path, label?} | folder-unlink {id} | folder-files {id} | folder-brand {id}
//   figma-connect {token} | figma-disconnect | figma-link {url} | figma-unlink {key} | figma-frames {key} | figma-import {key, ids}
//   tool-path {cli, path}   ('' clears it) | tool-check {cli}
// Folders are read-only for Signal. The Figma token is stored encrypted and never returned.
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { jsonError } from '@/lib/server/security';
import { FolderError, getFolder, linkFolder, listFiles, listFolders, unlinkFolder } from '@/lib/studio/folders';
import { FigmaError, connectFigma, disconnectFigma, figmaStatus, importFrames, linkFigmaFile, listFigmaFiles, listFrames, listImports, unlinkFigmaFile } from '@/lib/studio/figma';
import { BrandError, importFolder } from '@/lib/studio/brand';
import { cliInfo, saveCliPath, type Cli } from '@/lib/studio/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const isCli = (v: unknown): v is Cli => v === 'claude' || v === 'codex';
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return inProject(req, null, async (project) => {
    const [folders, figma, files, imports, claude, codex] = await Promise.all([listFolders(project.id), figmaStatus(), listFigmaFiles(project.id), listImports(project), cliInfo('claude'), cliInfo('codex')]);
    return NextResponse.json({ folders, figma: { ...figma, files, imports }, tools: { claude, codex } }, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  return inProject(req, b.project, async (project) => {
    try {
      switch (b.action) {
        case 'folder-link': {
          const f = await linkFolder(project.id, str(b.path), str(b.label, 60));
          return NextResponse.json({ folder: f, message: `Linked “${f.label}”.` });
        }
        case 'folder-unlink':
          return NextResponse.json({ ok: await unlinkFolder(project.id, str(b.id, 40)), message: 'Folder unlinked. Nothing in it was changed.' });
        case 'folder-files': {
          const f = await getFolder(project.id, str(b.id, 40));
          return NextResponse.json({ folder: f, ...(await listFiles(f)) });
        }
        case 'folder-brand': {
          const f = await getFolder(project.id, str(b.id, 40));
          const kit = await importFolder(f.path);
          return NextResponse.json({ message: `Brand updated from “${f.label}”${kit.logo ? ' (logo found)' : ''}.` });
        }
        case 'figma-connect': {
          const who = await connectFigma(str(b.token, 300));
          return NextResponse.json({ message: `Figma connected as ${who}.` });
        }
        case 'figma-disconnect':
          await disconnectFigma();
          return NextResponse.json({ message: 'Figma disconnected. The token was deleted from this machine.' });
        case 'figma-link': {
          const f = await linkFigmaFile(project.id, str(b.url, 600));
          return NextResponse.json({ file: f, message: `Linked “${f.name}”.` });
        }
        case 'figma-unlink':
          return NextResponse.json({ ok: await unlinkFigmaFile(project.id, str(b.key, 64)), message: 'Figma file unlinked.' });
        case 'figma-frames':
          return NextResponse.json({ frames: await listFrames(project.id, str(b.key, 64)) });
        case 'figma-import': {
          const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [];
          const out = await importFrames(project, str(b.key, 64), ids);
          return NextResponse.json({ imports: out, message: `Exported ${out.length} frame${out.length === 1 ? '' : 's'} to the brand folder.` });
        }
        case 'tool-path': {
          if (!isCli(b.cli)) return jsonError(400, 'validation', 'Unknown tool.');
          await saveCliPath(b.cli, str(b.path, 1000));
          const info = await cliInfo(b.cli);
          return NextResponse.json({ tool: info, message: info.found ? `${info.label} found: ${info.version}` : `${info.label} was not found.` });
        }
        case 'tool-check': {
          if (!isCli(b.cli)) return jsonError(400, 'validation', 'Unknown tool.');
          const info = await cliInfo(b.cli);
          return NextResponse.json({ tool: info, message: info.found ? `${info.label} ${info.version}${info.signedIn === false ? ' · not signed in' : ''}` : `${info.label} was not found on this machine.` });
        }
        default:
          return jsonError(400, 'validation', 'Unknown action.');
      }
    } catch (e) {
      if (e instanceof FolderError || e instanceof FigmaError || e instanceof BrandError) return jsonError(e.status, e.status === 404 ? 'not_found' : e.status === 409 ? 'conflict' : e.status >= 500 ? 'upstream' : 'validation', e.message);
      if (b.action === 'tool-path' || b.action === 'figma-connect') return jsonError(400, 'validation', (e as Error).message);
      throw e;
    }
  });
}
