import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { runAgentLoopStream } from "../core/agent-loop.js";
import { buildWorkspaceContext } from "../core/workspace.js";
import { createPermissionManagerFromSettings } from "../permissions/index.js";
import type { AgentObserver, ModelRequest, ModelResponse } from "../core/agent-types.js";
import type { ModelProvider, ModelStreamEvent } from "../model/provider.js";
import { buildTimeline } from "../web/client/timeline.js";

class FinalStreamProvider implements ModelProvider {
  readonly name = "verify-final-stream";

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return { content: "普通最终答案", toolCalls: [], stopReason: "final" };
  }

  async *generateStream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "token_delta", text: "普通" };
    yield { type: "token_delta", text: "最终答案" };
    yield { type: "done" };
  }
}

class ForcedFinalStreamProvider implements ModelProvider {
  readonly name = "verify-forced-final-stream";
  private calls = 0;

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return { content: "unused", toolCalls: [], stopReason: "final" };
  }

  async *generateStream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: "tool_calls",
        toolCalls: [{ id: "missing-tool-call", name: "glob", input: { pattern: "docs/**/*" } }],
      };
      yield { type: "done" };
      return;
    }

    yield { type: "reasoning_delta", text: "整理已有信息" };
    yield { type: "token_delta", text: "阶段性" };
    yield { type: "token_delta", text: "总结" };
    yield { type: "done" };
  }
}

class SpeculativeToolProvider implements ModelProvider {
  readonly name = "verify-speculative-tool-stream";
  private calls = 0;

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return { content: "unused", toolCalls: [], stopReason: "final" };
  }

  async *generateStream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "token_delta", text: "这不是最终答案" };
      yield {
        type: "tool_calls",
        toolCalls: [{ id: "speculative-tool-call", name: "glob", input: { pattern: "docs/**/*" } }],
      };
      yield { type: "done" };
      return;
    }
    yield { type: "token_delta", text: "读取后的最终答案" };
    yield { type: "done" };
  }
}

class ReasoningOnlyThenFinalProvider implements ModelProvider {
  readonly name = "verify-reasoning-only-recovery";
  private calls = 0;

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return { content: "unused", toolCalls: [], stopReason: "final" };
  }

  async *generateStream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "reasoning_delta", text: "误写进 reasoning 的整篇答案" };
      yield { type: "done", reasoningContent: "误写进 reasoning 的整篇答案" };
      return;
    }
    yield { type: "reasoning_delta", text: "简短整理" };
    yield { type: "token_delta", text: "恢复后的最终答案" };
    yield { type: "done" };
  }
}

function recordingObserver(events: string[]): AgentObserver {
  return {
    onAnswerStart: () => events.push("answer_start"),
    onAnswerToken: (text) => events.push(`answer_delta:${text}`),
    onAnswerEnd: () => events.push("answer_end"),
    onAnswerAbort: () => events.push("answer_abort"),
    onAssistantText: (text) => events.push(`assistant_text:${text}`),
    onThinkingStart: () => events.push("thinking_start"),
    onThinkingEnd: () => events.push("thinking_end"),
    onThinkingDiscard: () => events.push("thinking_discard"),
    onReasoningToken: (text) => events.push(`reasoning:${text}`),
    onFinal: (text) => events.push(`final:${text}`),
  };
}

async function run(): Promise<void> {
  const workspace = buildWorkspaceContext(process.cwd());
  const permissionManager = createPermissionManagerFromSettings(workspace.settings);

  const normalEvents: string[] = [];
  const normal = await runAgentLoopStream({
    userInput: "测试普通最终输出",
    workspace,
    modelProvider: new FinalStreamProvider(),
    permissionManager,
    maxSteps: 2,
    observer: recordingObserver(normalEvents),
  });
  assert.equal(normal.finalText, "普通最终答案");
  assert.deepEqual(normalEvents, [
    "answer_start",
    "answer_delta:普通",
    "answer_delta:最终答案",
    "answer_end",
    "final:普通最终答案",
  ]);

  const forcedEvents: string[] = [];
  const forced = await runAgentLoopStream({
    userInput: "测试强制收束输出",
    workspace,
    modelProvider: new ForcedFinalStreamProvider(),
    permissionManager,
    maxSteps: 1,
    observer: recordingObserver(forcedEvents),
  });
  assert.equal(forced.finalText, "阶段性总结");
  assert.deepEqual(forcedEvents.filter((event) => !event.startsWith("reasoning:")), [
    "thinking_start",
    "thinking_end",
    "answer_start",
    "answer_delta:阶段性",
    "answer_delta:总结",
    "answer_end",
    "final:阶段性总结",
  ]);
  assert.equal(forcedEvents.filter((event) => event === "answer_start").length, 1);
  assert.equal(forcedEvents.filter((event) => event === "answer_end").length, 1);

  const speculativeEvents: string[] = [];
  const speculative = await runAgentLoopStream({
    userInput: "测试先输出正文后调用工具",
    workspace,
    modelProvider: new SpeculativeToolProvider(),
    permissionManager,
    maxSteps: 2,
    observer: recordingObserver(speculativeEvents),
  });
  assert.equal(speculative.finalText, "读取后的最终答案");
  assert.deepEqual(speculativeEvents, [
    "answer_start",
    "answer_delta:这不是最终答案",
    "assistant_text:这不是最终答案",
    "answer_abort",
    "answer_start",
    "answer_delta:读取后的最终答案",
    "answer_end",
    "final:读取后的最终答案",
  ]);

  const recoveryEvents: string[] = [];
  const recovered = await runAgentLoopStream({
    userInput: "生成正式答案",
    workspace,
    modelProvider: new ReasoningOnlyThenFinalProvider(),
    permissionManager,
    maxSteps: 3,
    observer: recordingObserver(recoveryEvents),
  });
  assert.equal(recovered.finalText, "恢复后的最终答案");
  assert.equal(recoveryEvents.filter((event) => event === "thinking_discard").length, 1);
  assert.equal(recovered.newMessages.some((message) => message.name === "__runtime"), false);

  const groupedTimeline = buildTimeline([
    { type: "attachments_loaded", data: { items: [
      { label: "图1", name: "界面.png", mimeType: "image/png", kind: "image", ok: true, detail: "原图已进入上下文" },
      { label: "文件1", name: "需求.pdf", mimeType: "application/pdf", kind: "file", ok: true, detail: "全文文字 + 3 页页面图已进入上下文" },
    ] }, at: "1" },
    { type: "thinking_start", data: { phase: "agent" }, at: "2" },
    { type: "thinking_end", data: { phase: "agent" }, at: "3" },
    { type: "tool_call", data: { toolCallId: "g1", toolName: "glob", inputPreview: JSON.stringify({ pattern: "**/*.md" }) }, at: "4" },
    { type: "tool_call", data: { toolCallId: "g2", toolName: "grep", inputPreview: JSON.stringify({ pattern: "需求" }) }, at: "5" },
    { type: "tool_result", data: { toolCallId: "g2", toolName: "grep", ok: true, contentPreview: "memory/需求偏好.md" }, at: "6" },
    { type: "tool_result", data: { toolCallId: "g1", toolName: "glob", ok: true, contentPreview: "memory/MEMORY.md\nmemory/需求偏好.md" }, at: "7" },
    { type: "thinking_start", data: { phase: "agent" }, at: "8" },
    { type: "thinking_end", data: { phase: "agent" }, at: "9" },
    { type: "tool_call", data: { toolCallId: "r1", toolName: "read", inputPreview: JSON.stringify({ file_path: "memory/a.md" }) }, at: "10" },
    { type: "tool_call", data: { toolCallId: "r2", toolName: "read", input: { file_path: "memory/b.md", offset: 21, limit: 20 }, inputPreview: "{truncated" }, at: "11" },
    { type: "tool_result", data: { toolCallId: "r1", toolName: "read", ok: true, contentPreview: "[memory/a.md lines 1-4 of 4]\n内容" }, at: "12" },
    { type: "tool_result", data: { toolCallId: "r2", toolName: "read", ok: true, contentPreview: "[memory/b.md lines 21-40 of 80]\n内容" }, at: "13" },
  ]);
  assert.deepEqual(groupedTimeline.map((entry) => entry.kind), ["attachments", "thinking", "tool_group", "thinking", "tool_group"]);
  assert.equal(groupedTimeline[0]?.kind === "attachments" ? groupedTimeline[0].label : "", "载入 1 张图片、1 个文件");
  assert.equal(groupedTimeline[2]?.kind === "tool_group" ? groupedTimeline[2].label : "", "查找 Memory · 2 次");
  assert.equal(groupedTimeline[4]?.kind === "tool_group" ? groupedTimeline[4].label : "", "读取 Memory · 2 个文件");
  assert.equal(groupedTimeline[4]?.kind === "tool_group" ? groupedTimeline[4].tools[0]?.resultSummary : "", "完整 · 共 4 行");
  assert.equal(groupedTimeline[4]?.kind === "tool_group" ? groupedTimeline[4].tools[1]?.resultSummary : "", "第 21–40 行 · 共 80 行");
  assert.match(groupedTimeline[4]?.kind === "tool_group" ? groupedTimeline[4].tools[1]?.input || "" : "", /"offset": 21/);

  const legacyTimeline = buildTimeline([
    { type: "reading_coverage", data: { readFileCount: 7 }, at: "1" },
    { type: "tool_call", data: { toolCallId: "todo", toolName: "todo_write", inputPreview: "{}" }, at: "2" },
    { type: "tool_result", data: { toolCallId: "todo", toolName: "todo_write", ok: true }, at: "3" },
    { type: "tool_call", data: { toolCallId: "skill", toolName: "read_skill", inputPreview: JSON.stringify({ id: "critical-review" }) }, at: "4" },
    { type: "tool_result", data: { toolCallId: "skill", toolName: "read_skill", ok: true }, at: "5" },
  ]);
  assert.equal(legacyTimeline.length, 1);
  assert.equal(legacyTimeline[0]?.kind === "tool" ? `${legacyTimeline[0].label} ${legacyTimeline[0].detail}` : "", "使用 Skill critical-review");

  const chatWorkspaceSource = await readFile(new URL(`file:///${process.cwd().replace(/\\/g, "/")}/src/web/client/components/ChatWorkspace.tsx`), "utf8");
  assert.match(chatWorkspaceSource, /turnAnchor="bottom"\s+autoScroll/);
  assert.doesNotMatch(chatWorkspaceSource, /turnAnchor="top"/);
  const webStylesSource = await readFile(new URL(`file:///${process.cwd().replace(/\\/g, "/")}/src/web/client/styles.css`), "utf8");
  assert.match(webStylesSource, /\.thread-viewport\s*\{[^}]*overflow-anchor:\s*none;[^}]*\}/s);
  assert.match(webStylesSource, /\.thread-viewport\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0;[^}]*\}/s);
  assert.match(chatWorkspaceSource, /添加到对话/);
  assert.match(chatWorkspaceSource, /lazy-user-annotations/);
  const deepseekProviderSource = await readFile(new URL(`file:///${process.cwd().replace(/\\/g, "/")}/src/model/deepseek-provider.ts`), "utf8");
  assert.doesNotMatch(deepseekProviderSource, /\{\s*tool_choice\s*:/);

  console.log("PASS answer streaming: normal final streams without an empty Thinking node");
  console.log("PASS answer streaming: forced final streams after reasoning and persists once");
  console.log("PASS answer streaming: tool-call prose moves to timeline before the real answer");
  console.log("PASS annotations: completed answers expose Add to conversation UI");
  console.log("PASS answer streaming: reasoning-only provider output is discarded and retried into the answer bubble");
  console.log("PASS timeline: attachments, searches and reads stay explicit without changing chronology");
  console.log("PASS timeline: legacy todo/coverage events stay hidden while old Skill calls remain readable");
  console.log("PASS viewport: assistant-ui owns anchoring and streaming rows cannot flex-shrink");
  console.log("PASS DeepSeek compatibility: thinking-mode requests do not send unsupported tool_choice");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
