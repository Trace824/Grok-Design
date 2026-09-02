import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Wordmark } from "@/components/logo";
import { emptySystem } from "@/lib/systems";
import { useDesignStore } from "@/lib/store";
import type { DesignSystem } from "@/lib/types";

type Search = { remix?: string };

export const Route = createFileRoute("/onboarding")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    remix: typeof s.remix === "string" ? s.remix : undefined,
  }),
  component: Onboarding,
});

const extractSystem = createServerFn({ method: "POST" })
  .validator((input: { notes: string; name: string }) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    const fallback: DesignSystem = {
      ...emptySystem(data.name || "Custom system"),
      sourceNotes: data.notes,
      voice: data.notes.slice(0, 180),
    };
    if (!apiKey) return fallback;
    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          max_tokens: 1200,
          messages: [
            {
              role: "system",
              content:
                'Extract a design system as JSON: { "name", "colors":[{"name","value"}], "fonts":[{"role","family","fallback"}], "radii", "spacing", "voice", "components" }. Hex colors only. No markdown.',
            },
            { role: "user", content: data.notes },
          ],
        }),
      });
      if (!res.ok) return fallback;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content ?? "";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0) return fallback;
      const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<DesignSystem>;
      return {
        ...fallback,
        name: parsed.name || fallback.name,
        colors: parsed.colors?.length ? parsed.colors : fallback.colors,
        fonts: parsed.fonts?.length ? parsed.fonts : fallback.fonts,
        radii: parsed.radii || fallback.radii,
        spacing: parsed.spacing || fallback.spacing,
        voice: parsed.voice || fallback.voice,
        components: parsed.components || fallback.components,
      };
    } catch {
      return fallback;
    }
  });

function Onboarding() {
  const { remix } = Route.useSearch();
  const navigate = useNavigate();
  const existing = useDesignStore((s) => s.systems.find((x) => x.id === remix));
  const [name, setName] = useState(existing?.name ?? "");
  const [notes, setNotes] = useState(existing?.sourceNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DesignSystem | null>(existing ?? null);

  const preview = useMemo(() => draft ?? existing, [draft, existing]);

  async function extract() {
    setBusy(true);
    try {
      const sys = await extractSystem({ data: { notes, name } });
      setDraft(sys);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const sys = draft ?? {
      ...emptySystem(name || "Untitled system"),
      sourceNotes: notes,
    };
    if (existing) {
      useDesignStore.getState().updateSystem(existing.id, { ...sys, id: existing.id });
    } else {
      useDesignStore.getState().addSystem({ ...sys, published: true });
      useDesignStore.getState().setDefaultSystem(sys.id);
    }
    void navigate({ to: "/" });
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-6 py-10">
      <Wordmark />
      <p className="mt-8 text-[11px] font-medium uppercase tracking-[0.18em] text-mute">
        {existing ? "Remix system" : "Onboarding"}
      </p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight">Your brand, built in</h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mute">
        Paste brand notes, a color list, a README from your component library, or a description of the product.
        Grok extracts colors, type, and components — then every project inherits them.
      </p>

      <label className="mt-8 block text-sm font-medium">
        System name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm outline-none"
          placeholder="Acme Product"
        />
      </label>
      <label className="mt-4 block text-sm font-medium">
        Codebase notes, guidelines, or a site you want captured
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={8}
          className="mt-1.5 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm outline-none"
          placeholder="Primary #111110, paper #f6f4ef, display Newsreader, body Figtree. Buttons are ink pills. Voice is dry and short."
        />
      </label>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy || !notes.trim()}
          onClick={() => void extract()}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {busy ? "Reading…" : "Extract design system"}
        </button>
        <button type="button" onClick={() => void navigate({ to: "/" })} className="rounded-lg px-4 py-2 text-sm text-mute">
          Skip for now
        </button>
      </div>

      {preview && (
        <section className="mt-10 rounded-xl border border-line bg-sheet p-5">
          <h2 className="font-serif text-2xl">{preview.name}</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {preview.colors.map((c) => (
              <div key={c.name} className="w-20">
                <div className="h-12 rounded-lg border border-line" style={{ background: c.value }} />
                <div className="mt-1 text-[11px]">{c.name}</div>
                <div className="font-mono text-[10px] text-mute">{c.value}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-ink-2">{preview.voice}</p>
          <p className="mt-2 text-sm text-mute">{preview.components}</p>
          <button type="button" onClick={save} className="mt-5 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper">
            Publish and use
          </button>
        </section>
      )}
    </main>
  );
}
