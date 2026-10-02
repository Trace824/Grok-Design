/**
 * Grok Build (CLI) headless runner — **server-only**.
 * Never import this module from client components or browser bundles.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRunHome,
  killGroup,
  redactSecrets,
  seedExternalAuth,
  type RunCredential,
  type RunHome,
} from "./grok-run/run-home.ts";
import type { Tweak } from "./types";

export type { RunCredential };

const COMMON_GROK_PATHS = [
  "/home/box/.local/bin/grok",
  "/usr/local/bin/grok",
  join(process.env.HOME || "", ".grok/bin/grok"),
  join(process.env.HOME || "", ".local/bin/grok"),
];

/** JSON Schema matching GenerateResult design fields (reply, title, html, tweaks). */
export const DESIGN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "title", "html", "tweaks"],
  properties: {
    reply: { type: "string", description: "Short designer note (2-4 sentences)" },
    title: { type: "string", description: "Short project title" },
    html: {
      type: "string",
      description: "Complete self-contained HTML5 document",
    },
    tweaks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "type", "cssVar", "value"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          type: { type: "string", enum: ["color", "range", "select", "toggle"] },
          cssVar: { type: "string" },
          value: { type: "string" },
          min: { type: "number" },
          max: { type: "number" },
          step: { type: "number" },
          unit: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value"],
              properties: {
                label: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type GrokBuildDesignOutput = {
  reply: string;
  title: string;
  html: string;
  tweaks: Tweak[];
};

export type RunGrokBuildDesignOpts = {
  /** User-facing prompt (includes context + USER REQUEST). */
  prompt: string;
  /** Design quality rules (SYSTEM prompt from generate.ts). */
  systemPrompt: string;
  model?: string;
  currentHtml?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Exactly one credential per run: the user's short-lived xAI access token
   * (served through the CLI's external-auth hook) or the server API key.
   */
  credential: RunCredential;
};

export type RunGrokBuildDesignResult = GrokBuildDesignOutput & {
  usedModel: string;
  rawText?: string;
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the `grok` binary: GROK_BUILD_BIN, PATH (`which`), then common install paths. */
export function resolveGrokBin(): string | null {
  const fromEnv = process.env.GROK_BUILD_BIN?.trim();
  if (fromEnv && existsSync(fromEnv) && isExecutable(fromEnv)) return fromEnv;

  try {
    const whichBin = existsSync("/usr/bin/which") ? "/usr/bin/which" : "which";
    const found = execFileSync(whichBin, ["grok"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
    if (found && existsSync(found) && isExecutable(found)) return found;
  } catch {
    // not on PATH
  }

  for (const p of COMMON_GROK_PATHS) {
    if (p && existsSync(p) && isExecutable(p)) return p;
  }
  return null;
}

export function isGrokBuildDisabled(): boolean {
  return (process.env.GROK_BUILD_DISABLED || "").toLowerCase() === "true";
}

export function allowApiFallback(): boolean {
  return (process.env.GROK_BUILD_ALLOW_API_FALLBACK || "").toLowerCase() === "true";
}

/**
 * True when Build should be the primary generation path (enabled + binary
 * present). Credential availability is decided by the caller
 * (`resolveGenerationCredential`).
 */
export function shouldUseGrokBuild(): boolean {
  if (isGrokBuildDisabled()) return false;
  return resolveGrokBin() !== null;
}

/** Default run timeouts — the user token handed to a run must outlive them. */
export const DESIGN_RUN_TIMEOUT_MS = 180_000;
export const EXTRACT_RUN_TIMEOUT_MS = 90_000;

/** Classified Grok Build failure; `message` is safe to show (redacted, no raw stderr dump). */
export class GrokBuildError extends Error {
  readonly code: "auth_rejected" | "forbidden" | "timeout" | "no_output" | "failed" | "auth_seed_failed";
  readonly httpStatus?: number;
  constructor(code: GrokBuildError["code"], message: string, httpStatus?: number) {
    super(message);
    this.name = "GrokBuildError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function classifyFailure(detail: string): GrokBuildError {
  const safe = redactSecrets(detail).slice(0, 300);
  const status = detail.match(/"?http_status"?\s*:\s*(\d{3})/)?.[1] ?? detail.match(/\b(401|403)\b/)?.[1];
  if (status === "401") return new GrokBuildError("auth_rejected", `Grok Build failed: xAI rejected the credential (401). ${safe}`, 401);
  if (status === "403") {
    return new GrokBuildError(
      "forbidden",
      `Grok Build failed: xAI refused this account (403) — your plan may not include Grok Build access. ${safe}`,
      403,
    );
  }
  return new GrokBuildError("failed", `Grok Build failed: ${safe}`);
}

function buildAgentsMd(systemPrompt: string): string {
  return `# Grok Design via Grok Build

You are **Grok Design** running through **Grok Build** (headless).
Your job is to produce a structured JSON design output for the product canvas.

## Output contract
- Produce **ONLY** the structured JSON matching the provided JSON schema
  (\`reply\`, \`title\`, \`html\`, \`tweaks\`). Prefer the session structured_output path.
- You may optionally write \`design.json\` with the same object; it is not required when structured output is available.
- Do **not** scaffold a repo, install packages, or make unrelated file edits.
- Do **not** call web search or spawn subagents.

## Design rules
${systemPrompt}
`;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeDesignOutput(
  parsed: Record<string, unknown> | null,
  rawText: string,
): GrokBuildDesignOutput | null {
  const obj = parsed || extractJsonObject(rawText);
  if (!obj) return null;

  const reply = typeof obj.reply === "string" ? obj.reply : "";
  const title = typeof obj.title === "string" ? obj.title : "";
  const html = typeof obj.html === "string" ? obj.html : "";
  const tweaks = Array.isArray(obj.tweaks) ? (obj.tweaks as Tweak[]) : [];

  if (!html || !/<html/i.test(html)) return null;
  return {
    reply: reply || "Updated the canvas.",
    title: title || "Untitled",
    html,
    tweaks,
  };
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function spawnGrok(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<SpawnResult> {
  const bin = resolveGrokBin();
  if (!bin) {
    return Promise.reject(
      new Error("Grok Build CLI binary not found (set GROK_BUILD_BIN or install grok)"),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so a timeout kills grok AND anything it spawned.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup(child.pid);
      reject(new GrokBuildError("timeout", `Grok Build timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function parseGrokJsonStdout(stdout: string): {
  structured?: Record<string, unknown> | null;
  text?: string;
  errorMessage?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {};

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        data = JSON.parse(lines[i]) as Record<string, unknown>;
        break;
      } catch {
        // continue
      }
    }
    if (!data) data = extractJsonObject(trimmed);
  }

  if (!data) return {};

  if (data.type === "error" && typeof data.message === "string") {
    return { errorMessage: data.message };
  }

  const structured =
    data.structured_output && typeof data.structured_output === "object"
      ? (data.structured_output as Record<string, unknown>)
      : null;

  const text =
    typeof data.text === "string"
      ? data.text
      : typeof data.result === "string"
        ? data.result
        : undefined;

  return {
    structured,
    text,
    errorMessage: typeof data.message === "string" ? data.message : undefined,
  };
}

/**
 * Fresh private run dir (HOME, GROK_HOME, cwd) + allowlisted env for ONE run;
 * for user-OAuth runs, seeds the CLI's external-auth credential first.
 */
async function prepareRun(bin: string, credential: RunCredential): Promise<RunHome> {
  const run = createRunHome(credential);
  if (credential.kind === "user_oauth") {
    try {
      await seedExternalAuth(bin, run);
    } catch {
      run.cleanup();
      throw new GrokBuildError("auth_seed_failed", "Grok Build could not load your xAI sign-in for this run.");
    }
  }
  return run;
}

/**
 * Run Grok Build headless to produce a design JSON result.
 * Creates a temp workdir, writes AGENTS.md (+ optional current.html), spawns grok, cleans up.
 */
export async function runGrokBuildDesign(
  opts: RunGrokBuildDesignOpts,
): Promise<RunGrokBuildDesignResult> {
  const bin = resolveGrokBin();
  if (!bin) {
    throw new Error("Grok Build CLI binary not found. Install grok or set GROK_BUILD_BIN.");
  }
  const model = opts.model?.trim() || undefined;
  const maxTurns = opts.maxTurns ?? 6;
  const timeoutMs = opts.timeoutMs ?? DESIGN_RUN_TIMEOUT_MS;
  const run = await prepareRun(bin, opts.credential);
  const workdir = run.cwd;

  try {
    writeFileSync(join(workdir, "AGENTS.md"), buildAgentsMd(opts.systemPrompt), "utf8");
    if (opts.currentHtml?.trim()) {
      writeFileSync(join(workdir, "current.html"), opts.currentHtml, "utf8");
    }

    const promptParts = [
      "Produce the design JSON for this request.",
      opts.currentHtml?.trim()
        ? "A current.html file is in the workdir — EDIT that design unless the user asked for a new direction."
        : "Create a new design from scratch.",
      "",
      opts.prompt,
    ];

    const args = [
      "--no-auto-update",
      "--always-approve",
      "-p",
      promptParts.join("\n"),
      "--cwd",
      workdir,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(DESIGN_OUTPUT_SCHEMA),
      "--disable-web-search",
      "--max-turns",
      String(maxTurns),
      "--disallowed-tools",
      // No shell: the run only needs structured output (also keeps the agent
      // away from its own run-scoped credential files).
      "Agent,web_search,web_fetch,run_terminal_cmd",
    ];
    if (model) {
      args.push("-m", model);
    }

    // Explicit allowlisted env from createRunHome; the parent env is never inherited.
    const { stdout, stderr, code } = await spawnGrok(args, { cwd: workdir, env: run.env, timeoutMs });
    const parsedOut = parseGrokJsonStdout(stdout);

    if (code !== 0) {
      const detail =
        parsedOut.errorMessage ||
        stderr.trim().slice(0, 400) ||
        stdout.trim().slice(0, 400) ||
        `exit ${code}`;
      throw classifyFailure(detail);
    }

    if (parsedOut.errorMessage && !parsedOut.structured && !parsedOut.text) {
      throw classifyFailure(parsedOut.errorMessage);
    }

    const design = normalizeDesignOutput(parsedOut.structured ?? null, parsedOut.text || stdout);
    if (!design) {
      throw new GrokBuildError(
        "no_output",
        "Grok Build returned no usable design JSON (missing html). " +
          (redactSecrets(stderr.trim()).slice(0, 200) || "Check structured_output / model output."),
      );
    }

    const usedModel = model ? `grok-build/${model}` : "grok-build";
    return { ...design, usedModel, rawText: parsedOut.text || stdout };
  } finally {
    run.cleanup();
  }
}

/** Schema for onboarding design-system extraction. */
export const DESIGN_SYSTEM_EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "colors", "fonts", "radii", "spacing", "voice", "components"],
  properties: {
    name: { type: "string" },
    colors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
      },
    },
    fonts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "family", "fallback"],
        properties: {
          role: { type: "string" },
          family: { type: "string" },
          fallback: { type: "string" },
        },
      },
    },
    radii: { type: "string" },
    spacing: { type: "string" },
    voice: { type: "string" },
    components: { type: "string" },
  },
} as const;

export type DesignSystemExtract = {
  name: string;
  colors: { name: string; value: string }[];
  fonts: { role: string; family: string; fallback: string }[];
  radii: string;
  spacing: string;
  voice: string;
  components: string;
};

/**
 * Headless Build run for design-system extraction (onboarding).
 */
export async function runGrokBuildExtractSystem(opts: {
  notes: string;
  name: string;
  model?: string;
  timeoutMs?: number;
  credential: RunCredential;
}): Promise<DesignSystemExtract> {
  const bin = resolveGrokBin();
  if (!bin) throw new Error("Grok Build CLI binary not found");

  const run = await prepareRun(bin, opts.credential);
  const workdir = run.cwd;
  const systemRules = `Extract a design system as JSON matching the schema.
Hex colors only. No markdown. Prefer the given name when sensible: ${opts.name || "Custom system"}.`;

  try {
    writeFileSync(
      join(workdir, "AGENTS.md"),
      `# Design system extractor

You extract design systems for Grok Design via Grok Build.
Produce ONLY structured JSON matching the schema. No repo edits.

${systemRules}
`,
      "utf8",
    );

    const args = [
      "--no-auto-update",
      "--always-approve",
      "-p",
      `Extract a design system from these notes:\n\n${opts.notes}`,
      "--cwd",
      workdir,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(DESIGN_SYSTEM_EXTRACT_SCHEMA),
      "--disable-web-search",
      "--max-turns",
      "4",
      "--disallowed-tools",
      "Agent,web_search,web_fetch,run_terminal_cmd",
    ];
    if (opts.model) args.push("-m", opts.model);

    const { stdout, stderr, code } = await spawnGrok(args, {
      cwd: workdir,
      env: run.env,
      timeoutMs: opts.timeoutMs ?? EXTRACT_RUN_TIMEOUT_MS,
    });

    const parsedOut = parseGrokJsonStdout(stdout);
    if (code !== 0) {
      throw classifyFailure(parsedOut.errorMessage || stderr.slice(0, 300) || `exit ${code}`);
    }
    const obj = parsedOut.structured || extractJsonObject(parsedOut.text || stdout);
    if (!obj) throw new Error("No design-system JSON from Grok Build");

    return {
      name: typeof obj.name === "string" ? obj.name : opts.name || "Custom system",
      colors: Array.isArray(obj.colors) ? (obj.colors as DesignSystemExtract["colors"]) : [],
      fonts: Array.isArray(obj.fonts) ? (obj.fonts as DesignSystemExtract["fonts"]) : [],
      radii: typeof obj.radii === "string" ? obj.radii : "",
      spacing: typeof obj.spacing === "string" ? obj.spacing : "",
      voice: typeof obj.voice === "string" ? obj.voice : "",
      components: typeof obj.components === "string" ? obj.components : "",
    };
  } finally {
    run.cleanup();
  }
}
