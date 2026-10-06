import { createFileRoute } from "@tanstack/react-router";

/** Starts "Connect xAI" (auth-code + PKCE). Server-only logic lives in routes.server. */
export const Route = createFileRoute("/api/xai/oauth/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleXaiOAuthStart } = await import("@/lib/xai/routes.server");
        return handleXaiOAuthStart(request);
      },
    },
  },
});
