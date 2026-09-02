import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useDesignStore } from "@/lib/store";
import { applyCssVars, injectBridge, tweaksToVars } from "@/lib/iframe-bridge";
import {
  getSharedProject,
  type SharedProjectPayload,
} from "@/lib/projects";

export const Route = createFileRoute("/share/$id")({ component: ShareView });

function ShareView() {
  const { id } = Route.useParams();
  const local = useDesignStore((s) => s.projects.find((p) => p.id === id));
  const [remote, setRemote] = useState<SharedProjectPayload | null | undefined>(
    undefined,
  );

  useEffect(() => {
    // Prefer a non-private local copy (same browser / localStorage).
    if (local && local.share !== "private") {
      setRemote(undefined);
      return;
    }
    // Local missing (or only private) — try DB-backed share when configured.
    let cancelled = false;
    setRemote(undefined);
    void getSharedProject({ data: { id } })
      .then((payload) => {
        if (!cancelled) setRemote(payload);
      })
      .catch(() => {
        if (!cancelled) setRemote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, local]);

  const project =
    local && local.share !== "private"
      ? local
      : remote && remote.share !== "private"
        ? remote
        : null;

  if (project) {
    const srcDoc = applyCssVars(
      injectBridge(project.html),
      tweaksToVars(project.tweaks),
    );
    return (
      <div className="flex h-dvh flex-col bg-paper">
        <header className="flex h-12 items-center justify-between border-b border-line px-4 text-sm">
          <div>
            <div className="font-medium">{project.name}</div>
            <div className="text-[11px] uppercase tracking-wider text-mute">
              {project.share} access
            </div>
          </div>
          {project.share === "edit" && (
            <Link
              to="/project/$id"
              params={{ id }}
              className="rounded-full bg-ink px-3 py-1.5 text-paper"
            >
              Open in Grok Design
            </Link>
          )}
        </header>
        <iframe
          title="Shared design"
          className="min-h-0 flex-1 border-0"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    );
  }

  if (remote === undefined && !(local && local.share === "private")) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="text-sm text-mute">Loading shared design…</div>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <h1 className="font-serif text-3xl">This design is private</h1>
        <Link to="/" className="mt-3 inline-block text-sm text-mute underline">
          Go home
        </Link>
      </div>
    </main>
  );
}
