import { createFileRoute, Link } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Wordmark } from "@/components/logo";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-10 font-serif text-3xl tracking-tight">Sign in to design</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          Your projects stay in this browser. Sign in to keep an identity on shared links.
        </p>
        <div className="mt-8 space-y-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <button
                key={p.providerId}
                type="button"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                className="w-full rounded-full border border-line bg-sheet px-4 py-2.5 text-sm font-medium hover:bg-paper-2"
              >
                Continue with {p.label}
              </button>
            ))
          ) : (
            <p className="text-sm text-mute">Sign-in is disabled in this environment.</p>
          )}
        </div>
        <Link to="/" className="mt-6 inline-block text-sm text-mute underline-offset-4 hover:underline">
          Continue without signing in
        </Link>
      </div>
    </main>
  );
}
