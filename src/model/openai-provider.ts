import OpenAI from "openai";
import type {
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";
import type { ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelRequest, ModelResponse, ModelUsage, ToolCall } from "../core/agent-types.js";
import {
  encodeReplayItems,
  mapMessagesToOpenAI,
  mapMessagesToOpenAIResponses,
  mapToolsToOpenAI,
  mapToolsToOpenAIResponses,
} from "./message-mapper.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** The catalog id sessions lock to; becomes `name`. */
  providerName: string;
  acceptsImages: boolean;
  contextWindowTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  baseURL?: string;
}

export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly acceptsImages: boolean;
  readonly contextWindowTokens: number;
  private client: OpenAI;
  private model: string;
  private reasoningEffort: "low" | "medium" | "high";

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.model = options.model;
    this.name = options.providerName;
    this.acceptsImages = options.acceptsImages;
    this.contextWindowTokens = options.contextWindowTokens ?? 400_000;
    this.reasoningEffort = options.reasoningEffort ?? "high";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: mapMessagesToOpenAIResponses(request.messages, { acceptsImages: this.acceptsImages }),
        tools: request.tools?.length ? mapToolsToOpenAIResponses(request.tools) : undefined,
        reasoning: { effort: this.reasoningEffort, summary: "auto" },
      }, { signal: request.signal });

      const toolCalls = extractResponsesToolCalls(response.output);
      return {
        content: response.output_text || null,
        toolCalls,
        stopReason: toolCalls.length > 0 ? "tool_call" : "final",
        // Reasoning items must travel with the function calls they preceded.
        reasoningContent: encodeReplayItems(extractReasoningItems(response.output)),
        usage: mapResponsesUsage(response.usage),
      };
    } catch (error) {
      if (!isResponsesUnavailableError(error)) throw error;
      return this.generateChatFallback(request);
    }
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let stream;
    try {
      stream = await this.client.responses.create({
        model: this.model,
        input: mapMessagesToOpenAIResponses(request.messages, { acceptsImages: this.acceptsImages }),
        tools: request.tools?.length ? mapToolsToOpenAIResponses(request.tools) : undefined,
        reasoning: { effort: this.reasoningEffort, summary: "auto" },
        stream: true,
      }, { signal: request.signal });
    } catch (error) {
      if (!isResponsesUnavailableError(error)) throw error;
      yield* this.generateChatStreamFallback(request);
      return;
    }

    const completedToolCalls = new Map<string, ToolCall>();
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "token_delta", text: event.delta };
          break;

        case "response.reasoning_summary_text.delta":
          if (event.delta) yield { type: "reasoning_delta", text: event.delta };
          break;

        case "response.output_item.done":
          if (event.item.type === "function_call") {
            completedToolCalls.set(event.item.call_id, toToolCall(event.item));
          }
          break;

        case "response.completed": {
          const toolCalls = extractResponsesToolCalls(event.response.output);
          if (toolCalls.length > 0) yield { type: "tool_calls", toolCalls };
          const usage = mapResponsesUsage(event.response.usage);
          if (usage) yield { type: "usage", usage };
          yield {
            type: "done",
            reasoningContent: encodeReplayItems(extractReasoningItems(event.response.output)),
            stopReason: toolCalls.length > 0 ? "tool_call" : "final",
          };
          return;
        }

        case "response.incomplete": {
          const toolCalls = extractResponsesToolCalls(event.response.output);
          if (toolCalls.length > 0) yield { type: "tool_calls", toolCalls };
          yield { type: "done", stopReason: toolCalls.length > 0 ? "tool_call" : "length" };
          return;
        }

        case "response.failed":
          yield { type: "error", error: event.response.error?.message ?? "OpenAI 响应失败。" };
          return;

        case "error":
          yield { type: "error", error: event.message || "OpenAI 流式响应失败。" };
          return;
      }
    }

    yield { type: "error", error: "模型连接提前结束，未收到完整回答的结束标记。请重试。" };
  }

  private async generateChatFallback(request: ModelRequest): Promise<ModelResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: mapMessagesToOpenAI(request.messages, { acceptsImages: this.acceptsImages }),
      tools: request.tools?.length ? mapToolsToOpenAI(request.tools) : undefined,
      reasoning_effort: this.reasoningEffort,
    }, { signal: request.signal });
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("OpenAI 未返回消息内容。");
    const toolCalls = (message.tool_calls ?? [])
      .filter(isFunctionToolCall)
      .map((toolCall) => ({ id: toolCall.id, name: toolCall.function.name, input: parseToolArguments(toolCall.function.arguments) }));
    return {
      content: message.content ?? null,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_call" : "final",
      usage: mapChatUsage(completion.usage),
    };
  }

  private async *generateChatStreamFallback(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: mapMessagesToOpenAI(request.messages, { acceptsImages: this.acceptsImages }),
      tools: request.tools?.length ? mapToolsToOpenAI(request.tools) : undefined,
      reasoning_effort: this.reasoningEffort,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: request.signal });
    const accumulators: Array<{ id: string; name: string; arguments: string }> = [];
    let finished = false;
    for await (const chunk of stream) {
      if (chunk.usage) {
        const usage = mapChatUsage(chunk.usage);
        if (usage) yield { type: "usage", usage };
      }
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: "token_delta", text: delta.content };
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index;
        accumulators[index] ??= { id: "", name: "", arguments: "" };
        if (fragment.id) accumulators[index].id = fragment.id;
        if (fragment.function?.name) accumulators[index].name += fragment.function.name;
        if (fragment.function?.arguments) accumulators[index].arguments += fragment.function.arguments;
      }
      if (choice?.finish_reason) finished = true;
    }
    if (!finished) {
      yield { type: "error", error: "模型连接提前结束，未收到完整回答的结束标记。请重试。" };
      return;
    }
    const toolCalls = accumulators
      .filter((item) => item?.id)
      .map((item) => ({ id: item.id, name: item.name, input: parseToolArguments(item.arguments) }));
    if (toolCalls.length > 0) yield { type: "tool_calls", toolCalls };
    yield { type: "done", stopReason: toolCalls.length > 0 ? "tool_call" : "final" };
  }
}

function extractResponsesToolCalls(output: ResponseOutputItem[]): ToolCall[] {
  return output.filter((item) => item.type === "function_call").map(toToolCall);
}

function toToolCall(item: Extract<ResponseOutputItem, { type: "function_call" }>): ToolCall {
  return { id: item.call_id, name: item.name, input: parseToolArguments(item.arguments) };
}

function extractReasoningItems(output: ResponseOutputItem[]): ResponseReasoningItem[] {
  return output.filter((item): item is ResponseReasoningItem => item.type === "reasoning");
}

function mapResponsesUsage(usage: Response["usage"] | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.total_tokens || promptTokens + completionTokens),
    promptCacheHitTokens: cached || undefined,
    promptCacheMissTokens: (promptTokens - cached) || undefined,
  };
}

function mapChatUsage(usage: OpenAI.Completions.CompletionUsage | null | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: Number(usage.prompt_tokens || 0),
    completionTokens: Number(usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
  };
}

function isResponsesUnavailableError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  if (status === 404 || status === 405 || status === 501) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:responses api|\/v1\/responses).*(?:not found|not supported|unsupported|not implemented)/i.test(message)
    || /(?:not found|not supported|unsupported|not implemented).*(?:responses api|\/v1\/responses)/i.test(message);
}

function isFunctionToolCall(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): toolCall is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
  return toolCall.type === "function";
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Kept as a type-only reference so the Responses input shape stays visible to
// readers of this file; the mapper owns the conversion.
export type { ResponseInputItem as OpenAIResponsesInputItem };
