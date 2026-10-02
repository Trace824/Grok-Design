/**
 * Explicit, allowlisted environment for Grok Build child processes. **Server-only.**
 *
 * The Grok agent runs with `--always-approve` on model-generated instructions,
 * so anything in its environment must be assumed readable by a prompt-injected
 * run. We therefore never spread `process.env`: the child gets a short list of
 * harmless passthrough variables, fixed isolation flags, its private per-run
 * HOME/GROK_HOME, and exactly ONE credential:
 *   - `user_oauth`: `GROK_AUTH_PROVIDER_COMMAND` pointing at a run-scoped helper
 *     that serves a short-lived access token (no refresh token, ever);
 *   - `server_key`: `XAI_API_KEY` (only when the server-key fallback is allowed).
 * `DATABASE_URL`, `BETTER_AUTH_SECRET`, OAuth client secrets, the token
 * encryption key, and the server `XAI_API_KEY` (on user runs) never reach it.
 * `assertNoSecretLeak` re-checks the final env against the parent env.
 *
 * Dependency-free so `node --test` can import it.
 */

/** Inherited from the parent only if present. Nothing secret-bearing. */
export const GROK_CHILD_ENV_PASSTHROUGH = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);

/** Same intent as FSB's GROK_BUILD_ISOLATION_ENV (grok-runtime.ts): no ambient config, telemetry, or extras. */
export const GROK_ISOLATION_ENV = Object.freeze({
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_SESSIONS_ENABLED: "0",
  GROK_CLAUDE_SKILLS_ENABLED: "0",
  GROK_CLAUDE_RULES_ENABLED: "0",
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_SESSIONS_ENABLED: "0",
  GROK_CODEX_SESSIONS_ENABLED: "0",
  GROK_MEMORY: "0",
  GROK_SUBAGENTS: "0",
  GROK_MANAGED_MCPS_ENABLED: "0",
  GROK_WORKFLOWS: "0",
  GROK_WEB_FETCH: "0",
  GROK_TELEMETRY_ENABLED: "false",
  GROK_TELEMETRY_TRACE_UPLOAD: "false",
  GROK_TRACE_UPLOAD: "false",
  GROK_FEEDBACK_ENABLED: "false",
  NO_OPEN_BROWSER: "1",
  RUST_LOG: "off",
});

/** Names that must never be passed through, even if an operator adds them to GROK_BUILD_EXTRA_ENV. */
const DENY_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|_KEY$|_KEYS$|^DATABASE_URL$|^PG|^BETTER_AUTH_|^GROK_AUTH_|^GROK_PREVIEW_|^XAI_|^AWS_|^FLY_API)/i;

export type GrokChildCredential =
  | { kind: "user_oauth"; authProviderCommand: string }
  | { kind: "server_key"; apiKey: string };

export type RunPaths = { home: string; grokHome: string };

/** Parse `GROK_BUILD_EXTRA_ENV` ("HTTPS_PROXY,NO_PROXY"): names only, deny-listed names dropped. */
export function parseExtraAllow(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Z_][A-Z0-9_]*$/i.test(s) && !DENY_NAME.test(s));
}

export function buildGrokChildEnv(opts: {
  source: Record<string, string | undefined>;
  paths: RunPaths;
  credential: GrokChildCredential;
  extraAllow?: readonly string[];
}): Record<string, string> {
  const env: Record<string, string> = {};
  const allow = new Set<string>([...GROK_CHILD_ENV_PASSTHROUGH, ...(opts.extraAllow ?? [])]);
  for (const name of allow) {
    if (DENY_NAME.test(name)) continue;
    const v = opts.source[name];
    if (typeof v === "string" && v && !v.includes("\0")) env[name] = v;
  }
  env.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  Object.assign(env, GROK_ISOLATION_ENV);
  const { home, grokHome } = opts.paths;
  Object.assign(env, {
    HOME: home,
    GROK_HOME: grokHome,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_CACHE_HOME: `${home}/.cache`,
  });
  if (opts.credential.kind === "user_oauth") {
    env.GROK_AUTH_PROVIDER_COMMAND = opts.credential.authProviderCommand;
    env.GROK_AUTH_PROVIDER_LABEL = "Grok Design";
    // Fail closed: a user run must never silently fall back to an API key.
    env.GROK_DISABLE_API_KEY_AUTH = "1";
  } else {
    env.XAI_API_KEY = opts.credential.apiKey;
  }
  return env;
}

/**
 * Throw if the child env carries any parent secret: a deny-listed name that we
 * did not set on purpose, or any parent secret VALUE under another name.
 */
export function assertNoSecretLeak(
  child: Record<string, string>,
  parent: Record<string, string | undefined>,
  credential: GrokChildCredential,
): void {
  const intentional = new Set<string>(
    credential.kind === "server_key" ? ["XAI_API_KEY"] : ["GROK_AUTH_PROVIDER_COMMAND", "GROK_AUTH_PROVIDER_LABEL"],
  );
  for (const name of Object.keys(child)) {
    if (DENY_NAME.test(name) && !intentional.has(name) && !(name in GROK_ISOLATION_ENV) && name !== "GROK_DISABLE_API_KEY_AUTH") {
      throw new Error(`grok child env: refusing secret-like variable ${name}`);
    }
  }
  const childValues = Object.entries(child);
  for (const [pName, pValue] of Object.entries(parent)) {
    if (!pValue || pValue.length < 8 || !DENY_NAME.test(pName)) continue;
    for (const [cName, cValue] of childValues) {
      if (credential.kind === "server_key" && cName === "XAI_API_KEY" && pName === "XAI_API_KEY") continue;
      if (cValue.includes(pValue)) {
        throw new Error(`grok child env: value of ${pName} leaked into ${cName}`);
      }
    }
  }
}
