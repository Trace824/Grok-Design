// Unit tests: RFC 8628 device-code start validation and server-side polling.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeviceTokenResponse,
  parseDeviceAuthorization,
  pollDeviceOnce,
  safeVerificationUrl,
  startDeviceAuthorization,
  DEVICE_GRANT_TYPE,
} from "../src/lib/xai/core/device.ts";

const OK_START = {
  device_code: "dev-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://accounts.x.ai/device",
  verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

test("device start: posts scope + client_id, returns display data only from allowlisted hosts", async () => {
  let seen;
  const auth = await startDeviceAuthorization({
    deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
    client: { clientId: "grok-design-test" },
    scope: "openid offline_access",
    fetchImpl: async (url, init) => {
      seen = { url, body: new URLSearchParams(init.body) };
      return new Response(JSON.stringify(OK_START), { status: 200 });
    },
  });
  assert.equal(seen.url, "https://auth.x.ai/oauth2/device/code");
  assert.equal(seen.body.get("client_id"), "grok-design-test");
  assert.equal(seen.body.get("scope"), "openid offline_access");
  assert.equal(auth.userCode, "ABCD-EFGH");
  assert.equal(auth.intervalS, 5);
  assert.equal(auth.verificationUriComplete, OK_START.verification_uri_complete);
});

test("device start: confidential client uses HTTP Basic, not a body secret", async () => {
  let headers;
  let body;
  await startDeviceAuthorization({
    deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
    client: { clientId: "id", clientSecret: "s3cret" },
    scope: "openid",
    fetchImpl: async (_u, init) => {
      headers = init.headers;
      body = String(init.body);
      return new Response(JSON.stringify(OK_START), { status: 200 });
    },
  });
  assert.match(headers.authorization, /^Basic /);
  assert.ok(!body.includes("s3cret"));
});

test("verification URLs must be https on xAI hosts without credentials", () => {
  const hosts = ["auth.x.ai", "accounts.x.ai"];
  assert.ok(safeVerificationUrl("https://accounts.x.ai/device", hosts));
  assert.equal(safeVerificationUrl("http://accounts.x.ai/device", hosts), null);
  assert.equal(safeVerificationUrl("https://evil.example/device", hosts), null);
  assert.equal(safeVerificationUrl("https://user:pw@accounts.x.ai/", hosts), null);
  assert.equal(safeVerificationUrl("https://accounts.x.ai/d?access_token=x", hosts), null);
  assert.throws(() => parseDeviceAuthorization(200, { ...OK_START, verification_uri: "https://evil.example" }));
  assert.throws(() => parseDeviceAuthorization(400, { error: "invalid_client" }), /invalid_client/);
});

test("token responses map to RFC 8628 outcomes; slow_down adds 5s", () => {
  assert.equal(classifyDeviceTokenResponse(400, { error: "authorization_pending" }, 5).outcome.kind, "pending");
  const slow = classifyDeviceTokenResponse(400, { error: "slow_down" }, 5);
  assert.equal(slow.outcome.kind, "pending");
  assert.equal(slow.intervalS, 10);
  assert.equal(classifyDeviceTokenResponse(400, { error: "expired_token" }, 5).outcome.kind, "expired");
  assert.equal(classifyDeviceTokenResponse(400, { error: "access_denied" }, 5).outcome.kind, "denied");
  assert.equal(classifyDeviceTokenResponse(400, { error: "invalid_client" }, 5).outcome.kind, "error");
  const ok = classifyDeviceTokenResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }, 5);
  assert.equal(ok.outcome.kind, "success");
  assert.equal(ok.outcome.tokens.refresh_token, "rt");
});

test("polling never calls xAI before next_poll_at or after expiry", async () => {
  const now = new Date("2026-10-02T12:00:00Z");
  let calls = 0;
  const requestToken = async () => (calls++, { status: 400, body: { error: "authorization_pending" } });
  const early = await pollDeviceOnce({
    now,
    requestToken,
    pending: { deviceCode: "d", intervalS: 5, nextPollAt: new Date(now.getTime() + 3000), expiresAt: new Date(now.getTime() + 600_000) },
  });
  assert.deepEqual(early.outcome, { kind: "pending", throttled: true });
  assert.equal(early.calledXai, false);
  const late = await pollDeviceOnce({
    now,
    requestToken,
    pending: { deviceCode: "d", intervalS: 5, nextPollAt: new Date(0), expiresAt: new Date(now.getTime() - 1) },
  });
  assert.equal(late.outcome.kind, "expired");
  assert.equal(calls, 0);
});

test("polling: one request per due poll, schedule advances by interval (and slow_down)", async () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const sent = [];
  const replies = [{ error: "authorization_pending" }, { error: "slow_down" }];
  const requestToken = async (dc) => {
    sent.push(dc);
    return { status: 400, body: replies.shift() };
  };
  const pending = { deviceCode: "dev-secret", intervalS: 5, nextPollAt: now, expiresAt: new Date(now.getTime() + 600_000) };
  const s1 = await pollDeviceOnce({ now, requestToken, pending });
  assert.equal(s1.calledXai, true);
  assert.equal(s1.nextPollAt.getTime(), now.getTime() + 5000);
  const s2 = await pollDeviceOnce({ now: s1.nextPollAt, requestToken, pending: { ...pending, nextPollAt: s1.nextPollAt } });
  assert.equal(s2.intervalS, 10);
  assert.equal(s2.nextPollAt.getTime(), s1.nextPollAt.getTime() + 10_000);
  assert.deepEqual(sent, ["dev-secret", "dev-secret"]);
});

test("polling: success returns tokens; network errors stay pending", async () => {
  const now = new Date();
  const pending = { deviceCode: "d", intervalS: 5, nextPollAt: new Date(0), expiresAt: new Date(now.getTime() + 60_000) };
  const ok = await pollDeviceOnce({
    now,
    pending,
    requestToken: async () => ({ status: 200, body: { access_token: "at", expires_in: 3600 } }),
  });
  assert.equal(ok.outcome.kind, "success");
  const blip = await pollDeviceOnce({
    now,
    pending,
    requestToken: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(blip.outcome.kind, "pending");
  assert.ok(DEVICE_GRANT_TYPE.endsWith("device_code"));
});
