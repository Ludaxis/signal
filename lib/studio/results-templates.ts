// Results "By template": measured posts grouped by the template that made them. Names
// come from Post maker template records, then from the project pack's format labels; the core's own format
// labels are never shown. Posts with neither group under one "no template" row (name null).
import { rate } from './analytics';
import type { PackageView } from './content';
import { FORMAT_LABEL, isFormat, loadPackFormats } from './formats';
import { listTemplates } from './postmaker/store/templates';
import { postmakerRoot } from './postmaker/store/paths';
import type { Project } from './projects';

export interface TemplateNames {
  /** Template id → name, from the Post maker store. */
  templates: Record<string, string>;
  /** Format id → label, only where the project pack names the format itself. */
  formats: Record<string, string>;
}
export interface TemplateRow {
  /** `template:<id>`, `format:<id>` or `none`. */
  key: string;
  /** null for the "no template" row. */
  name: string | null;
  posts: number;
  avgViews: number | null;
  avgRate: number | null;
}

/** The template a package came from, when its lineage says so (Post maker packages carry `source.templateId`). */
function templateOf(p: PackageView): string | null {
  const id = (p.source as { templateId?: unknown } | null | undefined)?.templateId;
  return typeof id === 'string' && id ? id : null;
}

/** The group key and display name of one package. */
export function groupOf(p: PackageView, names: TemplateNames): { key: string; name: string | null } {
  const tpl = templateOf(p);
  if (tpl && names.templates[tpl]) return { key: `template:${tpl}`, name: names.templates[tpl]! };
  const f = p.source?.format;
  if (f && names.formats[f]) return { key: `format:${f}`, name: names.formats[f]! };
  return { key: 'none', name: null };
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Measured posts by template, best engagement rate first; the "no template" row always comes last. */
export function byTemplate(pkgs: PackageView[], names: TemplateNames): TemplateRow[] {
  const groups = new Map<string, { name: string | null; ps: PackageView[] }>();
  for (const p of pkgs) {
    if (!p.posted || !p.metrics?.metrics) continue;
    const g = groupOf(p, names);
    const cur = groups.get(g.key) ?? { name: g.name, ps: [] };
    cur.ps.push(p);
    groups.set(g.key, cur);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, name: g.name, posts: g.ps.length, avgViews: avg(g.ps.map((p) => p.metrics!.metrics!.views)), avgRate: avg(g.ps.map((p) => rate(p.metrics!.metrics))) }))
    .sort((a, b) => (a.key === 'none' ? 1 : 0) - (b.key === 'none' ? 1 : 0) || (b.avgRate ?? -1) - (a.avgRate ?? -1) || a.key.localeCompare(b.key));
}

/** Template and pack names for a project. A store or pack that cannot be read contributes no names. */
export async function templateNames(project: Project): Promise<TemplateNames> {
  const templates: Record<string, string> = {};
  try {
    for (const tpl of await listTemplates(postmakerRoot(project))) templates[tpl.id] = tpl.name;
  } catch {
    /* no store yet */
  }
  const formats: Record<string, string> = {};
  try {
    const set = await loadPackFormats(project);
    if (set.from === 'pack') {
      // A label the pack set differs from the core's; an unchanged one is still the core label and is not shown.
      for (const [f, label] of Object.entries(set.labels)) if (isFormat(f) && label !== FORMAT_LABEL[f]) formats[f] = label;
    }
  } catch {
    /* no pack */
  }
  return { templates, formats };
}
