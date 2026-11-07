// The Post maker CLI agents and their fixed envelopes (model tier, per-call cap, turns). No imports, so both
// claude-agent.ts (the `claude -p` arguments) and team/roles.ts (the role registry) can read them.

/** The Post maker CLI agents. */
export const POSTMAKER_AGENT_IDS = ['deconstructor', 'copywriter', 'language-editor', 'art-director', 'animator', 'sound-designer'] as const;
export type PostmakerAgentId = (typeof POSTMAKER_AGENT_IDS)[number];
export const isPostmakerAgent = (a: unknown): a is PostmakerAgentId => typeof a === 'string' && (POSTMAKER_AGENT_IDS as readonly string[]).includes(a);

/** A Post maker agent's fixed envelope: model tier, per-call cap (--max-budget-usd on API-key billing), turns. */
export interface AgentEnvelope {
  model: 'opus' | 'sonnet';
  budgetUsd: number;
  maxTurns: number;
}

/** Fixed in code, never chosen by the model. */
export const POSTMAKER_AGENTS: Record<PostmakerAgentId, AgentEnvelope> = {
  deconstructor: { model: 'opus', budgetUsd: 2.0, maxTurns: 12 },
  copywriter: { model: 'opus', budgetUsd: 1.2, maxTurns: 6 },
  'language-editor': { model: 'opus', budgetUsd: 0.6, maxTurns: 4 },
  'art-director': { model: 'sonnet', budgetUsd: 0.6, maxTurns: 4 },
  animator: { model: 'opus', budgetUsd: 1.2, maxTurns: 6 },
  'sound-designer': { model: 'sonnet', budgetUsd: 0.4, maxTurns: 4 },
};

/** The copywriter on `post-copy` runs on sonnet, $0.40, 4 turns (on `script` it is opus, $1.20, 6). */
export const COPYWRITER_POST_COPY: AgentEnvelope = { model: 'sonnet', budgetUsd: 0.4, maxTurns: 4 };

/** The envelope of a Post maker agent for one step kind (only the copywriter differs by kind). */
export function agentEnvelope(agent: PostmakerAgentId, kind?: string): AgentEnvelope {
  return agent === 'copywriter' && kind === 'post-copy' ? COPYWRITER_POST_COPY : POSTMAKER_AGENTS[agent];
}
