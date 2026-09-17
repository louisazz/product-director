export type Project = {
  id: string;
  name: string;
  description?: string;
  month: string;
  status?: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

export const PROJECT_STATUS_OPTIONS = [
  "产品规划中",
  "待启动",
  "讨论中",
  "待方案排期",
  "方案打磨中",
  "方案定稿待开发",
  "开发中",
  "走查中",
  "近期上线",
  "上线归档",
  "hold",
] as const;

export type ProjectStatus = typeof PROJECT_STATUS_OPTIONS[number];

export type ProjectFile = {
  fileId: string;
  name: string;
  mimeType: string;
  absolutePath: string;
  size: number;
  updatedAt: string;
  pageCount?: number;
};

export type SkillSummary = {
  id: string;
  title: string;
  description?: string;
};

export type SessionSummary = {
  id: string;
  kind: "chat" | "retrospective";
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  modelProvider?: ProviderName;
};

export type AttachmentPage = { page: number; relativePath?: string; dataUrl?: string };
export type AttachmentReferenceScope = "session" | "project";

export type AttachmentRef = {
  id: string;
  fileId?: string;
  name: string;
  mimeType: string;
  size: number;
  kind?: "image" | "file";
  label?: string;
  referenceScope?: AttachmentReferenceScope;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
  sourceTurnIndex?: number;
  sourceCreatedAt?: string;
  pageCount?: number;
  relativePath?: string;
  previewUrl?: string;
  dataUrl?: string;
  extractedText?: string;
  pages?: AttachmentPage[];
};

export type ImageAttachmentRef = AttachmentRef;

export type ProjectAttachmentReference = AttachmentRef & {
  referenceScope: "project";
  sourceSessionId: string;
  sourceSessionTitle: string;
  sourceTurnIndex: number;
  sourceCreatedAt: string;
};

export type TurnEvent = {
  type: string;
  data: Record<string, unknown>;
  at: string;
};

export type ConversationAnnotation = {
  id: string;
  sourceTurnIndex: number;
  sourceKind: "answer";
  selectedText: string;
  comment: string;
};

export type AgentTurn = {
  userContent: string;
  userAnnotations?: ConversationAnnotation[];
  events: TurnEvent[];
  status: "running" | "completed" | "stopped" | "error";
  finalAnswer?: string;
  partialAnswerText?: string;
  stoppedAt?: string;
  modelProvider?: ProviderName;
  userAttachments?: ImageAttachmentRef[];
};

export type LegacyMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  modelProvider?: ProviderName;
  attachments?: ImageAttachmentRef[];
};

export type AgentSession = {
  id: string;
  projectId: string;
  kind: "chat" | "retrospective";
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: LegacyMessage[];
  turns: AgentTurn[];
  modelProvider?: ProviderName;
  taskState?: {
    schemaVersion: 4;
    lastUserInput: string;
    updatedAt: string;
    workingSet?: { note: string; updatedAt: string };
  };
};

export type ProjectProgress = {
  version: 1;
  projectId: string;
  content: string;
  generatedAt: string;
  coveredSessions: Array<{ id: string; title: string; updatedAt: string }>;
};

export type ConfirmationRequest = {
  id: string;
  toolName: string;
  category: string;
  inputPreview: string;
  message: string;
};

export type StreamEvent = { type: string; data: Record<string, unknown> };

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  events?: TurnEvent[];
  status?: AgentTurn["status"];
  annotations?: ConversationAnnotation[];
  modelProvider?: ProviderName;
  attachments?: ImageAttachmentRef[];
};

export type ViewName = "files" | "chat" | "progress" | "retrospective";
/** Mirrors the server's chat model catalog ids (src/model/model-catalog.ts). */
export const PROVIDER_IDS = [
  "deepseek-v4.1-flash",
  "deepseek-pro",
  "deepseek-vision",
  "claude-fable-5.1",
  "claude-opus-5",
  "gpt-6",
] as const;
export type ProviderName = typeof PROVIDER_IDS[number];
export const DEFAULT_PROVIDER: ProviderName = "deepseek-v4.1-flash";
export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ChatModelInfo = {
  id: ProviderName;
  vendor: "deepseek" | "anthropic" | "openai";
  vendorLabel: string;
  label: string;
  description: string;
  acceptsImages: boolean;
  configured: boolean;
  legacy?: boolean;
};
export type ModelCatalog = { models: ChatModelInfo[]; defaultModel: ProviderName };
export type ApiKeyVendor = ChatModelInfo["vendor"];
export type ThemeName = "light" | "dark";
