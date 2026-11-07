// The template name Accept asks for: required, at most 60 characters, prefilled from the reference (a
// link's address) or the recipe's own title line (its hook's on-screen words, else the first beat's name). Pure, so
// the Proof dialog and the server share the limit; the server stays the authority.
import type { Recipe, Reference } from './types';

export const TEMPLATE_NAME_MAX = 60;

/** Collapses spaces and cuts at a word boundary to `max` characters (no ellipsis: it is a name, not a preview). */
export function clipName(s: string, max = TEMPLATE_NAME_MAX): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at >= max / 2 ? cut.slice(0, at) : one.slice(0, max)).replace(/[\s,.;:·-]+$/u, '');
}

/** The reference's title: a link's host and path (an uploaded file has none of its own). */
function referenceTitle(ref: Pick<Reference, 'url'> | null): string {
  if (!ref?.url) return '';
  try {
    const u = new URL(ref.url);
    const p = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${p}`;
  } catch {
    return '';
  }
}

/** The recipe's title line: the hook's on-screen words (first language that has them), else the first beat's name. */
function recipeTitle(recipe: Pick<Recipe, 'beats' | 'languages'>): string {
  const hook = recipe.beats.find((b) => b.segment === 'hook') ?? recipe.beats[0];
  if (!hook) return '';
  for (const l of ['en', ...recipe.languages] as const) {
    const text = hook.onScreenText[l]?.trim();
    if (text) return text;
  }
  return hook.name.trim();
}

/** The name the Accept dialog starts with; empty when neither the reference nor the recipe offers one. */
export function suggestedTemplateName(recipe: Pick<Recipe, 'beats' | 'languages'>, ref: Pick<Reference, 'url'> | null): string {
  return clipName(referenceTitle(ref) || recipeTitle(recipe));
}

/** A typed name Accept takes: non-empty after trimming and within the limit. */
export const templateNameOk = (s: string): boolean => {
  const n = s.replace(/\s+/g, ' ').trim();
  return n.length > 0 && n.length <= TEMPLATE_NAME_MAX;
};
