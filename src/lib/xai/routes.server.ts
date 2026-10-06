/**
 * Handlers for the fixed xAI OAuth server routes — **server-only**.
 *   GET /api/xai/oauth/start     → 302 to xAI's authorize endpoint
 *   GET /api/xai/oauth/callback  → validate state, exchange code, 302 back to the app
 * Both return 404 when the feature (or the redirect flow) is disabled.
 */
import { getXaiConfig } from "./config.server";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json" },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, location } });
}

/** Back into the app (relative, fixed path — no open `returnTo`). */
function backToApp(result: "connected" | "error", reason?: string): Response {
  const qs = new URLSearchParams({ xai: result });
  if (reason) qs.set("reason", reason.replace(/[^a-z0-9_]/gi, "").slice(0, 40));
  return redirect(`/?${qs.toString()}`);
}

function disabled(): Response {
  return json(404, { error: "xai_oauth_disabled", message: "xAI sign-in is not enabled on this server." });
}

/** Same rule as `assertSameSiteRequest`: block scripted cross-site requests, allow navigations. */
function isAllowedNavigation(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return true;
  const dest = request.headers.get("sec-fetch-dest");
  return request.headers.get("sec-fetch-mode") === "navigate" && request.method === "GET" && dest !== "object" && dest !== "embed";
}

async function sessionUserId(request: Request): Promise<string | null> {
  const { auth, authConfigured } = await import("../auth/server");
  if (!authConfigured) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user?.id ?? null;
}

export async function handleXaiOAuthStart(request: Request): Promise<Response> {
  const cfg = getXaiConfig();
  if (!cfg.enabled || !cfg.authCodeFlow) return disabled();
  if (!isAllowedNavigation(request)) return json(403, { error: "forbidden" });
  const userId = await sessionUserId(request);
  if (!userId) return redirect("/login");
  const { startAuthCodeFlow } = await import("./service.server");
  try {
    return redirect(await startAuthCodeFlow(userId));
  } catch (err) {
    console.warn(`[xai] start failed: ${err instanceof Error ? err.message : "error"}`);
    return backToApp("error", "start_failed");
  }
}

export async function handleXaiOAuthCallback(request: Request): Promise<Response> {
  const cfg = getXaiConfig();
  if (!cfg.enabled || !cfg.authCodeFlow) return disabled();
  if (!isAllowedNavigation(request)) return json(403, { error: "forbidden" });
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const service = await import("./service.server");
  if (error) {
    await service.abandonAuthCodeFlow(state).catch(() => undefined);
    return backToApp("error", error === "access_denied" ? "access_denied" : "authorize_error");
  }
  const userId = await sessionUserId(request);
  if (!userId) {
    await service.abandonAuthCodeFlow(state).catch(() => undefined);
    return backToApp("error", "signed_out");
  }
  try {
    await service.completeAuthCodeFlow(userId, { code, state });
    return backToApp("connected");
  } catch (err) {
    const reason = err instanceof service.XaiFlowError ? err.code : "callback_failed";
    if (!(err instanceof service.XaiFlowError)) {
      console.warn(`[xai] callback failed: ${err instanceof Error ? err.message : "error"}`);
    }
    return backToApp("error", reason);
  }
}
