/**
 * PKCE (RFC 7636, S256 only), OAuth `state` and OIDC `nonce` helpers.
 * **Server-only** (node:crypto). Dependency-free so `node --test` can import it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** base64url without padding (RFC 4648 §5). */
export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/** 32 random bytes → 43-char verifier (RFC 7636 §4.1: 43..128 unreserved chars). */
export function createCodeVerifier(bytes = 32): string {
  if (bytes < 32 || bytes > 96) throw new RangeError("verifier entropy must be 32..96 bytes");
  return base64url(randomBytes(bytes));
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))` — the only method xAI advertises. */
export function codeChallengeS256(verifier: string): string {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    throw new TypeError("invalid code_verifier");
  }
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** Opaque, unguessable token for `state` / `nonce` (32 bytes of entropy). */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** Hex SHA-256, used to store `state` / `nonce` without keeping the raw value. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type AuthCodeHandshake = {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  stateHash: string;
  nonceHash: string;
};

/** Fresh state + nonce + PKCE pair, plus the hashes that get persisted. */
export function createAuthCodeHandshake(): AuthCodeHandshake {
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = createCodeVerifier();
  return {
    state,
    nonce,
    codeVerifier,
    codeChallenge: codeChallengeS256(codeVerifier),
    stateHash: sha256Hex(state),
    nonceHash: sha256Hex(nonce),
  };
}

/**
 * Build the authorization URL. `authorizationEndpoint` must come from the
 * pinned issuer's discovery document; `redirectUri` from fixed config — never
 * from request headers.
 */
export function buildAuthorizationUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  extraParams?: Record<string, string>;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    ...(opts.extraParams ?? {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Validate a callback `state` against a persisted handshake row. Pure so the
 * binding rules are unit-testable: right hash, same user, not expired.
 */
export function checkPendingState(opts: {
  state: string | null | undefined;
  row: { state_hash: string | null; user_id: string; expires_at: Date | string } | null;
  userId: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: "missing_state" | "unknown_state" | "user_mismatch" | "expired" } {
  if (!opts.state) return { ok: false, reason: "missing_state" };
  const row = opts.row;
  if (!row || !row.state_hash || !safeEqual(row.state_hash, sha256Hex(opts.state))) {
    return { ok: false, reason: "unknown_state" };
  }
  if (row.user_id !== opts.userId) return { ok: false, reason: "user_mismatch" };
  const exp = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (!(exp.getTime() > (opts.now ?? new Date()).getTime())) return { ok: false, reason: "expired" };
  return { ok: true };
}
