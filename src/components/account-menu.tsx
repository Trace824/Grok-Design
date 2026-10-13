import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getCliSignIn, getCliUsage, signOutCli, type CliSignInView, type CliUsageView } from "@/lib/grok-run/signin";
import { cn } from "@/lib/cn";

type Variant = "footer" | "inline" | "compact";

function periodLabel(period: "week" | "month" | "period") {
  if (period === "week") return "this week";
  if (period === "month") return "this month";
  return "this period";
}

function resetLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function UsageMeter({ usage, wide }: { usage: CliUsageView; wide?: boolean }) {
  if (usage.unavailable) return <span className="text-mute">Usage unavailable</span>;
  const pct = Math.round(usage.usedPercent);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className={cn("h-1 overflow-hidden rounded-full bg-line", wide ? "w-full flex-1" : "w-10")}>
        <span className="block h-full bg-ink" style={{ width: `${Math.max(0, Math.min(100, usage.usedPercent))}%` }} />
      </span>
      <span className="shrink-0">
        {pct}% {periodLabel(usage.period)}
      </span>
    </span>
  );
}

function UsageDetails({ usage }: { usage: CliUsageView | null }) {
  if (!usage) return <p className="text-xs text-mute">Checking usage…</p>;
  if (usage.unavailable) return <p className="text-xs text-mute">Usage unavailable</p>;
  const reset = usage.resetsAt ? resetLabel(usage.resetsAt) : null;
  return (
    <div className="mt-3">
      {usage.tier && <p className="text-xs text-mute">{usage.tier}</p>}
      <div className="mt-2">
        <UsageMeter usage={usage} wide />
      </div>
      {reset && <p className="mt-1 text-xs text-mute">Resets {reset}</p>}
      {usage.extraCreditCents != null && usage.extraCreditCents > 0 && (
        <p className="mt-1 text-xs text-mute">${(usage.extraCreditCents / 100).toFixed(2)} extra credits</p>
      )}
    </div>
  );
}

export function CliAccount({
  variant,
  email: emailHint = null,
  onSignedOut,
}: {
  variant: Variant;
  email?: string | null;
  onSignedOut?: (view: CliSignInView) => void;
}) {
  const [status, setStatus] = useState<CliSignInView | null>(
    variant === "inline" ? { state: "signed_in", email: emailHint } : null,
  );
  const [usage, setUsage] = useState<CliUsageView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (variant === "inline") return;
    let cancelled = false;
    void getCliSignIn()
      .then((view) => {
        if (!cancelled) setStatus(view);
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: "signed_out" });
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  useEffect(() => {
    if (variant !== "inline") return;
    setStatus({ state: "signed_in", email: emailHint });
  }, [variant, emailHint]);

  const signedIn = status?.state === "signed_in";
  const email = status?.state === "signed_in" ? status.email : null;

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void getCliUsage()
      .then((view) => {
        if (!cancelled) setUsage(view);
      })
      .catch(() => {
        if (!cancelled) setUsage({ unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    setProblem(null);
    try {
      const view = await signOutCli();
      setStatus(view);
      setUsage(null);
      setOpen(false);
      onSignedOut?.(view);
    } catch {
      setProblem("Couldn't sign out.");
    } finally {
      setBusy(false);
    }
  }

  if (variant === "compact") {
    if (!signedIn) return null;
    const label = usage && !usage.unavailable ? `${Math.round(usage.usedPercent)}%` : email || "Account";
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
          className="rounded-md px-2 py-1 text-[12px] font-medium text-mute hover:bg-paper-2 hover:text-ink"
        >
          {label}
        </button>
        {open && (
          <Menu
            id={menuId}
            email={email}
            usage={usage}
            busy={busy}
            problem={problem}
            onSignOut={() => void signOut()}
            className="right-0 top-full mt-1"
          />
        )}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div className="mt-8 rounded-xl border border-line bg-sheet p-4">
        <p className="truncate text-sm text-ink">Signed in{email ? ` as ${email}` : ""}.</p>
        <UsageDetails usage={usage} />
        <p className="mt-3 text-xs text-faint">This server shares one xAI sign-in.</p>
        {problem && <p className="mt-2 text-xs text-red-700">{problem}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void signOut()}
          className="mt-3 w-full rounded-full border border-line py-2 text-sm font-medium hover:bg-paper-2 disabled:opacity-60"
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </div>
    );
  }

  if (!status) return <div className="h-4 w-16 animate-pulse rounded-full bg-paper-2" />;
  if (!signedIn) {
    return (
      <Link to="/login" className="hover:text-ink">
        Sign in
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-2 text-left hover:text-ink"
      >
        <span className="max-w-[9rem] truncate">{email || "xAI connected"}</span>
        {usage?.unavailable ? (
          <span className="shrink-0 text-faint">Usage unavailable</span>
        ) : usage ? (
          <UsageMeter usage={usage} />
        ) : null}
      </button>
      {open && (
        <Menu
          id={menuId}
          email={email}
          usage={usage}
          busy={busy}
          problem={problem}
          onSignOut={() => void signOut()}
          className="bottom-full left-0 mb-2"
        />
      )}
    </div>
  );
}

function Menu({
  id,
  email,
  usage,
  busy,
  problem,
  onSignOut,
  className,
}: {
  id: string;
  email: string | null;
  usage: CliUsageView | null;
  busy: boolean;
  problem: string | null;
  onSignOut: () => void;
  className: string;
}) {
  return (
    <div id={id} className={cn("absolute z-30 w-64 rounded-xl border border-line bg-sheet p-3 shadow-soft", className)}>
      <p className="truncate text-sm text-ink">{email || "xAI connected"}</p>
      <UsageDetails usage={usage} />
      <p className="mt-3 text-xs text-faint">This server shares one xAI sign-in.</p>
      {problem && <p className="mt-2 text-xs text-red-700">{problem}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={onSignOut}
        className="mt-3 w-full rounded-full border border-line py-1.5 text-[13px] font-medium hover:bg-paper-2 disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
