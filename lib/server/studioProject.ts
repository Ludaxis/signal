// Resolves the Studio project for a request (?project= or body.project) and runs the handler in it.
import type { NextRequest } from 'next/server';
import { jsonError } from './security';
import { ProjectError, getProject, withProject, type Project } from '../studio/projects';

export async function inProject(req: NextRequest, bodyProject: unknown, fn: (p: Project) => Promise<Response>): Promise<Response> {
  const q = new URL(req.url).searchParams.get('project');
  const id = typeof bodyProject === 'string' ? bodyProject : q;
  let project: Project;
  try {
    project = await getProject(id);
  } catch (e) {
    if (e instanceof ProjectError) return jsonError(e.status, 'not_found', e.message);
    throw e;
  }
  return withProject(project, () => fn(project));
}
