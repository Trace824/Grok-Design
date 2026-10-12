import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Loader2 } from "lucide-react";
import { Wordmark } from "@/components/logo";
import { CliAccount } from "@/components/account-menu";
import { getCliSignIn, startCliSignIn, type CliSignInView } from "@/lib/grok-run/signin";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const [view, setView] = useState<CliSignInView | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await getCliSignIn());
    } catch {
      setView({ state: "error", message: "Couldn't reach the server." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (view?.state !== "pending") return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [view?.state, refresh]);

  async function start() {
    setBusy(true);
    try {
      setView(await startCliSignIn());
    } catch {
      setView({ state: "error", message: "Couldn't start xAI sign-in." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-10 font-serif text-3xl tracking-tight">Sign in to design</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          Sign in with your xAI account. Generations on this server run on that account.
        </p>

        {view?.state === "signed_in" ? (
          <CliAccount
            variant="inline"
            email={view.email}
            onSignedOut={(next) => setView(next.state === "signed_in" ? next : { state: "signed_out" })}
          />
        ) : view?.state === "pending" ? (
          <div className="mt-8 rounded-xl border border-line bg-sheet p-4">
            <p className="text-sm text-ink-2">Open xAI and confirm this code:</p>
            <p className="mt-2 font-mono text-2xl tracking-[0.2em] text-ink">{view.userCode}</p>
            <a
              href={view.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink underline-offset-4 hover:underline"
            >
              Open accounts.x.ai
              <ExternalLink className="size-3.5" />
            </a>
            <p className="mt-3 flex items-center gap-2 text-xs text-mute">
              <Loader2 className="size-3.5 animate-spin" /> Waiting for approval…
            </p>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy || view === null}
            onClick={() => void start()}
            className="mt-8 w-full rounded-full border border-line bg-sheet px-4 py-2.5 text-sm font-medium hover:bg-paper-2 disabled:opacity-60"
          >
            {busy ? "Starting…" : "Sign in with xAI"}
          </button>
        )}

        {view?.state === "error" && <p className="mt-3 text-xs text-red-700">{view.message}</p>}

        <Link to="/" className="mt-6 inline-block text-sm text-mute underline-offset-4 hover:underline">
          {view?.state === "signed_in" ? "Back to designs" : "Continue without signing in"}
        </Link>
      </div>
    </main>
  );
}
