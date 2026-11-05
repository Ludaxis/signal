# Security

## How Signal handles secrets

- **Provider keys** (Meta app secret, Upload-Post, Cloudflare R2, Anthropic, Higgsfield) are read from the environment (`.env.local`, git-ignored). They never reach the browser and are redacted from error messages before they are shown or stored.
- **Instagram tokens** obtained through Meta Unified Login are encrypted with AES-256-GCM using `SIGNAL_TOKEN_KEY` and stored under `SIGNAL_SECRETS_DIR` (default `~/.signal`, mode 0600). Disconnecting deletes them.
- **Sessions** are HMAC-signed tokens in an httpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure over HTTPS). The owner password is compared in constant time and never stored.
- **Same-origin checks** apply to every mutating request, on top of the cookie's SameSite attribute, and a per-request CSP nonce is set by `proxy.ts`.
- **Agents** run in empty temporary folders with an allow-listed environment; only the key you named for Signal is passed on, and only when you switched that on.

## Running it safely

- Keep Signal on your own machine or behind an authenticated reverse proxy. The password-less mode (`SIGNAL_LOCAL_ONLY_NO_PASSWORD=1`) is accepted only from loopback addresses and must never be exposed.
- Everything that posts, schedules or spends is off until you turn it on in `signal.config.json`; `SIGNAL_PUBLISH_PAUSED=1` and `SIGNAL_AUTOPILOT_PAUSED=1` stop all of it at once.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately to the maintainers through the repository's security advisory feature (GitHub: *Security → Report a vulnerability*). Include steps to reproduce and the version or commit. You will get an acknowledgement within a few days.
