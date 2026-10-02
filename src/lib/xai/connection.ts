/**
 * Server functions for the xAI connect UI. Handlers run on the server; the
 * browser only ever receives connection metadata, a device `user_code` and a
 * verification URL — never a token.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

export type XaiFeature = { enabled: boolean; authCodeFlow: boolean; deviceFlow: boolean };

export type XaiConnection = {
  connected: boolean;
  status: "active" | "needs_reauth" | null;
  email: string | null;
  scope: string | null;
  flow: "auth_code" | "device" | null;
  lastError: string | null;
  connectedAt: string | null;
};

/** Public, non-sensitive feature flags (UI hides itself when disabled). */
export const getXaiFeature = createServerFn({ method: "GET" }).handler(async (): Promise<XaiFeature> => {
  const { publicXaiFeature } = await import("./config.server");
  return publicXaiFeature();
});

async function service() {
  const s = await import("./service.server");
  if (!s.xaiEnabled()) throw new Error("xAI sign-in is not enabled on this server.");
  return s;
}

export const getXaiConnection = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<XaiConnection> => (await service()).getConnection(context.userId));

export const startXaiDeviceConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => (await service()).startDeviceFlow(context.userId));

export const pollXaiDeviceConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => {
    if (!input || typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id)) {
      throw new Error("invalid device session id");
    }
    return { id: input.id };
  })
  .handler(async ({ context, data }) => (await service()).pollDeviceFlow(context.userId, data.id));

export const disconnectXai = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => (await service()).disconnect(context.userId));
