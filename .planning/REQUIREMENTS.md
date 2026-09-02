# Requirements — Fly readiness

REQ-FLY-01 Dockerfile + fly.toml (Node 22, 0.0.0.0:$PORT)
REQ-FLY-02 README + .env.example for auth/DB/XAI
REQ-FLY-03 Scrub baked PREVIEW_CLIENT_SECRET; env-only
REQ-FLY-04 Add grok-4.6 as default/selectable
REQ-FLY-05 Rename package to grok-design; engines.node>=22
REQ-FLY-06 DB-backed projects for /share when DATABASE_URL set
REQ-FLY-07 Portable startup.sh ($PWD, not only /workspace)
