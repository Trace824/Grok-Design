// Unit tests: the Grok Build child gets an explicit allowlisted env and a
// private run dir; no server secrets and no refresh token ever reach it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertNoSecretLeak, buildGrokChildEnv, parseExtraAllow } from "../src/lib/grok-run/child-env.ts";
import { createRunHome, redactSecrets } from "../src/lib/grok-run/run-home.ts";

const PARENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  HOME: "/home/server",
  DATABASE_URL: "postgres://user:dbpassword@neon.example/db",
  BETTER_AUTH_SECRET: "better-auth-secret-value",
  XAI_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString("base64"),
  XAI_API_KEY: "xai-serverkeyserverkeyserverkey",
  XAI_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
  GROK_AUTH_CLIENT_SECRET: "grok-broker-secret-value",
  GROK_PREVIEW_CLIENT_SECRET: "preview-secret-value",
  HTTPS_PROXY: "http://proxyuser:proxypass@proxy:3128",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value-123",
  RANDOM_UNLISTED: "harmless-but-not-allowlisted",
};
const SECRET_NAMES = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "XAI_TOKEN_ENC_KEY",
  "XAI_OAUTH_CLIENT_SECRET",
  "GROK_AUTH_CLIENT_SECRET",
  "GROK_PREVIEW_CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY",
];
const paths = { home: "/tmp/gd-run-x/home", grokHome: "/tmp/gd-run-x/grok-home" };

function assertNoParentSecrets(env, { allowServerKey }) {
  const values = Object.values(env).join("\n");
  for (const name of SECRET_NAMES) {
    assert.equal(env[name], undefined, `${name} must not be passed`);
    assert.ok(!values.includes(PARENT[name]), `value of ${name} leaked`);
  }
  if (!allowServerKey) {
    assert.equal(env.XAI_API_KEY, undefined);
    assert.ok(!values.includes(PARENT.XAI_API_KEY), "server XAI_API_KEY leaked into a user run");
  }
  assert.equal(env.HTTPS_PROXY, undefined, "proxy URLs can carry credentials");
  assert.equal(env.RANDOM_UNLISTED, undefined, "unlisted vars are not inherited");
}

test("user OAuth run: allowlist only + external auth hook; no secrets, no API key", () => {
  const env = buildGrokChildEnv({
    source: PARENT,
    paths,
    credential: { kind: "user_oauth", authProviderCommand: "/tmp/gd-run-x/auth-provider.sh" },
  });
  assertNoParentSecrets(env, { allowServerKey: false });
  assert.equal(env.GROK_AUTH_PROVIDER_COMMAND, "/tmp/gd-run-x/auth-provider.sh");
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "1", "fails closed instead of falling back to an API key");
  assert.equal(env.HOME, paths.home);
  assert.equal(env.GROK_HOME, paths.grokHome);
  assert.ok(env.XDG_CONFIG_HOME.startsWith(paths.home));
  assert.equal(env.PATH, PARENT.PATH);
  assert.equal(env.RUST_LOG, "off");
  assert.equal(env.NO_OPEN_BROWSER, "1");
  assert.doesNotThrow(() => assertNoSecretLeak(env, PARENT, { kind: "user_oauth", authProviderCommand: "x" }));
});

test("server-key run: only XAI_API_KEY is added, nothing else secret", () => {
  const cred = { kind: "server_key", apiKey: PARENT.XAI_API_KEY };
  const env = buildGrokChildEnv({ source: PARENT, paths, credential: cred });
  assertNoParentSecrets(env, { allowServerKey: true });
  assert.equal(env.XAI_API_KEY, PARENT.XAI_API_KEY);
  assert.equal(env.GROK_AUTH_PROVIDER_COMMAND, undefined);
  assert.doesNotThrow(() => assertNoSecretLeak(env, PARENT, cred));
});

test("operator extra allowlist cannot re-admit secret-looking names", () => {
  assert.deepEqual(parseExtraAllow("HTTPS_PROXY, NO_PROXY,DATABASE_URL,BETTER_AUTH_SECRET,MY_TOKEN,bad name"), [
    "HTTPS_PROXY",
    "NO_PROXY",
  ]);
  const env = buildGrokChildEnv({
    source: PARENT,
    paths,
    credential: { kind: "user_oauth", authProviderCommand: "x" },
    extraAllow: ["DATABASE_URL", "NO_PROXY"],
  });
  assert.equal(env.DATABASE_URL, undefined);
});

test("assertNoSecretLeak catches a leaked name or value", () => {
  const cred = { kind: "user_oauth", authProviderCommand: "x" };
  assert.throws(() => assertNoSecretLeak({ PATH: "/bin", DATABASE_URL: "x" }, PARENT, cred), /DATABASE_URL/);
  assert.throws(() => assertNoSecretLeak({ PATH: "/bin", FOO: PARENT.BETTER_AUTH_SECRET }, PARENT, cred), /BETTER_AUTH_SECRET/);
  assert.throws(() => assertNoSecretLeak({ XAI_API_KEY: PARENT.XAI_API_KEY }, PARENT, cred), /XAI_API_KEY/);
});

test("createRunHome: private 0700 dir, access token only, helper serves once, cleanup removes it", () => {
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const run = createRunHome({ kind: "user_oauth", accessToken: "user-access-token-abc", expiresAt }, PARENT);
  try {
    assert.equal(statSync(run.root).mode & 0o777, 0o700);
    assertNoParentSecrets(run.env, { allowServerKey: false });
    const tokenFile = join(run.root, "token.json");
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    const tok = JSON.parse(readFileSync(tokenFile, "utf8"));
    assert.deepEqual(Object.keys(tok).sort(), ["access_token", "expires_in"], "no refresh token in the run dir");
    assert.ok(tok.expires_in > 25 * 60);
    assert.match(readFileSync(join(run.grokHome, "config.toml"), "utf8"), /disable_api_key_auth = true/);

    const helper = run.env.GROK_AUTH_PROVIDER_COMMAND;
    // Headless refresh is refused: the child can never mint a token.
    const refusal = spawnSync("sh", ["-c", helper], { env: { ...run.env, GROK_AUTH_EXPIRED: "1" }, encoding: "utf8" });
    assert.equal(refusal.status, 1);
    assert.equal(refusal.stdout, "");
    const first = spawnSync("sh", ["-c", helper], { env: run.env, encoding: "utf8" });
    assert.equal(first.status, 0);
    assert.equal(JSON.parse(first.stdout).access_token, "user-access-token-abc");
    assert.equal(existsSync(tokenFile), false, "token file is deleted after the CLI picked it up");
    assert.equal(spawnSync("sh", ["-c", helper], { env: run.env }).status, 1);
  } finally {
    run.cleanup();
  }
  assert.equal(existsSync(run.root), false);
});

test("createRunHome: server-key run writes no token file or helper", () => {
  const run = createRunHome({ kind: "server_key", apiKey: PARENT.XAI_API_KEY }, PARENT);
  try {
    assert.equal(existsSync(join(run.root, "token.json")), false);
    assert.equal(run.env.XAI_API_KEY, PARENT.XAI_API_KEY);
    assert.doesNotMatch(readFileSync(join(run.grokHome, "config.toml"), "utf8"), /disable_api_key_auth/);
  } finally {
    run.cleanup();
  }
});

test("grok-build.ts no longer spreads process.env into the child", () => {
  const src = readFileSync("src/lib/grok-build.ts", "utf8");
  assert.doesNotMatch(src, /\.\.\.process\.env/);
  assert.match(src, /env: run\.env/);
});

test("redactSecrets scrubs tokens from error text", () => {
  const out = redactSecrets(
    'failed {"access_token":"abc123456789"} Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlMTIz key=xai-AAAAAAAAAAAAAAAAAAAA',
  );
  assert.doesNotMatch(out, /abc123456789|eyJhbGci|xai-AAAA/);
});
