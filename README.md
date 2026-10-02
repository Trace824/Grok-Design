# Grok Design

Visual design product for HTML prototypes and slides (Grok Build export). Edit with chat, live tweaks, comments, and shareable previews.

Design generation and designer replies run through **Grok Build** (CLI headless agent) when `XAI_API_KEY` is set and the `grok` binary is available. Without a key, generation falls back to local templates.

## Local development

```bash
npm install
cp .env.example .env   # optional — fill in secrets as needed
npm run dev            # http://0.0.0.0:8080
```

Requires **Node.js 22+**. Install the Grok CLI (see https://x.ai/cli) for Build-backed generation, or set `GROK_BUILD_BIN` to the binary path.

Without `DATABASE_URL`, the app uses embedded PGLite for auth tables and Zustand `localStorage` for projects. Without `XAI_API_KEY`, generation falls back to local templates.

## Fly.io deploy (cheap defaults)

`fly.toml` uses **shared-cpu-1x / 1gb** (Grok Build needs more than 256mb), `auto_stop_machines = stop`, `min_machines_running = 0` (scale to zero when idle).

**Postgres:** use **[Neon Free](https://neon.tech)** for `DATABASE_URL` (scale-to-zero, $0 within free limits). Do **not** create Fly Managed Postgres unless you want higher monthly cost.

Deploy: `fly launch` (first time), set secrets with `fly secrets set`, then `fly deploy`.

The multi-stage `Dockerfile` installs the Grok CLI into the runner image, builds with Nitro `node-server`, and starts:

`HOST=0.0.0.0 PORT=8080 node .output/server/index.mjs`

### Secrets / env

| Variable | Purpose |
|----------|---------|
| DATABASE_URL | Prefer Neon Free. Enables DB-backed share + Better Auth persistence. |
| XAI_API_KEY | xAI auth for Grok Build (optional; local templates without it) |
| GROK_BUILD_BIN | Optional path to grok (Dockerfile sets /usr/local/bin/grok) |
| GROK_BUILD_DISABLED | true to skip Build (legacy chat completions when a key is set) |
| GROK_BUILD_ALLOW_API_FALLBACK | true to fall back to api.x.ai chat completions if Build fails |
| VITE_AUTH_ENABLED | Set false to disable federated auth |
| BETTER_AUTH_URL | Public app origin |
| BETTER_AUTH_SECRET | Session signing secret |
| GROK_AUTH_* | Broker OAuth client (deployed) |
| GROK_PREVIEW_CLIENT_SECRET | Preview OAuth secret (never commit) |

| XAI_OAUTH_* / XAI_TOKEN_ENC_KEY / XAI_SERVER_KEY_FALLBACK | Per-user xAI sign-in — see below |
| GROK_BUILD_EXTRA_ENV | Extra env var names passed to the Grok child (e.g. `HTTPS_PROXY`); secret-like names refused |

See .env.example for the full list.

## Per-user xAI sign-in ("Connect xAI")

Signed-in users can connect their own xAI / SuperGrok account; generations then run on **their** credential instead of the server `XAI_API_KEY`. The feature is **off** (UI hidden, `/api/xai/*` routes return `404 {"error":"xai_oauth_disabled"}`) unless `XAI_OAUTH_CLIENT_ID`, `XAI_OAUTH_SCOPE` and `XAI_TOKEN_ENC_KEY` are all set. xAI has no public third-party client registration, so this needs a client xAI issues for Grok Design — the Grok CLI's own client id is never used.

| Variable | Required | Purpose |
|----------|----------|---------|
| `XAI_OAUTH_CLIENT_ID` | yes | Grok Design's xAI OAuth client id (a UUID) |
| `XAI_OAUTH_CLIENT_SECRET` | no | Confidential client secret (`client_secret_basic`); omit for a public client |
| `XAI_OAUTH_SCOPE` | yes | Space-separated scopes (`openid` always added). Write scopes such as `api-keys:write`, `billing:*` are refused |
| `XAI_TOKEN_ENC_KEY` | yes | AES-256-GCM key, 32 bytes base64/hex. Rotate with `k2:<new>,k1:<old>` |
| `XAI_OAUTH_REDIRECT_URI` | no | Fixed callback `https://<app>/api/xai/oauth/callback`; enables the redirect flow |
| `XAI_OAUTH_DEVICE_FLOW` | no | `false` hides the device-code flow (on by default) |
| `XAI_SERVER_KEY_FALLBACK` | no | `true` lets users without a working connection generate on `XAI_API_KEY` |
| `XAI_OAUTH_ISSUER` | no | Defaults to `https://auth.x.ai` (endpoints come from its OIDC discovery document) |

**How it works.** The server is the token broker; the browser only does consent.

- **Redirect flow:** "Connect xAI" navigates to `/api/xai/oauth/start`. The server creates PKCE (S256), `state` and `nonce`, stores them (state/nonce hashed, verifier encrypted, bound to the user, 10-minute TTL, single use) and 302s to xAI. `/api/xai/oauth/callback` validates state, exchanges the code server-side (xAI's token endpoint has no CORS), verifies the id_token (ES256 via JWKS; iss/aud/nonce/exp) and stores the tokens.
- **Device-code flow (RFC 8628):** "Use a device code" starts the grant on the server; the user sees only the user code and xAI's verification URL. The browser polls our server, which makes at most one token request per xAI `interval` (honouring `slow_down`).
- **Storage:** `xai_credentials` (one row per user, `migrations/0003_xai_credentials.sql`) holds AES-256-GCM-encrypted access/refresh tokens, bound to the user and column via AAD.
- **Refresh:** about 5 minutes before expiry (or when a run needs longer), single-flight per user (in-process promise + `SELECT … FOR UPDATE`). Rotated refresh tokens are saved; `invalid_grant` marks the account `needs_reauth` and the UI shows Connect again.
- **Runs:** every Grok Build run gets a fresh `mkdtemp` HOME/GROK_HOME, an explicit allowlisted env (never `process.env`), and only a short-lived access token via the CLI's `GROK_AUTH_PROVIDER_COMMAND` hook. The refresh token, `DATABASE_URL`, `BETTER_AUTH_SECRET`, the encryption key and the server `XAI_API_KEY` never reach the child or the browser. The run dir is removed afterwards.
- **Disconnect:** revokes the refresh and access tokens at xAI (best effort) and deletes the row.

**Fly.io / Neon notes**

- Fly's root filesystem resets on every start/deploy, so credentials live in **Neon** (`DATABASE_URL`). In production (`NODE_ENV=production`) the feature refuses to turn on without `DATABASE_URL`, because PGLite would lose every connection on restart (`XAI_OAUTH_ALLOW_PGLITE=true` overrides).
- Set secrets with `fly secrets set XAI_OAUTH_CLIENT_ID=… XAI_OAUTH_SCOPE="…" XAI_TOKEN_ENC_KEY=$(openssl rand -base64 32) XAI_OAUTH_REDIRECT_URI=https://grok-design.fly.dev/api/xai/oauth/callback`. Never put them in `fly.toml [env]`.
- **Preview deploys** (`*.grok-sandbox.com`, dynamic hosts) can't use a fixed redirect URI: leave `XAI_OAUTH_REDIRECT_URI` unset there and use the device-code flow.
- Locally (no `DATABASE_URL`) PGLite works but resets with the dev server.


## Scripts

npm run dev / build / typecheck / start
