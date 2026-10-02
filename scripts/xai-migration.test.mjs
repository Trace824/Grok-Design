// Integration test: migrations/0003 applies on PGLite (same SQL Neon gets via
// scripts/migrate.mjs) and supports upsert, FOR UPDATE and cascade delete.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("0003_xai_credentials applies on PGLite after 0001/0002", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  try {
    for (const f of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
      await pg.exec(readFileSync(`migrations/${f}`, "utf8"));
    }
    await pg.query(`insert into "user" (id, name, email, "emailVerified") values ('u1', 'U', 'u@x', false)`);
    const insert = `insert into xai_credentials (user_id, flow, client_id, scope, access_token_enc, refresh_token_enc, key_id, access_expires_at)
      values ($1, 'device', 'cid', 'openid', 'gcm1.k1.a.b.c', 'gcm1.k1.d.e.f', 'k1', now() + interval '1 hour')
      on conflict (user_id) do update set access_token_enc = excluded.access_token_enc, version = xai_credentials.version + 1`;
    await pg.query(insert, ["u1"]);
    await pg.query(insert, ["u1"]);
    const row = (await pg.query("select status, version from xai_credentials where user_id = 'u1'")).rows[0];
    assert.equal(row.status, "active");
    assert.equal(Number(row.version), 1);
    await pg.transaction(async (tx) => {
      const locked = await tx.query("select user_id from xai_credentials where user_id = 'u1' for update");
      assert.equal(locked.rows.length, 1);
      await tx.query("update xai_credentials set status = 'needs_reauth' where user_id = 'u1'");
    });
    await assert.rejects(pg.query("update xai_credentials set status = 'bogus' where user_id = 'u1'"));
    await assert.rejects(
      pg.query(`insert into xai_credentials (user_id, flow, client_id, key_id) values ('ghost', 'device', 'c', 'k1')`),
      "FK to user",
    );
    await pg.query(
      `insert into xai_oauth_pending (id, user_id, kind, state_hash, expires_at) values ('p1', 'u1', 'auth_code', 'h', now() + interval '10 minutes')`,
    );
    await assert.rejects(
      pg.query(`insert into xai_oauth_pending (id, user_id, kind, state_hash, expires_at) values ('p2', 'u1', 'auth_code', 'h', now())`),
      "state_hash is unique",
    );
    await pg.query(`delete from "user" where id = 'u1'`);
    assert.equal((await pg.query("select count(*)::int as n from xai_credentials")).rows[0].n, 0, "cascade");
    assert.equal((await pg.query("select count(*)::int as n from xai_oauth_pending")).rows[0].n, 0, "cascade");
  } finally {
    await pg.close();
  }
});
