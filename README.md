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

## Fly.io deploy

```bash
fly launch --name grok-design   # first time only, if needed
fly secrets set DATABASE_URL=... XAI_API_KEY=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=https://grok-design.fly.dev GROK_AUTH_CLIENT_ID=... GROK_AUTH_CLIENT_SECRET=... VITE_AUTH_ENABLED=true
fly deploy
```

The multi-stage `Dockerfile` builds with Nitro `node-server` and starts:

`HOST=0.0.0.0 PORT=8080 node .output/server/index.mjs`

### Secrets / env

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (Neon / Fly). Enables DB-backed share + Better Auth persistence |
| `XAI_API_KEY` | xAI generation |
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
