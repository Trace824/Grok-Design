import { uid } from "./id";
import type { DesignSystem } from "./types";

export function grokDefaultSystem(): DesignSystem {
  const now = Date.now();
  return {
    id: "sys_grok_default",
    name: "Grok Default",
    published: true,
    isDefault: true,
    colors: [
      { name: "Ink", value: "#f4f4f5" },
      { name: "Void", value: "#050505" },
      { name: "Stone", value: "#8b8b90" },
      { name: "Accent", value: "#f4f4f5" },
      { name: "Panel", value: "#141414" },
    ],
    fonts: [
      { role: "Display", family: "Outfit", fallback: "system-ui, sans-serif" },
      { role: "Body", family: "Outfit", fallback: "system-ui, sans-serif" },
    ],
    radii: "999px pills, 12px cards, 8px controls",
    spacing: "8px base, generous section padding 72–96px",
    voice: "Direct, dry, a little irreverent. Short sentences. No hype.",
    components:
      "True-black fields, hairline borders, white primary pills, quiet ghost buttons.",
    sourceNotes: "Built-in Grok Design system.",
    createdAt: now,
    updatedAt: now,
  };
}

export function emptySystem(name = "Untitled system"): DesignSystem {
  const now = Date.now();
  return {
    id: uid("sys"),
    name,
    published: false,
    isDefault: false,
    colors: [
      { name: "Primary", value: "#1c1917" },
      { name: "Background", value: "#fafaf9" },
      { name: "Accent", value: "#44403c" },
    ],
    fonts: [
      { role: "Display", family: "Outfit", fallback: "system-ui, sans-serif" },
      { role: "Body", family: "Outfit", fallback: "system-ui, sans-serif" },
    ],
    radii: "12px",
    spacing: "8px base",
    voice: "",
    components: "",
    sourceNotes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function systemPromptBlock(system: DesignSystem): string {
  return [
    `DESIGN SYSTEM: ${system.name}`,
    `Colors: ${system.colors.map((c) => `${c.name} ${c.value}`).join(", ")}`,
    `Typography: ${system.fonts.map((f) => `${f.role} ${f.family} (${f.fallback})`).join("; ")}`,
    `Radii: ${system.radii}`,
    `Spacing: ${system.spacing}`,
    `Voice: ${system.voice || "plain and confident"}`,
    `Components: ${system.components || "minimal, production-quality"}`,
    system.sourceNotes ? `Notes: ${system.sourceNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
