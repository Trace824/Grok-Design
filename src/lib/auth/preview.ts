/**
 * Shared LIVE-PREVIEW OAuth client metadata (server-only — NEVER import from the client).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL, which can't be pre-registered per app. The broker instead exposes ONE
 * shared "preview" client that accepts any
 * `https://*.grok-sandbox.com/api/auth/oauth2/callback/*`
 * (broker: `app-builder-deployer/auth/src/preview-oauth.ts`).
 *
 * The client **secret must never be baked into git**. Supply it via
 * `GROK_PREVIEW_CLIENT_SECRET` (or `GROK_AUTH_CLIENT_SECRET`, which the server
 * already prefers when set). When neither is set, federated preview auth is
 * disabled cleanly (`authConfigured` is false in `server.ts`).
 *
 * When deployed, the deployer injects a per-app `GROK_AUTH_*` that overrides
 * the preview client id (see `server.ts`).
 */
export const PREVIEW_CLIENT_ID = "grok_preview";

/** The shared auth broker issuer (OIDC discovery lives under it). */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/oauth2/callback/...` the broker allows.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
