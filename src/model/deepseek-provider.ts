import OpenAI from "openai";
import type { ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../core/agent-types.js";
import { mapMessagesToOpenAI, mapToolsToOpenAI } from "./message-mapper.js";

// DeepSeek's API default can be too small once thinking tokens and the visible
// answer share the same output budget. Keep enough room for a design analysis;
// callers can still override this per request.
const DEFAULT_MAX_TOKENS = 32_768;

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  providerName?: string;
  acceptsImages?: boolean;
  embeddingModel?: string;
}

export class DeepSeekProvider implements ModelProvider {
  readonly name: string;
  readonly contextWindowTokens = 1_000_000;
  readonly acceptsImages: boolean;
  private client: OpenAI;
  private model: string;
  private embeddingModel: string;

  constructor(options: DeepSeekProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com",
    });
    this.model = options.model ?? "deepseek-v4-pro";
    this.acceptsImages = options.acceptsImages ?? [
      "deepseek-flash",
      "deepseek-v4-flash-vision-exp",
    ].includes(this.model);
    this.name = options.providerName ?? (this.acceptsImages ? "deepseek-vision" : "deepseek-pro");
    this.embeddingModel = options.embeddingModel ?? "deepseek-embed";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const messages = mapMessagesToOpenAI(request.messages, { acceptsImages: this.acceptsImages });
    const tools = request.tools && request.tools.length > 0
      ? mapToolsToOpenAI(request.tools)
      : undefined;

    const maxTokens = (request.settings?.maxTokens as number | undefined) ?? DEFAULT_MAX_TOKENS;
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      // DeepSeek V4 thinking mode supports tools but rejects tool_choice.
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }, { signal: request.signal });

    const choice = completion.choices[0];
    const message = choice.message;

    const content = message.content ?? null;

    // DeepSeek thinking mode returns reasoning_content that MUST be
    // passed back in subsequent assistant messages.
    const reasoningContent = (message as unknown as Record<string, unknown>).reasoning_content as string | undefined;

    let toolCalls: ToolCall[] = [];
    if (message.tool_calls && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls
        .filter(isFunctionToolCall)
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
        }));
    }

    const stopReason = toolCalls.length > 0
      ? "tool_call"
      : mapFinishReason(choice.finish_reason);

    return { content, toolCalls, stopReason, reasoningContent, usage: mapUsage(completion.usage) };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const resp = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: texts,
    });
    return resp.data.map((d) => d.embedding);
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const messages = mapMessagesToOpenAI(request.messages, { acceptsImages: this.acceptsImages });
    const tools = request.tools && request.tools.length > 0
      ? mapToolsToOpenAI(request.tools)
      : undefined;

    const maxTokens = (request.settings?.maxTokens as number | undefined) ?? DEFAULT_MAX_TOKENS;
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }, { signal: request.signal });

    let accumulatedContent = "";
    let accumulatedReasoning = "";
    const toolCallAccumulators: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];
    let streamStopReason: ModelResponse["stopReason"] = "final";
    let receivedFinishReason = false;

    for await (const chunk of stream) {
      if (chunk.usage) yield { type: "usage", usage: mapUsage(chunk.usage) };
      const delta = chunk.choices[0]?.delta;
      const deltaRaw = delta as unknown as Record<string, unknown> | undefined;

      // Reasoning content (DeepSeek thinking mode) — stream in real-time
      if (deltaRaw?.reasoning_content) {
        const reasoningChunk = String(deltaRaw.reasoning_content);
        accumulatedReasoning += reasoningChunk;
        yield { type: "reasoning_delta", text: reasoningChunk };
      }

      // Text content delta
      if (delta?.content) {
        accumulatedContent += delta.content;
        yield { type: "token_delta", text: delta.content };
      }

      // Tool call fragments (may arrive across multiple chunks)
      if (delta?.tool_calls) {
        for (const tcFragment of delta.tool_calls) {
          const idx = tcFragment.index;
          if (!toolCallAccumulators[idx]) {
            toolCallAccumulators[idx] = { id: tcFragment.id || "", name: "", arguments: "" };
          }
          const acc = toolCallAccumulators[idx];
          if (tcFragment.id) acc.id = tcFragment.id;
          if (tcFragment.function?.name) acc.name += tcFragment.function.name;
          if (tcFragment.function?.arguments) acc.arguments += tcFragment.function.arguments;
          yield {
            type: "tool_call_delta",
            toolCallIndex: idx,
            toolCallId: acc.id,
            toolName: acc.name,
            toolArguments: acc.arguments,
          };
        }
      }

      // Finish reason
      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason) {
        receivedFinishReason = true;
        streamStopReason = mapFinishReason(finishReason);
      }
      if (finishReason === "tool_calls") {
        const finalToolCalls: ToolCall[] = toolCallAccumulators
          .filter((a) => a.id)
          .map((a) => ({
            id: a.id,
            name: a.name,
            input: parseToolArguments(a.arguments),
          }));
        yield { type: "tool_calls", toolCalls: finalToolCalls };
      }
    }

    if (!receivedFinishReason) {
      yield { type: "error", error: "模型连接提前结束，未收到完整回答的结束标记。请重试。" };
      return;
    }
    yield { type: "done", reasoningContent: accumulatedReasoning || undefined, stopReason: streamStopReason };
  }
}

function mapFinishReason(reason: string | null | undefined): ModelResponse["stopReason"] {
  if (reason === "tool_calls" || reason === "function_call") return "tool_call";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "error";
  return "final";
}

function mapUsage(usage: OpenAI.Completions.CompletionUsage | null | undefined) {
  if (!usage) return undefined;
  const raw = usage as unknown as Record<string, any>;
  return {
    promptTokens: Number(usage.prompt_tokens || 0),
    completionTokens: Number(usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    promptCacheHitTokens: Number(raw.prompt_cache_hit_tokens || 0) || undefined,
    promptCacheMissTokens: Number(raw.prompt_cache_miss_tokens || 0) || undefined,
  };
}

function isFunctionToolCall(
  tc: OpenAI.Chat.Completions.ChatCompletionMessageToolCall
): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
  return tc.type === "function";
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
