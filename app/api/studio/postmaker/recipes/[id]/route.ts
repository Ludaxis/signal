// GET /api/studio/postmaker/recipes/[id]?project=   RecipeView: recipe, pipeline, nodes with derived status,
// versions, per-node estimate and gate state, the plan estimate, the latest run and the connectors the pipeline uses,
// plus the reference, person-made sign-offs, notes and the Proof projection.
// GET /api/studio/postmaker/recipes/[id]?project=&only=recipe   RecipeOnlyView: the recipe and its reference, for a
// recipe that has no pipeline yet ("Stop after the recipe").
import type { NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { inProject } from '@/lib/server/studioProject';
import { pmError, pmFail, pmJson } from '@/lib/studio/postmaker/api/http';
import { recipeOnlyView, recipeView } from '@/lib/studio/postmaker/service';
import { RECIPE_ID_RE } from '@/lib/studio/postmaker/store/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (typeof id !== 'string' || !RECIPE_ID_RE.test(id)) return pmError(400, 'validation', 'Unknown recipe.');
  return inProject(req, null, async (project) => {
    try {
      const only = new URL(req.url).searchParams.get('only');
      if (only !== null && only !== 'recipe') return pmError(400, 'validation', 'only must be recipe.');
      return pmJson(only === 'recipe' ? await recipeOnlyView(project, id) : await recipeView(project, id));
    } catch (e) {
      return pmFail(e, 'recipe');
    }
  });
}
