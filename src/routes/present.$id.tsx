import { createFileRoute, Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useDesignStore } from "@/lib/store";
import { applyCssVars, injectBridge, tweaksToVars } from "@/lib/iframe-bridge";

export const Route = createFileRoute("/present/$id")({ component: Present });

function Present() {
  const { id } = Route.useParams();
  const project = useDesignStore((s) => s.projects.find((p) => p.id === id));
  if (!project) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Link to="/">Back</Link>
      </div>
    );
  }
  const srcDoc = applyCssVars(injectBridge(project.html), tweaksToVars(project.tweaks));
  return (
    <div className="relative h-dvh bg-paper">
      <Link
        to="/project/$id"
        params={{ id }}
        className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full bg-sheet text-ink"
      >
        <X className="size-4" />
      </Link>
      {project.html ? (
        <iframe title="Present" className="h-full w-full border-0" srcDoc={srcDoc} sandbox="allow-scripts allow-same-origin" />
      ) : (
        <div className="grid h-full place-items-center text-ink">Nothing to present yet.</div>
      )}
    </div>
  );
}
