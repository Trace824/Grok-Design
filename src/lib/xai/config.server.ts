/**
 * xAI sign-in configuration — **server-only**.
 *
 * xAI has no public third-party OAuth client registration, so everything is
 * env-driven and the feature is OFF unless an operator supplies a client that
 * xAI issued for Grok Design. We never hardcode or reuse the Grok CLI's own
 * client id.
 *
 *   XAI_OAUTH_CLIENT_ID      required — Grok Design's own xAI OAuth client
 *   XAI_OAUTH_CLIENT_SECRET  optional — confidential client (client_secret_basic)
 *   XAI_OAUTH_SCOPE          required — space-separated; `openid` is always added
 *   XAI_TOKEN_ENC_KEY        required — AES-256-GCM key(s), see core/crypto.ts
 *   XAI_OAUTH_REDIRECT_URI   optional — fixed callback (…/api/xai/oauth/callback);
 *                            enables the redirect (auth-code + PKCE) flow
 *   XAI_OAUTH_DEVICE_FLOW    optional — "false" disables the device-code flow
 *   XAI_OAUTH_ISSUER         optional — defaults to https://auth.x.ai
 *   XAI_SERVER_KEY_FALLBACK  optional — "true" lets users without a working xAI
 *                            connection generate on the server XAI_API_KEY
 */
import { parseKeyring, type Keyring } from "./core/crypto.ts";
import type { ClientCredentials } from "./core/oidc.ts";

export const XAI_DEFAULT_ISSUER = "https://auth.x.ai";

/** Scopes we refuse to request even if configured (least privilege). */
const FORBIDDEN_SCOPE = /^(api-keys:write|billing:.*|orgs?:write|teams?:write|workspaces?:write|grok-workspace:serve|logs:read)$/;

export type XaiConfig =
  | { enabled: false; reason: string; serverKeyFallback: boolean }
  | {
      enabled: true;
      issuer: string;
      client: ClientCredentials;
      scope: string;
      keyring: Keyring;
      redirectUri: string | null;
      authCodeFlow: boolean;
      deviceFlow: boolean;
      serverKeyFallback: boolean;
    };

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

function validRedirectUri(raw: string): string | null {
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    if (u.hash || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Pure parser (exported for tests). Never echoes secret values in `reason`. */
export function parseXaiConfig(e: Record<string, string | undefined>): XaiConfig {
  const get = (k: string) => {
    const v = e[k]?.trim();
    return v ? v : undefined;
  };
  // When the feature is OFF, behaviour is unchanged: the server key is used as before.
  const off = (reason: string): XaiConfig => ({ enabled: false, reason, serverKeyFallback: true });
  const clientId = get("XAI_OAUTH_CLIENT_ID");
  const rawScope = get("XAI_OAUTH_SCOPE");
  const rawKey = get("XAI_TOKEN_ENC_KEY");
  if (!clientId) return off("XAI_OAUTH_CLIENT_ID unset");
  if (!rawScope) return off("XAI_OAUTH_SCOPE unset");
  if (!rawKey) return off("XAI_TOKEN_ENC_KEY unset");
  if (get("VITE_AUTH_ENABLED") === "false") return off("app auth disabled (VITE_AUTH_ENABLED=false)");
  if (get("NODE_ENV") === "production" && !get("DATABASE_URL") && get("XAI_OAUTH_ALLOW_PGLITE") !== "true") {
    return off("production without DATABASE_URL (credentials would be lost on restart)");
  }
  let keyring: Keyring;
  try {
    keyring = parseKeyring(rawKey);
  } catch (err) {
    return off(err instanceof Error ? err.message : "invalid XAI_TOKEN_ENC_KEY");
  }
  const scopes = new Set(rawScope.split(/\s+/).filter(Boolean));
  scopes.add("openid");
  const forbidden = [...scopes].filter((s) => FORBIDDEN_SCOPE.test(s));
  if (forbidden.length) return off(`XAI_OAUTH_SCOPE requests forbidden scopes: ${forbidden.join(" ")}`);
  const issuer = (get("XAI_OAUTH_ISSUER") ?? XAI_DEFAULT_ISSUER).replace(/\/+$/, "");
  if (!issuer.startsWith("https://")) return off("XAI_OAUTH_ISSUER must be https");
  const rawRedirect = get("XAI_OAUTH_REDIRECT_URI");
  const redirectUri = rawRedirect ? validRedirectUri(rawRedirect) : null;
  if (rawRedirect && !redirectUri) return off("XAI_OAUTH_REDIRECT_URI must be https (or http://localhost)");
  const deviceFlow = get("XAI_OAUTH_DEVICE_FLOW") !== "false";
  const authCodeFlow = Boolean(redirectUri);
  if (!deviceFlow && !authCodeFlow) return off("no flow enabled (set XAI_OAUTH_REDIRECT_URI or XAI_OAUTH_DEVICE_FLOW)");
  const clientSecret = get("XAI_OAUTH_CLIENT_SECRET");
  return {
    enabled: true,
    issuer,
    client: clientSecret ? { clientId, clientSecret } : { clientId },
    scope: [...scopes].join(" "),
    keyring,
    redirectUri,
    authCodeFlow,
    deviceFlow,
    serverKeyFallback: get("XAI_SERVER_KEY_FALLBACK") === "true",
  };
}

let cached: XaiConfig | null = null;
let warned = false;

export function getXaiConfig(): XaiConfig {
  if (cached) return cached;
  cached = parseXaiConfig(process.env);
  const partiallyConfigured = Boolean(env("XAI_OAUTH_CLIENT_ID") || env("XAI_TOKEN_ENC_KEY"));
  if (!cached.enabled && partiallyConfigured && !warned) {
    warned = true;
    console.warn(`[xai] sign-in disabled: ${cached.reason}`);
  }
  return cached;
}

/** Non-sensitive flags the browser may see. */
export function publicXaiFeature(): { enabled: boolean; authCodeFlow: boolean; deviceFlow: boolean } {
  const c = getXaiConfig();
  return c.enabled
    ? { enabled: true, authCodeFlow: c.authCodeFlow, deviceFlow: c.deviceFlow }
    : { enabled: false, authCodeFlow: false, deviceFlow: false };
}
