import type { ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelRequest, ModelResponse, AgentMessage } from "../core/agent-types.js";

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const lastUserMsg = findLastUserMessage(request.messages);
    const userText = lastUserMsg?.content.slice(0, 200) ?? "(no user input)";

    return {
      content: this.buildContent(userText, request),
      toolCalls: [],
      stopReason: "final",
    };
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const lastUserMsg = findLastUserMessage(request.messages);
    const userText = lastUserMsg?.content.slice(0, 200) ?? "(no user input)";
    const text = this.buildContent(userText, request);

    // Simulate token-by-token output
    for (let i = 0; i < text.length; i += 3) {
      yield { type: "token_delta", text: text.slice(i, i + 3) };
      await sleep(2);
    }
    yield { type: "done" };
  }

  private buildContent(userText: string, _request: ModelRequest): string {
    return [
      `这是 mock agent response。`,
      ``,
      `已收到你的问题：`,
      `"${userText}"`,
      ``,
      `当前可用工具：${_request.tools?.length ?? 0} 个（MockModelProvider 不会调用它们）。`,
      ``,
      `如需验证工具调用闭环：npm run smoke:tools`,
      `如需验证 DeepSeek：设置 DEEPSEEK_API_KEY 后运行 npm run smoke:deepseek`,
    ].join("\n");
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLastUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i];
    }
  }
  return undefined;
}
