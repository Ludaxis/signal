# Connections screen

How the Connections screen is organised, and why.

## Principles (from integration-settings practice)

1. **Status first.** The top card answers the one question that matters: "If I drag a post to
   Posted, will it go out?" It is a three-step checklist (a way to post, posting for this account,
   the Publishing switch), each step with its own switch or button. When every step is done it
   collapses into "Ready to post" with the route it will use.
2. **One row per service, one action per row.** Rows are grouped by job (Publishing, Creating,
   Sources), not by technology. Each row shows the name, one line of state (the connected account,
   the version, what is missing), a status pill and a single button (Set up / Manage / Open).
3. **Calm status colours.** Green = working, amber = set up but needs you (expired sign-in, key
   missing, bucket needed for Meta), grey = not set up or switched off. Red is not used for things
   you simply have not set up, so real problems stand out.
4. **Details on demand.** Keys, tests, profile choice, permissions, disconnect and advanced calls
   live in the service's side panel. Keys for a service sit with that service, not in a separate
   "Keys" list.
5. **Secrets are write-only.** Keys are pasted once, stored encrypted, never shown again; the
   panel shows only where a value comes from (Saved / From .env.local) and its last 4 characters.
   Every key form has a "Where do I find it?" hint and, where possible, a Test button.
6. **One primary button per area.** Only the next setup step in the top card is a filled button;
   row buttons are quiet.
7. **Features stay explicit.** Every feature switch is listed under Features, off by default.
8. **No duplicates.** Every service appears once (the old screen listed Upload-Post, the media
   bucket and Higgsfield twice, and Claude/Codex in two places).

## Sources

- SaaS integrations UX patterns: https://www.saasui.design/blog/saas-integrations-ux-patterns
- API keys and tokens UX patterns: https://www.saasui.design/blog/saas-api-keys-tokens-ux-patterns
- Post-connection configuration UI patterns: https://truto.one/blog/post-connection-configuration-ui-patterns-for-saas-integrations.md
- Buffer, connecting channels: https://support.buffer.com/articles/connecting-your-channels-to-buffer-HvWLgAJvL9.md
- API key best practices: https://zuplo.com/docs/articles/api-key-best-practices.md
- Progressive disclosure examples: https://userpilot.com/blog/progressive-disclosure-examples/
