import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BookOpen, Folder, Plus, Search } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { authEnabled, signIn, GROK_PROVIDERS } from "@/lib/auth/client";
import { Wordmark } from "@/components/logo";
import { XaiConnectCard } from "@/components/xai-connect-card";
import { EXAMPLES } from "@/lib/examples";
import { useDesignStore } from "@/lib/store";
import { tutorialHtml } from "@/lib/templates";
import { uid } from "@/lib/id";
import type { Fidelity, ProjectKind } from "@/lib/types";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/")({ component: Home });

const KINDS: { id: ProjectKind; label: string }[] = [
  { id: "prototype", label: "Prototype" },
  { id: "slides", label: "Slide deck" },
  { id: "template", label: "From template" },
  { id: "other", label: "Other" },
];

function Home() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const {
    projects,
    systems,
    homeTab,
    setHomeTab,
    createProject,
    hydrated,
    setHydrated,
    addSystem,
    updateSystem,
    setDefaultSystem,
    deleteSystem,
  } = useDesignStore();
  const [kind, setKind] = useState<ProjectKind>("prototype");
  const [fidelity, setFidelity] = useState<Fidelity>("hifi");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState(false);
  const [filter, setFilter] = useState<"recent" | "yours">("recent");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!hydrated) {
      const t = window.setTimeout(() => setHydrated(), 50);
      return () => window.clearTimeout(t);
    }
  }, [hydrated, setHydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const hasTutorial = useDesignStore.getState().projects.some((p) => p.id === "prj_tutorial");
    if (hasTutorial) return;
    useDesignStore.setState((s) => ({
      projects: [
        {
          id: "prj_tutorial",
          name: "Learn about Grok Design",
          kind: "other",
          fidelity: "hifi",
          speakerNotes: false,
          html: tutorialHtml(),
          files: [{ name: "index.html", html: tutorialHtml() }],
          activeFile: "index.html",
          tweaks: [],
          messages: [
            {
              id: uid("msg"),
              role: "assistant",
              content:
                "This is the guided walkthrough. Open comments, try Tweaks, or start a new prototype from the home screen.",
              createdAt: Date.now(),
            },
          ],
          comments: [],
          versions: [],
          systemId: s.systems.find((x) => x.isDefault)?.id ?? null,
          share: "view",
          model: "grok-4.5",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...s.projects,
      ],
    }));
  }, [hydrated]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects, query]);

  function create() {
    const project = createProject({
      name: name || defaultName(kind),
      kind,
      fidelity: kind === "slides" ? "hifi" : fidelity,
      speakerNotes: kind === "slides" ? notes : false,
    });
    void navigate({ to: "/project/$id", params: { id: project.id } });
  }

  function useExample(id: string) {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    const project = createProject({
      name: ex.title,
      kind: ex.kind,
      fidelity: ex.fidelity,
    });
    useDesignStore.getState().addMessage(project.id, {
      id: uid("msg"),
      role: "user",
      content: ex.prompt,
      createdAt: Date.now(),
    });
    void navigate({
      to: "/project/$id",
      params: { id: project.id },
      search: { run: "1" } as never,
    });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-paper lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-line lg:w-[340px] lg:border-b-0 lg:border-r">
        <div className="flex items-start justify-between px-6 pt-6">
          <Wordmark />
          <span className="mt-1 rounded-full border border-line px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-mute">
            Research Preview
          </span>
        </div>

        <div className="px-5 pt-7">
          <div className="rounded-xl border border-line bg-sheet p-3 shadow-soft">
            <div className="flex flex-wrap gap-1 rounded-full border border-line bg-paper p-1 text-[13px]">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setKind(k.id)}
                  className={cn(
                    "rounded-full px-2.5 py-1.5 font-medium",
                    kind === k.id ? "bg-ink text-paper" : "text-mute hover:text-ink",
                  )}
                >
                  {k.label}
                </button>
              ))}
            </div>

            <h2 className="mt-4 px-1 text-[15px] font-medium tracking-tight">
              {kind === "prototype"
                ? "What do you want to design?"
                : kind === "slides"
                  ? "New slide deck"
                  : kind === "template"
                    ? "From a template"
                    : "New file"}
            </h2>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="mt-3 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />

            {kind === "prototype" && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <FidelityCard
                  active={fidelity === "wireframe"}
                  title="Wireframe"
                  onClick={() => setFidelity("wireframe")}
                  sketch
                />
                <FidelityCard
                  active={fidelity === "hifi"}
                  title="High fidelity"
                  onClick={() => setFidelity("hifi")}
                />
              </div>
            )}

            {kind === "slides" && (
              <label className="mt-3 flex items-center gap-2 px-1 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={notes}
                  onChange={(e) => setNotes(e.target.checked)}
                  className="size-4 accent-ink"
                />
                Use speaker notes
              </label>
            )}

            {kind === "template" && (
              <p className="mt-3 px-1 text-sm text-mute">
                Duplicate any project from Share → Duplicate as template, or start from an example on the right.
              </p>
            )}

            <button
              type="button"
              onClick={create}
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-full bg-ink py-2.5 text-sm font-semibold text-paper hover:bg-clay-2"
            >
              <Plus className="size-4" />
              Create
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-line bg-sheet p-4">
            <p className="text-sm leading-relaxed text-ink-2">
              Create a design system so anyone can create good-looking designs and assets.
            </p>
            <button
              type="button"
              onClick={() => void navigate({ to: "/onboarding" })}
              className="mt-3 w-full rounded-full border border-line py-2.5 text-sm font-semibold text-ink hover:bg-paper-2"
            >
              Set up design system
            </button>
          </div>

          <SignedIn>
            <XaiConnectCard />
          </SignedIn>
        </div>

        <div className="mt-auto flex items-center gap-2 px-6 py-5 text-[13px] text-mute">
          <AuthChip pending={isPending} signedIn={Boolean(user)} name={user?.displayName} />
          <span className="text-line-2">·</span>
          <span>xAI</span>
          <span className="text-line-2">·</span>
          <a className="hover:text-ink" href="https://docs.x.ai" target="_blank" rel="noreferrer">
            Docs
          </a>
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-6 pt-5">
          <div className="flex gap-6 text-[15px]">
            {(
              [
                ["designs", "Designs"],
                ["examples", "Examples"],
                ["systems", "Design systems"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setHomeTab(id)}
                className={cn(
                  "border-b-2 py-3 font-medium",
                  homeTab === id ? "border-ink text-ink" : "border-transparent text-mute hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {homeTab === "designs" && (
          <div className="px-6 py-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex rounded-full bg-paper-2 p-1 text-sm">
                <button
                  type="button"
                  onClick={() => setFilter("recent")}
                  className={cn(
                    "rounded-full px-3 py-1 font-medium",
                    filter === "recent" ? "bg-sheet shadow-sm" : "text-mute",
                  )}
                >
                  Recent
                </button>
                <button
                  type="button"
                  onClick={() => setFilter("yours")}
                  className={cn(
                    "rounded-full px-3 py-1 font-medium",
                    filter === "yours" ? "bg-sheet shadow-sm" : "text-mute",
                  )}
                >
                  Your designs
                </button>
              </div>
              <label className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-64 rounded-lg border border-line bg-sheet py-2 pl-9 pr-3 text-sm outline-none"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void navigate({ to: "/project/$id", params: { id: p.id } })}
                  className="overflow-hidden rounded-xl border border-line bg-sheet text-left shadow-soft transition hover:-translate-y-0.5"
                >
                  <div className="flex h-36 items-center justify-center bg-gradient-to-b from-paper-2 to-sheet">
                    {p.id === "prj_tutorial" ? (
                      <BookOpen className="size-12 text-ink-2" strokeWidth={1.25} />
                    ) : (
                      <Folder className="size-12 text-faint" strokeWidth={1.25} />
                    )}
                  </div>
                  <div className="border-t border-line px-4 py-3">
                    <div className="font-medium">{p.name}</div>
                    <div className="mt-0.5 text-sm text-mute">
                      {p.id === "prj_tutorial" ? (
                        <span className="text-ring">Quick tutorial</span>
                      ) : (
                        <>
                          Your design · {relTime(p.updatedAt)}
                        </>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {homeTab === "examples" && (
          <div className="grid grid-cols-1 gap-4 px-6 py-6 sm:grid-cols-2 xl:grid-cols-3">
            {EXAMPLES.map((ex) => (
              <article key={ex.id} className="flex flex-col rounded-xl border border-line bg-sheet p-4 shadow-soft">
                <div className="text-[11px] font-medium uppercase tracking-wider text-mute">{ex.tag}</div>
                <h3 className="mt-2 font-serif text-2xl tracking-tight">{ex.title}</h3>
                <p className="mt-1 flex-1 text-sm leading-relaxed text-mute">{ex.blurb}</p>
                <button
                  type="button"
                  onClick={() => useExample(ex.id)}
                  className="mt-4 self-start rounded-full border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper"
                >
                  Use this prompt
                </button>
              </article>
            ))}
          </div>
        )}

        {homeTab === "systems" && (
          <div className="px-6 py-6">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-mute">Published systems apply to every new project.</p>
              <button
                type="button"
                onClick={() => void navigate({ to: "/onboarding" })}
                className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-paper"
              >
                New system
              </button>
            </div>
            <div className="grid gap-3">
              {systems.map((sys) => (
                <div key={sys.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-sheet px-4 py-3">
                  <div>
                    <div className="font-medium">
                      {sys.name}
                      {sys.isDefault && (
                        <span className="ml-2 text-[11px] font-medium uppercase tracking-wider text-mute">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      {sys.colors.slice(0, 6).map((c) => (
                        <span
                          key={c.name}
                          className="size-5 rounded-full border border-line"
                          style={{ background: c.value }}
                          title={c.name}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <label className="flex items-center gap-1.5 text-mute">
                      <input
                        type="checkbox"
                        checked={sys.published}
                        onChange={(e) => updateSystem(sys.id, { published: e.target.checked })}
                      />
                      Published
                    </label>
                    {!sys.isDefault && (
                      <button type="button" className="text-mute hover:text-ink" onClick={() => setDefaultSystem(sys.id)}>
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-mute hover:text-ink"
                      onClick={() => void navigate({ to: "/onboarding", search: { remix: sys.id } as never })}
                    >
                      Remix
                    </button>
                    {!sys.isDefault && (
                      <button type="button" className="text-mute hover:text-ink" onClick={() => deleteSystem(sys.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function defaultName(kind: ProjectKind) {
  if (kind === "slides") return "Untitled deck";
  if (kind === "template") return "From template";
  if (kind === "other") return "Untitled file";
  return "Untitled prototype";
}

function relTime(ts: number) {
  const d = Date.now() - ts;
  if (d < 60_000) return "Just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return "Today";
}

function AuthChip({
  pending,
  signedIn,
  name,
}: {
  pending: boolean;
  signedIn: boolean;
  name?: string | null;
}) {
  if (pending) return <div className="h-6 w-24 animate-pulse rounded-full bg-paper-2" />;
  if (signedIn) {
    return (
      <SignedIn>
        <div className="flex items-center gap-2 text-ink-2">
          <UserButton />
        </div>
      </SignedIn>
    );
  }
  return (
    <SignedOut>
      {authEnabled ? (
        <button
          type="button"
          className="hover:text-ink"
          onClick={() => signIn(GROK_PROVIDERS[0].providerId, { callbackURL: "/" })}
        >
          {name ?? "Sign in"}
        </button>
      ) : (
        <span>Local</span>
      )}
    </SignedOut>
  );
}

function FidelityCard({
  active,
  title,
  onClick,
  sketch,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  sketch?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl border bg-paper p-2 text-left",
        active ? "border-ink" : "border-line hover:border-line-2",
      )}
    >
      <div
        className={cn(
          "mb-2 h-16 rounded-md border",
          sketch ? "border-dashed border-faint bg-paper-2" : "border-line bg-sheet",
        )}
      >
        <svg viewBox="0 0 120 64" className="h-full w-full text-mute">
          {sketch ? (
            <>
              <rect x="8" y="10" width="44" height="44" fill="none" stroke="currentColor" strokeDasharray="3 2" />
              <rect x="60" y="10" width="52" height="18" fill="none" stroke="currentColor" />
              <rect x="60" y="34" width="52" height="20" fill="none" stroke="currentColor" />
            </>
          ) : (
            <>
              <rect x="8" y="10" width="50" height="44" rx="4" fill="#1a1a1a" stroke="currentColor" />
              <circle cx="92" cy="24" r="10" fill="#f4f4f5" />
              <rect x="68" y="40" width="40" height="8" rx="2" fill="#f4f4f5" />
            </>
          )}
        </svg>
      </div>
      <div className="px-0.5 text-[13px] font-medium">{title}</div>
    </button>
  );
}
