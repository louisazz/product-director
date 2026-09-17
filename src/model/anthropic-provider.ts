import type { ModelProvider, ModelStreamEvent } from "./provider.js";
import type { AgentMessage, ModelRequest, ModelResponse, ModelUsage, ToolCall, ToolDefinition } from "../core/agent-types.js";
import { buildUserContent, decodeReplayItems, encodeReplayItems } from "./message-mapper.js";

// Streaming lets a long answer run without tripping HTTP timeouts, so the cap
// can be generous; callers may still override it per request.
const DEFAULT_MAX_TOKENS = 64_000;
const API_VERSION = "2023-06-01";
// A classifier decline is re-run on Anthropic's recommended substitute inside
// the same call instead of coming back as an empty answer. The header and the
// `fallbacks: "default"` body form belong together.
const BETA_FEATURES = "server-side-fallback-2026-07-01";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** The catalog id sessions lock to; becomes `name`. */
  providerName: string;
  acceptsImages: boolean;
  contextWindowTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  baseURL?: string;
  maxTokens?: number;
}

type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

type InputBlock =
  | ThinkingBlock
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | InputBlock[];
}

interface ResponseBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface MessagesResponse {
  content?: ResponseBlock[];
  stop_reason?: string | null;
  usage?: RawUsage;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

class AnthropicApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly acceptsImages: boolean;
  readonly contextWindowTokens: number;
  private apiKey: string;
  private model: string;
  private baseURL: string;
  private maxTokens: number;
  private reasoningEffort: "low" | "medium" | "high";

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.name = options.providerName;
    this.acceptsImages = options.acceptsImages;
    this.contextWindowTokens = options.contextWindowTokens ?? 1_000_000;
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.reasoningEffort = options.reasoningEffort ?? "high";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.requestMessages(request, false);
    const payload = await response.json() as MessagesResponse;
    const blocks = payload.content ?? [];
    const text = blocks.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n");
    const thinkingBlocks = blocks.map(toThinkingBlock).filter((block): block is ThinkingBlock => Boolean(block));
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === "tool_use" && block.id && block.name)
      .map((block) => ({ id: block.id!, name: block.name!, input: block.input ?? {} }));

    return {
      content: text || (payload.stop_reason === "refusal" ? "Claude 拒绝了这项请求。" : null),
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_call" : mapStopReason(payload.stop_reason),
      reasoningContent: encodeReplayItems(thinkingBlocks),
      usage: mapUsage(payload.usage),
    };
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.requestMessages(request, true);
    if (!response.body) throw new Error("Anthropic 流式响应为空。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopReason: string | undefined;
    let sawText = false;
    let sawStop = false;
    const usage: RawUsage = {};
    // Thinking blocks come back with a signature and have to be echoed on the
    // next request of the same turn, so they are collected in block order.
    const thinkingByIndex = new Map<number, ThinkingBlock>();
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string; initialInput: Record<string, unknown> }>();

    const handle = (event: Record<string, unknown>): ModelStreamEvent[] => {
      const out: ModelStreamEvent[] = [];
      switch (event.type) {
        case "error": {
          const error = event.error as { message?: string } | undefined;
          throw new Error(error?.message ?? "Anthropic 流式请求失败。");
        }
        case "message_start": {
          const message = event.message as { usage?: RawUsage } | undefined;
          Object.assign(usage, message?.usage ?? {});
          break;
        }
        case "content_block_start": {
          const index = Number(event.index ?? 0);
          const block = event.content_block as ResponseBlock | undefined;
          if (block?.type === "tool_use") {
            toolCallsByIndex.set(index, { id: block.id ?? "", name: block.name ?? "", arguments: "", initialInput: block.input ?? {} });
          } else if (block?.type === "thinking") {
            thinkingByIndex.set(index, { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
          } else if (block?.type === "redacted_thinking" && block.data) {
            thinkingByIndex.set(index, { type: "redacted_thinking", data: block.data });
          }
          break;
        }
        case "content_block_delta": {
          const index = Number(event.index ?? 0);
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            sawText = true;
            out.push({ type: "token_delta", text: delta.text });
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            const block = thinkingByIndex.get(index);
            if (block?.type === "thinking") block.thinking += delta.thinking;
            if (delta.thinking) out.push({ type: "reasoning_delta", text: delta.thinking });
          } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
            const block = thinkingByIndex.get(index);
            if (block?.type === "thinking") block.signature += delta.signature;
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const accumulator = toolCallsByIndex.get(index);
            if (accumulator) accumulator.arguments += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as { stop_reason?: string } | undefined;
          stopReason = delta?.stop_reason ?? stopReason;
          Object.assign(usage, (event.usage as RawUsage | undefined) ?? {});
          sawStop = true;
          break;
        }
      }
      return out;
    };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseEvent(rawEvent);
        if (event) yield* handle(event);
      }
    }
    if (buffer.trim()) {
      const finalEvent = parseSseEvent(buffer);
      if (finalEvent) yield* handle(finalEvent);
    }

    if (!sawStop) {
      yield { type: "error", error: "模型连接提前结束，未收到完整回答的结束标记。请重试。" };
      return;
    }

    const toolCalls = [...toolCallsByIndex.values()]
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name, input: item.arguments ? parseToolArguments(item.arguments) : item.initialInput }));
    if (toolCalls.length > 0) yield { type: "tool_calls", toolCalls };
    if (stopReason === "refusal" && !sawText) yield { type: "token_delta", text: "Claude 拒绝了这项请求。" };
    const mapped = mapUsage(usage);
    if (mapped) yield { type: "usage", usage: mapped };
    const thinkingBlocks = [...thinkingByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
    yield {
      type: "done",
      reasoningContent: encodeReplayItems(thinkingBlocks),
      stopReason: toolCalls.length > 0 ? "tool_call" : mapStopReason(stopReason),
    };
  }

  /**
   * Thinking blocks are bound to the exact history that produced them. This
   * harness trims old tool results and folds runtime notes into the system
   * prompt, so on an account that enforces the binding the replay can be
   * rejected; the documented recovery is to strip the blocks and retry once.
   */
  private async requestMessages(request: ModelRequest, stream: boolean): Promise<Response> {
    try {
      return await this.callMessages(request, stream, true);
    } catch (error) {
      if (error instanceof AnthropicApiError && error.status === 400 && /thinking|signature/i.test(error.message)) {
        return this.callMessages(request, stream, false);
      }
      throw error;
    }
  }

  private async callMessages(request: ModelRequest, stream: boolean, replayThinking: boolean): Promise<Response> {
    const mapped = mapMessagesToAnthropic(request.messages, { acceptsImages: this.acceptsImages, replayThinking });
    const maxTokens = (request.settings?.maxTokens as number | undefined) ?? this.maxTokens;
    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-beta": BETA_FEATURES,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system: mapped.system || undefined,
        messages: mapped.messages,
        tools: request.tools?.length ? mapToolsToAnthropic(request.tools) : undefined,
        // Adaptive thinking is the only mode on the Claude 5 family; the
        // summarized display is what lets the reasoning panel show anything.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: this.reasoningEffort },
        fallbacks: "default",
        stream,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      let message = detail;
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } };
        message = parsed.error?.message ?? detail;
      } catch {
        // Keep the response text as the useful error detail.
      }
      throw new AnthropicApiError(response.status, `Anthropic API ${response.status}: ${message || response.statusText}`);
    }
    return response;
  }
}

export function mapMessagesToAnthropic(
  messages: AgentMessage[],
  options: { acceptsImages: boolean; replayThinking: boolean },
): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const mapped: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      continue;
    }

    if (message.role === "user") {
      const content = buildUserContent(message, { acceptsImages: options.acceptsImages });
      if (typeof content === "string") {
        if (content.trim()) mapped.push({ role: "user", content });
        continue;
      }
      const blocks = content.flatMap((part): InputBlock[] => {
        if (part.type === "text") return part.text.trim() ? [{ type: "text", text: part.text }] : [];
        const image = parseDataUrl(part.dataUrl);
        return image ? [{ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }] : [];
      });
      if (blocks.length) mapped.push({ role: "user", content: blocks });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: InputBlock[] = [];
      if (options.replayThinking && message.toolCalls?.length) blocks.push(...decodeThinkingBlocks(message.reasoningContent));
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const toolCall of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.input ?? {} });
      }
      // An empty assistant turn is rejected by the API; dropping it leaves two
      // consecutive user turns, which the API merges.
      if (blocks.length) mapped.push({ role: "assistant", content: blocks });
      continue;
    }

    const toolResult: InputBlock = { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content };
    const previous = mapped[mapped.length - 1];
    if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((block) => block.type === "tool_result")) {
      previous.content.push(toolResult);
    } else {
      mapped.push({ role: "user", content: [toolResult] });
    }
  }

  return { system: system.join("\n\n"), messages: mapped };
}

function decodeThinkingBlocks(value: string | undefined): ThinkingBlock[] {
  return decodeReplayItems(value, (item) =>
    (item.type === "thinking" && typeof item.signature === "string" && typeof item.thinking === "string")
    || (item.type === "redacted_thinking" && typeof item.data === "string")) as ThinkingBlock[];
}

function toThinkingBlock(block: ResponseBlock): ThinkingBlock | undefined {
  if (block.type === "thinking" && typeof block.signature === "string") {
    return { type: "thinking", thinking: block.thinking ?? "", signature: block.signature };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data };
  }
  return undefined;
}

/** Anthropic takes raw base64 plus a media type, not a data URL. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function mapToolsToAnthropic(tools: ToolDefinition[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}

function mapStopReason(reason: string | null | undefined): ModelResponse["stopReason"] {
  if (reason === "tool_use") return "tool_call";
  if (reason === "max_tokens") return "length";
  return "final";
}

function mapUsage(usage: RawUsage | undefined): ModelUsage | undefined {
  if (!usage || (!usage.input_tokens && !usage.output_tokens)) return undefined;
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const promptTokens = Number(usage.input_tokens || 0) + cacheRead + cacheCreation;
  const completionTokens = Number(usage.output_tokens || 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    promptCacheHitTokens: cacheRead || undefined,
    promptCacheMissTokens: (Number(usage.input_tokens || 0) + cacheCreation) || undefined,
  };
}

function findSseBoundary(buffer: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseEvent(rawEvent: string): Record<string, unknown> | null {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}
