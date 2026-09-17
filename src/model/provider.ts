import type { ModelRequest, ModelResponse, ModelUsage, ToolCall } from "../core/agent-types.js";

export interface ModelStreamEvent {
  type: "token_delta" | "tool_call_delta" | "tool_calls" | "done" | "error" | "reasoning_delta" | "usage";
  text?: string;
  toolCalls?: ToolCall[];
  toolCallIndex?: number;
  toolCallId?: string;
  /** Accumulated function name at this point in the stream. */
  toolName?: string;
  /** Accumulated raw JSON arguments at this point in the stream. */
  toolArguments?: string;
  error?: string;
  reasoningContent?: string;
  usage?: ModelUsage;
  stopReason?: ModelResponse["stopReason"];
}

export interface ModelProvider {
  readonly name: string;
  readonly contextWindowTokens?: number;
  generate(request: ModelRequest): Promise<ModelResponse>;
  generateStream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /** Convert texts to vector embeddings for semantic search. Optional — fallback to keyword if absent. */
  embed?(texts: string[]): Promise<number[][]>;
}
