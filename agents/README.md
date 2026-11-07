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
  copywriter/prompt.md       # Post maker: script, caption and hashtags
  deconstructor/prompt.md    # Post maker: reads a reference video into a recipe
  language-editor/prompt.md  # Post maker agents without a built-in prompt work from the task text alone
  art-director/prompt.md
  animator/prompt.md
  sound-designer/prompt.md
```

The Post maker check (reviewer on the `check` step) uses its own built-in prompt and is not overridable here.

A file replaces the built-in prompt for that role; a missing file keeps the built-in one.
Prompts cannot grant tools: the allow-lists stay in code, and no role can publish, schedule or approve.
