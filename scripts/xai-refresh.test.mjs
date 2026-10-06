// Unit tests: per-user single-flight refresh, rotation, dead-refresh handling.
import assert from "node:assert/strict";
import test from "node:test";
import { createTokenBroker, XaiCredentialError } from "../src/lib/xai/core/refresh.ts";
import { OAuthError } from "../src/lib/xai/core/oidc.ts";

/** In-memory store whose `withLockedCredential` is a real per-user mutex (like FOR UPDATE). */
function memoryStore(initial) {
  const rows = new Map(Object.entries(initial));
  const locks = new Map();
  const log = [];
  return {
    rows,
    log,
    async read(userId) {
      const r = rows.get(userId);
      return r ? { ...r } : null;
    },
    async withLockedCredential(userId, fn) {
      const prev = locks.get(userId) ?? Promise.resolve();
      let release;
      const mine = new Promise((r) => (release = r));
      locks.set(userId, prev.then(() => mine));
      await prev;
      try {
        const r = rows.get(userId);
        return await fn(r ? { ...r } : null, {
          async save(u) {
            log.push(["save", userId]);
            rows.set(userId, { ...rows.get(userId), status: "active", accessToken: u.accessToken, refreshToken: u.refreshToken, accessExpiresAt: u.accessExpiresAt, version: rows.get(userId).version + 1 });
          },
          async markNeedsReauth(code) {
            log.push(["dead", userId, code]);
            rows.set(userId, { ...rows.get(userId), status: "needs_reauth", accessToken: null, refreshToken: null, accessExpiresAt: null });
          },
        });
      } finally {
        release();
      }
    },
  };
}

const T0 = 1_800_000_000_000;
const expiring = (overrides = {}) => ({
  status: "active",
  accessToken: "at-old",
  refreshToken: "rt-1",
  accessExpiresAt: new Date(T0 + 60_000), // inside the 5-minute window
  version: 0,
  ...overrides,
});

test("fresh token is returned without refreshing", async () => {
  const store = memoryStore({ u1: expiring({ accessExpiresAt: new Date(T0 + 3600_000) }) });
  let calls = 0;
  const broker = createTokenBroker({ store, now: () => T0, refresh: async () => (calls++, { access_token: "x" }) });
  assert.equal((await broker.getFreshAccessToken("u1")).accessToken, "at-old");
  assert.equal(calls, 0);
});

test("refreshes ~5 minutes before expiry, single-flight across concurrent callers", async () => {
  const store = memoryStore({ u1: expiring() });
  let calls = 0;
  const broker = createTokenBroker({
    store,
    now: () => T0,
    refresh: async (rt) => {
      calls += 1;
      assert.equal(rt, "rt-1");
      await new Promise((r) => setTimeout(r, 20));
      return { access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 };
    },
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => broker.getFreshAccessToken("u1")));
  assert.equal(calls, 1, "exactly one refresh for 10 concurrent requests");
  assert.ok(results.every((r) => r.accessToken === "at-new"));
  assert.equal(store.rows.get("u1").refreshToken, "rt-2", "rotated refresh token persisted");
  assert.equal(broker.inflightCount(), 0);
});

test("cross-process: a second broker waiting on the row lock reuses the refreshed token", async () => {
  const store = memoryStore({ u1: expiring() });
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { access_token: `at-${calls}`, refresh_token: `rt-${calls + 1}`, expires_in: 3600 };
  };
  // Two brokers = two Node processes sharing one DB (only the row lock is shared).
  const a = createTokenBroker({ store, now: () => T0, refresh });
  const b = createTokenBroker({ store, now: () => T0, refresh });
  const [ra, rb] = await Promise.all([a.getFreshAccessToken("u1"), b.getFreshAccessToken("u1")]);
  assert.equal(calls, 1, "the lock holder refreshed; the waiter re-read and reused");
  assert.equal(ra.accessToken, rb.accessToken);
});

test("users refresh independently", async () => {
  const store = memoryStore({ u1: expiring(), u2: expiring({ refreshToken: "rt-u2" }) });
  const seen = [];
  const broker = createTokenBroker({
    store,
    now: () => T0,
    refresh: async (rt) => (seen.push(rt), { access_token: `at-${rt}`, expires_in: 3600 }),
  });
  await Promise.all([broker.getFreshAccessToken("u1"), broker.getFreshAccessToken("u2")]);
  assert.deepEqual(seen.sort(), ["rt-1", "rt-u2"]);
});

test("no rotation in response keeps the existing refresh token", async () => {
  const store = memoryStore({ u1: expiring() });
  const broker = createTokenBroker({ store, now: () => T0, refresh: async () => ({ access_token: "at-new", expires_in: 3600 }) });
  await broker.getFreshAccessToken("u1");
  assert.equal(store.rows.get("u1").refreshToken, "rt-1");
});

test("dead refresh (invalid_grant) marks the account disconnected", async () => {
  const store = memoryStore({ u1: expiring() });
  const broker = createTokenBroker({
    store,
    now: () => T0,
    refresh: async () => {
      throw new OAuthError("invalid_grant", 400);
    },
  });
  await assert.rejects(broker.getFreshAccessToken("u1"), (e) => e instanceof XaiCredentialError && e.code === "needs_reauth");
  const row = store.rows.get("u1");
  assert.equal(row.status, "needs_reauth");
  assert.equal(row.refreshToken, null, "dead tokens are cleared");
  await assert.rejects(broker.getFreshAccessToken("u1"), (e) => e.code === "needs_reauth");
});

test("transient refresh failure keeps the account connected", async () => {
  const store = memoryStore({ u1: expiring() });
  const broker = createTokenBroker({
    store,
    now: () => T0,
    refresh: async () => {
      throw new OAuthError("temporarily_unavailable", 503);
    },
  });
  await assert.rejects(broker.getFreshAccessToken("u1"), (e) => e.code === "refresh_failed");
  assert.equal(store.rows.get("u1").status, "active");
  assert.equal(store.rows.get("u1").refreshToken, "rt-1");
});

test("minTtl forces a refresh when the token would expire mid-run; not_connected without a row", async () => {
  const store = memoryStore({ u1: expiring({ accessExpiresAt: new Date(T0 + 6 * 60_000) }) });
  let calls = 0;
  const broker = createTokenBroker({ store, now: () => T0, refresh: async () => (calls++, { access_token: "at-long", expires_in: 3600 }) });
  assert.equal((await broker.getFreshAccessToken("u1", 0)).accessToken, "at-old");
  assert.equal((await broker.getFreshAccessToken("u1", 8 * 60_000)).accessToken, "at-long");
  assert.equal(calls, 1);
  await assert.rejects(broker.getFreshAccessToken("nobody"), (e) => e.code === "not_connected");
});
