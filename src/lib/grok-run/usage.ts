/**
 * Included-usage numbers from the same billing call the Grok CLI panel uses.
 * The access token stays in this process. Callers only receive display fields.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cliProfileChildEnv, ensureProfile, grokExecutable, profilePaths } from "./cli-login.ts";

const CACHE_MS = 60_000;
const SIGNED_IN_MODES = new Set(["oidc", "oauth"]);

export type CliUsageView =
  | {
      unavailable: false;
      usedPercent: number;
      period: "week" | "month" | "period";
      resetsAt: string | null;
      tier: string | null;
      extraCreditCents: number | null;
    }
  | { unavailable: true };

const UNAVAILABLE: CliUsageView = { unavailable: true };

const g = globalThis as typeof globalThis & {
  __gdCliUsage?: { at: number; view: CliUsageView };
  __gdCliVersion?: string;
};

export function clearUsageCache(): void {
  g.__gdCliUsage = undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function periodOf(type: unknown): "week" | "month" | "period" {
  const text = typeof type === "string" ? type : "";
  if (/WEEKLY/i.test(text)) return "week";
  if (/MONTHLY/i.test(text)) return "month";
  return "period";
}

/** Accept the CLI's wrapped credits body or a flat one. Tokens are dropped. */
export function parseBillingBody(body: unknown): CliUsageView {
  const root = asRecord(body);
  if (!root) return UNAVAILABLE;
  const wrapped = asRecord(root.config);
  const source = wrapped ?? root;
  const periodObj = asRecord(source.currentPeriod);
  const endRaw = periodObj?.end ?? source.billingPeriodEnd;
  const resetsAt = typeof endRaw === "string" && !Number.isNaN(Date.parse(endRaw)) ? endRaw : null;
  const percent = source.creditUsagePercent;
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  // proto3 omits a zero percent, so a credits body with no percent means 0% used.
  const creditsBody =
    periodObj != null ||
    typeof source.billingPeriodEnd === "string" ||
    asRecord(source.prepaidBalance) != null ||
    asRecord(source.onDemandUsed) != null;
  if (!hasPercent && !creditsBody) return UNAVAILABLE;

  const tierRaw = root.subscriptionTier ?? root.subscription_tier ?? source.subscriptionTier;
  const tier = typeof tierRaw === "string" && tierRaw.trim() ? tierRaw.trim().slice(0, 80) : null;
  const prepaid = asRecord(source.prepaidBalance);
  const cents =
    prepaid && typeof prepaid.val === "number" && Number.isFinite(prepaid.val) && prepaid.val > 0
      ? Math.round(prepaid.val)
      : null;

  return {
    unavailable: false,
    usedPercent: hasPercent ? Math.max(0, Math.min(100, percent)) : 0,
    period: periodOf(periodObj?.type),
    resetsAt,
    tier,
    extraCreditCents: cents,
  };
}

type Access = { key: string; userId: string | null; fresh: boolean };

function expiresMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return null;
}

function accessFromAuthJson(raw: string, now: number): Access | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(data);
  if (!root) return null;
  for (const [id, value] of Object.entries(root)) {
    const row = asRecord(value);
    if (!row || typeof row.auth_mode !== "string" || !SIGNED_IN_MODES.has(row.auth_mode)) continue;
    if (typeof row.key !== "string" || !row.key.trim()) continue;
    const userRaw = row.user_id ?? row.userId ?? row.sub;
    const fromKey = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    const userId =
      typeof userRaw === "string" && userRaw.trim() ? userRaw.trim().slice(0, 80) : fromKey ?? null;
    const expiry = expiresMs(row.expires_at);
    return { key: row.key, userId, fresh: expiry == null || expiry > now + 30_000 };
  }
  return null;
}

function readAccess(now: number): Access | null {
  const paths = profilePaths();
  try {
    if (!existsSync(paths.authPath)) return null;
    return accessFromAuthJson(readFileSync(paths.authPath, "utf8"), now);
  } catch {
    return null;
  }
}

function clientVersion(bin: string): string {
  if (g.__gdCliVersion) return g.__gdCliVersion;
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    g.__gdCliVersion = match?.[1] ?? "0.0.0";
  } catch {
    g.__gdCliVersion = "0.0.0";
  }
  return g.__gdCliVersion;
}

function refreshAccess(now: number): Access | null {
  const bin = grokExecutable();
  const paths = ensureProfile();
  if (bin) {
    try {
      execFileSync(bin, ["models"], {
        cwd: paths.home,
        env: cliProfileChildEnv(paths),
        timeout: 20_000,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // a stale key is tried once below; a hard failure becomes "unavailable"
    }
  }
  return readAccess(now);
}

async function fetchBilling(access: Access, bin: string | null): Promise<CliUsageView | "unauthorized"> {
  const base = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1").replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.key}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": bin ? clientVersion(bin) : "0.0.0",
  };
  if (access.userId) headers["x-userid"] = access.userId;
  try {
    const res = await fetch(`${base}/billing?format=credits`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return UNAVAILABLE;
    return parseBillingBody(await res.json());
  } catch {
    return UNAVAILABLE;
  }
}

/** Display fields only. Failures stay `unavailable` so sign-in and sign-out still work. */
export async function readCliUsage(now = Date.now()): Promise<CliUsageView> {
  const cached = g.__gdCliUsage;
  if (cached && now - cached.at < CACHE_MS) return cached.view;

  let access = readAccess(now);
  if (!access?.fresh) access = refreshAccess(now) ?? access;
  const bin = grokExecutable();
  let view: CliUsageView = UNAVAILABLE;
  if (access?.key) {
    const first = await fetchBilling(access, bin);
    if (first === "unauthorized") {
      const refreshed = refreshAccess(now);
      view = refreshed?.key ? await settled(fetchBilling(refreshed, bin)) : UNAVAILABLE;
    } else {
      view = first;
    }
  }
  g.__gdCliUsage = { at: now, view };
  return view;
}

async function settled(result: Promise<CliUsageView | "unauthorized">): Promise<CliUsageView> {
  const view = await result;
  return view === "unauthorized" ? UNAVAILABLE : view;
}
