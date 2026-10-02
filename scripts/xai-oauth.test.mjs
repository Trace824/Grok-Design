// Unit tests: PKCE/state, AES-GCM token encryption, id_token verification,
// discovery caching, and xAI sign-in config gating. Pure modules only (no DB).
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  buildAuthorizationUrl,
  checkPendingState,
  codeChallengeS256,
  createAuthCodeHandshake,
  createCodeVerifier,
  sha256Hex,
} from "../src/lib/xai/core/pkce.ts";
import { ciphertextKeyId, decryptSecret, encryptSecret, parseKeyring } from "../src/lib/xai/core/crypto.ts";
import {
  createDiscoveryCache,
  isTerminalRefreshError,
  OAuthError,
  parseTokenSet,
  validateMetadata,
  verifyIdToken,
} from "../src/lib/xai/core/oidc.ts";
import { parseXaiConfig } from "../src/lib/xai/config.server.ts";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("hex");

// ── PKCE / state ────────────────────────────────────────────────────────────
test("PKCE S256 matches the RFC 7636 Appendix B vector", () => {
  assert.equal(
    codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("code verifier is 43+ unreserved chars and rejects bad input", () => {
  const v = createCodeVerifier();
  assert.match(v, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.throws(() => codeChallengeS256("too-short"));
  assert.throws(() => createCodeVerifier(16));
});

test("handshake: fresh random state/nonce/verifier, only hashes persisted", () => {
  const a = createAuthCodeHandshake();
  const b = createAuthCodeHandshake();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
  assert.equal(a.stateHash, sha256Hex(a.state));
  assert.equal(a.nonceHash, sha256Hex(a.nonce));
  assert.notEqual(a.stateHash, a.state);
  assert.equal(a.codeChallenge, codeChallengeS256(a.codeVerifier));
});

test("authorization URL carries S256 challenge, state, nonce and the fixed redirect", () => {
  const h = createAuthCodeHandshake();
  const url = new URL(
    buildAuthorizationUrl({
      authorizationEndpoint: "https://auth.x.ai/oauth2/authorize",
      clientId: "grok-design-test",
      redirectUri: "https://grok-design.fly.dev/api/xai/oauth/callback",
      scope: "openid email offline_access",
      state: h.state,
      nonce: h.nonce,
      codeChallenge: h.codeChallenge,
    }),
  );
  assert.equal(url.origin + url.pathname, "https://auth.x.ai/oauth2/authorize");
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("code_challenge"), h.codeChallenge);
  assert.equal(p.get("state"), h.state);
  assert.equal(p.get("nonce"), h.nonce);
  assert.equal(p.get("redirect_uri"), "https://grok-design.fly.dev/api/xai/oauth/callback");
  assert.equal(p.get("code_verifier"), null, "verifier must never leave the server");
});

test("callback state is bound to user, single row, and TTL", () => {
  const h = createAuthCodeHandshake();
  const row = { state_hash: h.stateHash, user_id: "u1", expires_at: new Date(Date.now() + 60_000) };
  assert.deepEqual(checkPendingState({ state: h.state, row, userId: "u1" }), { ok: true });
  assert.equal(checkPendingState({ state: null, row, userId: "u1" }).reason, "missing_state");
  assert.equal(checkPendingState({ state: "forged", row, userId: "u1" }).reason, "unknown_state");
  assert.equal(checkPendingState({ state: h.state, row: null, userId: "u1" }).reason, "unknown_state");
  assert.equal(checkPendingState({ state: h.state, row, userId: "attacker" }).reason, "user_mismatch");
  const expired = { ...row, expires_at: new Date(Date.now() - 1).toISOString() };
  assert.equal(checkPendingState({ state: h.state, row: expired, userId: "u1" }).reason, "expired");
});

// ── AES-256-GCM ─────────────────────────────────────────────────────────────
test("encryption round-trips and never stores plaintext", () => {
  const kr = parseKeyring(KEY_A);
  const ct = encryptSecret(kr, "refresh-token-value", { userId: "u1", purpose: "refresh_token" });
  assert.ok(!ct.includes("refresh-token-value"));
  assert.match(ct, /^gcm1\.k1\./);
  assert.equal(decryptSecret(kr, ct, { userId: "u1", purpose: "refresh_token" }), "refresh-token-value");
  const ct2 = encryptSecret(kr, "refresh-token-value", { userId: "u1", purpose: "refresh_token" });
  assert.notEqual(ct, ct2, "random IV per encryption");
});

test("AAD binds ciphertext to user and column; tampering fails", () => {
  const kr = parseKeyring(KEY_A);
  const ct = encryptSecret(kr, "secret", { userId: "u1", purpose: "access_token" });
  assert.throws(() => decryptSecret(kr, ct, { userId: "u2", purpose: "access_token" }));
  assert.throws(() => decryptSecret(kr, ct, { userId: "u1", purpose: "refresh_token" }));
  const parts = ct.split(".");
  const body = Buffer.from(parts[3], "base64url");
  body[0] ^= 1;
  parts[3] = body.toString("base64url");
  assert.throws(() => decryptSecret(kr, parts.join("."), { userId: "u1", purpose: "access_token" }));
});

test("key rotation: first key encrypts, older keys still decrypt", () => {
  const old = parseKeyring(`k1:${KEY_A}`);
  const ct = encryptSecret(old, "t", { userId: "u", purpose: "p" });
  const rotated = parseKeyring(`k2:${KEY_B},k1:${KEY_A}`);
  assert.equal(rotated.activeId, "k2");
  assert.equal(decryptSecret(rotated, ct, { userId: "u", purpose: "p" }), "t");
  assert.equal(ciphertextKeyId(encryptSecret(rotated, "t", { userId: "u", purpose: "p" })), "k2");
  assert.throws(() => decryptSecret(parseKeyring(`k9:${KEY_B}`), ct, { userId: "u", purpose: "p" }), /unknown encryption key/);
  assert.throws(() => decryptSecret(parseKeyring(KEY_B), ct, { userId: "u", purpose: "p" }), "same id, wrong key");
});

test("keyring rejects short or malformed keys without echoing them", () => {
  assert.throws(() => parseKeyring(""), /not set/);
  assert.throws(() => parseKeyring(Buffer.alloc(16).toString("base64")), /32 bytes/);
  assert.throws(() => parseKeyring(`${KEY_A},${KEY_B}`), /id:key/);
  try {
    parseKeyring("c2hvcnQ=");
  } catch (e) {
    assert.ok(!String(e.message).includes("c2hvcnQ="));
  }
});

// ── id_token (ES256 via JWKS) ───────────────────────────────────────────────
const ISS = "https://auth.x.ai";
const CLIENT = "grok-design-test";
const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

async function signJwt(claims, header = { alg: "ES256", kid: "k1", typ: "JWT" }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(sig).toString("base64url")}`;
}

const now = Math.floor(Date.now() / 1000);
const nonce = "nonce-123";
const baseClaims = { iss: ISS, sub: "xai-user-1", aud: CLIENT, exp: now + 600, iat: now, nonce, email: "a@b.c" };
const verifyOpts = {
  issuer: ISS,
  clientId: CLIENT,
  expectedNonceSha256: sha256Hex(nonce),
  getKey: async (kid) => (kid === "k1" ? publicKey : null),
};

test("id_token: valid ES256 token verifies (iss/aud/nonce/exp)", async () => {
  const claims = await verifyIdToken(await signJwt(baseClaims), verifyOpts);
  assert.equal(claims.sub, "xai-user-1");
});

test("id_token: rejects wrong nonce, aud, iss, expiry, alg, kid, signature", async () => {
  const bad = async (claims, header, opts = {}) =>
    assert.rejects(verifyIdToken(await signJwt(claims, header), { ...verifyOpts, ...opts }));
  await bad({ ...baseClaims, nonce: "other" });
  await bad({ ...baseClaims, aud: "someone-else" });
  await bad({ ...baseClaims, aud: [CLIENT, "x"], azp: "x" });
  await bad({ ...baseClaims, iss: "https://evil.example" });
  await bad({ ...baseClaims, exp: now - 3600 });
  await bad(baseClaims, { alg: "none", kid: "k1" });
  await bad(baseClaims, { alg: "HS256", kid: "k1" });
  await bad(baseClaims, { alg: "ES256", kid: "unknown" });
  const good = await signJwt(baseClaims);
  const [h, , s] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ ...baseClaims, sub: "victim" })).toString("base64url");
  await assert.rejects(verifyIdToken(`${h}.${forged}.${s}`, verifyOpts), /signature/);
  // device flow: no nonce expected
  const { nonce: _n, ...noNonce } = baseClaims;
  await verifyIdToken(await signJwt(noNonce), { ...verifyOpts, expectedNonceSha256: null });
});

// ── discovery ───────────────────────────────────────────────────────────────
const DISCOVERY = {
  issuer: ISS,
  authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  revocation_endpoint: "https://auth.x.ai/oauth2/revoke",
  jwks_uri: "https://auth.x.ai/.well-known/jwks.json",
  code_challenge_methods_supported: ["S256"],
};

test("discovery: pinned issuer, https same-host endpoints, S256 required", () => {
  assert.equal(validateMetadata(DISCOVERY, ISS).token_endpoint, DISCOVERY.token_endpoint);
  assert.throws(() => validateMetadata({ ...DISCOVERY, issuer: "https://evil" }, ISS), /issuer/);
  assert.throws(() => validateMetadata({ ...DISCOVERY, token_endpoint: "https://evil.example/t" }, ISS), /issuer host/);
  assert.throws(() => validateMetadata({ ...DISCOVERY, token_endpoint: "http://auth.x.ai/t" }, ISS), /https/);
  assert.throws(() => validateMetadata({ ...DISCOVERY, code_challenge_methods_supported: ["plain"] }, ISS), /S256/);
});

test("discovery: cached within TTL, stale-if-error after", async () => {
  let calls = 0;
  let fail = false;
  let t = 0;
  const cache = createDiscoveryCache({
    issuer: ISS,
    ttlMs: 1000,
    staleMs: 5000,
    now: () => t,
    fetchImpl: async () => {
      calls += 1;
      if (fail) throw new Error("network");
      return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    },
  });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1, "concurrent callers share one fetch");
  t = 500;
  await cache.get();
  assert.equal(calls, 1);
  t = 2000;
  fail = true;
  assert.equal((await cache.get()).issuer, ISS, "stale copy served on error");
  t = 10_000;
  await assert.rejects(cache.get());
});

test("token responses: errors become OAuthError; terminal refresh errors detected", () => {
  assert.equal(parseTokenSet(200, { access_token: "a", refresh_token: "r", expires_in: 60 }).refresh_token, "r");
  assert.throws(() => parseTokenSet(400, { error: "invalid_grant" }), OAuthError);
  assert.ok(isTerminalRefreshError(new OAuthError("invalid_grant", 400)));
  assert.ok(!isTerminalRefreshError(new OAuthError("temporarily_unavailable", 503)));
  assert.ok(!isTerminalRefreshError(new Error("network")));
  // Client misconfiguration must not wipe every user's grant.
  assert.ok(!isTerminalRefreshError(new OAuthError("invalid_client", 401)));
});

// ── config gating ───────────────────────────────────────────────────────────
test("feature is disabled unless client id, scope and key are set", () => {
  assert.equal(parseXaiConfig({}).enabled, false);
  assert.equal(parseXaiConfig({ XAI_OAUTH_CLIENT_ID: "c", XAI_OAUTH_SCOPE: "email" }).enabled, false);
  assert.equal(parseXaiConfig({}).serverKeyFallback, true, "feature off keeps today's server-key behaviour");
  const on = parseXaiConfig({ XAI_OAUTH_CLIENT_ID: "c", XAI_OAUTH_SCOPE: "email offline_access", XAI_TOKEN_ENC_KEY: KEY_A });
  assert.equal(on.enabled, true);
  assert.equal(on.deviceFlow, true);
  assert.equal(on.authCodeFlow, false, "redirect flow needs a fixed XAI_OAUTH_REDIRECT_URI");
  assert.equal(on.serverKeyFallback, false, "server key fallback is opt-in once users can connect");
  assert.ok(on.scope.split(" ").includes("openid"));
  assert.equal(on.client.clientSecret, undefined);
});

test("config rejects forbidden scopes, bad redirect URIs, and prod without Neon", () => {
  const base = { XAI_OAUTH_CLIENT_ID: "c", XAI_OAUTH_SCOPE: "openid", XAI_TOKEN_ENC_KEY: KEY_A };
  assert.equal(parseXaiConfig({ ...base, XAI_OAUTH_SCOPE: "openid api-keys:write" }).enabled, false);
  assert.equal(parseXaiConfig({ ...base, XAI_OAUTH_REDIRECT_URI: "http://evil.example/cb" }).enabled, false);
  const ok = parseXaiConfig({ ...base, XAI_OAUTH_REDIRECT_URI: "https://grok-design.fly.dev/api/xai/oauth/callback" });
  assert.equal(ok.authCodeFlow, true);
  assert.equal(parseXaiConfig({ ...base, XAI_OAUTH_DEVICE_FLOW: "false" }).enabled, false);
  assert.equal(parseXaiConfig({ ...base, NODE_ENV: "production" }).enabled, false);
  assert.equal(parseXaiConfig({ ...base, NODE_ENV: "production", DATABASE_URL: "postgres://x" }).enabled, true);
  assert.equal(parseXaiConfig({ ...base, VITE_AUTH_ENABLED: "false" }).enabled, false);
  const disabled = parseXaiConfig({ ...base, XAI_TOKEN_ENC_KEY: "short" });
  assert.equal(disabled.enabled, false);
  assert.ok(!disabled.reason.includes("short"), "reason never echoes the key");
});
