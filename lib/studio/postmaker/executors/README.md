# Post maker executors: agent steps and the vision envelope

One executor per step kind. The agent executors:

| File | Kind | Role (envelope) | Live call | Mock |
|---|---|---|---|---|
| `analyse.ts` | `analyse` | `deconstructor` (opus, $2.00, 12 turns), vision mode | sheets + timeline only | beats at the detected cuts |
| `script.ts` | `script` | `copywriter` (opus, $1.20, 6 turns) | no tools | the recipe's own on-screen text |
| `post-copy.ts` | `post-copy:<lang>` | `copywriter` (sonnet, $0.40, 4 turns) | no tools | hook + CTA |

`agent.ts` builds one prompt from the `ContextBundle` (shared rules, the built-in role prompt or its override in `<SIGNAL_PROMPTS_DIR>/<role>/prompt.md`, the fixed task, the bundle as data, untrusted material inside `<untrusted_data>`), keeps the whole prompt within 120,000 characters, and calls an injected `AgentCall` (`runnerCall` over a claude-agent `Runner`, or `connectorCall` over the claude-cli connector). Every answer is a proposal validated by zod against the closed vocabularies in `vocab.ts`. The registry swaps these executors in only when `defaultExecutors({ agents })` is given; the engine tests keep their fakes otherwise.

## Prompt injection and the gates

- **Escaping.** Both JSON blocks of a prompt have `<` and `>` written as `\u003c` and `\u003e` (still valid JSON): the untrusted frame and the trusted `## Input` block. The trusted block holds upstream text an agent wrote after reading outside material (a recipe's name, purpose, visual and on-screen text from the deconstructor), so neither block can close `<untrusted_data>` or open a section. JSON escapes newlines, so no text can start a heading line either. This applies to every agent, Studio agents included.
- **The gate.** The engine's live path is `connectorCall` (callConnector, `requireLive`, the `agents` switch). `runnerCall` exists for fake runners in tests; given a real CLI runner (`makeClaudeCliRunner`, tagged so `isClaudeCliRunner` knows it), it checks `claudeAgentsAllowed()` first and refuses with 403, as `runAgent` does.
- **Local references only.** `preprocess` and `probeReference` refuse a `src` that is not an absolute path or that starts with a scheme (`http:`, `file:`, `pipe:`, `concat:` …): ffmpeg and ffprobe open URLs, and a child process is outside the Node network guard.

## Vision mode and the `--restricted` re-verification

Vision mode is a change to the agent safety envelope. It is implemented behind an explicit option and is **off everywhere by default**:

- `cliArgs({ vision: true })` (claude-agent.ts) and `claudeCliArgs({ vision: true })` (connectors/cli.ts) pass `--tools Read` and `--allowedTools Read`, remove `Read` from `--disallowedTools`, keep every other denied tool (shell, edits, writes, globbing, sub-agents, skills, the web) and keep `--restricted`, `--strict-mcp-config`, `--no-session-persistence` and `--disable-slash-commands`. No `--add-dir` is ever passed. A non-vision argv is unchanged byte for byte (tests).
- The cwd is a fresh temp folder holding only the files the caller hands over: at most 8 plainly named `.jpg`, `.jpeg`, `.png` or `.txt` files (the contact sheets and `timeline.txt`). It is removed after the run.
- The default runner `claudeCliRunner` and the registry's claude-cli connector **refuse** vision requests (403). Only `makeClaudeCliRunner({ allowVision: true })` or `makeCliConnectors({ allowVision: true })` run them; nothing in the app constructs either yet.

**Read-only check of the installed CLI (2026-11-06).** `claude --version` reports `2.1.319 (Claude Code)`, the version the existing flags are pinned to. Its `claude --help` documents:

- `--restricted`: "removes the built-in tools that run commands or code (Bash, PowerShell and the other code-running tools) and WebFetch unless --tools names them, and ignores user, project and local settings files (managed settings and --settings still apply; add --strict-mcp-config to skip MCP servers too). Also confines the file tools to the working directories (--add-dir included), refuses bypassPermissions, and lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files."
- `--tools` ("Specify the list of available tools from the built-in set … e.g. "Bash,Edit,Read""), `--allowedTools` and `--disallowedTools`, `--strict-mcp-config`, `--no-session-persistence`, `--disable-slash-commands`, `--max-budget-usd` and `--input-format` (`text` or `stream-json`).
- `--max-turns` is **not** listed (0 matches), as the existing comment in claude-agent.ts already records; the CLI accepts it.

**Result.** The help text of the pinned CLI documents the confinement this design relies on: with `--restricted`, file tools (Read included) are confined to the working directories, and Signal passes no `--add-dir`, so the working directory is the temp folder alone. This is a **documentation check only**: no real CLI run was made, so the confinement has not been observed in behaviour. Two notes: managed settings and `--settings` still apply under `--restricted` (Signal passes no `--settings`); and a fallback that sends the images as stream-json content blocks on stdin is not implemented or verified.

**Before any vision run with the real CLI**: have the envelope reviewed for security, turn on the `agents` switch (and `agentsApiKey` for API-key billing), and run only attended, button-triggered runs. Re-run this `--restricted` check after every CLI upgrade.
