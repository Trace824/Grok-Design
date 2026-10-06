import { createFileRoute } from "@tanstack/react-router";

/** Fixed OAuth redirect URI (XAI_OAUTH_REDIRECT_URI must point here). */
export const Route = createFileRoute("/api/xai/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleXaiOAuthCallback } = await import("@/lib/xai/routes.server");
        return handleXaiOAuthCallback(request);
      },
    },
  },
});
