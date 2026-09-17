import { randomUUID } from "node:crypto";
import type { ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelRequest, ModelResponse } from "../core/agent-types.js";

export interface ScriptedToolUseOptions {
  toolName?: string;
  input?: Record<string, unknown>;
}

export class ScriptedToolUseModelProvider implements ModelProvider {
  readonly name = "scripted-tool-use";
  private callCount = 0;
  private scriptedCallCount = 0;
  private options: ScriptedToolUseOptions;

  constructor(options?: ScriptedToolUseOptions) {
    this.options = options ?? {};
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    if (request.tools && request.tools.length > 0) {
      this.scriptedCallCount++;
    }
    return this.buildResponse(request);
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.callCount++;
    const response = this.buildResponse(request);

    if (response.content) {
      for (let i = 0; i < response.content.length; i += 5) {
        yield { type: "token_delta", text: response.content.slice(i, i + 5) };
        await sleep(2);
      }
    }

    if (response.toolCalls.length > 0) {
      yield { type: "tool_calls", toolCalls: response.toolCalls };
    }

    yield { type: "done" };
  }

  private buildResponse(request: ModelRequest): ModelResponse {
    // Tool-free probe call — return a lightweight result without consuming the scripted slot.
    if (!request.tools || request.tools.length === 0) {
      return {
        content: JSON.stringify({
          goal: "test",
          relation: "new",
          steps: [{ title: "执行任务", purpose: "完成用户请求" }],
        }),
        toolCalls: [],
        stopReason: "final",
      };
    }

    if (this.scriptedCallCount === 1) {
      const availableTools = request.tools ?? [];
      const preferredName = this.options.toolName ?? "glob";
      const targetTool =
        availableTools.find((t) => t.name === preferredName) ??
        availableTools[0];

      if (!targetTool) {
        return {
          content: "I have no tools to inspect the workspace.",
          toolCalls: [],
          stopReason: "final",
        };
      }

      const input =
        this.options.input ??
        (targetTool.name === "glob" ? { pattern: "docs/**/*" } : {});

      return {
        content: "Let me inspect what documents are available in the workspace.",
        toolCalls: [
          {
            id: randomUUID(),
            name: targetTool.name,
            input,
          },
        ],
        stopReason: "tool_call",
      };
    }

    const toolResults = request.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.content)
      .join("\n\n");

    return {
      content: [
        `Tool call loop verified.`,
        ``,
        `I requested a tool, received results, and am now composing a final answer.`,
        ``,
        `Tool results received:`,
        toolResults ? toolResults.slice(0, 500) : `(no tool results)`,
        ``,
        `This confirms: tool call → tool execution → result injection → final response`,
      ].join("\n"),
      toolCalls: [],
      stopReason: "final",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
