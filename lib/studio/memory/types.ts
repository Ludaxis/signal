// Shared contract for project memory, decision routing and the agent team (design:
// docs/design/memory-graph-and-agent-team.md). Every module builds against these types.
// Server-only data model; the UI imports these types too (no runtime code here).

export type Goal = 'awareness' | 'engagement' | 'installs' | 'traffic' | 'launch' | 'community';

// ---- Layer 1: timeline -------------------------------------------------------------------------
export type EventType =
  // content
  | 'brief.created' | 'post.made' | 'post.reviewed' | 'post.approved' | 'post.rejected' | 'post.edited'
  | 'post.scheduled' | 'post.published' | 'post.failed' | 'post.discarded' | 'post.label-confirmed'
  // results
  | 'metrics.snapshot' | 'account.snapshot'
  // audience (themes and counts only, never usernames)
  | 'comments.theme' | 'comment.question'
  // strategy
  | 'campaign.created' | 'campaign.status' | 'strategy.proposed' | 'strategy.approved' | 'plan.made'
  | 'pivot.proposed' | 'pivot.approved' | 'pivot.rejected'
  // knowledge
  | 'research.finding' | 'note.added' | 'brand.updated' | 'catalog.updated'
  // system
  | 'agent.run' | 'decision.made';

export interface MemEvent {
  id: string; // 'ev_' + time-sortable random
  at: string; // ISO time
  project: string;
  campaign: string | null;
  type: EventType;
  by: string; // user email, agent role ('agent:reviewer') or 'system'
  refs: { package?: string; slot?: string; branch?: string; strategy?: string; decision?: string; run?: string };
  data: Record<string, unknown>; // small, no secrets, no personal data
}

// ---- Layer 2: decision map -----------------------------------------------------------------------
export type NodeType = 'goal' | 'strategy' | 'pillar' | 'hypothesis' | 'variant' | 'outcome' | 'learning' | 'pivot';
export type BranchStatus = 'proposed' | 'exploring' | 'promising' | 'winning' | 'weak' | 'pruned';

export interface GraphNode {
  id: string; // stable, e.g. 'goal:c-…', 'pl:c-…:guess-the-link', 'var:pkg-12'
  type: NodeType;
  parent: string | null;
  label: string;
  campaign: string | null;
  status: BranchStatus | null; // for branches (pillar, hypothesis, variant)
  weight: number | null; // pillar weight 0–100
  created: string; // ISO
  updated: string; // ISO
  evidence: string[]; // event ids
  learning: string | null; // learning id
  goalWeight: Partial<Record<Goal, number>>;
  meta: Record<string, unknown>; // e.g. { format, hook, packageId, metrics }
}
export interface Graph { version: 1; project: string; nodes: GraphNode[]; updatedAt: string }

// ---- Layer 3: learnings --------------------------------------------------------------------------
export type MetricKey = 'views' | 'reach' | 'saves_per_reach' | 'engagement_rate' | 'comments_per_reach' | 'shares_per_reach' | 'likes_per_reach';

export interface Learning {
  id: string; // 'lr:…'
  text: string;
  metric: MetricKey;
  scope: { campaign?: string; branch?: string; format?: string; hookStyle?: string; hour?: number };
  effect: number | null; // ratio vs baseline (1 = same)
  interval: [number, number] | null;
  mean: number | null; // recency-weighted mean of the metric in scope
  baseline: number | null; // recency-weighted project mean
  n: number; // posts in scope
  nEff: number; // Σ recency weight × maturity
  confidence: number; // 0–1, P(effect in claimed direction), capped (see stats)
  status: 'active' | 'too-little-data' | 'retired';
  lastEvidence: string | null; // ISO
  halfLifeDays: number;
  branch: string | null;
  updatedAt: string;
}
export interface LearningsFile { version: 1; project: string; learnings: Learning[]; updatedAt: string }

// ---- Routing decisions ---------------------------------------------------------------------------
export type DecisionKind = 'predicate' | 'choice' | 'score';
export type DecisionId =
  | 'file-branch' | 'new-or-variant' | 'comment-kind' | 'comment-theme' | 'research-relevant'
  | 'pack-areas' | 'learning-valid' | 'similar-posts' | 'catalog-fit'
  | 'brief-match' | 'answer-unambiguous' | 'brand-rules' | 'visual-quality' | 'ai-label'
  | 'significant-change' | 'branch-status' | 'explore-exploit' | 'pivot-needed' | 'experiment-goal'
  | 'slot-format' | 'hook-style' | 'hook-too-similar' | 'best-time'
  | 'prompt-injection' | 'personal-data';

export interface DecisionRecord {
  id: string; // 'dc_…'
  at: string;
  project: string;
  campaign: string | null;
  decision: DecisionId;
  kind: DecisionKind;
  inputsHash: string; // sha256 of the normalised inputs (no raw text stored)
  via: 'rule' | 'cache' | 'judge' | 'escalated';
  answer: string | number | boolean | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  threshold: number | null;
  judge: string | null; // model id when via=judge
  costUsd: number | null;
  outcome: 'right' | 'wrong' | null; // filled later when known
  note: string | null;
}

// ---- Layer 4: context packs ----------------------------------------------------------------------
export type Role = 'lead' | 'researcher' | 'strategist' | 'planner' | 'creative-producer' | 'motion-designer' | 'reviewer' | 'analyst' | 'community-manager';
export interface ContextPack {
  role: Role;
  project: string;
  campaign: string | null;
  builtAt: string;
  inputsHash: string;
  budgetTokens: number;
  tokensApprox: number; // chars / 4
  sections: { title: string; text: string }[];
}

// ---- Agent runs ----------------------------------------------------------------------------------
export interface AgentRunRecord {
  id: string; // 'run_…'
  role: Role;
  project: string;
  campaign: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'error' | 'stopped-budget';
  model: string | null;
  costUsd: number | null;
  turns: number | null;
  summary: string | null;
  error: string | null;
}

// ---- Memory API payload (GET /api/studio/memory) ---------------------------------------------------
export interface MemoryPayload {
  enabled: boolean;
  reason: string;
  /** timeZone: the project's IANA zone; days and times in Memory read it. */
  project: { id: string; name: string; handle: string; timeZone?: string };
  campaigns: { id: string; name: string; goal: Goal; status: string }[];
  graph: Graph;
  learnings: Learning[];
  events: MemEvent[]; // newest first, capped
  decisions: DecisionRecord[]; // newest first, capped
  runs: AgentRunRecord[]; // newest first, capped
  stats: { events: number; decisions: number; judgeCostUsd: number; agentCostUsd: number };
}
