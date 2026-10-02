import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Link2, Loader2, Unlink } from "lucide-react";
import {
  disconnectXai,
  getXaiConnection,
  getXaiFeature,
  pollXaiDeviceConnect,
  startXaiDeviceConnect,
  type XaiConnection,
  type XaiFeature,
} from "@/lib/xai/connection";

type DeviceState = {
  id: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalS: number;
};

const REASONS: Record<string, string> = {
  access_denied: "You declined the xAI consent screen.",
  signed_out: "Sign in to Grok Design first, then connect xAI.",
  expired: "The connect link expired. Try again.",
  unknown_state: "That connect link is no longer valid. Try again.",
  user_mismatch: "That connect link belongs to a different Grok Design account.",
  exchange_failed: "xAI didn't accept the sign-in. Try again.",
  id_token_invalid: "xAI's identity token failed verification.",
};

const LAST_ERRORS: Record<string, string> = {
  inference_401: "xAI rejected your token on the last run.",
  inference_403: "xAI refused your account on the last run — your plan may not include Grok Build.",
  refresh_rejected: "xAI revoked or expired your sign-in.",
  no_refresh_token: "Your sign-in can't be renewed automatically.",
};

/**
 * "xAI account" settings card: connect / disconnect the user's own xAI
 * (SuperGrok) account. Renders nothing when the server has the feature off.
 * Tokens never reach the browser — only status, a device user code, and xAI's
 * verification URL.
 */
export function XaiConnectCard() {
  const [feature, setFeature] = useState<XaiFeature | null>(null);
  const [conn, setConn] = useState<XaiConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const pollTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConn(await getXaiConnection());
    } catch {
      setConn(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void getXaiFeature()
      .then((f) => {
        if (!alive) return;
        setFeature(f);
        if (f.enabled) void refresh();
      })
      .catch(() => alive && setFeature({ enabled: false, authCodeFlow: false, deviceFlow: false }));
    // Result of the redirect flow (`/?xai=connected|error&reason=…`).
    const params = new URLSearchParams(window.location.search);
    const result = params.get("xai");
    if (result) {
      const reason = params.get("reason") ?? "";
      setNotice(
        result === "connected"
          ? { tone: "ok", text: "xAI account connected." }
          : { tone: "error", text: REASONS[reason] ?? "Couldn't connect your xAI account." },
      );
      params.delete("xai");
      params.delete("reason");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
    return () => {
      alive = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [refresh]);

  const stopDevice = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setDevice(null);
  }, []);

  const schedulePoll = useCallback(
    (id: string, intervalS: number) => {
      pollTimer.current = window.setTimeout(async () => {
        try {
          const r = await pollXaiDeviceConnect({ data: { id } });
          if (r.state === "pending") return schedulePoll(id, r.intervalS);
          stopDevice();
          if (r.state === "connected") {
            setNotice({ tone: "ok", text: "xAI account connected." });
            await refresh();
          } else {
            setNotice({
              tone: "error",
              text:
                r.state === "denied"
                  ? "You declined the xAI consent screen."
                  : r.state === "expired"
                    ? "The code expired. Start again."
                    : "Couldn't connect your xAI account.",
            });
          }
        } catch {
          stopDevice();
          setNotice({ tone: "error", text: "Couldn't reach the server while waiting for xAI." });
        }
      }, Math.max(1, intervalS) * 1000);
    },
    [refresh, stopDevice],
  );

  async function startDevice() {
    setBusy(true);
    setNotice(null);
    try {
      const d = await startXaiDeviceConnect();
      setDevice(d);
      schedulePoll(d.id, d.intervalS);
    } catch {
      setNotice({ tone: "error", text: "Couldn't start the xAI device sign-in." });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      await disconnectXai();
      setNotice({ tone: "ok", text: "xAI account disconnected." });
      await refresh();
    } catch {
      setNotice({ tone: "error", text: "Couldn't disconnect. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!feature?.enabled) return null;

  const connected = conn?.connected === true;
  const needsReauth = conn?.status === "needs_reauth";

  return (
    <div className="mt-4 rounded-xl border border-line bg-sheet p-4" data-testid="xai-connect-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">xAI account</h3>
        <span
          className={
            connected
              ? "rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-paper"
              : "rounded-full border border-line px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-mute"
          }
        >
          {connected ? "Connected" : needsReauth ? "Reconnect" : "Not connected"}
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        {connected
          ? `Generations run on your own xAI account${conn?.email ? ` (${conn.email})` : ""}.`
          : needsReauth
            ? "Your xAI sign-in expired or was revoked. Connect again to keep generating with your account."
            : "Use your own xAI / SuperGrok account for generations."}
      </p>
      {connected && conn?.lastError && LAST_ERRORS[conn.lastError] && (
        <p className="mt-2 text-xs text-mute">{LAST_ERRORS[conn.lastError]}</p>
      )}

      {device && (
        <div className="mt-3 rounded-lg border border-line bg-paper p-3 text-sm">
          <p className="text-ink-2">Open xAI and enter this code:</p>
          <p className="mt-1 font-mono text-lg tracking-[0.2em] text-ink" data-testid="xai-user-code">
            {device.userCode}
          </p>
          <a
            href={device.verificationUriComplete ?? device.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-ink underline-offset-4 hover:underline"
          >
            Open {new URL(device.verificationUri).host}
            <ExternalLink className="size-3.5" />
          </a>
          <div className="mt-2 flex items-center gap-2 text-xs text-mute">
            <Loader2 className="size-3.5 animate-spin" /> Waiting for approval…
            <button type="button" onClick={stopDevice} className="ml-auto underline-offset-4 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!device && (
        <div className="mt-3 flex flex-col gap-2">
          {connected ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
              className="flex w-full items-center justify-center gap-1.5 rounded-full border border-line py-2 text-sm font-semibold text-ink hover:bg-paper-2 disabled:opacity-60"
            >
              <Unlink className="size-4" /> Disconnect xAI
            </button>
          ) : (
            <>
              {feature.authCodeFlow && (
                <button
                  type="button"
                  disabled={busy}
                  // Top-level navigation: the server creates PKCE/state and 302s to xAI.
                  onClick={() => window.location.assign("/api/xai/oauth/start")}
                  className="flex w-full items-center justify-center gap-1.5 rounded-full bg-ink py-2 text-sm font-semibold text-paper hover:bg-clay-2 disabled:opacity-60"
                >
                  <Link2 className="size-4" /> Connect xAI
                </button>
              )}
              {feature.deviceFlow && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startDevice()}
                  className={
                    feature.authCodeFlow
                      ? "w-full rounded-full py-1.5 text-xs font-medium text-mute underline-offset-4 hover:text-ink hover:underline disabled:opacity-60"
                      : "flex w-full items-center justify-center gap-1.5 rounded-full bg-ink py-2 text-sm font-semibold text-paper hover:bg-clay-2 disabled:opacity-60"
                  }
                >
                  {feature.authCodeFlow ? "Use a device code instead" : "Connect xAI with a code"}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {notice && (
        <p
          role="status"
          className={notice.tone === "ok" ? "mt-2 text-xs text-ink-2" : "mt-2 text-xs text-red-700"}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
