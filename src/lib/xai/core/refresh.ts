/**
 * Per-user access-token broker with single-flight refresh. **Server-only.**
 *
 * Two layers of mutual exclusion:
 *   1. in-process: one refresh promise per user (`inflight` map), so concurrent
 *      generations in this Node process share one refresh;
 *   2. cross-process: the store's `withLockedCredential` holds a row lock
 *      (`SELECT … FOR UPDATE` in one transaction) around re-read → refresh →
 *      save, so a second machine can't race refresh-token rotation.
 * After taking the lock the row is re-read; if another holder already refreshed
 * it, that token is reused and xAI is not called.
 */
import { isTerminalRefreshError, type TokenSet } from "./oidc.ts";

export const REFRESH_SKEW_MS = 5 * 60_000; // refresh ~5 min before expiry (matches the CLI default)
export const DEFAULT_ACCESS_TTL_S = 3600; // when xAI omits expires_in

export type StoredCredential = {
  status: "active" | "needs_reauth";
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  version: number;
};

export type CredentialUpdate = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  scope?: string;
};

export interface RefreshStore {
  /** Unlocked read (fast path). `null` when the user never connected. */
  read(userId: string): Promise<StoredCredential | null>;
  /**
   * Run `fn` holding an exclusive per-user lock; `fn` gets the row as re-read
   * under the lock, plus writers that run inside the same transaction.
   */
  withLockedCredential<T>(
    userId: string,
    fn: (
      cred: StoredCredential | null,
      ops: {
        save(update: CredentialUpdate): Promise<void>;
        markNeedsReauth(code: string): Promise<void>;
      },
    ) => Promise<T>,
  ): Promise<T>;
}

export type XaiCredentialErrorCode = "not_connected" | "needs_reauth" | "refresh_failed";

export class XaiCredentialError extends Error {
  readonly code: XaiCredentialErrorCode;
  constructor(code: XaiCredentialErrorCode, message?: string) {
    super(message ?? `xAI credential unavailable: ${code}`);
    this.name = "XaiCredentialError";
    this.code = code;
  }
}

export type FreshToken = { accessToken: string; expiresAt: Date };

function isFresh(cred: StoredCredential | null, nowMs: number, minTtlMs: number): cred is StoredCredential & {
  accessToken: string;
  accessExpiresAt: Date;
} {
  return Boolean(
    cred &&
      cred.status === "active" &&
      cred.accessToken &&
      cred.accessExpiresAt &&
      cred.accessExpiresAt.getTime() - nowMs > minTtlMs,
  );
}

export function createTokenBroker(opts: {
  store: RefreshStore;
  refresh: (refreshToken: string) => Promise<TokenSet>;
  now?: () => number;
  skewMs?: number;
  onEvent?: (event: { type: "refreshed" | "reused" | "dead" | "transient_failure"; userId: string }) => void;
}) {
  const now = opts.now ?? Date.now;
  const skew = opts.skewMs ?? REFRESH_SKEW_MS;
  const inflight = new Map<string, Promise<FreshToken>>();

  async function refreshLocked(userId: string, thresholdMs: number): Promise<FreshToken> {
    return opts.store.withLockedCredential(userId, async (cred, ops) => {
      if (!cred) throw new XaiCredentialError("not_connected");
      if (cred.status !== "active") throw new XaiCredentialError("needs_reauth");
      // Another request/machine may have refreshed while we waited for the lock.
      if (isFresh(cred, now(), thresholdMs)) {
        opts.onEvent?.({ type: "reused", userId });
        return { accessToken: cred.accessToken, expiresAt: cred.accessExpiresAt };
      }
      if (!cred.refreshToken) {
        await ops.markNeedsReauth("no_refresh_token");
        opts.onEvent?.({ type: "dead", userId });
        throw new XaiCredentialError("needs_reauth");
      }
      let tokens: TokenSet;
      try {
        tokens = await opts.refresh(cred.refreshToken);
      } catch (err) {
        if (isTerminalRefreshError(err)) {
          await ops.markNeedsReauth("refresh_rejected");
          opts.onEvent?.({ type: "dead", userId });
          throw new XaiCredentialError("needs_reauth");
        }
        opts.onEvent?.({ type: "transient_failure", userId });
        throw new XaiCredentialError("refresh_failed");
      }
      const expiresAt = new Date(now() + (tokens.expires_in ?? DEFAULT_ACCESS_TTL_S) * 1000);
      await ops.save({
        accessToken: tokens.access_token,
        // Rotation: persist the new refresh token when xAI returns one; otherwise keep the old one.
        refreshToken: tokens.refresh_token ?? cred.refreshToken,
        accessExpiresAt: expiresAt,
        scope: tokens.scope,
      });
      opts.onEvent?.({ type: "refreshed", userId });
      return { accessToken: tokens.access_token, expiresAt };
    });
  }

  return {
    /**
     * An access token valid for at least `minTtlMs` (default: the 5-minute
     * skew). Refreshes at most once per call; if xAI's token lifetime is
     * shorter than `minTtlMs`, the freshly minted token is returned anyway.
     */
    async getFreshAccessToken(userId: string, minTtlMs = 0): Promise<FreshToken> {
      const threshold = Math.max(skew, minTtlMs);
      const cred = await opts.store.read(userId);
      if (!cred) throw new XaiCredentialError("not_connected");
      if (cred.status !== "active") throw new XaiCredentialError("needs_reauth");
      if (isFresh(cred, now(), threshold)) {
        return { accessToken: cred.accessToken, expiresAt: cred.accessExpiresAt };
      }
      let p = inflight.get(userId);
      if (!p) {
        p = refreshLocked(userId, threshold).finally(() => inflight.delete(userId));
        inflight.set(userId, p);
      }
      return p;
    },
    /** Test/diagnostic hook. */
    inflightCount(): number {
      return inflight.size;
    },
  };
}
