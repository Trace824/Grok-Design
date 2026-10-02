/**
 * Per-run private Grok home — **server-only**.
 *
 * Every Grok Build run gets a fresh `mkdtemp` directory (0700) with its own
 * HOME, GROK_HOME (pinned config.toml) and cwd, removed after the run. For a
 * user-OAuth run we use the CLI's documented external-auth hook
 * (`GROK_AUTH_PROVIDER_COMMAND`, see the CLI user guide "External Auth
 * Provider"): a run-scoped helper prints `{"access_token","expires_in"}` once.
 *
 * Verified against grok 1.0.13: in headless `-p` mode the CLI does NOT invoke
 * the provider by itself when it has no cached credential ("Not signed in"),
 * but `grok login` does (interactive contract, `GROK_AUTH_EXPIRED` unset) and
 * stores the token as an `external` credential in `$GROK_HOME/auth.json`. So a
 * run is: write token file → `grok login` (helper serves + deletes the file) →
 * `grok -p …`. A later headless refresh (`GROK_AUTH_EXPIRED=1`) gets exit 1 —
 * the child can never mint a new token; the server hands out a token that
 * already covers the run timeout. The refresh token never enters the run dir.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoSecretLeak,
  buildGrokChildEnv,
  parseExtraAllow,
  type GrokChildCredential,
} from "./child-env.ts";

export type RunCredential =
  | { kind: "user_oauth"; accessToken: string; expiresAt: Date }
  | { kind: "server_key"; apiKey: string };

export type RunHome = {
  root: string;
  home: string;
  grokHome: string;
  cwd: string;
  env: Record<string, string>;
  credentialKind: RunCredential["kind"];
  cleanup(): void;
};

const CONFIG_TOML = `# Pinned by Grok Design for one headless run.
[cli]
auto_update = false

[features]
telemetry = false
feedback = false

[memory]
enabled = false

[subagents]
enabled = false

[telemetry]
trace_upload = false
`;

const OAUTH_CONFIG_TOML = `${CONFIG_TOML}
[auth]
disable_api_key_auth = true
`;

function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function createRunHome(credential: RunCredential, source: Record<string, string | undefined> = process.env): RunHome {
  const root = mkdtempSync(join(tmpdir(), "gd-run-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const grokHome = join(root, "grok-home");
  const cwd = join(root, "cwd");
  for (const d of [home, grokHome, cwd]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // best effort
    }
  };
  try {
    writeFileSync(join(grokHome, "config.toml"), credential.kind === "user_oauth" ? OAUTH_CONFIG_TOML : CONFIG_TOML, {
      mode: 0o600,
    });
    let childCred: GrokChildCredential;
    if (credential.kind === "user_oauth") {
      const tokenFile = join(root, "token.json");
      const helper = join(root, "auth-provider.sh");
      const expiresIn = Math.max(60, Math.floor((credential.expiresAt.getTime() - Date.now()) / 1000));
      writeFileSync(tokenFile, JSON.stringify({ access_token: credential.accessToken, expires_in: expiresIn }), {
        mode: 0o600,
      });
      writeFileSync(
        helper,
        [
          "#!/bin/sh",
          "# Grok Design run-scoped auth provider: serves the pre-minted token once.",
          "# Headless refresh is refused: the child must never mint credentials.",
          '[ "${GROK_AUTH_EXPIRED:-}" = "1" ] && exit 1',
          `f=${shQuote(tokenFile)}`,
          '[ -f "$f" ] || exit 1',
          'cat "$f" && rm -f "$f"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      childCred = { kind: "user_oauth", authProviderCommand: helper };
    } else {
      childCred = { kind: "server_key", apiKey: credential.apiKey };
    }
    const env = buildGrokChildEnv({
      source,
      paths: { home, grokHome },
      credential: childCred,
      extraAllow: parseExtraAllow(source.GROK_BUILD_EXTRA_ENV),
    });
    assertNoSecretLeak(env, source, childCred);
    return { root, home, grokHome, cwd, env, credentialKind: credential.kind, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * `grok login` with the run-scoped external provider, so the headless run
 * finds a cached `external` credential. Bounded: never waits for a browser.
 */
export function seedExternalAuth(bin: string, run: RunHome, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["login"], {
      cwd: run.cwd,
      env: run.env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const timer = setTimeout(() => {
      killGroup(child.pid);
      reject(new Error("grok_auth_seed_timeout"));
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("grok_auth_seed_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(join(run.grokHome, "auth.json"))) resolve();
      else reject(new Error("grok_auth_seed_failed"));
    });
  });
}

/** SIGTERM the whole process group, then SIGKILL after a grace period. */
export function killGroup(pid: number | undefined, graceMs = 2000): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs).unref();
}

/** Strip anything token-like from text before it is logged or shown. */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/xai-[A-Za-z0-9]{16,}/g, "[redacted-key]")
    .replace(/("?(?:access_token|refresh_token|id_token|device_code|code_verifier|key)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}
