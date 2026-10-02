/**
 * Minimal OIDC/OAuth client for xAI (`https://auth.x.ai`). **Server-only.**
 *
 * - Discovery + JWKS with in-memory caching (xAI sends no cache headers).
 * - id_token verification (ES256 via WebCrypto; iss/aud/azp/exp/iat/nonce).
 * - Token endpoint (code exchange, refresh, device-code), revoke, device
 *   authorization. xAI's token endpoint has no CORS, so all of this runs on the
 *   server; nothing here is ever sent to the browser.
 *
 * Dependency-free (fetch + node:crypto + WebCrypto) and fetch-injectable so it
 * is unit-testable with `node --test`.
 */
import { createHash, webcrypto } from "node:crypto";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
};

export type TokenSet = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
};

/** OAuth error from xAI. `message` never contains token material. */
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, description?: string) {
    super(`xAI OAuth error: ${code}${description ? ` (${description.slice(0, 160)})` : ""}`);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

const HTTP_TIMEOUT_MS = 10_000;

function assertHttpsSameHost(label: string, value: unknown, issuerHost: string): string {
  if (typeof value !== "string") throw new Error(`OIDC discovery: missing ${label}`);
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password) {
    throw new Error(`OIDC discovery: ${label} must be https`);
  }
  if (u.host !== issuerHost) throw new Error(`OIDC discovery: ${label} is not on the issuer host`);
  return value;
}

/** Validate a discovery document against the pinned issuer. */
export function validateMetadata(raw: unknown, issuer: string): OidcMetadata {
  if (!raw || typeof raw !== "object") throw new Error("OIDC discovery: not an object");
  const m = raw as Record<string, unknown>;
  if (m.issuer !== issuer) throw new Error("OIDC discovery: issuer mismatch");
  const host = new URL(issuer).host;
  const out: OidcMetadata = {
    issuer,
    authorization_endpoint: assertHttpsSameHost("authorization_endpoint", m.authorization_endpoint, host),
    token_endpoint: assertHttpsSameHost("token_endpoint", m.token_endpoint, host),
    jwks_uri: assertHttpsSameHost("jwks_uri", m.jwks_uri, host),
  };
  if (m.device_authorization_endpoint !== undefined) {
    out.device_authorization_endpoint = assertHttpsSameHost(
      "device_authorization_endpoint",
      m.device_authorization_endpoint,
      host,
    );
  }
  if (m.revocation_endpoint !== undefined) {
    out.revocation_endpoint = assertHttpsSameHost("revocation_endpoint", m.revocation_endpoint, host);
  }
  if (Array.isArray(m.code_challenge_methods_supported)) {
    out.code_challenge_methods_supported = m.code_challenge_methods_supported as string[];
    if (!out.code_challenge_methods_supported.includes("S256")) {
      throw new Error("OIDC discovery: issuer does not support PKCE S256");
    }
  }
  return out;
}

/**
 * Cached discovery: fresh for `ttlMs`, then refetched; on a failed refetch a
 * cached copy is served for up to `staleMs` more (stale-if-error). Concurrent
 * callers share one in-flight fetch.
 */
export function createDiscoveryCache(opts: {
  issuer: string;
  fetchImpl?: FetchLike;
  ttlMs?: number;
  staleMs?: number;
  now?: () => number;
}) {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ttl = opts.ttlMs ?? 60 * 60_000;
  const stale = opts.staleMs ?? 24 * 60 * 60_000;
  const now = opts.now ?? Date.now;
  const url = `${opts.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let cached: { value: OidcMetadata; at: number } | null = null;
  let inflight: Promise<OidcMetadata> | null = null;

  async function load(): Promise<OidcMetadata> {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const value = validateMetadata(await res.json(), opts.issuer);
    cached = { value, at: now() };
    return value;
  }

  return {
    async get(): Promise<OidcMetadata> {
      if (cached && now() - cached.at < ttl) return cached.value;
      inflight ??= load().finally(() => {
        inflight = null;
      });
      try {
        return await inflight;
      } catch (err) {
        if (cached && now() - cached.at < ttl + stale) return cached.value;
        throw err;
      }
    },
    clear() {
      cached = null;
    },
  };
}

type Jwk = { kty?: string; crv?: string; kid?: string; x?: string; y?: string; use?: string; alg?: string };

/**
 * JWKS cache keyed by `kid`. Unknown kid → one refetch (rate-limited by
 * `refetchCooldownMs`) to pick up key rotation.
 */
export function createJwksCache(opts: {
  jwksUri: () => Promise<string>;
  fetchImpl?: FetchLike;
  ttlMs?: number;
  refetchCooldownMs?: number;
  now?: () => number;
}) {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ttl = opts.ttlMs ?? 60 * 60_000;
  const cooldown = opts.refetchCooldownMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const res = await fetchImpl(await opts.jwksUri(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.kid || !jwk.x || !jwk.y) continue;
      if (jwk.use && jwk.use !== "sig") continue;
      const key = await webcrypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      next.set(jwk.kid, key as CryptoKey);
    }
    keys = next;
    fetchedAt = now();
  }

  function refreshOnce(): Promise<void> {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async getKey(kid: string): Promise<CryptoKey | null> {
      if (now() - fetchedAt >= ttl) await refreshOnce();
      let key = keys.get(kid) ?? null;
      if (!key && now() - fetchedAt >= cooldown) {
        await refreshOnce();
        key = keys.get(kid) ?? null;
      }
      return key;
    },
  };
}

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [k: string]: unknown;
};

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify an ES256 id_token. Throws with a short reason on any failure.
 * `expectedNonceSha256` (hex SHA-256 of the nonce we sent — only the hash is
 * stored) is required for the auth-code flow; the device flow has no nonce, so
 * pass `null` there.
 */
export async function verifyIdToken(
  idToken: string,
  opts: {
    issuer: string;
    clientId: string;
    expectedNonceSha256: string | null;
    getKey: (kid: string) => Promise<CryptoKey | null>;
    nowSec?: number;
    skewSec?: number;
  },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token: malformed");
  let header: Record<string, unknown>;
  let claims: IdTokenClaims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]) as IdTokenClaims;
  } catch {
    throw new Error("id_token: malformed");
  }
  if (header.alg !== "ES256") throw new Error("id_token: unexpected alg");
  if (typeof header.kid !== "string") throw new Error("id_token: missing kid");
  const key = await opts.getKey(header.kid);
  if (!key) throw new Error("id_token: unknown signing key");
  const sig = Buffer.from(parts[2], "base64url");
  if (sig.length !== 64) throw new Error("id_token: bad signature length");
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
  );
  if (!ok) throw new Error("id_token: bad signature");

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSec ?? 60;
  if (claims.iss !== opts.issuer) throw new Error("id_token: iss mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) throw new Error("id_token: aud mismatch");
  if (aud.length > 1 && claims.azp !== opts.clientId) throw new Error("id_token: azp mismatch");
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) throw new Error("id_token: expired");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new Error("id_token: issued in the future");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("id_token: missing sub");
  if (opts.expectedNonceSha256 !== null) {
    const got = typeof claims.nonce === "string" ? createHash("sha256").update(claims.nonce, "utf8").digest("hex") : "";
    if (!got || !constantTimeEq(got, opts.expectedNonceSha256)) {
      throw new Error("id_token: nonce mismatch");
    }
  }
  return claims;
}

export type ClientCredentials = { clientId: string; clientSecret?: string };

function clientAuth(client: ClientCredentials, body: URLSearchParams): Record<string, string> {
  if (client.clientSecret) {
    // client_secret_basic (RFC 6749 §2.3.1: form-urlencode id and secret first)
    const basic = Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
    ).toString("base64");
    return { authorization: `Basic ${basic}` };
  }
  body.set("client_id", client.clientId); // public client (`none`)
  return {};
}

export async function postForm(
  url: string,
  client: ClientCredentials,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = new URLSearchParams(params);
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...clientAuth(client, body),
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, body: json };
}

export function oauthErrorFrom(status: number, body: Record<string, unknown>): OAuthError {
  const code = typeof body.error === "string" ? body.error.slice(0, 64) : `http_${status}`;
  const desc = typeof body.error_description === "string" ? body.error_description : undefined;
  return new OAuthError(code, status, desc);
}

export function parseTokenSet(status: number, body: Record<string, unknown>): TokenSet {
  if (status < 200 || status >= 300 || typeof body.access_token !== "string" || !body.access_token) {
    throw oauthErrorFrom(status, body);
  }
  return {
    access_token: body.access_token,
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    id_token: typeof body.id_token === "string" ? body.id_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

/** Authorization-code exchange (with PKCE verifier). */
export async function exchangeAuthorizationCode(opts: {
  tokenEndpoint: string;
  client: ClientCredentials;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const { status, body } = await postForm(
    opts.tokenEndpoint,
    opts.client,
    {
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
  return parseTokenSet(status, body);
}

/** Refresh-token grant. The response MAY carry a rotated refresh_token. */
export async function refreshTokens(opts: {
  tokenEndpoint: string;
  client: ClientCredentials;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const { status, body } = await postForm(
    opts.tokenEndpoint,
    opts.client,
    { grant_type: "refresh_token", refresh_token: opts.refreshToken },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
  return parseTokenSet(status, body);
}

/** RFC 7009 revoke. Best effort: resolves `false` instead of throwing. */
export async function revokeToken(opts: {
  revocationEndpoint: string;
  client: ClientCredentials;
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  try {
    const { status } = await postForm(
      opts.revocationEndpoint,
      opts.client,
      { token: opts.token, token_type_hint: opts.tokenTypeHint },
      opts.fetchImpl ?? ((u, i) => fetch(u, i)),
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

/**
 * Refresh failures that mean "this user's grant is dead; ask them to reconnect".
 * Only `invalid_grant` (RFC 6749 §5.2: refresh token invalid, expired, revoked,
 * or already rotated). Client-level errors (`invalid_client`,
 * `unauthorized_client`, HTTP 401) are server misconfiguration and must NOT wipe
 * every user's tokens, so they count as transient.
 */
export function isTerminalRefreshError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === "invalid_grant";
}

