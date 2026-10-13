/**
 * Browser-facing sign-in calls. The handler imports the CLI runner so the
 * client bundle never sees `node:child_process` or `auth.json`.
 */
import { createServerFn } from "@tanstack/react-start";
import type { CliSignInView } from "./cli-login.ts";
import type { CliUsageView } from "./usage.ts";

export type { CliSignInView, CliUsageView };

export const getCliSignIn = createServerFn({ method: "GET" }).handler(async (): Promise<CliSignInView> => {
  const { currentSignIn } = await import("./cli-login.ts");
  return currentSignIn();
});

export const startCliSignIn = createServerFn({ method: "POST" }).handler(async (): Promise<CliSignInView> => {
  const { beginSignIn } = await import("./cli-login.ts");
  return beginSignIn();
});

export const signOutCli = createServerFn({ method: "POST" }).handler(async (): Promise<CliSignInView> => {
  const { signOutProfile } = await import("./cli-login.ts");
  const { clearUsageCache } = await import("./usage.ts");
  const view = signOutProfile();
  clearUsageCache();
  return view;
});

export const getCliUsage = createServerFn({ method: "GET" }).handler(async (): Promise<CliUsageView> => {
  const { currentSignIn } = await import("./cli-login.ts");
  if (currentSignIn().state !== "signed_in") return { unavailable: true };
  const { readCliUsage } = await import("./usage.ts");
  return readCliUsage();
});
