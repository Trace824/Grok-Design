/**
 * xAI token broker — **server-only**. Orchestrates the connect flows
 * (auth-code + PKCE, device code), refresh, disconnect, and per-run credential
 * resolution. The browser never receives a token from anything in here.
 */
import { createAuthCodeHandshake, buildAuthorizationUrl, checkPendingState, sha256Hex } from "./core/pkce.ts";
import {
  createDiscoveryCache,
  createJwksCache,
  exchangeAuthorizationCode,
  refreshTokens,
  revokeToken,
  verifyIdToken,
  type TokenSet,
} from "./core/oidc.ts";
import { deviceTokenRequester, pollDeviceOnce, startDeviceAuthorization } from "./core/device.ts";
import { createTokenBroker, DEFAULT_ACCESS_TTL_S, XaiCredentialError } from "./core/refresh.ts";
import { getXaiConfig, type XaiConfig } from "./config.server";
import { createXaiStore, type ConnectionInfo } from "./store.server";

type EnabledConfig = Extract<XaiConfig, { enabled: true }>;

export class XaiDisabledError extends Error {
  readonly status = 404;
  constructor() {
    super("xAI sign-in is not enabled on this server");
    this.name = "XaiDisabledError";
  }
}

export class XaiFlowError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`xAI connect failed: ${code}`);
    this.name = "XaiFlowError";
    this.code = code;
  }
}

const PENDING_TTL_S = 10 * 60;

type Runtime = {
  cfg: EnabledConfig;
  store: ReturnType<typeof createXaiStore>;
  discovery: ReturnType<typeof createDiscoveryCache>;
  jwks: ReturnType<typeof createJwksCache>;
  broker: ReturnType<typeof createTokenBroker>;
};

// On globalThis so dev HMR doesn't duplicate caches or the single-flight map.
const g = globalThis as typeof globalThis & { __xaiRuntime__?: Runtime };

function runtime(): Runtime {
  const cfg = getXaiConfig();
  if (!cfg.enabled) throw new XaiDisabledError();
  if (g.__xaiRuntime__) return g.__xaiRuntime__;
  const store = createXaiStore(cfg.keyring);
  const discovery = createDiscoveryCache({ issuer: cfg.issuer });
  const jwks = createJwksCache({ jwksUri: async () => (await discovery.get()).jwks_uri });
  const broker = createTokenBroker({
    store: store.refreshStore,
    refresh: async (refreshToken) =>
      refreshTokens({ tokenEndpoint: (await discovery.get()).token_endpoint, client: cfg.client, refreshToken }),
    onEvent: (e) => {
      if (e.type === "dead" || e.type === "transient_failure") console.warn(`[xai] refresh ${e.type}`);
    },
  });
  g.__xaiRuntime__ = { cfg, store, discovery, jwks, broker };
  return g.__xaiRuntime__;
}

export function xaiEnabled(): boolean {
  return getXaiConfig().enabled;
}

async function storeTokens(
  rt: Runtime,
  userId: string,
  flow: "auth_code" | "device",
  tokens: TokenSet,
  expectedNonceSha256: string | null,
) {
  let subject: string | null = null;
  let email: string | null = null;
  if (tokens.id_token) {
    const claims = await verifyIdToken(tokens.id_token, {
      issuer: rt.cfg.issuer,
      clientId: rt.cfg.client.clientId,
      expectedNonceSha256,
      getKey: (kid) => rt.jwks.getKey(kid),
    }).catch((err: unknown) => {
      console.warn(`[xai] ${err instanceof Error ? err.message : "id_token rejected"}`);
      throw new XaiFlowError("id_token_invalid");
    });
    subject = claims.sub;
    email = typeof claims.email === "string" ? claims.email.slice(0, 320) : null;
  } else if (flow === "auth_code") {
    // We always request `openid`; an auth-code response without an id_token
    // cannot prove the nonce binding, so refuse it.
    throw new XaiFlowError("missing_id_token");
  }
  await rt.store.upsertCredential(userId, {
    flow,
    clientId: rt.cfg.client.clientId,
    subject,
    email,
    scope: tokens.scope ?? rt.cfg.scope,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? DEFAULT_ACCESS_TTL_S) * 1000),
  });
}

/** Flow A step 1: create the handshake and return xAI's authorize URL. */
export async function startAuthCodeFlow(userId: string): Promise<string> {
  const rt = runtime();
  if (!rt.cfg.authCodeFlow || !rt.cfg.redirectUri) throw new XaiDisabledError();
  const meta = await rt.discovery.get();
  await rt.store.purgeExpiredPending();
  const h = createAuthCodeHandshake();
  await rt.store.insertAuthCodePending(userId, {
    stateHash: h.stateHash,
    nonceHash: h.nonceHash,
    codeVerifier: h.codeVerifier,
    ttlS: PENDING_TTL_S,
  });
  return buildAuthorizationUrl({
    authorizationEndpoint: meta.authorization_endpoint,
    clientId: rt.cfg.client.clientId,
    redirectUri: rt.cfg.redirectUri,
    scope: rt.cfg.scope,
    state: h.state,
    nonce: h.nonce,
    codeChallenge: h.codeChallenge,
  });
}

/** Flow A step 2 (callback): validate state, exchange code server-side, store tokens. */
export async function completeAuthCodeFlow(userId: string, params: { code: string | null; state: string | null }) {
  const rt = runtime();
  if (!rt.cfg.authCodeFlow || !rt.cfg.redirectUri) throw new XaiDisabledError();
  if (!params.state) throw new XaiFlowError("missing_state");
  const row = await rt.store.takeAuthCodePending(sha256Hex(params.state));
  const check = checkPendingState({ state: params.state, row, userId });
  if (!check.ok) throw new XaiFlowError(check.reason);
  if (!params.code) throw new XaiFlowError("missing_code");
  if (!row?.codeVerifier || !row.nonce_hash) throw new XaiFlowError("pending_corrupt");
  const meta = await rt.discovery.get();
  let tokens: TokenSet;
  try {
    tokens = await exchangeAuthorizationCode({
      tokenEndpoint: meta.token_endpoint,
      client: rt.cfg.client,
      code: params.code,
      codeVerifier: row.codeVerifier,
      redirectUri: rt.cfg.redirectUri,
    });
  } catch (err) {
    console.warn(`[xai] code exchange failed: ${err instanceof Error ? err.message : "error"}`);
    throw new XaiFlowError("exchange_failed");
  }
  await storeTokens(rt, userId, "auth_code", tokens, row.nonce_hash);
}

/** Abandon a callback that came back with `?error=` (consume the handshake). */
export async function abandonAuthCodeFlow(state: string | null) {
  if (!state) return;
  const rt = runtime();
  await rt.store.takeAuthCodePending(sha256Hex(state));
}

export type DeviceStart = {
  id: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalS: number;
  expiresAt: string;
};

/** Flow B step 1: RFC 8628 device authorization. Returns only display data. */
export async function startDeviceFlow(userId: string): Promise<DeviceStart> {
  const rt = runtime();
  if (!rt.cfg.deviceFlow) throw new XaiDisabledError();
  const meta = await rt.discovery.get();
  if (!meta.device_authorization_endpoint) throw new XaiFlowError("device_flow_unsupported");
  await rt.store.purgeExpiredPending();
  let auth;
  try {
    auth = await startDeviceAuthorization({
      deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
      client: rt.cfg.client,
      scope: rt.cfg.scope,
    });
  } catch (err) {
    console.warn(`[xai] device authorization failed: ${err instanceof Error ? err.message : "error"}`);
    throw new XaiFlowError("device_start_failed");
  }
  const { id, expiresAt } = await rt.store.insertDevicePending(userId, {
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: auth.verificationUriComplete ?? auth.verificationUri,
    intervalS: auth.intervalS,
    expiresInS: auth.expiresInS,
  });
  return {
    id,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    intervalS: auth.intervalS,
    expiresAt: expiresAt.toISOString(),
  };
}

export type DevicePollResult =
  | { state: "pending"; intervalS: number }
  | { state: "connected" }
  | { state: "expired" | "denied" | "error"; code?: string };

/** Flow B step 2: one server-side poll, rate-limited by xAI's interval. */
export async function pollDeviceFlow(userId: string, id: string): Promise<DevicePollResult> {
  const rt = runtime();
  if (!rt.cfg.deviceFlow) throw new XaiDisabledError();
  const pending = await rt.store.getDevicePending(userId, id);
  if (!pending) return { state: "expired" };
  if (!pending.deviceCode) {
    await rt.store.deletePending(id);
    return { state: "error", code: "pending_corrupt" };
  }
  const meta = await rt.discovery.get();
  const step = await pollDeviceOnce({
    pending: {
      deviceCode: pending.deviceCode,
      intervalS: pending.intervalS,
      nextPollAt: pending.nextPollAt,
      expiresAt: pending.expiresAt,
    },
    now: new Date(),
    requestToken: deviceTokenRequester({ tokenEndpoint: meta.token_endpoint, client: rt.cfg.client }),
  });
  switch (step.outcome.kind) {
    case "pending":
      if (step.calledXai) await rt.store.updateDeviceSchedule(id, step.intervalS, step.nextPollAt);
      return { state: "pending", intervalS: step.intervalS };
    case "success":
      await rt.store.deletePending(id);
      await storeTokens(rt, userId, "device", step.outcome.tokens, null);
      return { state: "connected" };
    case "expired":
    case "denied":
      await rt.store.deletePending(id);
      return { state: step.outcome.kind };
    default:
      await rt.store.deletePending(id);
      return { state: "error", code: step.outcome.code };
  }
}

export async function getConnection(userId: string): Promise<ConnectionInfo> {
  return runtime().store.getConnection(userId);
}

/** Revoke at xAI (best effort) and delete the row. */
export async function disconnect(userId: string): Promise<{ revoked: boolean }> {
  const rt = runtime();
  const tokens = await rt.store.deleteCredential(userId);
  if (!tokens) return { revoked: false };
  let revoked = false;
  try {
    const meta = await rt.discovery.get();
    if (meta.revocation_endpoint) {
      const endpoint = meta.revocation_endpoint;
      const results = await Promise.all([
        tokens.refreshToken
          ? revokeToken({ revocationEndpoint: endpoint, client: rt.cfg.client, token: tokens.refreshToken, tokenTypeHint: "refresh_token" })
          : Promise.resolve(false),
        tokens.accessToken
          ? revokeToken({ revocationEndpoint: endpoint, client: rt.cfg.client, token: tokens.accessToken, tokenTypeHint: "access_token" })
          : Promise.resolve(false),
      ]);
      revoked = results.some(Boolean);
    }
  } catch {
    revoked = false;
  }
  return { revoked };
}

export type ResolvedCredential =
  | { kind: "user_oauth"; userId: string; accessToken: string; expiresAt: Date }
  | { kind: "server_key"; apiKey: string }
  | { kind: "none"; reason: "no_key" | "signed_out" | "not_connected" | "needs_reauth" | "refresh_failed" };

/**
 * Pick the credential for one generation (policy):
 *   feature off → server XAI_API_KEY (unchanged behaviour) or none;
 *   feature on  → the user's xAI token (refreshed to cover `minTtlMs`), else
 *                 the server key only if XAI_SERVER_KEY_FALLBACK=true.
 */
export async function resolveGenerationCredential(userId: string | null, minTtlMs: number): Promise<ResolvedCredential> {
  const cfg = getXaiConfig();
  const serverKey = process.env.XAI_API_KEY?.trim();
  if (!cfg.enabled) return serverKey ? { kind: "server_key", apiKey: serverKey } : { kind: "none", reason: "no_key" };
  let reason: Extract<ResolvedCredential, { kind: "none" }>["reason"] = "signed_out";
  if (userId) {
    try {
      const t = await runtime().broker.getFreshAccessToken(userId, minTtlMs);
      return { kind: "user_oauth", userId, accessToken: t.accessToken, expiresAt: t.expiresAt };
    } catch (err) {
      reason = err instanceof XaiCredentialError ? err.code : "refresh_failed";
    }
  }
  if (cfg.serverKeyFallback && serverKey) return { kind: "server_key", apiKey: serverKey };
  return { kind: "none", reason };
}

/** Record a short inference error code (e.g. inference_403) for the settings UI. */
export async function recordInferenceError(userId: string, code: string) {
  try {
    await runtime().store.setLastError(userId, code);
  } catch {
    // diagnostics only
  }
}

export const CREDENTIAL_MESSAGES: Record<Extract<ResolvedCredential, { kind: "none" }>["reason"], string> = {
  no_key: "No xAI credential configured.",
  signed_out: "Sign in and connect your xAI account (home screen → xAI account) to generate with Grok.",
  not_connected: "Connect your xAI account (home screen → xAI account) to generate with Grok.",
  needs_reauth: "Your xAI connection expired or was revoked. Reconnect xAI on the home screen.",
  refresh_failed: "Couldn't refresh your xAI sign-in right now. Try again in a moment.",
};
