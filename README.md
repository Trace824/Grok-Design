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

See .env.example for the full list.


## Scripts

npm run dev / build / typecheck / start
