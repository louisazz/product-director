import type { AgentMessage, AttachmentRef, ToolDefinition } from "../core/agent-types.js";
import type OpenAI from "openai";
import type {
  FunctionTool as OpenAIResponsesTool,
  ResponseInputItem as OpenAIResponsesInputItem,
} from "openai/resources/responses/responses";

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAITool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface MessageMapOptions {
  /** When false, images are replaced by a text placeholder instead of image blocks. */
  acceptsImages?: boolean;
}

/**
 * Vendor-neutral pieces of a user message. Each provider turns these into its
 * own content-block shape, so the attachment rules (labels, PDF pages, size
 * limits) live in one place.
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export function mapMessagesToOpenAI(messages: AgentMessage[], options?: MessageMapOptions): OpenAIMessage[] {
  return messages.map((message) => toOpenAIMessage(message, options));
}

export function mapToolsToOpenAI(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}

/** Map the agent's persisted message history to the Responses API item format. */
export function mapMessagesToOpenAIResponses(messages: AgentMessage[], options?: MessageMapOptions): OpenAIResponsesInputItem[] {
  return messages.flatMap((message) => toOpenAIResponsesItems(message, options));
}

/** Responses function tools are flat; Chat Completions nests them under `function`. */
export function mapToolsToOpenAIResponses(tools: ToolDefinition[]): OpenAIResponsesTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // Workspace tools use permissive JSON schemas; strict validation would reject them.
    strict: false,
  }));
}

/**
 * Builds a user turn for any provider: a plain string when there is nothing to
 * show as an image (no attachments, or a blind model), otherwise ordered parts.
 */
export function buildUserContent(msg: AgentMessage, options?: MessageMapOptions): string | UserContentPart[] {
  const attachments = msg.attachments || [];
  const readableContent = renderAttachmentDirectives(msg.content, attachments);
  if (!attachments.length) return readableContent;
  if (!options?.acceptsImages) {
    const labels = attachments.map((item) => formatTextOnlyAttachment(item)).join("\n\n");
    return [readableContent, labels].filter(Boolean).join("\n\n");
  }
  const parts: UserContentPart[] = [];
  if (readableContent) parts.push({ type: "text", text: readableContent });
  for (const attachment of attachments) {
    const label = attachment.label || (attachment.mimeType.startsWith("image/") ? "图片" : "文件");
    parts.push({ type: "text", text: `[${attachmentModelLabel(attachment, label)}：${attachment.name}]` });
    if (attachment.mimeType.startsWith("image/") && attachment.dataUrl) {
      parts.push({ type: "image", dataUrl: attachment.dataUrl });
    } else if (attachment.mimeType === "application/pdf") {
      if (attachment.extractedText) parts.push({ type: "text", text: attachment.extractedText });
      for (const page of attachment.pages || []) {
        parts.push({ type: "text", text: `[${label} 第${page.page}页页面图]` });
        if (page.dataUrl) parts.push({ type: "image", dataUrl: page.dataUrl });
      }
      if ((attachment.pageCount || 0) > (attachment.pages?.length || 0)) {
        parts.push({ type: "text", text: `[${label} 共 ${attachment.pageCount} 页；本次已读取全文文字，并载入前 ${attachment.pages?.length || 0} 页页面图。]` });
      }
    } else if (attachment.extractedText) {
      parts.push({ type: "text", text: attachment.extractedText });
    } else if (attachment.oversized) {
      parts.push({
        type: "text",
        text: `[图片 ${attachment.name} 尺寸超出接口上限（单边最多 8192 px），本轮无法读取。需要看这张图时，请让用户分段裁切后重新发送。]`,
      });
    } else {
      parts.push({ type: "text", text: `[文件附件暂时无法读取：${attachment.name}]` });
    }
  }
  return parts;
}

function toOpenAIMessage(msg: AgentMessage, options?: MessageMapOptions): OpenAIMessage {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };

    case "user": {
      const content = buildUserContent(msg, options);
      if (typeof content === "string") return { role: "user", content };
      const blocks = content.map((part) => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: part.dataUrl, detail: "auto" } });
      return { role: "user", content: blocks } as unknown as OpenAIMessage;
    }

    case "assistant": {
      const base: Record<string, unknown> = {
        role: "assistant",
        // DeepSeek thinking-mode tool turns require a non-null assistant
        // content field even when the protocol intentionally leaves it empty.
        content: msg.toolCalls?.length ? msg.content : msg.content || null,
      };

      // DeepSeek reasoning_content must be passed back in subsequent turns.
      // Other vendors store structured replay data here; it is not theirs.
      if (msg.reasoningContent && !looksLikeStructuredReplay(msg.reasoningContent)) {
        base.reasoning_content = msg.reasoningContent;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          },
        }));
      }

      return base as unknown as OpenAIMessage;
    }

    case "tool":
      return {
        role: "tool",
        tool_call_id: msg.toolCallId || "",
        content: msg.content,
      };
  }
}

function toOpenAIResponsesItems(msg: AgentMessage, options?: MessageMapOptions): OpenAIResponsesInputItem[] {
  switch (msg.role) {
    case "system":
      return [{ role: "system", content: msg.content }];

    case "user": {
      const content = buildUserContent(msg, options);
      if (typeof content === "string") return [{ role: "user", content }];
      const blocks = content.map((part) => part.type === "text"
        ? { type: "input_text", text: part.text }
        : { type: "input_image", image_url: part.dataUrl, detail: "auto" });
      return [{ role: "user", content: blocks } as unknown as OpenAIResponsesInputItem];
    }

    case "assistant": {
      const items: OpenAIResponsesInputItem[] = [];
      if (msg.content) items.push({ role: "assistant", content: msg.content });
      // Responses requires the reasoning items that preceded a function call to
      // be replayed with it; the provider stored them on the message.
      if (msg.toolCalls?.length) {
        for (const item of decodeOpenAIReasoningItems(msg.reasoningContent)) {
          items.push(item as unknown as OpenAIResponsesInputItem);
        }
      }
      for (const toolCall of msg.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input ?? {}),
        });
      }
      // Preserve a genuinely empty assistant turn, but do not add a redundant
      // empty message before function-call items.
      if (items.length === 0) items.push({ role: "assistant", content: "" });
      return items;
    }

    case "tool":
      return [{
        type: "function_call_output",
        call_id: msg.toolCallId || "",
        output: msg.content,
      }];
  }
}

/**
 * Anthropic and OpenAI keep per-turn reasoning as structured blocks that must
 * be echoed back verbatim. They are stored on `reasoningContent` as JSON so the
 * session schema stays unchanged; DeepSeek's plain text never parses this way.
 */
export function looksLikeStructuredReplay(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

export function encodeReplayItems(items: unknown[]): string | undefined {
  return items.length ? JSON.stringify(items) : undefined;
}

export function decodeReplayItems(value: string | undefined, accept: (item: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  if (!value || !looksLikeStructuredReplay(value)) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && accept(item as Record<string, unknown>));
  } catch {
    return [];
  }
}

function decodeOpenAIReasoningItems(value: string | undefined): Record<string, unknown>[] {
  return decodeReplayItems(value, (item) => item.type === "reasoning" && typeof item.id === "string");
}

/** Keep editor serialization out of model prompts while retaining a clear label reference. */
export function renderAttachmentDirectives(content: string, attachments: AttachmentRef[] = []): string {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return content.replace(/:(attachment|session-attachment|project-attachment)\[([^\]]+)\](?:\{name=([^}]+)\})?/g, (_match, type: string, serializedLabel: string, id?: string) => {
    const attachment = id ? byId.get(id) : undefined;
    const prefix = type === "project-attachment" ? "@@@" : type === "session-attachment" ? "@@" : "@";
    if (!attachment) return `${prefix}${serializedLabel}`;
    return `${prefix}${attachmentModelLabel(attachment, attachment.label || serializedLabel)}`;
  });
}

function formatTextOnlyAttachment(attachment: AttachmentRef): string {
  const label = attachment.label || (attachment.mimeType.startsWith("image/") ? "图片" : "文件");
  const displayLabel = attachmentModelLabel(attachment, label);
  if (attachment.extractedText) return `[${displayLabel}：${attachment.name}]\n${attachment.extractedText}`;
  if (attachment.mimeType.startsWith("image/")) return `[${displayLabel}：${attachment.name}；当前模型无法读取图片内容]`;
  return `[${displayLabel}：${attachment.name}；当前模型暂时无法读取该文件]`;
}

function attachmentModelLabel(attachment: AttachmentRef, label: string): string {
  if (!attachment.referenceScope) return label;
  return `${label}，来自对话“${attachment.sourceSessionTitle || "来源不可用"}”`;
}

function toOpenAITool(td: ToolDefinition): OpenAITool {
  return {
    type: "function",
    function: {
      name: td.name,
      description: td.description,
      parameters: td.inputSchema as Record<string, unknown>,
    },
  };
}
