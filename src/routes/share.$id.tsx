import { createFileRoute, Link } from "@tanstack/react-router";
import { useDesignStore } from "@/lib/store";
import { applyCssVars, injectBridge, tweaksToVars } from "@/lib/iframe-bridge";

export const Route = createFileRoute("/share/$id")({ component: ShareView });

function ShareView() {
  const { id } = Route.useParams();
  const project = useDesignStore((s) => s.projects.find((p) => p.id === id));
  if (!project || project.share === "private") {
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
  const srcDoc = applyCssVars(injectBridge(project.html), tweaksToVars(project.tweaks));
  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex h-12 items-center justify-between border-b border-line px-4 text-sm">
        <div>
          <div className="font-medium">{project.name}</div>
          <div className="text-[11px] uppercase tracking-wider text-mute">{project.share} access</div>
        </div>
        {project.share === "edit" && (
          <Link to="/project/$id" params={{ id }} className="rounded-full bg-ink px-3 py-1.5 text-paper">
            Open in Grok Design
          </Link>
        )}
      </header>
      <iframe title="Shared design" className="min-h-0 flex-1 border-0" srcDoc={srcDoc} sandbox="allow-scripts allow-same-origin" />
    </div>
  );
}
