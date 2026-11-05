// Pure id helpers shared by stats.ts, graph.ts and packs.ts. Node and learning ids are stable
// across rebuilds (the same input always yields the same id), which is what lets rebuildMemory
// grow the graph idempotently and keep each node's `created` date.

/** URL-safe slug: lower case, letters/digits/dashes only, never empty. */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'x';
}

export const goalNodeId = (campaign: string) => `goal:${campaign}`;
export const strategyNodeId = (campaign: string, approvedAt: string) => `strat:${campaign}:${approvedAt.replace(/[:.]/g, '-')}`;
export const pillarNodeId = (campaign: string, pillar: string) => `pl:${campaign}:${slug(pillar)}`;
export const hookHypothesisId = (campaign: string, pillar: string, hookStyle: string) => `hyp:${campaign}:${slug(pillar)}:hook:${slug(hookStyle)}`;
export const formatHypothesisId = (campaign: string, pillar: string, format: string) => `hyp:${campaign}:${slug(pillar)}:format:${slug(format)}`;
export const variantNodeId = (packageId: string) => `var:pkg-${packageId}`;
export const learningNodeId = (learningId: string) => `learn:${learningId}`;
export const pivotNodeId = (pivotKey: string) => `pivot:${slug(pivotKey)}`;

/** Learning ids: 'lr:<campaign|project>:<metric>:<kind>[:<value>]'. */
export function learningId(campaign: string | null, metric: string, kind: 'baseline' | 'format' | 'hook' | 'hour' | 'pillar' | 'hyp-hook' | 'hyp-format', value?: string): string {
  const base = `lr:${campaign ?? 'project'}:${metric}:${kind}`;
  return value === undefined ? base : `${base}:${slug(value)}`;
}
