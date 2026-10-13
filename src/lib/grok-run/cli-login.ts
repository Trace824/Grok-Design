/**
 * Sign in the way FSB does: the Grok CLI's own xAI login, not a custom client.
 *
 * FSB runs `grok login --oauth` on the same machine as the browser. On Fly the
 * CLI's localhost callback is unreachable, so this uses `grok login --device-auth`
 * (the CLI's headless/remote mode). Same client, same `auth.json`.
 *
 * Server-only. The browser receives a user code, a verification URL, and an
 * email — never a refresh token.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNoSecretLeak, buildGrokChildEnv, parseExtraAllow } from "./child-env.ts";
import { killGroup, redactSecrets } from "./run-home.ts";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;

/** Hosts the CLI is allowed to send the operator to. */
const ALLOWED_HOSTS = new Set(["auth.x.ai", "accounts.x.ai", "grok.com", "auth.grok.com"]);

const FORBIDDEN_QUERY = /(?:token|secret|password|credential|api[_-]?key|authorization|device_code)/i;

/** The installed CLI records a finished xAI login as `oidc`. FSB's probe calls that `oauth`. */
const SIGNED_IN_MODES = new Set(["oidc", "oauth"]);

export type DeviceChallenge = {
  userCode: string;
  verificationUrl: string;
};

export type CliSignInView =
  | { state: "signed_out" }
  | { state: "pending"; userCode: string; verificationUrl: string }
  | { state: "signed_in"; email: string | null }
  | { state: "error"; message: string };

export type ProfilePaths = {
  root: string;
  home: string;
  grokHome: string;
  authPath: string;
};

type LiveLogin = {
  userCode: string;
  verificationUrl: string;
};

const g = globalThis as typeof globalThis & {
  __gdCliLogin?: LiveLogin | null;
  __gdCliLoginError?: string | null;
  __gdCliLoginStart?: Promise<CliSignInView> | null;
  __gdCliLoginPid?: number | null;
  /** Bumped on sign-out so a killed login cannot write a new error or session. */
  __gdCliLoginEpoch?: number;
};

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Persistent profile: Fly volume when `GROK_PROFILE_ROOT` is set, otherwise a home directory. */
export function profilePaths(env: Record<string, string | undefined> = process.env): ProfilePaths {
  const configured = env.GROK_PROFILE_ROOT?.trim();
  const root = configured || join(homedir(), ".grok-design", "profile");
  const home = join(root, "home");
  const grokHome = join(root, "grok-home");
  return { root, home, grokHome, authPath: join(grokHome, "auth.json") };
}

export function ensureProfile(paths: ProfilePaths = profilePaths()): ProfilePaths {
  for (const dir of [paths.root, paths.home, paths.grokHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // volume mount may refuse chmod; the directory still has to exist
    }
  }
  return paths;
}

/**
 * Pull the device-login challenge out of CLI output.
 * Returns null until both an allowlisted URL and a user code are present.
 */
export function parseDeviceLoginOutput(raw: string): DeviceChallenge | null {
  const text = stripAnsi(raw);
  const matches = text.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  for (const candidate of matches) {
    const trimmed = candidate.replace(/[),.;]+$/, "");
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) continue;
    if ([...url.searchParams.keys()].some((key) => FORBIDDEN_QUERY.test(key))) continue;
    const fromQuery = url.searchParams.get("user_code")?.trim();
    const code = fromQuery || standaloneCode(text);
    if (!code || code.length > 64) continue;
    return { userCode: code, verificationUrl: url.toString() };
  }
  return null;
}

function standaloneCode(text: string): string | null {
  const match = text.match(/\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/);
  return match?.[1] ?? null;
}

/** Signed in when auth.json holds an xAI session. Email only — tokens stay on disk. */
export function profileFromAuthJson(raw: string): { signedIn: boolean; email: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { signedIn: false, email: null };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { signedIn: false, email: null };
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.auth_mode !== "string" || !SIGNED_IN_MODES.has(row.auth_mode)) continue;
    const email = typeof row.email === "string" && row.email.trim() ? row.email.trim().slice(0, 320) : null;
    return { signedIn: true, email };
  }
  return { signedIn: false, email: null };
}

export function readProfileStatus(paths: ProfilePaths = profilePaths()): { signedIn: boolean; email: string | null } {
  try {
    if (!existsSync(paths.authPath)) return { signedIn: false, email: null };
    return profileFromAuthJson(readFileSync(paths.authPath, "utf8"));
  } catch {
    return { signedIn: false, email: null };
  }
}

export function currentSignIn(): CliSignInView {
  const status = readProfileStatus();
  if (status.signedIn) {
    g.__gdCliLogin = null;
    g.__gdCliLoginError = null;
    return { state: "signed_in", email: status.email };
  }
  const live = g.__gdCliLogin;
  if (live) return { state: "pending", userCode: live.userCode, verificationUrl: live.verificationUrl };
  if (g.__gdCliLoginError) return { state: "error", message: g.__gdCliLoginError };
  return { state: "signed_out" };
}

/** Start `grok login --device-auth`, or return the login already in progress. */
export function beginSignIn(): Promise<CliSignInView> {
  const now = currentSignIn();
  if (now.state === "signed_in" || now.state === "pending") return Promise.resolve(now);
  if (g.__gdCliLoginStart) return g.__gdCliLoginStart;
  g.__gdCliLoginError = null;
  const pending = runLogin().finally(() => {
    if (g.__gdCliLoginStart === pending) g.__gdCliLoginStart = null;
  });
  g.__gdCliLoginStart = pending;
  return pending;
}

/** Stop a pending device login, then `grok logout` for this server's one profile. */
export function signOutProfile(): CliSignInView {
  g.__gdCliLoginEpoch = (g.__gdCliLoginEpoch ?? 0) + 1;
  const pid = g.__gdCliLoginPid;
  g.__gdCliLoginPid = null;
  g.__gdCliLogin = null;
  g.__gdCliLoginError = null;
  g.__gdCliLoginStart = null;
  if (pid) killGroup(pid);

  const paths = ensureProfile();
  const bin = resolveBin();
  let logoutFailed = !bin;
  if (bin) {
    try {
      execFileSync(bin, ["logout"], {
        cwd: paths.home,
        env: loginEnv(paths),
        timeout: 20_000,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      logoutFailed = true;
    }
  }
  if (logoutFailed && readProfileStatus(paths).signedIn) {
    try {
      unlinkSync(paths.authPath);
    } catch {
      // the next status read reports whatever is still on disk
    }
  }
  return currentSignIn();
}

export function grokExecutable(): string | null {
  return resolveBin();
}

/** Allowlisted env for CLI commands against the persistent profile. */
export function cliProfileChildEnv(paths: ProfilePaths = ensureProfile()): Record<string, string> {
  return loginEnv(paths);
}

function resolveBin(): string | null {
  const fromEnv = process.env.GROK_BUILD_BIN?.trim();
  const candidates = [
    fromEnv,
    "/usr/local/bin/grok",
    join(process.env.HOME || "", ".grok/bin/grok"),
    join(process.env.HOME || "", ".local/bin/grok"),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // keep looking
    }
  }
  try {
    const found = execFileSync("which", ["grok"], { encoding: "utf8" }).trim().split("\n")[0];
    if (found) {
      accessSync(found, constants.X_OK);
      return found;
    }
  } catch {
    // not on PATH
  }
  return null;
}

function loginEnv(paths: ProfilePaths): Record<string, string> {
  const credential = { kind: "cli_profile" } as const;
  const env = buildGrokChildEnv({
    source: process.env,
    paths: { home: paths.home, grokHome: paths.grokHome },
    credential,
    extraAllow: parseExtraAllow(process.env.GROK_BUILD_EXTRA_ENV),
  });
  assertNoSecretLeak(env, process.env, credential);
  return env;
}

function runLogin(): Promise<CliSignInView> {
  const bin = resolveBin();
  if (!bin) {
    return Promise.resolve({ state: "error", message: "Grok CLI is not installed on the server." });
  }
  const paths = ensureProfile();
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (view: CliSignInView) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(view);
    };
    const epoch = g.__gdCliLoginEpoch ?? 0;
    const child = spawn(bin, ["login", "--device-auth"], {
      cwd: paths.home,
      env: loginEnv(paths),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    g.__gdCliLoginPid = child.pid ?? null;
    timer = setTimeout(() => {
      if ((g.__gdCliLoginEpoch ?? 0) !== epoch) return;
      killGroup(child.pid);
      g.__gdCliLogin = null;
      g.__gdCliLoginError = "Sign-in timed out. Try again.";
      finish({ state: "error", message: g.__gdCliLoginError });
    }, LOGIN_TIMEOUT_MS);

    const take = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length >= OUTPUT_LIMIT) return;
      output += text;
      if (output.length > OUTPUT_LIMIT) output = output.slice(0, OUTPUT_LIMIT);
      const challenge = parseDeviceLoginOutput(output);
      if (!challenge) return;
      g.__gdCliLogin = challenge;
      finish({ state: "pending", userCode: challenge.userCode, verificationUrl: challenge.verificationUrl });
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => {
      if (g.__gdCliLoginPid === child.pid) g.__gdCliLoginPid = null;
      g.__gdCliLogin = null;
      g.__gdCliLoginError = "Could not start xAI sign-in.";
      finish({ state: "error", message: g.__gdCliLoginError });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (g.__gdCliLoginPid === child.pid) g.__gdCliLoginPid = null;
      if ((g.__gdCliLoginEpoch ?? 0) !== epoch) {
        g.__gdCliLogin = null;
        return;
      }
      const status = readProfileStatus(paths);
      g.__gdCliLogin = null;
      if (status.signedIn) {
        g.__gdCliLoginError = null;
        finish({ state: "signed_in", email: status.email });
        return;
      }
      // A timeout already reported. Don't replace it with the kill's exit.
      if (settled) return;
      const message =
        code === 0
          ? "Sign-in finished without an xAI session."
          : redactSecrets(output).trim().slice(0, 180) || "xAI sign-in was cancelled or failed.";
      g.__gdCliLoginError = message;
      finish({ state: "error", message });
    });
  });
}
