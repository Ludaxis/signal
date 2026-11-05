# Agent prompt overrides

Signal ships its agent prompts in code (`lib/studio/team/roles.ts`). To change the voice or rules of
a role without editing the source, put Markdown files here (or in `SIGNAL_PROMPTS_DIR`):

```
agents/
  _shared.md                 # rules every role gets first
  strategist/prompt.md
  content-planner/prompt.md  # the CLI planner (campaign plans)
  planner/prompt.md          # the agent-team planner
  researcher/prompt.md
  reviewer/prompt.md
  analyst/prompt.md
  community-manager/prompt.md
  creative-producer/prompt.md
  motion-designer/prompt.md
  lead/prompt.md
```

A file replaces the built-in prompt for that role; a missing file keeps the built-in one.
Prompts cannot grant tools: the allow-lists stay in code, and no role can publish, schedule or approve.
