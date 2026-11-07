// Plain-language labels for the Memory tab: event sentences, event groups, status, decision and
// metric names, and small number formats. Pure functions, no React.
import { formatDateTime } from '@/lib/time';
import type { AgentRunRecord, BranchStatus, DecisionId, DecisionRecord, EventType, MemEvent, MetricKey, NodeType, Role } from '@/lib/studio/memory/types';

export type EventGroup = 'content' | 'results' | 'audience' | 'strategy' | 'knowledge' | 'system';
export const EVENT_GROUPS: { id: EventGroup; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'results', label: 'Results' },
  { id: 'audience', label: 'Audience' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'system', label: 'System' },
];
export function eventGroup(type: EventType): EventGroup {
  const head = type.split('.')[0];
  switch (head) {
    case 'brief':
    case 'post':
      return 'content';
    case 'metrics':
    case 'account':
      return 'results';
    case 'comments':
    case 'comment':
      return 'audience';
    case 'campaign':
    case 'strategy':
    case 'plan':
    case 'pivot':
      return 'strategy';
    case 'research':
    case 'note':
    case 'brand':
    case 'catalog':
      return 'knowledge';
    default:
      return 'system';
  }
}

export const STATUS_LABEL: Record<BranchStatus, string> = { proposed: 'Proposed', exploring: 'Exploring', promising: 'Promising', winning: 'Winning', weak: 'Weak', pruned: 'Pruned' };
export const TYPE_LABEL: Record<NodeType, string> = { goal: 'Goal', strategy: 'Strategy', pillar: 'Pillar', hypothesis: 'Hypothesis', variant: 'Variant', outcome: 'Outcome', learning: 'Learning', pivot: 'Pivot' };
export const ROLE_LABEL: Record<Role, string> = { lead: 'Lead', researcher: 'Researcher', strategist: 'Strategist', planner: 'Planner', 'creative-producer': 'Creative producer', 'motion-designer': 'Motion-graphics designer', reviewer: 'Reviewer', analyst: 'Analyst', 'community-manager': 'Community manager' };
export const METRIC_LABEL: Record<MetricKey, string> = { views: 'views', reach: 'reach', saves_per_reach: 'saves per reach', engagement_rate: 'engagement rate', comments_per_reach: 'comments per reach', shares_per_reach: 'shares per reach', likes_per_reach: 'likes per reach' };
export const DECISION_TITLE: Record<DecisionId, string> = {
  'file-branch': 'Which branch does this belong to?',
  'new-or-variant': 'New idea or a variant?',
  'comment-kind': 'What kind of comment is this?',
  'comment-theme': 'Which theme does this comment fit?',
  'research-relevant': 'Is this finding relevant here?',
  'pack-areas': 'Which memory areas does this task need?',
  'learning-valid': 'Is this learning still valid?',
  'similar-posts': 'Most similar past posts',
  'catalog-fit': 'Assets that fit the brief',
  'brief-match': 'Does the post match the brief?',
  'answer-unambiguous': 'Is the puzzle answer unambiguous?',
  'brand-rules': 'Brand rules and claims policy',
  'visual-quality': 'Visual quality',
  'ai-label': 'AI label present and correct?',
  'significant-change': 'Is this change significant?',
  'branch-status': 'Branch status',
  'explore-exploit': 'Exploit or explore the next slot?',
  'pivot-needed': 'Does this call for a pivot?',
  'experiment-goal': 'Which goal does this serve?',
  'slot-format': 'Format for this slot',
  'hook-style': 'Hook style',
  'hook-too-similar': 'Hook too similar to a recent one?',
  'best-time': 'Best posting time',
  'prompt-injection': 'Does outside text try to instruct the agent?',
  'personal-data': 'Does the draft contain personal data?',
};
export const VIA_LABEL: Record<DecisionRecord['via'], string> = { rule: 'Rule', cache: 'Cache', judge: 'Judge', escalated: 'Escalated' };
export const RUN_STATUS_LABEL: Record<AgentRunRecord['status'], string> = { running: 'Running', done: 'Done', error: 'Error', 'stopped-budget': 'Stopped at budget' };

const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const fmtInt = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-GB').format(Math.round(v)));
export const fmtUsd = (v: number | null | undefined, free = 'free'): string => (v === null || v === undefined ? free : v === 0 ? free : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const fmtPct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
export const fmtEffect = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `×${v.toFixed(2)}`);
export function fmtDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'running';
  const sec = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s`;
}
export function who(by: string): string {
  if (by === 'system') return 'Signal';
  if (by.startsWith('agent:')) return `${ROLE_LABEL[by.slice(6) as Role] ?? by.slice(6)} agent`;
  return 'You';
}

/** One readable sentence per event. Never includes usernames (memory stores none). */
export function describeEvent(e: MemEvent): string {
  const d = e.data;
  const pkg = e.refs.package ? `Post ${e.refs.package}` : 'Post';
  const hook = s(d.hook) ? `“${s(d.hook)}”` : '';
  switch (e.type) {
    case 'brief.created':
      return `Brief for ${pkg.toLowerCase()}${hook ? `: ${hook}` : ''}${s(d.pillar) ? ` · ${s(d.pillar)}` : ''}`;
    case 'post.made':
      return `${pkg} made${s(d.format) ? ` (${s(d.format)})` : ''}${hook ? `: ${hook}` : ''}`;
    case 'post.reviewed':
      return `${pkg} reviewed${n(d.briefMatch) !== null ? `: brief match ${n(d.briefMatch)}/5` : ''}${n(d.visual) !== null ? `, visual ${n(d.visual)}/5` : ''}${s(d.verdict) ? ` → ${s(d.verdict)}` : ''}`;
    case 'post.approved':
      return `${pkg} approved${hook ? `: ${hook}` : ''}`;
    case 'post.rejected':
      return `${pkg} rejected${s(d.reason) ? `: ${s(d.reason)}` : ''}`;
    case 'post.edited':
      return `${pkg} edited${Array.isArray(d.changed) ? ` (${(d.changed as unknown[]).map(s).filter(Boolean).join(', ')})` : ''}`;
    case 'post.scheduled':
      return `${pkg} scheduled for ${s(d.at) ? formatDateTime(s(d.at)) : 'later'}${s(d.via) ? ` via ${s(d.via) === 'upload-post' ? 'Upload-Post' : 'Signal'}` : ''}`;
    case 'post.published':
      return `${pkg} published${hook ? `: ${hook}` : ''}`;
    case 'post.failed':
      return `${pkg} failed${s(d.error) ? `: ${s(d.error)}` : ''}`;
    case 'post.discarded':
      return `Draft ${e.refs.package ?? ''} discarded${s(d.reason) ? `: ${s(d.reason)}` : ''}`;
    case 'post.label-confirmed':
      return `AI label confirmed on ${pkg.toLowerCase()}${s(d.where) ? ` (${s(d.where)})` : ''}`;
    case 'metrics.snapshot': {
      const parts = [n(d.views) !== null ? `${fmtInt(n(d.views))} views` : '', n(d.reach) !== null ? `${fmtInt(n(d.reach))} reach` : '', n(d.saves) !== null ? `${fmtInt(n(d.saves))} saves` : '', n(d.comments) !== null ? `${fmtInt(n(d.comments))} comments` : ''].filter(Boolean);
      return `Results for ${pkg.toLowerCase()}${n(d.ageHours) !== null ? ` at ${n(d.ageHours)} h` : ''}: ${parts.join(' · ')}`;
    }
    case 'account.snapshot':
      return `Account: ${fmtInt(n(d.followers))} followers${n(d.posts) !== null ? ` · ${fmtInt(n(d.posts))} posts` : ''}`;
    case 'comments.theme': {
      const themes = d.themes && typeof d.themes === 'object' ? Object.entries(d.themes as Record<string, unknown>).map(([k, v]) => `${k} ${s(v)}`).join(', ') : '';
      return `Comment themes on ${pkg.toLowerCase()}${themes ? `: ${themes}` : ''}`;
    }
    case 'comment.question':
      return `Question from the audience${s(d.question) ? `: “${s(d.question)}”` : ''}`;
    case 'campaign.created':
      return `Campaign “${s(d.name)}” created${s(d.goal) ? ` · goal: ${s(d.goal)}` : ''}`;
    case 'campaign.status':
      return `Campaign ${s(d.status) || 'status changed'}`;
    case 'strategy.proposed':
      return `Strategy v${s(d.version) || '?'} proposed${s(d.summary) ? `: ${s(d.summary)}` : ''}`;
    case 'strategy.approved':
      return `Strategy v${s(d.version) || '?'} approved${s(d.note) ? ` · ${s(d.note)}` : ''}`;
    case 'plan.made':
      return `Plan made${n(d.slots) !== null ? `: ${n(d.slots)} slots` : ''}${s(d.from) && s(d.to) ? ` from ${s(d.from)} to ${s(d.to)}` : ''}`;
    case 'pivot.proposed':
      return `Pivot proposed: ${s(d.title) || 'change of direction'}${s(d.why) ? ` — ${s(d.why)}` : ''}`;
    case 'pivot.approved':
      return `Pivot approved: ${s(d.title) || 'change of direction'}${s(d.note) ? ` · ${s(d.note)}` : ''}`;
    case 'pivot.rejected':
      return `Pivot rejected: ${s(d.title) || 'change of direction'}${s(d.reason) ? ` · ${s(d.reason)}` : ''}`;
    case 'research.finding':
      return `Research: ${s(d.finding) || 'finding added'}`;
    case 'note.added':
      return `Note: ${s(d.note)}`;
    case 'brand.updated':
      return `Brand updated${Array.isArray(d.changed) ? `: ${(d.changed as unknown[]).map(s).filter(Boolean).join(', ')}` : ''}`;
    case 'catalog.updated':
      return `Catalog updated${n(d.items) !== null ? `: ${fmtInt(n(d.items))} items` : ''}${n(d.categories) !== null ? ` in ${fmtInt(n(d.categories))} categories` : ''}${Array.isArray(d.added) && (d.added as unknown[]).length ? ` · new: ${(d.added as unknown[]).map(s).join(', ')}` : ''}`;
    case 'agent.run': {
      const role = ROLE_LABEL[s(d.role) as Role] ?? s(d.role) ?? 'Agent';
      if (s(d.status) === 'running') return `${role} agent is running`;
      return `${role} agent ran${s(d.model) ? ` (${s(d.model)}` : ''}${n(d.costUsd) !== null ? `${s(d.model) ? ', ' : ' ('}${fmtUsd(n(d.costUsd))}` : ''}${n(d.seconds) !== null ? `, ${n(d.seconds)} s` : ''}${s(d.model) || n(d.costUsd) !== null || n(d.seconds) !== null ? ')' : ''}${s(d.summary) ? `: ${s(d.summary)}` : ''}`;
    }
    case 'decision.made':
      return s(d.text) || `Decision: ${DECISION_TITLE[s(d.decision) as DecisionId] ?? s(d.decision) ?? 'routing'}${d.answer !== undefined ? ` → ${String(d.answer)}` : ''}`;
    default:
      return (e.type as string).replace('.', ' ');
  }
}

/** Source URL for research findings and permalinks, when present and http(s). */
export function eventLink(e: MemEvent): string | null {
  const u = e.data.source ?? e.data.permalink ?? e.data.url;
  return typeof u === 'string' && /^https?:\/\//.test(u) ? u : null;
}
