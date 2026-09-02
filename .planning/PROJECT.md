# Grok Design

**What:** Visual design product for HTML prototypes/slides (Grok Build export).
**Repo:** https://github.com/Trace824/Grok-Design
**Deploy:** Fly.io + DATABASE_URL (Neon or Fly Postgres)

## Goals
1. Fly Dockerfile/fly.toml + documented env
2. No secrets in git
3. Share works cross-browser when DB configured
4. PGLite/localStorage still works without Fly

## Non-goals
- Split project.$id.tsx
- Full realtime multiplayer
