import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Eraser,
  FileCode,
  Image as ImageIcon,
  Link2,
  Loader2,
  MessageSquare,
  MousePointer2,
  Pencil,
  Presentation,
  Redo2,
  Send,
  SlidersHorizontal,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { generateDesign } from "@/lib/generate";
import { useDesignStore } from "@/lib/store";
import { uid } from "@/lib/id";
import { cn } from "@/lib/cn";
import {
  applyCssVars,
  injectBridge,
  tweaksToVars,
} from "@/lib/iframe-bridge";
import {
  downloadHandoff,
  downloadHtml,
  downloadPptx,
  downloadZip,
  printPdf,
} from "@/lib/export";
import type {
  AgentStep,
  Attachment,
  CanvasMode,
  ModelId,
  PinComment,
  Stroke,
} from "@/lib/types";

type Search = { run?: string };

export const Route = createFileRoute("/project/$id")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    run: typeof s.run === "string" ? s.run : undefined,
  }),
  component: Workspace,
});

const MODELS: { id: ModelId; label: string }[] = [
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4", label: "Grok 4" },
  { id: "grok-3", label: "Grok 3" },
];

function Workspace() {
  const { id } = Route.useParams();
  const { run } = Route.useSearch();
  const navigate = useNavigate();
  const project = useDesignStore((s) => s.projects.find((p) => p.id === id));
  const systems = useDesignStore((s) => s.systems);
  const mode = useDesignStore((s) => s.canvasMode);
  const tweaksOn = useDesignStore((s) => s.tweaksOn);
  const zoom = useDesignStore((s) => s.zoom);
  const device = useDesignStore((s) => s.device);
  const strokes = useDesignStore((s) => s.strokes);
  const {
    setCanvasMode,
    setTweaksOn,
    setZoom,
    setDevice,
    setStrokes,
    addMessage,
    setHtml,
    setTweaks,
    addComment,
    toggleComment,
    removeComment,
    updateProject,
    restoreVersion,
  } = useDesignStore();

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [tab, setTab] = useState<"chat" | "comments">("chat");
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [editTarget, setEditTarget] = useState<{ selector: string; text: string; tag: string } | null>(null);
  const [commentDraft, setCommentDraft] = useState<{ x: number; y: number; text: string; target?: string } | null>(null);
  const ran = useRef(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const system = systems.find((s) => s.id === project?.systemId) ?? systems.find((s) => s.isDefault);
  const srcDoc = useMemo(() => {
    if (!project?.html) return "";
    return applyCssVars(injectBridge(project.html), tweaksToVars(project.tweaks));
  }, [project?.html, project?.tweaks]);

  useEffect(() => {
    useDesignStore.getState().setCanvasMode("preview");
    useDesignStore.getState().setStrokes([]);
  }, [id]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !project) return;
    frame.contentWindow.postMessage(
      { source: "grok-design-host", type: "set-mode", mode },
      "*",
    );
    frame.contentWindow.postMessage(
      { source: "grok-design-host", type: "set-vars", vars: tweaksToVars(project.tweaks) },
      "*",
    );
  }, [mode, project?.tweaks, srcDoc]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data;
      if (!d || d.source !== "grok-design") return;
      if (d.type === "element" && d.mode === "comment") {
        setCommentDraft({
          x: d.rect.x + d.rect.w / 2,
          y: d.rect.y,
          text: "",
          target: d.text || d.tag,
        });
        setTab("comments");
      }
      if (d.type === "element" && d.mode === "edit") {
        setEditTarget({ selector: d.selector, text: d.text, tag: d.tag });
      }
      if (d.type === "text-edit") {
        setEditTarget((cur) => (cur ? { ...cur, text: d.text } : cur));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function runGenerate(prompt: string, extras?: { comments?: string[]; drawings?: string }) {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    setTab("chat");
    const running: AgentStep[] = [
      { id: "s1", label: "Searching", status: "running" },
      { id: "s2", label: "Designing", status: "running" },
    ];
    setSteps(running);
    const userMsg = {
      id: uid("msg"),
      role: "user" as const,
      content: prompt,
      createdAt: Date.now(),
      attachments: pending.length ? pending : undefined,
    };
    addMessage(project.id, userMsg);
    setPending([]);
    setDraft("");

    const t1 = window.setTimeout(() => {
      setSteps((s) => s.map((x) => (x.id === "s1" ? { ...x, status: "done" } : x)));
    }, 600);

    const history = [...project.messages, userMsg]
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const attachNote = pending
      .map((a) => `[${a.kind}] ${a.name}${a.text ? `: ${a.text.slice(0, 800)}` : ""}${a.url ? ` ${a.url}` : ""}`)
      .join("\n");

    try {
      const result = await generateDesign({
        data: {
          prompt: attachNote ? `${prompt}\n\nAttached context:\n${attachNote}` : prompt,
          history,
          kind: project.kind,
          fidelity: project.fidelity,
          speakerNotes: project.speakerNotes,
          currentHtml: project.html || undefined,
          comments: extras?.comments,
          drawings: extras?.drawings,
          system,
          model: project.model,
        },
      });
      window.clearTimeout(t1);
      if (!result.ok) {
        setError(result.error);
        setSteps([]);
        addMessage(project.id, {
          id: uid("msg"),
          role: "assistant",
          content: `I couldn't generate that: ${result.error}`,
          createdAt: Date.now(),
        });
        return;
      }
      setSteps([
        { id: "s1", label: "Searching", status: "done" },
        { id: "s2", label: "Designing", status: "done" },
        { id: "s3", label: "Done", status: "done" },
      ]);
      setHtml(project.id, result.html, project.html ? "Revision" : "First version");
      setTweaks(project.id, result.tweaks);
      if (result.title && project.name.startsWith("Untitled")) {
        updateProject(project.id, { name: result.title });
      }
      addMessage(project.id, {
        id: uid("msg"),
        role: "assistant",
        content: result.reply,
        createdAt: Date.now(),
        steps: [
          { id: "s1", label: "Searching", status: "done" },
          { id: "s2", label: "Designing", status: "done" },
          { id: "s3", label: "Done", status: "done" },
        ],
      });
      window.setTimeout(() => setSteps([]), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSteps([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!project || ran.current) return;
    const last = project.messages.at(-1);
    if (run === "1" && last?.role === "user" && !project.html) {
      ran.current = true;
      void runGenerate(last.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, run]);

  function sendComments() {
    if (!project) return;
    const selected = project.comments.filter((c) => c.selected && !c.resolved);
    if (!selected.length) return;
    const text = selected.map((c) => `${c.target ? `(${c.target}) ` : ""}${c.text}`).join("\n");
    selected.forEach((c) =>
      useDesignStore.setState((s) => ({
        projects: s.projects.map((p) =>
          p.id === project.id
            ? {
                ...p,
                comments: p.comments.map((x) =>
                  x.id === c.id ? { ...x, resolved: true, selected: false } : x,
                ),
              }
            : p,
        ),
      })),
    );
    void runGenerate(`Apply these inline comments:\n${text}`, { comments: selected.map((c) => c.text) });
  }

  function sendDrawings() {
    if (!project || !strokes.length) return;
    const desc = `${strokes.length} ink stroke(s) marked on the canvas. Interpret them as layout annotations and apply.`;
    setStrokes([]);
    void runGenerate("Apply my canvas markup.", { drawings: desc });
  }

  async function onFiles(list: FileList | null) {
    if (!list) return;
    const next: Attachment[] = [];
    for (const file of [...list]) {
      const isImg = file.type.startsWith("image/");
      const att: Attachment = {
        id: uid("att"),
        name: file.name,
        kind: isImg ? "image" : "document",
        mime: file.type,
      };
      if (isImg || file.size < 400_000) {
        att.dataUrl = await readData(file);
        if (!isImg) att.text = await file.text().catch(() => "");
      } else {
        att.text = `(file ${file.name}, ${Math.round(file.size / 1024)}kb)`;
      }
      next.push(att);
    }
    setPending((p) => [...p, ...next]);
  }

  if (!project) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="text-center">
          <p className="font-serif text-2xl">Project not found</p>
          <Link to="/" className="mt-3 inline-block text-sm text-mute underline">
            Back to designs
          </Link>
        </div>
      </div>
    );
  }

  const width =
    device === "mobile" ? 390 : device === "tablet" ? 768 : "100%";

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
        <Link to="/" className="grid size-8 place-items-center rounded-md text-mute hover:bg-paper-2 hover:text-ink">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="hidden items-center gap-1 rounded-md border border-line bg-sheet px-1 py-0.5 text-[12px] sm:flex">
          <span className="rounded px-2 py-1 text-mute">Design files</span>
          <span className="rounded bg-paper-2 px-2 py-1 font-medium">{project.activeFile}</span>
        </div>
        <input
          value={project.name}
          onChange={(e) => updateProject(project.id, { name: e.target.value })}
          className="min-w-0 flex-1 truncate bg-transparent text-sm font-medium outline-none sm:max-w-xs"
        />
        <div className="ml-auto flex items-center gap-1">
          <IconBtn label="Undo" onClick={() => project.versions[1] && restoreVersion(project.id, project.versions[1].id)}>
            <Undo2 className="size-4" />
          </IconBtn>
          <IconBtn label="Redo">
            <Redo2 className="size-4" />
          </IconBtn>
          <label className="ml-1 hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] font-medium sm:flex">
            Tweaks
            <button
              type="button"
              role="switch"
              aria-checked={tweaksOn}
              onClick={() => setTweaksOn(!tweaksOn)}
              className={cn(
                "relative h-5 w-8 rounded-full",
                tweaksOn ? "bg-ink" : "bg-line-2",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-sheet transition",
                  tweaksOn ? "left-3.5" : "left-0.5",
                )}
              />
            </button>
          </label>
          <ModeBtn active={mode === "comment"} onClick={() => setCanvasMode(mode === "comment" ? "preview" : "comment")} icon={<MessageSquare className="size-3.5" />} label="Comment" />
          <ModeBtn active={mode === "edit"} onClick={() => setCanvasMode(mode === "edit" ? "preview" : "edit")} icon={<Type className="size-3.5" />} label="Edit" />
          <ModeBtn active={mode === "draw"} onClick={() => setCanvasMode(mode === "draw" ? "preview" : "draw")} icon={<Pencil className="size-3.5" />} label="Draw" />
          <select
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="hidden rounded-md border border-line bg-sheet px-1.5 py-1 text-[12px] sm:block"
          >
            {[50, 75, 100, 125, 150, 200].map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
          <div className="relative">
            <button
              type="button"
              onClick={() => void navigate({ to: "/present/$id", params: { id: project.id } })}
              className="hidden items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium hover:bg-paper-2 sm:flex"
            >
              <Presentation className="size-3.5" /> Present
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="rounded-md px-2 py-1 text-[12px] font-medium hover:bg-paper-2"
          >
            Share
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              className="rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-paper"
            >
              Export
            </button>
            {exportOpen && (
              <ExportMenu
                onClose={() => setExportOpen(false)}
                onHtml={() => downloadHtml(project)}
                onZip={() => void downloadZip(project, system)}
                onPdf={() => printPdf()}
                onPptx={() => downloadPptx(project)}
                onHandoff={() => downloadHandoff(project, system)}
              />
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex h-[42vh] w-full shrink-0 flex-col border-b border-line lg:h-auto lg:w-[340px] lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-4 border-b border-line px-4 text-sm">
            <button
              type="button"
              className={cn("border-b-2 py-2.5", tab === "chat" ? "border-ink font-medium" : "border-transparent text-mute")}
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              className={cn("border-b-2 py-2.5", tab === "comments" ? "border-ink font-medium" : "border-transparent text-mute")}
              onClick={() => setTab("comments")}
            >
              Comments
              {project.comments.filter((c) => !c.resolved).length > 0 && (
                <span className="ml-1 text-mute">{project.comments.filter((c) => !c.resolved).length}</span>
              )}
            </button>
            <select
              value={project.model}
              onChange={(e) => updateProject(project.id, { model: e.target.value as ModelId })}
              className="ml-auto bg-transparent py-2 text-[11px] text-mute"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {tab === "chat" ? (
            <>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {project.messages.length === 0 && !busy && (
                  <EmptyPrompt kind={project.kind} fidelity={project.fidelity} />
                )}
                {project.messages.map((m) => (
                  <div key={m.id} className="grok-rise text-sm leading-relaxed">
                    {m.role === "user" ? (
                      <div className="rounded-xl bg-paper-2 px-3 py-2">{m.content}</div>
                    ) : (
                      <div>
                        {m.steps?.map((s) => (
                          <StepRow key={s.id} step={s} />
                        ))}
                        <p className="mt-1 whitespace-pre-wrap text-ink-2">{m.content}</p>
                      </div>
                    )}
                  </div>
                ))}
                {busy && steps.map((s) => <StepRow key={s.id} step={s} />)}
                {error && <p className="text-sm text-terra">{error}</p>}
              </div>
              <div className="border-t border-line p-3">
                {pending.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {pending.map((a) => (
                      <span key={a.id} className="rounded-full bg-paper-2 px-2 py-0.5 text-[11px]">
                        {a.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="rounded-2xl border border-line bg-paper p-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (draft.trim()) void runGenerate(draft.trim());
                      }
                    }}
                    rows={3}
                    placeholder="Describe what you want to create…"
                    className="w-full resize-none bg-transparent text-sm outline-none"
                  />
                  <div className="mt-1 flex items-center gap-1">
                    <input ref={fileRef} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-mute hover:bg-paper-2"
                      onClick={() => fileRef.current?.click()}
                      title="Attach"
                    >
                      <Upload className="size-4" />
                    </button>
                    <ImportMenu
                      onUrl={(url) =>
                        setPending((p) => [
                          ...p,
                          { id: uid("att"), name: url, kind: "url", url },
                        ])
                      }
                      onGithub={(url) =>
                        setPending((p) => [
                          ...p,
                          { id: uid("att"), name: url, kind: "github", url },
                        ])
                      }
                    />
                    <button
                      type="button"
                      disabled={busy || !draft.trim()}
                      onClick={() => void runGenerate(draft.trim())}
                      className="ml-auto inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-paper disabled:opacity-40"
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <CommentsPane
              comments={project.comments}
              onToggle={(cid) => toggleComment(project.id, cid)}
              onRemove={(cid) => removeComment(project.id, cid)}
              onSend={sendComments}
            />
          )}
        </aside>

        <main className="relative min-w-0 flex-1 bg-paper-2">
          <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-md border border-line bg-sheet p-0.5 text-[11px]">
            {(["desktop", "tablet", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={cn("rounded px-2 py-1 capitalize", device === d ? "bg-paper-2 font-medium" : "text-mute")}
              >
                {d}
              </button>
            ))}
          </div>

          <div className="h-full overflow-auto p-6">
            <div
              className="relative mx-auto h-full origin-top bg-sheet shadow-soft"
              style={{
                width,
                maxWidth: "100%",
                transform: `scale(${zoom / 100})`,
                minHeight: "70%",
              }}
            >
              {project.html ? (
                <iframe
                  ref={frameRef}
                  data-gd-frame
                  title="Canvas"
                  className="h-full min-h-[70vh] w-full border-0 bg-sheet"
                  sandbox="allow-scripts allow-same-origin allow-modals"
                  srcDoc={srcDoc}
                />
              ) : (
                <div className="grid min-h-[70vh] place-items-center text-center text-mute">
                  <div>
                    <MousePointer2 className="mx-auto mb-3 size-8 opacity-40" />
                    <p>The canvas is empty.</p>
                    <p className="text-sm">Describe what you want in chat.</p>
                  </div>
                </div>
              )}

              {mode === "draw" && (
                <DrawLayer
                  strokes={strokes}
                  onChange={setStrokes}
                  onSend={sendDrawings}
                  onClear={() => setStrokes([])}
                />
              )}

              {project.comments
                .filter((c) => !c.resolved)
                .map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className="absolute z-20 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-ink text-[11px] font-semibold text-paper shadow"
                    style={{ left: c.x, top: c.y }}
                    onClick={() => setTab("comments")}
                  >
                    {i + 1}
                  </button>
                ))}

              {commentDraft && (
                <form
                  className="absolute z-30 w-64 rounded-lg border border-line bg-sheet p-2 shadow-soft"
                  style={{ left: commentDraft.x, top: commentDraft.y }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!commentDraft.text.trim()) return;
                    addComment(project.id, {
                      x: commentDraft.x,
                      y: commentDraft.y,
                      text: commentDraft.text.trim(),
                      selected: true,
                      resolved: false,
                      target: commentDraft.target,
                    });
                    setCommentDraft(null);
                    setTab("comments");
                  }}
                >
                  <textarea
                    autoFocus
                    value={commentDraft.text}
                    onChange={(e) => setCommentDraft({ ...commentDraft, text: e.target.value })}
                    placeholder="Ask for a change…"
                    className="h-16 w-full resize-none bg-transparent text-sm outline-none"
                  />
                  <div className="flex justify-end gap-1">
                    <button type="button" className="px-2 text-xs text-mute" onClick={() => setCommentDraft(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="rounded bg-ink px-2 py-0.5 text-xs text-paper">
                      Pin
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          {tweaksOn && project.tweaks.length > 0 && (
            <TweaksPanel
              tweaks={project.tweaks}
              onChange={(tid, v) => useDesignStore.getState().setTweakValue(project.id, tid, v)}
            />
          )}

          {mode === "edit" && editTarget && (
            <div className="absolute right-4 top-14 z-20 w-64 rounded-xl border border-line bg-sheet p-3 shadow-soft">
              <div className="text-[11px] uppercase tracking-wider text-mute">{editTarget.tag}</div>
              <textarea
                value={editTarget.text}
                onChange={(e) => {
                  const text = e.target.value;
                  setEditTarget({ ...editTarget, text });
                  frameRef.current?.contentWindow?.postMessage(
                    { source: "grok-design-host", type: "set-text", selector: editTarget.selector, text },
                    "*",
                  );
                }}
                className="mt-2 h-24 w-full rounded-md border border-line p-2 text-sm outline-none"
              />
              <p className="mt-2 text-[11px] text-mute">Click any text on the canvas to edit it in place.</p>
            </div>
          )}
        </main>
      </div>

      {shareOpen && (
        <ShareDialog
          access={project.share}
          onChange={(a) => useDesignStore.getState().setShare(project.id, a)}
          onCopy={() => {
            const url = `${window.location.origin}/share/${project.id}`;
            void navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          copied={copied}
          onClose={() => setShareOpen(false)}
          onDuplicate={() => {
            const copy = useDesignStore.getState().duplicateProject(project.id);
            if (copy) void navigate({ to: "/project/$id", params: { id: copy.id } });
          }}
        />
      )}
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(step.status === "running");
  return (
    <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-0.5 text-left text-[13px] text-mute">
      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      {step.status === "running" ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Check className="size-3.5 text-ok" />
      )}
      {step.label}
    </button>
  );
}

function EmptyPrompt({ kind, fidelity }: { kind: string; fidelity: string }) {
  return (
    <div className="text-sm text-mute">
      <p className="font-medium text-ink">New {kind}</p>
      <p className="mt-1">
        {fidelity === "wireframe"
          ? "Ask for structure first — screens, hierarchy, empty states."
          : "Describe the goal, layout, content, and audience."}
      </p>
      <ul className="mt-3 space-y-1.5 text-[13px]">
        <li>“Dashboard of monthly revenue with region filters.”</li>
        <li>“Four-screen mobile onboarding for a meditation app.”</li>
        <li>“Landing page with hero, proof, and pricing.”</li>
      </ul>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" title={label} onClick={onClick} className="grid size-8 place-items-center rounded-md text-mute hover:bg-paper-2 hover:text-ink">
      {children}
    </button>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hidden items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium sm:flex",
        active ? "bg-ink text-paper" : "hover:bg-paper-2",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function TweaksPanel({
  tweaks,
  onChange,
}: {
  tweaks: { id: string; label: string; type: string; value: string; min?: number; max?: number; step?: number; options?: { label: string; value: string }[] }[];
  onChange: (id: string, value: string) => void;
}) {
  return (
    <aside className="absolute bottom-4 right-4 z-20 w-72 rounded-xl border border-line bg-sheet p-3 shadow-soft">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <SlidersHorizontal className="size-3.5" /> Tweaks
        </div>
        <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ok">
          Live
        </span>
      </div>
      <div className="space-y-3">
        {tweaks.map((t) => (
          <label key={t.id} className="block text-[12px]">
            <span className="text-mute">{t.label}</span>
            {t.type === "color" && (
              <input
                type="color"
                value={t.value.startsWith("#") ? t.value : "#111111"}
                onChange={(e) => onChange(t.id, e.target.value)}
                className="mt-1 h-8 w-full cursor-pointer rounded border border-line bg-sheet"
              />
            )}
            {t.type === "range" && (
              <input
                type="range"
                min={t.min ?? 0}
                max={t.max ?? 100}
                step={t.step ?? 1}
                value={Number(t.value) || 0}
                onChange={(e) => onChange(t.id, e.target.value)}
                className="mt-1 w-full accent-ink"
              />
            )}
            {t.type === "select" && (
              <select
                value={t.value}
                onChange={(e) => onChange(t.id, e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-sheet px-2 py-1"
              >
                {(t.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {t.type === "toggle" && (
              <input
                type="checkbox"
                className="ml-2 align-middle"
                checked={t.value === "true" || t.value === "1"}
                onChange={(e) => onChange(t.id, e.target.checked ? "true" : "false")}
              />
            )}
          </label>
        ))}
      </div>
    </aside>
  );
}

function CommentsPane({
  comments,
  onToggle,
  onRemove,
  onSend,
}: {
  comments: PinComment[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
}) {
  const open = comments.filter((c) => !c.resolved);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {open.length === 0 && (
          <p className="px-1 text-sm text-mute">
            Switch to Comment and click an element. Check the notes you want Grok to apply.
          </p>
        )}
        {open.map((c, i) => (
          <label key={c.id} className="flex gap-2 rounded-lg border border-line bg-sheet p-2 text-sm">
            <input type="checkbox" checked={c.selected} onChange={() => onToggle(c.id)} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="mr-1 text-[11px] text-mute">{i + 1}</span>
              {c.text}
              {c.target && <div className="truncate text-[11px] text-faint">{c.target}</div>}
            </span>
            <button type="button" onClick={() => onRemove(c.id)} className="text-faint hover:text-ink">
              <X className="size-3.5" />
            </button>
          </label>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <button
          type="button"
          disabled={!open.some((c) => c.selected)}
          onClick={onSend}
          className="w-full rounded-lg bg-ink py-2 text-sm font-medium text-paper disabled:opacity-40"
        >
          Send selected to Grok
        </button>
      </div>
    </div>
  );
}

function DrawLayer({
  strokes,
  onChange,
  onSend,
  onClear,
}: {
  strokes: Stroke[];
  onChange: (s: Stroke[]) => void;
  onSend: () => void;
  onClear: () => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const current = useRef<Stroke | null>(null);

  function pos(e: PointerEvent<SVGSVGElement>) {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  return (
    <div className="absolute inset-0 z-10">
      <svg
        ref={ref}
        className="h-full w-full touch-none"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          current.current = { id: uid("ink"), points: [pos(e)], color: "#f4f4f5" };
          onChange([...strokes, current.current]);
        }}
        onPointerMove={(e) => {
          if (!current.current) return;
          current.current.points.push(pos(e));
          onChange([...strokes.filter((s) => s.id !== current.current!.id), { ...current.current }]);
        }}
        onPointerUp={() => {
          current.current = null;
        }}
      >
        {strokes.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke={s.color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
          />
        ))}
      </svg>
      <div className="absolute bottom-4 left-4 flex gap-2">
        <button type="button" onClick={onClear} className="inline-flex items-center gap-1 rounded-full border border-line bg-sheet px-3 py-1.5 text-xs font-medium">
          <Eraser className="size-3.5" /> Clear
        </button>
        <button type="button" onClick={onSend} disabled={!strokes.length} className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper disabled:opacity-40">
          Apply markup
        </button>
      </div>
    </div>
  );
}

function ImportMenu({ onUrl, onGithub }: { onUrl: (v: string) => void; onGithub: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"url" | "github" | null>(null);
  return (
    <div className="relative">
      <button type="button" className="rounded-md px-2 py-1 text-[12px] font-medium text-mute hover:bg-paper-2" onClick={() => setOpen((v) => !v)}>
        Import
      </button>
      {open && (
        <div className="absolute bottom-9 left-0 z-30 w-64 rounded-lg border border-line bg-sheet p-2 text-sm shadow-soft">
          {!mode ? (
            <div className="grid">
              <button type="button" className="rounded px-2 py-1.5 text-left hover:bg-paper" onClick={() => setMode("url")}>
                Web capture
              </button>
              <button type="button" className="rounded px-2 py-1.5 text-left hover:bg-paper" onClick={() => setMode("github")}>
                GitHub repo
              </button>
              <p className="px-2 py-1 text-[11px] text-mute">Or attach DOCX, PPTX, XLSX, images from the upload button.</p>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!value.trim()) return;
                if (mode === "url") onUrl(value.trim());
                else onGithub(value.trim());
                setValue("");
                setMode(null);
                setOpen(false);
              }}
            >
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={mode === "url" ? "https://…" : "https://github.com/…"}
                className="w-full rounded-md border border-line px-2 py-1 text-sm outline-none"
              />
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" className="text-xs text-mute" onClick={() => setMode(null)}>
                  Back
                </button>
                <button type="submit" className="text-xs font-medium">
                  Add
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function ExportMenu({
  onClose,
  onHtml,
  onZip,
  onPdf,
  onPptx,
  onHandoff,
}: {
  onClose: () => void;
  onHtml: () => void;
  onZip: () => void;
  onPdf: () => void;
  onPptx: () => void;
  onHandoff: () => void;
}) {
  const items = [
    { label: "Download as .zip", fn: onZip, icon: Download },
    { label: "Export as PDF", fn: onPdf, icon: FileCode },
    { label: "Export as PPTX", fn: onPptx, icon: Presentation },
    { label: "Standalone HTML", fn: onHtml, icon: FileCode },
    { label: "Send to Canva", fn: onHtml, icon: ImageIcon },
    { label: "Handoff to Grok Code", fn: onHandoff, icon: FileCode },
  ];
  return (
    <div className="absolute right-0 top-9 z-40 w-60 rounded-xl border border-line bg-sheet p-1 shadow-soft">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-paper"
          onClick={() => {
            it.fn();
            onClose();
          }}
        >
          <it.icon className="size-4 text-mute" />
          {it.label}
        </button>
      ))}
      <p className="px-3 py-2 text-[11px] text-mute">Also: Adobe, Gamma, Lovable, Miro, Replit, Vercel, Wix.</p>
    </div>
  );
}

function ShareDialog({
  access,
  onChange,
  onCopy,
  copied,
  onClose,
  onDuplicate,
}: {
  access: string;
  onChange: (a: "private" | "view" | "comment" | "edit") => void;
  onCopy: () => void;
  copied: boolean;
  onClose: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-sheet p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-2xl">Share</h2>
          <button type="button" onClick={onClose}><X className="size-4" /></button>
        </div>
        <p className="mt-1 text-sm text-mute">Organization-scoped link. Anyone with access can open the canvas.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {(["private", "view", "comment", "edit"] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => onChange(a)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm capitalize",
                access === a ? "border-ink bg-paper" : "border-line",
              )}
            >
              {a === "view" ? "View only" : a}
            </button>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCopy} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink py-2 text-sm font-medium text-paper">
            <Link2 className="size-4" /> {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" onClick={onDuplicate} className="flex-1 rounded-lg border border-line py-2 text-sm font-medium">
            Duplicate as template
          </button>
        </div>
      </div>
    </div>
  );
}

function readData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
