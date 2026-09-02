export type ProjectKind = "prototype" | "slides" | "template" | "other";
export type Fidelity = "wireframe" | "hifi";
export type CanvasMode = "preview" | "comment" | "edit" | "draw";
export type ShareAccess = "private" | "view" | "comment" | "edit";
export type HomeTab = "designs" | "examples" | "systems";
export type DesignsFilter = "recent" | "yours";
export type TweakType = "color" | "range" | "select" | "toggle";
export type ModelId = "grok-4.6" | "grok-4.5" | "grok-4" | "grok-3";

export type Tweak = {
  id: string;
  label: string;
  type: TweakType;
  cssVar: string;
  value: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: string }[];
};

export type ChatRole = "user" | "assistant" | "system";

export type AgentStep = {
  id: string;
  label: string;
  status: "running" | "done";
  detail?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  steps?: AgentStep[];
  attachments?: Attachment[];
};

export type Attachment = {
  id: string;
  name: string;
  kind: "image" | "document" | "code" | "url" | "github";
  mime?: string;
  dataUrl?: string;
  text?: string;
  url?: string;
};

export type PinComment = {
  id: string;
  x: number;
  y: number;
  text: string;
  selected: boolean;
  resolved: boolean;
  createdAt: number;
  target?: string;
};

export type Stroke = {
  id: string;
  points: { x: number; y: number }[];
  color: string;
};

export type Version = {
  id: string;
  label: string;
  html: string;
  tweaks: Tweak[];
  createdAt: number;
};

export type DesignFile = {
  name: string;
  html: string;
};

export type DesignSystem = {
  id: string;
  name: string;
  published: boolean;
  isDefault: boolean;
  colors: { name: string; value: string }[];
  fonts: { role: string; family: string; fallback: string }[];
  radii: string;
  spacing: string;
  voice: string;
  components: string;
  sourceNotes: string;
  createdAt: number;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  speakerNotes: boolean;
  html: string;
  files: DesignFile[];
  activeFile: string;
  tweaks: Tweak[];
  messages: ChatMessage[];
  comments: PinComment[];
  versions: Version[];
  systemId: string | null;
  share: ShareAccess;
  model: ModelId;
  thumbnail?: string;
  createdAt: number;
  updatedAt: number;
};

export type WizardPrefs = {
  style?: string;
  color?: string;
  density?: string;
};
