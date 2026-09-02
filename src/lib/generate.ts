import { createServerFn } from "@tanstack/react-start";
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

const SYSTEM = `You are Grok Design, xAI's visual design product (the counterpart to Claude Design).
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

function extractJson(text: string): Partial<GenerateResult> | null {
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

function extractHtml(text: string): string | null {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && /<html/i.test(fence[1])) return fence[1].trim();
  const doc = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
  return doc ? doc[0] : null;
}

export const generateDesign = createServerFn({ method: "POST" })
  .validator((input: GenerateInput) => input)
  .handler(async ({ data }): Promise<GenerateResult | GenerateError> => {
    const apiKey = process.env.XAI_API_KEY;
    const model = data.model || "grok-4.5";
    const local = fallbackDesign({
      prompt: data.prompt,
      kind: data.kind,
      fidelity: data.fidelity,
      speakerNotes: data.speakerNotes,
      system: data.system,
    });

    if (!apiKey) {
      return { ...local, ok: true, usedModel: "local", fallback: true };
    }

    const context = [
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
      const html = (parsed?.html && /<html/i.test(parsed.html) ? parsed.html : extractHtml(text)) || local.html;
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
  });
