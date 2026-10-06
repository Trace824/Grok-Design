/**
 * Persistence for xAI credentials + pending OAuth handshakes — **server-only**.
 * Works on Neon (`pg`) and local PGLite via `@/lib/db`. Every query is scoped
 * by a server-verified user id; tokens are encrypted before they are written.
 */
import { randomUUID } from "node:crypto";
import { getSql, withTransaction, type Sql } from "../db";
import { decryptSecret, encryptSecret, type Keyring } from "./core/crypto.ts";
import type { CredentialUpdate, RefreshStore, StoredCredential } from "./core/refresh.ts";

type CredRow = {
  user_id: string;
  flow: "auth_code" | "device";
  client_id: string;
  subject: string | null;
  email: string | null;
  scope: string;
  access_token_enc: string | null;
  access_expires_at: Date | string | null;
  refresh_token_enc: string | null;
  key_id: string;
  status: "active" | "needs_reauth";
  last_error: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type PendingRow = {
  id: string;
  user_id: string;
  kind: "auth_code" | "device";
  state_hash: string | null;
  code_verifier_enc: string | null;
  nonce_hash: string | null;
  device_code_enc: string | null;
  user_code: string | null;
  verification_uri: string | null;
  poll_interval_s: number | null;
  next_poll_at: Date | string | null;
  expires_at: Date | string;
};

const toDate = (v: Date | string | null): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

export type ConnectionInfo = {
  connected: boolean;
  status: "active" | "needs_reauth" | null;
  email: string | null;
  scope: string | null;
  flow: "auth_code" | "device" | null;
  lastError: string | null;
  connectedAt: string | null;
};

export function createXaiStore(keyring: Keyring) {
  const enc = (userId: string, purpose: string, value: string) => encryptSecret(keyring, value, { userId, purpose });
  const dec = (userId: string, purpose: string, value: string | null): string | null => {
    if (!value) return null;
    try {
      return decryptSecret(keyring, value, { userId, purpose });
    } catch {
      return null; // unknown/rotated-out key or tampering → treated as missing
    }
  };

  function toStored(row: CredRow | undefined): StoredCredential | null {
    if (!row) return null;
    const accessToken = dec(row.user_id, "access_token", row.access_token_enc);
    const refreshToken = dec(row.user_id, "refresh_token", row.refresh_token_enc);
    const undecryptable = (row.access_token_enc && !accessToken) || (row.refresh_token_enc && !refreshToken);
    return {
      status: undecryptable ? "needs_reauth" : row.status,
      accessToken,
      refreshToken,
      accessExpiresAt: toDate(row.access_expires_at),
      version: Number(row.version),
    };
  }

  async function markNeedsReauthWith(sql: Sql, userId: string, code: string) {
    await sql`update xai_credentials
      set status = 'needs_reauth', access_token_enc = null, refresh_token_enc = null,
          access_expires_at = null, last_error = ${code}, version = version + 1, updated_at = now()
      where user_id = ${userId}`;
  }

  const refreshStore: RefreshStore = {
    async read(userId) {
      const sql = await getSql();
      const rows = await sql<CredRow>`select * from xai_credentials where user_id = ${userId}`;
      return toStored(rows[0]);
    },
    async withLockedCredential(userId, fn) {
      return withTransaction(async (tx) => {
        const rows = await tx<CredRow>`select * from xai_credentials where user_id = ${userId} for update`;
        return fn(toStored(rows[0]), {
          async save(update: CredentialUpdate) {
            await tx`update xai_credentials
              set access_token_enc = ${enc(userId, "access_token", update.accessToken)},
                  refresh_token_enc = ${update.refreshToken ? enc(userId, "refresh_token", update.refreshToken) : null},
                  access_expires_at = ${update.accessExpiresAt.toISOString()},
                  scope = coalesce(${update.scope ?? null}, scope),
                  key_id = ${keyring.activeId}, status = 'active', last_error = null,
                  last_refreshed_at = now(), version = version + 1, updated_at = now()
              where user_id = ${userId}`;
          },
          markNeedsReauth: (code: string) => markNeedsReauthWith(tx, userId, code),
        });
      });
    },
  };

  return {
    refreshStore,

    async getConnection(userId: string): Promise<ConnectionInfo> {
      const sql = await getSql();
      const rows = await sql<CredRow>`select * from xai_credentials where user_id = ${userId}`;
      const row = rows[0];
      if (!row) {
        return { connected: false, status: null, email: null, scope: null, flow: null, lastError: null, connectedAt: null };
      }
      const stored = toStored(row);
      return {
        connected: stored?.status === "active",
        status: stored?.status ?? row.status,
        email: row.email,
        scope: row.scope,
        flow: row.flow,
        lastError: row.last_error,
        connectedAt: toDate(row.created_at)?.toISOString() ?? null,
      };
    },

    async upsertCredential(
      userId: string,
      c: {
        flow: "auth_code" | "device";
        clientId: string;
        subject: string | null;
        email: string | null;
        scope: string;
        accessToken: string;
        refreshToken: string | null;
        accessExpiresAt: Date;
      },
    ) {
      const sql = await getSql();
      await sql`insert into xai_credentials
          (user_id, flow, client_id, subject, email, scope, access_token_enc, access_expires_at,
           refresh_token_enc, key_id, status, last_error, version, last_refreshed_at, created_at, updated_at)
        values (${userId}, ${c.flow}, ${c.clientId}, ${c.subject}, ${c.email}, ${c.scope},
           ${enc(userId, "access_token", c.accessToken)}, ${c.accessExpiresAt.toISOString()},
           ${c.refreshToken ? enc(userId, "refresh_token", c.refreshToken) : null}, ${keyring.activeId},
           'active', null, 0, now(), now(), now())
        on conflict (user_id) do update set
          flow = excluded.flow, client_id = excluded.client_id, subject = excluded.subject,
          email = excluded.email, scope = excluded.scope, access_token_enc = excluded.access_token_enc,
          access_expires_at = excluded.access_expires_at, refresh_token_enc = excluded.refresh_token_enc,
          key_id = excluded.key_id, status = 'active', last_error = null,
          version = xai_credentials.version + 1, last_refreshed_at = now(), updated_at = now()`;
    },

    async setLastError(userId: string, code: string) {
      const sql = await getSql();
      await sql`update xai_credentials set last_error = ${code.slice(0, 64)}, updated_at = now() where user_id = ${userId}`;
    },

    /** Delete the row; returns the decrypted tokens so the caller can revoke them. */
    async deleteCredential(userId: string): Promise<{ accessToken: string | null; refreshToken: string | null } | null> {
      const sql = await getSql();
      const rows = await sql<CredRow>`delete from xai_credentials where user_id = ${userId} returning *`;
      await sql`delete from xai_oauth_pending where user_id = ${userId}`;
      const row = rows[0];
      if (!row) return null;
      return {
        accessToken: dec(userId, "access_token", row.access_token_enc),
        refreshToken: dec(userId, "refresh_token", row.refresh_token_enc),
      };
    },

    async purgeExpiredPending() {
      const sql = await getSql();
      await sql`delete from xai_oauth_pending where expires_at < now()`;
    },

    async insertAuthCodePending(userId: string, p: { stateHash: string; nonceHash: string; codeVerifier: string; ttlS: number }) {
      const sql = await getSql();
      const id = randomUUID();
      // Keep at most a handful of open handshakes per user.
      await sql`delete from xai_oauth_pending where user_id = ${userId} and kind = 'auth_code'
        and id not in (select id from xai_oauth_pending where user_id = ${userId} and kind = 'auth_code'
                       order by created_at desc limit 4)`;
      await sql`insert into xai_oauth_pending (id, user_id, kind, state_hash, code_verifier_enc, nonce_hash, expires_at)
        values (${id}, ${userId}, 'auth_code', ${p.stateHash}, ${enc(userId, `pkce:${id}`, p.codeVerifier)},
                ${p.nonceHash}, ${new Date(Date.now() + p.ttlS * 1000).toISOString()})`;
      return id;
    },

    /** Single use: the row is deleted as it is read. */
    async takeAuthCodePending(stateHash: string): Promise<(PendingRow & { codeVerifier: string | null }) | null> {
      const sql = await getSql();
      const rows = await sql<PendingRow>`delete from xai_oauth_pending
        where state_hash = ${stateHash} and kind = 'auth_code' returning *`;
      const row = rows[0];
      if (!row) return null;
      return { ...row, codeVerifier: dec(row.user_id, `pkce:${row.id}`, row.code_verifier_enc) };
    },

    async insertDevicePending(
      userId: string,
      p: { deviceCode: string; userCode: string; verificationUri: string; intervalS: number; expiresInS: number },
    ) {
      const sql = await getSql();
      const id = randomUUID();
      await sql`delete from xai_oauth_pending where user_id = ${userId} and kind = 'device'`;
      const now = Date.now();
      await sql`insert into xai_oauth_pending
          (id, user_id, kind, device_code_enc, user_code, verification_uri, poll_interval_s, next_poll_at, expires_at)
        values (${id}, ${userId}, 'device', ${enc(userId, `device:${id}`, p.deviceCode)}, ${p.userCode},
                ${p.verificationUri}, ${p.intervalS}, ${new Date(now + p.intervalS * 1000).toISOString()},
                ${new Date(now + p.expiresInS * 1000).toISOString()})`;
      return { id, expiresAt: new Date(now + p.expiresInS * 1000) };
    },

    async getDevicePending(userId: string, id: string) {
      const sql = await getSql();
      const rows = await sql<PendingRow>`select * from xai_oauth_pending
        where id = ${id} and user_id = ${userId} and kind = 'device'`;
      const row = rows[0];
      if (!row) return null;
      return {
        row,
        deviceCode: dec(userId, `device:${id}`, row.device_code_enc),
        intervalS: row.poll_interval_s ?? 5,
        nextPollAt: toDate(row.next_poll_at) ?? new Date(0),
        expiresAt: toDate(row.expires_at) as Date,
      };
    },

    async updateDeviceSchedule(id: string, intervalS: number, nextPollAt: Date) {
      const sql = await getSql();
      await sql`update xai_oauth_pending set poll_interval_s = ${intervalS}, next_poll_at = ${nextPollAt.toISOString()}
        where id = ${id}`;
    },

    async deletePending(id: string) {
      const sql = await getSql();
      await sql`delete from xai_oauth_pending where id = ${id}`;
    },
  };
}

export type XaiStore = ReturnType<typeof createXaiStore>;
