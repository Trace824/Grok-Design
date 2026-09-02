# Grok Design

Visual design product for HTML prototypes and slides (Grok Build export). Edit with chat, live tweaks, comments, and shareable previews.

## Local development

```bash
npm install
cp .env.example .env   # optional — fill in secrets as needed
npm run dev            # http://0.0.0.0:8080
```

Requires **Node.js 22+**.

Without `DATABASE_URL`, the app uses embedded PGLite for auth tables and Zustand `localStorage` for projects. Without `XAI_API_KEY`, generation falls back to local templates.

## Fly.io deploy (cheap defaults)

`fly.toml` is tuned for low cost: **shared-cpu-1x / 256mb**, `auto_stop_machines = stop`, `min_machines_running = 0` (scale to zero when idle). Bump memory to `512mb` only if the app OOMs.

**Postgres:** use **[Neon Free](https://neon.tech)** for `DATABASE_URL` (scale-to-zero, $0 within free limits). Do **not** create Fly Managed Postgres unless you want ~$38+/mo.

```bash
fly launch --name grok-design   # first time only, if needed
# Create a Neon Free project, copy the connection string, then:
fly secrets set DATABASE_URL='postgresql://...' XAI_API_KEY=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=https://grok-design.fly.dev GROK_AUTH_CLIENT_ID=... GROK_AUTH_CLIENT_SECRET=... VITE_AUTH_ENABLED=true
fly deploy
```

The multi-stage `Dockerfile` builds with Nitro `node-server` and starts:

`HOST=0.0.0.0 PORT=8080 node .output/server/index.mjs`

### Secrets / env

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | **Prefer Neon Free.** Enables DB-backed share + Better Auth persistence. Skip Fly Managed Postgres for cost. |
| `XAI_API_KEY` | xAI generation (optional; local templates without it) |
| `VITE_AUTH_ENABLED` | Set `false` to disable federated auth |
| `BETTER_AUTH_URL` | Public app origin |
| `BETTER_AUTH_SECRET` | Session signing secret |
| `GROK_AUTH_*` | Broker OAuth client (deployed) |
| `GROK_PREVIEW_CLIENT_SECRET` | Preview OAuth secret (never commit) |

See `.env.example` for the full list.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server on `0.0.0.0:8080` |
| `npm run build` | Production build + DB migrate (no-op without `DATABASE_URL`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` | Production Node server (after build) |
