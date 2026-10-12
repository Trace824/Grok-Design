// Device-login output parsing and auth.json status. No live `grok` process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDeviceLoginOutput, profileFromAuthJson, readProfileStatus } from "../src/lib/grok-run/cli-login.ts";
import { buildGrokChildEnv } from "../src/lib/grok-run/child-env.ts";
import { createRunHome } from "../src/lib/grok-run/run-home.ts";

const SAMPLE = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH

Confirm this code in your browser:

  ABCD-EFGH

\u001b[90mOnly continue with a code you requested.\u001b[0m

Waiting for authorization...
`;

test("parseDeviceLoginOutput reads the CLI's code and allowlisted URL", () => {
  const parsed = parseDeviceLoginOutput(SAMPLE);
  assert.ok(parsed);
  assert.equal(parsed.userCode, "ABCD-EFGH");
  assert.equal(parsed.verificationUrl, "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH");
});

test("parseDeviceLoginOutput rejects a secret-bearing URL and a foreign host", () => {
  assert.equal(
    parseDeviceLoginOutput("https://accounts.x.ai/oauth2/device?device_code=secret&user_code=ABCD-EFGH"),
    null,
  );
  assert.equal(parseDeviceLoginOutput("https://evil.example/device?user_code=ABCD-EFGH"), null);
  assert.equal(parseDeviceLoginOutput("still waiting"), null);
});

test("profileFromAuthJson treats the CLI's oidc session as signed in and drops tokens", () => {
  const raw = JSON.stringify({
    "https://auth.x.ai::client": {
      auth_mode: "oidc",
      email: "ada@example.com",
      refresh_token: "should-not-leak",
      key: "should-not-leak",
    },
  });
  const status = profileFromAuthJson(raw);
  assert.deepEqual(status, { signedIn: true, email: "ada@example.com" });
  assert.equal(JSON.stringify(status).includes("should-not-leak"), false);
  assert.deepEqual(profileFromAuthJson('{"x":{"auth_mode":"external","email":"nope@example.com"}}'), {
    signedIn: false,
    email: null,
  });
});

test("readProfileStatus reads only email from a profile auth.json", () => {
  const root = mkdtempSync(join(tmpdir(), "gd-profile-"));
  const grokHome = join(root, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  const paths = { root, home: join(root, "home"), grokHome, authPath: join(grokHome, "auth.json") };
  try {
    assert.deepEqual(readProfileStatus(paths), { signedIn: false, email: null });
    writeFileSync(
      paths.authPath,
      JSON.stringify({
        session: { auth_mode: "oidc", email: "ada@example.com", refresh_token: "secret-token" },
      }),
    );
    assert.deepEqual(readProfileStatus(paths), { signedIn: true, email: "ada@example.com" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli profile run keeps GROK_HOME and never receives an API key", () => {
  const root = mkdtempSync(join(tmpdir(), "gd-persist-"));
  const home = join(root, "home");
  const grokHome = join(root, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "auth.json"), '{"session":{"auth_mode":"oidc","email":"ada@example.com"}}', {
    mode: 0o600,
  });
  const env = buildGrokChildEnv({
    source: { PATH: "/usr/bin", XAI_API_KEY: "xai-serverkeyserverkeyserverkey", DATABASE_URL: "postgres://secret" },
    paths: { home, grokHome },
    credential: { kind: "cli_profile" },
  });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_HOME, grokHome);
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "1");
  const run = createRunHome(
    { kind: "cli_profile", home, grokHome },
    { PATH: "/usr/bin", XAI_API_KEY: "xai-serverkeyserverkeyserverkey" },
  );
  try {
    assert.equal(run.grokHome, grokHome);
    assert.equal(existsSync(join(grokHome, "auth.json")), true);
    assert.equal(run.env.XAI_API_KEY, undefined);
  } finally {
    run.cleanup();
  }
  assert.equal(existsSync(join(grokHome, "auth.json")), true, "cleanup must not delete the profile");
  assert.equal(existsSync(run.root), false);
  rmSync(root, { recursive: true, force: true });
});

test("parser fixture matches the file we ship", () => {
  const src = readFileSync("src/lib/grok-run/cli-login.ts", "utf8");
  assert.match(src, /login", "--device-auth"/);
  assert.match(src, /\["logout"\]/);
  assert.match(src, /__gdCliLoginPid/);
  assert.doesNotMatch(src, /\.\.\.process\.env/);
});
