# Contributing

Thanks for helping with Signal. Keep changes small and safe: this app posts to real accounts.

## Setup

```bash
npm ci
cp .env.example .env.local          # set SIGNAL_OWNER_PASSWORD
cp signal.config.example.json signal.config.json
npm run dev
```

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

All four must pass. Add or adapt a test under `tests/unit/` for behaviour you change; the tests never touch the network (every provider is faked).

## Ground rules

- **Off by default.** Anything that spends money, publishes, schedules or runs unattended must stay behind a switch in `signal.config.json` and respect `SIGNAL_PUBLISH_PAUSED` / `SIGNAL_AUTOPILOT_PAUSED`.
- **No secrets in code, logs or errors.** Keys and tokens stay in the environment or the encrypted store; redact them from every message that could reach the browser or a file.
- **The owner decides.** Agents propose; a post is published only after a human approval or an explicit, trust-based autopilot rule the owner switched on.
- **No real names.** Fixtures, examples and screenshots use placeholder brands and handles.

## Reporting a security issue

See [SECURITY.md](SECURITY.md).
