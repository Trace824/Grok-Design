/**
 * RFC 8628 Device Authorization Grant against xAI. **Server-only.**
 *
 * The server starts the grant and makes at most ONE token request per browser
 * poll, enforcing xAI's `interval` (and `slow_down` back-off) server-side, so a
 * fast or malicious client cannot make us hammer the token endpoint. The
 * browser only ever sees `user_code` + the verification URL; the `device_code`
 * stays encrypted in the DB.
 */
import {
  OAuthError,
  oauthErrorFrom,
  parseTokenSet,
  postForm,
  type ClientCredentials,
  type FetchLike,
  type TokenSet,
} from "./oidc.ts";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
const MAX_LIFETIME_S = 30 * 60;

/** Hosts a verification URL may point at (xAI uses accounts.x.ai / auth.x.ai). */
export const DEFAULT_VERIFICATION_HOSTS = ["auth.x.ai", "accounts.x.ai"] as const;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** `verification_uri_complete` when xAI provides one (code pre-filled). */
  verificationUriComplete: string | null;
  expiresInS: number;
  intervalS: number;
};

/** Accept only short https URLs on allowlisted hosts, without credentials or fragments. */
export function safeVerificationUrl(value: unknown, allowedHosts: readonly string[]): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash) return null;
  if (!allowedHosts.includes(u.hostname)) return null;
  for (const key of u.searchParams.keys()) {
    if (/token|secret|password|credential|api_key|authorization|device_code/i.test(key)) return null;
  }
  return u.toString();
}

export function parseDeviceAuthorization(
  status: number,
  body: Record<string, unknown>,
  allowedHosts: readonly string[] = DEFAULT_VERIFICATION_HOSTS,
): DeviceAuthorization {
  if (status < 200 || status >= 300) throw oauthErrorFrom(status, body);
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  const verificationUri = safeVerificationUrl(body.verification_uri, allowedHosts);
  if (!deviceCode || !userCode || userCode.length > 64 || !verificationUri) {
    throw new Error("device authorization: malformed response");
  }
  const complete = safeVerificationUrl(body.verification_uri_complete, allowedHosts);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 600;
  const interval = typeof body.interval === "number" && body.interval > 0 ? body.interval : DEFAULT_INTERVAL_S;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: complete,
    expiresInS: Math.min(expiresIn, MAX_LIFETIME_S),
    intervalS: Math.min(Math.max(interval, 1), MAX_INTERVAL_S),
  };
}

export async function startDeviceAuthorization(opts: {
  deviceAuthorizationEndpoint: string;
  client: ClientCredentials;
  scope: string;
  allowedHosts?: readonly string[];
  fetchImpl?: FetchLike;
}): Promise<DeviceAuthorization> {
  const { status, body } = await postForm(
    opts.deviceAuthorizationEndpoint,
    opts.client,
    { scope: opts.scope },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
  return parseDeviceAuthorization(status, body, opts.allowedHosts);
}

export type DevicePollOutcome =
  | { kind: "success"; tokens: TokenSet }
  | { kind: "pending"; throttled: boolean }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; code: string };

/** Map one token-endpoint response to an outcome + the next interval. */
export function classifyDeviceTokenResponse(
  status: number,
  body: Record<string, unknown>,
  currentIntervalS: number,
): { outcome: DevicePollOutcome; intervalS: number } {
  if (status >= 200 && status < 300) {
    try {
      return { outcome: { kind: "success", tokens: parseTokenSet(status, body) }, intervalS: currentIntervalS };
    } catch {
      return { outcome: { kind: "error", code: "malformed_token_response" }, intervalS: currentIntervalS };
    }
  }
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  switch (code) {
    case "authorization_pending":
      return { outcome: { kind: "pending", throttled: false }, intervalS: currentIntervalS };
    case "slow_down":
      // RFC 8628 §3.5: increase the interval by 5 seconds for this and all later requests.
      return {
        outcome: { kind: "pending", throttled: false },
        intervalS: Math.min(currentIntervalS + 5, MAX_INTERVAL_S),
      };
    case "expired_token":
      return { outcome: { kind: "expired" }, intervalS: currentIntervalS };
    case "access_denied":
      return { outcome: { kind: "denied" }, intervalS: currentIntervalS };
    default:
      return { outcome: { kind: "error", code: code.slice(0, 64) }, intervalS: currentIntervalS };
  }
}

export type PendingDevice = {
  deviceCode: string;
  intervalS: number;
  nextPollAt: Date;
  expiresAt: Date;
};

/**
 * One server-side poll step. Never calls xAI before `nextPollAt` (returns a
 * throttled `pending`) or after `expiresAt` (returns `expired`). Returns the
 * schedule the caller must persist.
 */
export async function pollDeviceOnce(opts: {
  pending: PendingDevice;
  now: Date;
  requestToken: (deviceCode: string) => Promise<{ status: number; body: Record<string, unknown> }>;
}): Promise<{ outcome: DevicePollOutcome; intervalS: number; nextPollAt: Date; calledXai: boolean }> {
  const { pending, now } = opts;
  if (now.getTime() >= pending.expiresAt.getTime()) {
    return { outcome: { kind: "expired" }, intervalS: pending.intervalS, nextPollAt: pending.nextPollAt, calledXai: false };
  }
  if (now.getTime() < pending.nextPollAt.getTime()) {
    return {
      outcome: { kind: "pending", throttled: true },
      intervalS: pending.intervalS,
      nextPollAt: pending.nextPollAt,
      calledXai: false,
    };
  }
  let res: { status: number; body: Record<string, unknown> };
  try {
    res = await opts.requestToken(pending.deviceCode);
  } catch {
    // Network blip: keep pending, back off one interval.
    return {
      outcome: { kind: "pending", throttled: false },
      intervalS: pending.intervalS,
      nextPollAt: new Date(now.getTime() + pending.intervalS * 1000),
      calledXai: true,
    };
  }
  const { outcome, intervalS } = classifyDeviceTokenResponse(res.status, res.body, pending.intervalS);
  return { outcome, intervalS, nextPollAt: new Date(now.getTime() + intervalS * 1000), calledXai: true };
}

/** Token request for the device grant (raw status/body for `pollDeviceOnce`). */
export function deviceTokenRequester(opts: {
  tokenEndpoint: string;
  client: ClientCredentials;
  fetchImpl?: FetchLike;
}): (deviceCode: string) => Promise<{ status: number; body: Record<string, unknown> }> {
  return (deviceCode) =>
    postForm(
      opts.tokenEndpoint,
      opts.client,
      { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode },
      opts.fetchImpl ?? ((u, i) => fetch(u, i)),
    );
}

export { OAuthError };
