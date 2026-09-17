export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ChatModelId =
  | "deepseek-v4.1-flash"
  | "deepseek-pro"
  | "deepseek-vision"
  | "claude-fable-5.1"
  | "claude-opus-5"
  | "gpt-6";

export type AttachmentKind = "image" | "file";
export type AttachmentReferenceScope = "session" | "project";

export interface AttachmentPage {
  page: number;
  relativePath?: string;
  /** Present only while building a model request. */
  dataUrl?: string;
}

export interface AttachmentRef {
  id: string;
  /** Stable identity of the physical Project file. Legacy records may omit it. */
  fileId?: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  kind?: AttachmentKind;
  /** Message-local label such as 图1 or 文件1. */
  label?: string;
  /** Explicit recall made with @@ or @@@. Fresh uploads omit this field. */
  referenceScope?: AttachmentReferenceScope;
  /** Session and turn where this file first appeared in the selected source. */
  sourceSessionId?: string;
  sourceSessionTitle?: string;
  sourceTurnIndex?: number;
  sourceCreatedAt?: string;
  pageCount?: number;
  /** Present only while building a model request; never persisted in Session JSON. */
  dataUrl?: string;
  /** Present only while building a model request; never persisted in Session JSON. */
  extractedText?: string;
  /** Present only while building a model request; never persisted in Session JSON. */
  pages?: AttachmentPage[];
  /**
   * Set while building a request when the stored image exceeds the API's
   * per-side pixel limit. Such an image cannot be sent at all, so it is
   * described in text instead of failing the whole turn with a 400.
   */
  oversized?: boolean;
}

/** Compatibility alias while older Sessions still contain image-only records. */
export type ImageAttachmentRef = AttachmentRef;

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  traceEvents?: TimelineTraceEvent[];
  modelProvider?: ChatModelId;
  attachments?: AttachmentRef[];
}

export interface TimelineTraceEvent {
  type: string;
  label: string;
  status?: "pending" | "done" | "error" | "info";
  toolName?: string;
  at: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  error?: string;
  permission?: {
    level: string;
    category: string;
    allowed: boolean;
    confirmed?: boolean;
  };
}

export interface ModelRequest {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  /** Runtime intent to require a tool; adapters may omit an unsupported wire-level field. */
  toolChoice?: "auto" | "required";
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  reasoningContent?: string;
  usage?: ModelUsage;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

export type StopReason = "final" | "tool_call" | "length" | "max_steps" | "error";

export interface AgentStep {
  index: number;
  inputMessages: AgentMessage[];
  modelResponse: ModelResponse;
  toolResults: ToolResult[];
  stopReason: StopReason;
}

export interface AgentRunResult {
  messages: AgentMessage[];
  steps: AgentStep[];
  finalText: string;
  stopReason: StopReason;
  newMessages: AgentMessage[];
  workingSet?: TaskWorkingSet;
}

export interface SessionTaskState {
  schemaVersion: 4;
  lastUserInput: string;
  updatedAt: string;
  workingSet?: TaskWorkingSet;
}

export interface WorkingSetSource {
  path: string;
  lastUsedAt: string;
}

export interface TaskWorkingSet {
  version: 2;
  summary: string;
  sources: WorkingSetSource[];
  updatedAt: string;
}

/** Minimal state for Claude Code-style conversation compaction. */
export interface SessionContextState {
  version: 1;
  summary: string;
  compactedThroughMessageId?: string;
  compactionCount: number;
  lastPromptTokens?: number;
  updatedAt: string;
}

export interface AgentObserver {
  onStart?(): void;
  onStatus?(message: string): void;
  /** A user-visible answer is about to stream. */
  onAnswerStart?(): void;
  /** A user-visible final-answer token that belongs in the answer bubble. */
  onAnswerToken?(text: string): void;
  /** The streamed answer is complete. `onFinal` remains the authoritative persisted result. */
  onAnswerEnd?(text: string): void;
  /** Optimistic answer text turned out to precede a tool call and must leave the answer bubble. */
  onAnswerAbort?(): void;
  /** @deprecated Use onAnswerToken for user-visible final answer streaming. */
  onToken?(text: string): void;
  onModelStep?(stepIndex: number, stopReason: string, contentPreview: string): void;
  onToolCall?(toolCall: { id?: string; name: string; input: Record<string, unknown> }): void;
  onToolResult?(result: { toolCallId?: string; name: string; ok: boolean; contentPreview: string }): void;
  onFinal?(text: string): void;
  /** Ordinary assistant text emitted before tool calls. */
  onAssistantText?(text: string): void;
  onReasoningToken?(text: string): void;
  /** A model API call is about to begin — frontend creates a Thinking node */
  onThinkingStart?(phase: string): void;
  /** A model API call has completed — frontend finalizes the Thinking node timing */
  onThinkingEnd?(phase: string): void;
  /** Discard the latest thinking block when a provider returned no user-visible answer and the step will be retried. */
  onThinkingDiscard?(phase: string): void;
}

// ─── Turn-based session replay ──────────────────────────────────────────

/** A single timeline event, stored for deterministic replay. */
export interface TurnEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

/** A user's precise comment on a completed answer in this Session. */
export interface ConversationAnnotation {
  id: string;
  sourceTurnIndex: number;
  sourceKind: "answer";
  selectedText: string;
  comment: string;
}

/** One turn = one user message → agent response cycle. */
export interface AgentTurn {
  userContent: string;
  userAnnotations?: ConversationAnnotation[];
  modelProvider?: ChatModelId;
  userAttachments?: AttachmentRef[];
  events: TurnEvent[];
  status: "running" | "completed" | "stopped" | "error";
  finalAnswer?: string;
  answerHtml?: string;
  /** Partial answer captured by frontend at stop time — not from post-stop background generation. */
  partialAnswerText?: string;
  stoppedAt?: string;
  resumeSnapshot?: {
    stoppedAt: string;
    previousUserGoal: string;
    partialAnswerText?: string;
  };
}
