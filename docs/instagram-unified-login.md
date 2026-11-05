# Runbook: Instagram API with Unified Login

How Signal connects an Instagram Professional account through Meta's **Instagram API with Facebook Login for Business (Unified Login)** and posts with it. Placeholders are in angle brackets.

## 1. Meta app

1. developers.facebook.com → **Create app** → type *Business*. Note the **App ID** and **App Secret** (Settings → Basic).
2. Add the products **Instagram** and **Facebook Login for Business**.
3. Facebook Login for Business → **Configurations** → create one for *Instagram* with the permissions `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`. Note the **configuration ID**.
4. Facebook Login for Business → Settings → **Valid OAuth Redirect URIs**: `https://<your-host>/api/studio/instagram/callback`. Meta refuses plain `http://localhost`; locally use `npm run dev:https` with `SIGNAL_DEV_HOST=<your-dev-hostname>` and a trusted local certificate.
5. The Instagram account must be a Professional account that belongs to a business portfolio your Meta user can see. In development mode only users with a role on the app can connect; App Review is required for others.

## 2. Signal configuration

```
META_APP_ID=<app id>
META_APP_SECRET=<app secret>
META_LOGIN_CONFIG_ID=<configuration id>
META_REDIRECT_URI=https://<your-host>/api/studio/instagram/callback
SIGNAL_TOKEN_KEY=<openssl rand -base64 32>
META_GRAPH_VERSION=v26.0            # optional
```

`signal.config.json`: `"unifiedLogin": true`, `"instagramApi": true`. For posting through the API you also need the R2 bucket (`R2_*`) and the account's posting limits with one-click posting on.

## 3. Connect

Connections screen → **Connect with Meta**. Signal creates a random `state` bound to an HMAC-signed, httpOnly, 10-minute cookie and sends you to `www.facebook.com/dialog/oauth` with the configuration id. On return, the callback:

1. verifies the state (signature, expiry, nonce, same session);
2. exchanges the code for a Business Integration System User token;
3. inspects the token (`debug_token`: valid, issued for this app, scopes, expiry);
4. lists `/me/assigned_instagram_accounts` and keeps only accounts whose username matches a Signal project's handle; others are ignored and not stored;
5. encrypts the token (AES-256-GCM with `SIGNAL_TOKEN_KEY`) into `<SIGNAL_SECRETS_DIR>/instagram-connections.json` (mode 0600).

The screen shows the granted permissions and what each unlocks (publish, comments, insights) and the expiry. **Disconnect** deletes the stored token.

## 4. Posting

Approve a post → **Post now** (or schedule it). Signal uploads the files to R2 under unguessable keys, creates the container(s) with `is_ai_generated=true`, waits for `FINISHED`, calls `media_publish` once, records the permalink and deletes the hosted files. Afterwards you confirm Instagram's AI label is visible before the next approval.

## 5. Troubleshooting

- *"Set META_APP_ID, …"* — a variable is missing or malformed (the secret must not be a numeric id; the redirect must be https and end with the callback path).
- *The login was started from another Signal session / took longer than 10 minutes* — start Connect again from the same browser.
- *The Meta login configuration did not grant instagram_content_publish* — add the permission to the configuration and connect again.
- *The stored connection is for @other, not @yours* — the handle in the project differs from the connected account.
- Transport note: Meta documents the code exchange as a GET with query parameters; Signal keeps Next's request logging off (`logging: false` in `next.config.ts`). Do not add request tracing around `ig-unified.ts`.
