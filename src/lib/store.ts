import { create } from "zustand";
import { persist } from "zustand/middleware";
import { uid } from "./id";
import { grokDefaultSystem } from "./systems";
import type {
  Attachment,
  CanvasMode,
  ChatMessage,
  DesignSystem,
  Fidelity,
  HomeTab,
  PinComment,
  Project,
  ProjectKind,
  ShareAccess,
  Stroke,
  Tweak,
} from "./types";

type CreateInput = {
  name: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  speakerNotes?: boolean;
  html?: string;
  messages?: ChatMessage[];
  systemId?: string | null;
};

type DesignState = {
  hydrated: boolean;
  projects: Project[];
  systems: DesignSystem[];
  homeTab: HomeTab;
  canvasMode: CanvasMode;
  tweaksOn: boolean;
  zoom: number;
  device: "desktop" | "tablet" | "mobile";
  strokes: Stroke[];
  setHydrated: () => void;
  setHomeTab: (tab: HomeTab) => void;
  setCanvasMode: (mode: CanvasMode) => void;
  setTweaksOn: (on: boolean) => void;
  setZoom: (z: number) => void;
  setDevice: (d: DesignState["device"]) => void;
  setStrokes: (s: Stroke[]) => void;
  createProject: (input: CreateInput) => Project;
  updateProject: (id: string, patch: Partial<Project>) => void;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  duplicateProject: (id: string) => Project | null;
  getProject: (id: string) => Project | undefined;
  setHtml: (id: string, html: string, saveVersion?: string) => void;
  setTweaks: (id: string, tweaks: Tweak[]) => void;
  setTweakValue: (id: string, tweakId: string, value: string) => void;
  addMessage: (id: string, message: ChatMessage) => void;
  addComment: (id: string, comment: Omit<PinComment, "id" | "createdAt">) => void;
  toggleComment: (id: string, commentId: string) => void;
  removeComment: (id: string, commentId: string) => void;
  restoreVersion: (id: string, versionId: string) => void;
  addSystem: (system: DesignSystem) => void;
  updateSystem: (id: string, patch: Partial<DesignSystem>) => void;
  deleteSystem: (id: string) => void;
  setDefaultSystem: (id: string) => void;
  defaultSystem: () => DesignSystem;
  setShare: (id: string, access: ShareAccess) => void;
  attachToLastUser: (id: string, files: Attachment[]) => void;
};

function emptyProject(input: CreateInput, defaultSystemId: string | null): Project {
  const now = Date.now();
  const html = input.html ?? "";
  return {
    id: uid("prj"),
    name: input.name.trim() || "Untitled",
    kind: input.kind,
    fidelity: input.fidelity,
    speakerNotes: Boolean(input.speakerNotes),
    html,
    files: [{ name: "index.html", html }],
    activeFile: "index.html",
    tweaks: [],
    messages: input.messages ?? [],
    comments: [],
    versions: html
      ? [{ id: uid("ver"), label: "Initial", html, tweaks: [], createdAt: now }]
      : [],
    systemId: input.systemId ?? defaultSystemId,
    share: "private",
    model: "grok-4.6",
    createdAt: now,
    updatedAt: now,
  };
}

export const useDesignStore = create<DesignState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      projects: [],
      systems: [grokDefaultSystem()],
      homeTab: "designs",
      canvasMode: "preview",
      tweaksOn: false,
      zoom: 100,
      device: "desktop",
      strokes: [],
      setHydrated: () => set({ hydrated: true }),
      setHomeTab: (homeTab) => set({ homeTab }),
      setCanvasMode: (canvasMode) => set({ canvasMode }),
      setTweaksOn: (tweaksOn) => set({ tweaksOn }),
      setZoom: (zoom) => set({ zoom }),
      setDevice: (device) => set({ device }),
      setStrokes: (strokes) => set({ strokes }),
      createProject: (input) => {
        const def = get().systems.find((s) => s.isDefault) ?? get().systems[0];
        const project = emptyProject(input, def?.id ?? null);
        set((s) => ({ projects: [project, ...s.projects] }));
        return project;
      },
      updateProject: (id, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
          ),
        })),
      renameProject: (id, name) => get().updateProject(id, { name }),
      deleteProject: (id) =>
        set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),
      duplicateProject: (id) => {
        const src = get().projects.find((p) => p.id === id);
        if (!src) return null;
        const copy: Project = {
          ...src,
          id: uid("prj"),
          name: `${src.name} copy`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          share: "private",
        };
        set((s) => ({ projects: [copy, ...s.projects] }));
        return copy;
      },
      getProject: (id) => get().projects.find((p) => p.id === id),
      setHtml: (id, html, saveVersion) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id) return p;
            const files = p.files.map((f) =>
              f.name === p.activeFile ? { ...f, html } : f,
            );
            const versions = saveVersion
              ? [
                  {
                    id: uid("ver"),
                    label: saveVersion,
                    html,
                    tweaks: p.tweaks,
                    createdAt: Date.now(),
                  },
                  ...p.versions,
                ].slice(0, 12)
              : p.versions;
            return { ...p, html, files, versions, updatedAt: Date.now() };
          }),
        })),
      setTweaks: (id, tweaks) => get().updateProject(id, { tweaks }),
      setTweakValue: (id, tweakId, value) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? {
                  ...p,
                  tweaks: p.tweaks.map((t) =>
                    t.id === tweakId ? { ...t, value } : t,
                  ),
                  updatedAt: Date.now(),
                }
              : p,
          ),
        })),
      addMessage: (id, message) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? { ...p, messages: [...p.messages, message], updatedAt: Date.now() }
              : p,
          ),
        })),
      addComment: (id, comment) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? {
                  ...p,
                  comments: [
                    ...p.comments,
                    { ...comment, id: uid("cmt"), createdAt: Date.now() },
                  ],
                  updatedAt: Date.now(),
                }
              : p,
          ),
        })),
      toggleComment: (id, commentId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? {
                  ...p,
                  comments: p.comments.map((c) =>
                    c.id === commentId ? { ...c, selected: !c.selected } : c,
                  ),
                }
              : p,
          ),
        })),
      removeComment: (id, commentId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? { ...p, comments: p.comments.filter((c) => c.id !== commentId) }
              : p,
          ),
        })),
      restoreVersion: (id, versionId) => {
        const p = get().projects.find((x) => x.id === id);
        const v = p?.versions.find((x) => x.id === versionId);
        if (!p || !v) return;
        get().setHtml(id, v.html);
        get().setTweaks(id, v.tweaks);
      },
      addSystem: (system) => set((s) => ({ systems: [system, ...s.systems] })),
      updateSystem: (id, patch) =>
        set((s) => ({
          systems: s.systems.map((sys) =>
            sys.id === id ? { ...sys, ...patch, updatedAt: Date.now() } : sys,
          ),
        })),
      deleteSystem: (id) =>
        set((s) => ({
          systems: s.systems.filter((sys) => sys.id !== id || sys.isDefault),
        })),
      setDefaultSystem: (id) =>
        set((s) => ({
          systems: s.systems.map((sys) => ({
            ...sys,
            isDefault: sys.id === id,
          })),
        })),
      defaultSystem: () =>
        get().systems.find((s) => s.isDefault) ?? get().systems[0] ?? grokDefaultSystem(),
      setShare: (id, share) => get().updateProject(id, { share }),
      attachToLastUser: (id, files) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id) return p;
            const msgs = [...p.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user") {
                msgs[i] = {
                  ...msgs[i],
                  attachments: [...(msgs[i].attachments ?? []), ...files],
                };
                break;
              }
            }
            return { ...p, messages: msgs };
          }),
        })),
    }),
    {
      name: "grok-design-v1",
      partialize: (s) => ({
        projects: s.projects,
        systems: s.systems,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const fresh = grokDefaultSystem();
          const has = state.systems.some((s) => s.id === fresh.id);
          state.systems = has
            ? state.systems.map((s) =>
                s.id === fresh.id
                  ? { ...fresh, isDefault: s.isDefault, published: s.published }
                  : s,
              )
            : [fresh, ...state.systems];
          state.setHydrated();
        }
      },
    },
  ),
);
