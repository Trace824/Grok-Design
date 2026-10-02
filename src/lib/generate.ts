import { createServerFn } from "@tanstack/react-start";
import { optionalAuthMiddleware } from "./auth/middleware";
import { fallbackDesign, inferTitle } from "./templates";
import { systemPromptBlock } from "./systems";
import type { DesignSystem, Fidelity, ProjectKind, Tweak } from "./types";

export type GenerateInput = {
  prompt: string;
  history: { role: "user" | "assistant"; content: string }[];
  kind: ProjectKind;
  fidelity: Fidelity;
  speakerNotes?: boolean;
  currentHtml?: string;
  comments?: string[];
  drawings?: string;
  system?: DesignSystem;
  model?: string;
};

export type GenerateResult = {
  ok: true;
  reply: string;
  title: string;
  html: string;
  tweaks: Tweak[];
  usedModel: string;
  fallback?: boolean;
};

export type GenerateError = { ok: false; error: string };

/** Design quality rules — also fed into Grok Build AGENTS.md. */
export const SYSTEM = `You are Grok Design, xAI's visual design product (the counterpart to Claude Design).
You produce complete, self-contained HTML documents that render as real prototypes, slide decks, one-pagers, or marketing pages.

Output STRICT JSON only, no markdown fences:
{
  "reply": "short designer note to the user (2-4 sentences)",
  "title": "short project title",
  "html": "<!DOCTYPE html>...full document...",
  "tweaks": [
    { "id": "accent", "label": "Accent", "type": "color", "cssVar": "--accent", "value": "#111111" },
    { "id": "radius", "label": "Corner radius", "type": "range", "cssVar": "--radius", "value": "14", "min": 0, "max": 36, "step": 1, "unit": "px" }
  ]
}

Rules for html:
- One complete HTML5 document. Inline CSS. Optional small inline JS.
- Drive visual tokens through CSS variables on :root so Tweaks work live (--accent, --bg, --ink, --radius, --pad, etc.).
- Google fonts via fonts.googleapis.com is allowed. Prefer Newsreader + Figtree unless the design system specifies others.
- No external JS CDNs. No placeholder gray boxes for hero images — use CSS composition, SVG, or typographic posters.
- No purple gradients, no Inter-on-white generic SaaS look, no emoji icons, no lorem ipsum, no "Welcome to our platform".
- Real product copy. Distinctive type hierarchy. Hairline borders. Concentric radii.
- If fidelity is wireframe: grayscale, dashed boxes, labels, no color polish.
- If kind is slides: full-viewport .slide sections, Prev/Next + arrow keys, optional .notes.
- Interactive where it helps (tabs, filters, mobile frames, deck nav).
- If current HTML is provided, EDIT it — do not start over unless the user asked for a new direction.
- Apply listed comments and drawings as targeted edits.

tweaks: 4–8 useful controls for THIS design (colors, radius, density, theme, motion speed). type is color | range | select | toggle.`;

export function extractJson(text: string): Partial<GenerateResult> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Partial<GenerateResult>;
  } catch {
    return null;
  }
}

export function extractHtml(text: string): string | null {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && /<html/i.test(fence[1])) return fence[1].trim();
  const doc = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
  return doc ? doc[0] : null;
}

function buildUserContext(data: GenerateInput): string {
  return [
    data.system ? systemPromptBlock(data.system) : "",
    `Project kind: ${data.kind}. Fidelity: ${data.fidelity}.${data.speakerNotes ? " Include speaker notes." : ""}`,
    data.comments?.length ? `Inline comments to apply:\n- ${data.comments.join("\n- ")}` : "",
    data.drawings ? `User sketched on the canvas: ${data.drawings}` : "",
    data.currentHtml
      ? `CURRENT HTML (edit this unless asked to restart):\n${data.currentHtml.slice(0, 48000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function generateViaChatCompletions(
  data: GenerateInput,
  apiKey: string,
  local: ReturnType<typeof fallbackDesign>,
): Promise<GenerateResult | GenerateError> {
  const model = data.model || "grok-4.6";
  const context = buildUserContext(data);
  const messages = [
    { role: "system" as const, content: SYSTEM },
    ...data.history.slice(-8),
    { role: "user" as const, content: `${context}\n\nUSER REQUEST:\n${data.prompt}` },
  ];

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 16000,
        messages,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        return { ...local, ok: true, usedModel: "local", fallback: true };
      }
      return { ok: false, error: `Grok returned ${res.status}${err ? `: ${err.slice(0, 180)}` : ""}` };
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(text);
    const html =
      (parsed?.html && /<html/i.test(parsed.html) ? parsed.html : extractHtml(text)) || local.html;
    const tweaks =
      Array.isArray(parsed?.tweaks) && parsed.tweaks.length ? (parsed.tweaks as Tweak[]) : local.tweaks;
    return {
      ok: true,
      reply: parsed?.reply || "Updated the canvas.",
      title: parsed?.title || inferTitle(data.prompt),
      html,
      tweaks,
      usedModel: model,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Generation failed",
    };
  }
}

export const generateDesign = createServerFn({ method: "POST" })
  // Optional auth: resolves the signed-in user (to use THEIR xAI credential)
  // without rejecting anonymous callers. Enforcing auth here is a follow-up.
  .middleware([optionalAuthMiddleware])
  .validator((input: GenerateInput) => input)
  .handler(async ({ data, context }): Promise<GenerateResult | GenerateError> => {
    // Dynamic import keeps node:child_process out of the client graph
    // (same pattern as projects.ts → db).
    const {
      allowApiFallback,
      DESIGN_RUN_TIMEOUT_MS,
      GrokBuildError,
      isGrokBuildDisabled,
      resolveGrokBin,
      runGrokBuildDesign,
      shouldUseGrokBuild,
    } = await import("./grok-build");
    const { CREDENTIAL_MESSAGES, recordInferenceError, resolveGenerationCredential } = await import(
      "./xai/service.server"
    );

    const model = data.model || "grok-4.6";
    const local = fallbackDesign({
      prompt: data.prompt,
      kind: data.kind,
      fidelity: data.fidelity,
      speakerNotes: data.speakerNotes,
      system: data.system,
    });

    // The user's xAI token must outlive the run (+ the 5-minute refresh skew).
    const credential = await resolveGenerationCredential(
      context.userId ?? null,
      DESIGN_RUN_TIMEOUT_MS + 5 * 60_000,
    );
    if (credential.kind === "none" && credential.reason !== "no_key") {
      return { ok: false, error: CREDENTIAL_MESSAGES[credential.reason] };
    }
    const apiKey = credential.kind === "server_key" ? credential.apiKey : undefined;

    // No credential at all → local templates (unchanged).
    if (!apiKey && credential.kind !== "user_oauth") {
      return { ...local, ok: true, usedModel: "local", fallback: true };
    }

    const context_ = buildUserContext(data);
    const historyBlock =
      data.history.length > 0
        ? `Recent conversation:\n${data.history
            .slice(-8)
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .join("\n\n")}`
        : "";
    const buildPrompt = [context_, historyBlock, `USER REQUEST:\n${data.prompt}`]
      .filter(Boolean)
      .join("\n\n");

    // Primary: Grok Build headless when enabled + binary present.
    if (shouldUseGrokBuild()) {
      try {
        const built = await runGrokBuildDesign({
          prompt: buildPrompt,
          systemPrompt: SYSTEM,
          model,
          currentHtml: data.currentHtml,
          credential:
            credential.kind === "user_oauth"
              ? { kind: "user_oauth", accessToken: credential.accessToken, expiresAt: credential.expiresAt }
              : { kind: "server_key", apiKey: apiKey as string },
        });
        // Safety nets if structured fields need repair from raw text
        const fromRaw = built.rawText ? extractJson(built.rawText) : null;
        const html =
          built.html && /<html/i.test(built.html)
            ? built.html
            : (fromRaw?.html && /<html/i.test(fromRaw.html)
                ? fromRaw.html
                : extractHtml(built.rawText || "")) || local.html;
        const tweaks =
          Array.isArray(built.tweaks) && built.tweaks.length
            ? built.tweaks
            : Array.isArray(fromRaw?.tweaks) && fromRaw.tweaks.length
              ? (fromRaw.tweaks as Tweak[])
              : local.tweaks;
        return {
          ok: true,
          reply: built.reply || fromRaw?.reply || "Updated the canvas.",
          title: built.title || fromRaw?.title || inferTitle(data.prompt),
          html,
          tweaks,
          usedModel: built.usedModel,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Grok Build failed";
        if (credential.kind === "user_oauth") {
          if (e instanceof GrokBuildError && (e.httpStatus === 401 || e.httpStatus === 403)) {
            await recordInferenceError(credential.userId, `inference_${e.httpStatus}`);
          }
          // Never retry a user's request on the server key or a raw API call.
          return { ok: false, error: msg };
        }
        if (allowApiFallback() && apiKey) {
          return generateViaChatCompletions(data, apiKey, local);
        }
        return { ok: false, error: msg };
      }
    }

    if (credential.kind === "user_oauth") {
      return {
        ok: false,
        error: "Grok Build CLI not found on the server — your xAI account can only be used through Grok Build.",
      };
    }

    // Build preferred but binary missing — no silent API unless allowed.
    if (!isGrokBuildDisabled() && !resolveGrokBin() && !allowApiFallback()) {
      return {
        ok: false,
        error:
          "Grok Build CLI not found. Install the grok binary, set GROK_BUILD_BIN, or set GROK_BUILD_ALLOW_API_FALLBACK=true to use chat completions.",
      };
    }

    // Legacy chat completions: Build disabled, or explicit API fallback path.
    if (!apiKey) return { ...local, ok: true, usedModel: "local", fallback: true };
    return generateViaChatCompletions(data, apiKey, local);
  });
