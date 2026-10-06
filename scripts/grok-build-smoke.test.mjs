import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("grok binary resolves on PATH or common path", () => {
  const which = spawnSync("which", ["grok"], { encoding: "utf8" });
  const common = [
    "/home/box/.local/bin/grok",
    "/usr/local/bin/grok",
    `${process.env.HOME || ""}/.grok/bin/grok`,
  ];
  const found = which.status === 0 || common.some((p) => p && existsSync(p));
  assert.ok(found, "expected grok binary for local Build");
});

test("generate.ts prefers Grok Build and keeps SYSTEM prompt", () => {
  const src = readFileSync("src/lib/generate.ts", "utf8");
  assert.match(src, /shouldUseGrokBuild/);
  assert.match(src, /runGrokBuildDesign/);
  assert.match(src, /GROK_BUILD_ALLOW_API_FALLBACK|allowApiFallback/);
  assert.match(src, /You are Grok Design/);
  assert.match(src, /No purple gradients/);
  // chat completions must not be the unconditional primary path
  assert.match(src, /generateViaChatCompletions/);
  const buildIdx = src.indexOf("shouldUseGrokBuild()");
  const apiIdx = src.indexOf("generateViaChatCompletions(data, apiKey, local)");
  assert.ok(buildIdx > 0 && apiIdx > buildIdx, "Build check should appear before API fallback call");
});

test("grok-build.ts is server-oriented (node child_process)", () => {
  const src = readFileSync("src/lib/grok-build.ts", "utf8");
  assert.match(src, /server-only/i);
  assert.match(src, /DESIGN_OUTPUT_SCHEMA/);
  assert.match(src, /--json-schema/);
  assert.match(src, /structured_output/);
  assert.match(src, /GROK_BUILD_BIN/);
});

test("Dockerfile installs Grok CLI and fly memory is 1gb", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  assert.match(docker, /x\.ai\/cli\/install\.sh/);
  assert.match(docker, /GROK_BUILD_BIN/);
  const fly = readFileSync("fly.toml", "utf8");
  assert.match(fly, /memory\s*=\s*'1gb'/);
  assert.match(fly, /Grok Build agent needs more than 256mb/);
});

test("no-key dry path still documented as local fallback", () => {
  const src = readFileSync("src/lib/generate.ts", "utf8");
  assert.match(src, /usedModel:\s*"local"/);
  assert.match(src, /fallback:\s*true/);
  assert.match(src, /if\s*\(!apiKey\)/);
});
