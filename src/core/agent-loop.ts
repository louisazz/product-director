import { randomUUID } from "node:crypto";
import type { WorkspaceContext } from "./types.js";
import type { ModelProvider } from "../model/provider.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PermissionManager } from "../permissions/index.js";
import type {
  AgentMessage,
  AgentObserver,
  AgentRunResult,
  AgentStep,
  ModelResponse,
  TaskWorkingSet,
  ToolCall,
  ToolResult,
  ImageAttachmentRef,
} from "./agent-types.js";
import {
  assembleContext,
  AUTO_COMPACT_RATIO,
  estimateMessageTokens,
  estimateTextTokens,
  formatContextReport,
  pruneToolResultsToFit,
  sanitizeSessionMessages,
  TOOL_RESULT_PRUNE_TARGET_RATIO,
} from "./context-assembler.js";
import { buildSkillIndex } from "../skills/index.js";

export interface RunAgentLoopOptions {
  userInput: string;
  workspace: WorkspaceContext;
  modelProvider: ModelProvider;
  toolRegistry?: ToolRegistry;
  permissionManager: PermissionManager;
  historyMessages?: AgentMessage[];
  maxSteps?: number;
  observer?: AgentObserver;
  workingSet?: TaskWorkingSet;
  resumeContext?: string;
  resumeIntent?: boolean;
  conversationSummary?: string;
  actualPromptTokens?: number;
  compactionCount?: number;
  sessionId?: string;
  turnIndex?: number;
  signal?: AbortSignal;
  userAttachments?: ImageAttachmentRef[];
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentRunResult> {
  return runLoop(options, false);
}

export async function runAgentLoopStream(options: RunAgentLoopOptions): Promise<AgentRunResult> {
  return runLoop(options, true);
}

async function runLoop(options: RunAgentLoopOptions, preferStream: boolean): Promise<AgentRunResult> {
  const {
    userInput,
    workspace,
    modelProvider,
    toolRegistry,
    permissionManager,
    historyMessages,
    observer,
    workingSet,
    resumeContext,
    resumeIntent,
    conversationSummary,
    actualPromptTokens,
    compactionCount,
  } = options;
  const maxSteps = Math.max(2, options.maxSteps ?? 64);
  const allTools = toolRegistry?.list() || [];
  const assembled = assembleContext({
    workspace,
    historyMessages,
    workingSet,
    conversationSummary,
    actualPromptTokens,
    compactionCount,
    contextWindowTokens: modelProvider.contextWindowTokens,
    toolNames: allTools.map((tool) => tool.name),
  });
  const messages = assembled.messages;
  const newMessagesStart = messages.length;
  let lastPromptTokens = actualPromptTokens || 0;

  observer?.onStart?.();

  if (/^\/context(?:\s|$)/i.test(userInput.trim())) {
    const finalText = formatContextReport(assembled.report);
    messages.push(msg("user", userInput), msg("assistant", finalText));
    emitAnswer(observer, finalText);
    observer?.onFinal?.(finalText);
    return {
      messages,
      steps: [],
      finalText,
      stopReason: "final",
      newMessages: messages.slice(newMessagesStart),
      workingSet,
    };
  }

  if (resumeContext) messages.push(msg("user", resumeContext, { name: "__runtime" }));
  const effectiveInput = userInput;
  messages.push(msg("user", effectiveInput, { attachments: options.userAttachments }));

  // An explicit Skill choice is injected after the user message so it reads as a
  // constraint on this turn rather than as part of what the user said.
  const directive = parseSkillDirective(userInput, buildSkillIndex(workspace).skills.map((item) => item.id));
  if (directive) {
    messages.push(msg("system", skillDirectiveInstruction(directive.skillId, Boolean(directive.remainder)), { name: "__runtime" }));
  }

  const steps: AgentStep[] = [];
  const completedReads = new Set<string>();
  let emptyVisibleAnswerRetries = 0;
  observer?.onStatus?.("开始处理");

  for (let index = 0; index < maxSteps; index++) {
    throwIfAborted(options.signal);
    const remaining = maxSteps - index;
    const activeTools = remaining === 1 ? undefined : allTools;
    if (remaining === 1) observer?.onStatus?.("正在整理最终回答…");

    const contextWindow = modelProvider.contextWindowTokens || 1_000_000;
    const toolTokens = estimateTextTokens(JSON.stringify(activeTools || []));
    const estimatedRequestTokens = estimateMessageTokens(messages) + toolTokens;
    const pruneAt = Math.floor(contextWindow * AUTO_COMPACT_RATIO);
    const prepared = (Math.max(estimatedRequestTokens, lastPromptTokens) >= pruneAt
      ? pruneToolResultsToFit(messages, Math.max(1, Math.floor(contextWindow * TOOL_RESULT_PRUNE_TARGET_RATIO) - toolTokens)).messages
      : messages.map((item) => ({ ...item })));
    const requestMessages = prepared;
    const inputMessages = requestMessages.map((item) => ({ ...item }));
    const streamed = preferStream && Boolean(modelProvider.generateStream);
    const { response, answerStarted } = streamed
      ? await generateStreaming(modelProvider, { messages: requestMessages, tools: activeTools, toolChoice: "auto", signal: options.signal }, observer)
      : { response: await generateOnce(modelProvider, { messages: requestMessages, tools: activeTools, toolChoice: "auto", signal: options.signal }, observer), answerStarted: false };

    observer?.onModelStep?.(index, response.stopReason, (response.content || "").slice(0, 200));

    // A reasoning provider can occasionally finish after writing everything to
    // reasoning_content while leaving the user-visible content empty. Retrying
    // is safer than exposing hidden reasoning as the answer or claiming that an
    // empty response completed successfully.
    if (!response.toolCalls.length && !response.content?.trim() && response.stopReason !== "error") {
      observer?.onThinkingDiscard?.("agent");
      if (emptyVisibleAnswerRetries < 2) {
        emptyVisibleAnswerRetries++;
        messages.push(msg("system", [
          "[运行时恢复]",
          "上一步没有返回任何面向用户的正文。不要重新展开内部分析；现在直接在 assistant content 中输出本轮应交付的内容。",
          "请直接给出最终回答。",
        ].join("\n"), { name: "__runtime" }));
        continue;
      }
      throw new Error("模型连续返回了空正文，本轮没有被误判为完成。请重试或切换模型。");
    }

    const assistant = msg("assistant", response.content || "", {
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
      reasoningContent: response.toolCalls.length ? response.reasoningContent : undefined,
    });
    if (response.usage?.promptTokens) lastPromptTokens = response.usage.promptTokens;
    messages.push(assistant);
    const step: AgentStep = { index, inputMessages, modelResponse: response, toolResults: [], stopReason: response.stopReason };

    if (response.toolCalls.length) {
      if (response.content) observer?.onAssistantText?.(response.content);
      if (answerStarted) {
        observer?.onAnswerAbort?.();
      }
      const runCall = async (call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> => {
        throwIfAborted(options.signal);
        observer?.onStatus?.(`正在执行 ${call.name}`);
        observer?.onToolCall?.({ id: call.id, name: call.name, input: call.input });
        let result: ToolResult;
        const readKey = call.name === "read" ? stableToolKey(call) : "";
        try {
          result = readKey && completedReads.has(readKey)
            ? { toolCallId: call.id, name: call.name, ok: true, content: "[UNCHANGED: 本轮已经读取过同一文件的相同范围，请直接使用前一次读取结果。]" }
            : await executeToolCall(call, toolRegistry, permissionManager, workspace, userInput, options.sessionId, options.turnIndex, options.signal);
        } catch (error: any) {
          if (error?.name === "WebConfirmationRequiredError") {
            error.toolCallId = call.id;
            error.pendingNewMessages = persistable(messages.slice(newMessagesStart));
          }
          throw error;
        }
        if (readKey && result.ok) completedReads.add(readKey);
        return { call, result };
      };
      const parallel = response.toolCalls.length > 1 && response.toolCalls.every((call) => PARALLEL_READ_TOOLS.has(call.name));
      const executed = parallel
        ? await Promise.all(response.toolCalls.map(runCall))
        : await executeSequentially(response.toolCalls, runCall);
      for (const { result } of executed) {
        step.toolResults.push(result);
        messages.push(toolResultMessage(result));
        observer?.onToolResult?.({ toolCallId: result.toolCallId, name: result.name, ok: result.ok, contentPreview: result.content.slice(0, 500) });
      }
      steps.push(step);
      continue;
    }

    steps.push(step);
    if (response.stopReason === "error") {
      if (answerStarted) observer?.onAnswerAbort?.();
      throw new Error(response.content?.trim() || "模型没有正常完成本轮回答。");
    }
    const finalText = response.content?.trim() || "本轮没有生成可用回答。";
    const deliveredText = response.stopReason === "length"
      ? `${finalText}\n\n[回答达到模型单次输出上限，已保留当前内容，可继续生成。]`
      : finalText;
    if (answerStarted) observer?.onAnswerEnd?.(deliveredText);
    else emitAnswer(observer, deliveredText);
    observer?.onFinal?.(deliveredText);
    return result(messages, steps, deliveredText, response.stopReason, newMessagesStart, workingSet);
  }

  // Defensive fallback. The last model call has tools disabled, so this is only reached on a malformed provider response.
  const finalText = "已达到本轮处理上限，但模型没有生成最终回答。请发送“继续”，我会保留当前任务便签和已读资料继续处理。";
  emitAnswer(observer, finalText);
  observer?.onFinal?.(finalText);
  return result(messages, steps, finalText, "max_steps", newMessagesStart, workingSet);
}

const PARALLEL_READ_TOOLS = new Set(["glob", "grep", "read", "semantic_search", "skill"]);

/**
 * Reserved slash words that are runtime commands rather than Skill names.
 * A Skill happening to be named `context` must not shadow `/context`.
 */
const RESERVED_SLASH_COMMANDS = new Set(["context", "compact"]);

export interface SkillDirective {
  /** Skill id exactly as registered in the workspace catalog. */
  skillId: string;
  /** The user's own text with the leading directive removed. */
  remainder: string;
}

/**
 * Detect a leading `/<skill-id>` directive chosen from the composer panel.
 *
 * Only a known Skill id counts. An unknown slash word is left untouched so it
 * reaches the model as ordinary text — a user typing "/不知道写什么" should get
 * a normal reply, not a "Skill not found" error.
 */
export function parseSkillDirective(userInput: string, availableSkillIds: readonly string[]): SkillDirective | null {
  const match = userInput.trimStart().match(/^\/([\w-]+)(?:[\s\u3000]+([\s\S]*))?$/);
  if (!match) return null;
  const requested = match[1].toLowerCase();
  if (RESERVED_SLASH_COMMANDS.has(requested)) return null;
  const skillId = availableSkillIds.find((id) => id.toLowerCase() === requested);
  if (!skillId) return null;
  return { skillId, remainder: (match[2] || "").trim() };
}

/**
 * The directive is a user-side choice, so it is stated as an instruction rather
 * than pre-loading the body: the model still calls `skill`, which keeps the
 * timeline honest and lets the existing tool-result path own the content.
 */
function skillDirectiveInstruction(skillId: string, hasRemainder: boolean): string {
  return [
    "[用户已在输入框中显式选择了一个 Skill]",
    `Skill 名称：${skillId}`,
    "",
    `本轮必须先调用 skill 工具加载 ${skillId}，再按它的方法处理用户的问题。这是用户主动的选择，不要跳过，也不要改用其他 Skill。`,
    hasRemainder
      ? "用户在选择之后还写了正文，那才是本轮真正要解决的问题。"
      : "用户只选择了 Skill 而没有写正文。加载后先看这个 Skill 适用于什么，再结合当前对话判断该做什么；如果确实缺少必要信息，简短问清最关键的一两点。",
  ].join("\n");
}

async function executeSequentially<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

function stableToolKey(call: ToolCall): string {
  const entries = Object.entries(call.input).sort(([left], [right]) => left.localeCompare(right));
  return `${call.name}:${JSON.stringify(Object.fromEntries(entries))}`;
}

async function generateOnce(
  provider: ModelProvider,
  request: Parameters<ModelProvider["generate"]>[0],
  observer?: AgentObserver,
): Promise<ModelResponse> {
  observer?.onThinkingStart?.("agent");
  try {
    return await provider.generate(request);
  } finally {
    observer?.onThinkingEnd?.("agent");
  }
}

async function generateStreaming(
  provider: ModelProvider,
  request: Parameters<ModelProvider["generate"]>[0],
  observer?: AgentObserver,
): Promise<{ response: ModelResponse; answerStarted: boolean }> {
  let content = "";
  let reasoning = "";
  let toolCalls: ToolCall[] = [];
  let error = "";
  let thinking = false;
  let answerStarted = false;
  let usage: ModelResponse["usage"];
  let stopReason: ModelResponse["stopReason"] = "final";
  try {
    for await (const event of provider.generateStream!(request)) {
      if (event.type === "reasoning_delta" && event.text) {
        if (!thinking) {
          observer?.onThinkingStart?.("agent");
          thinking = true;
        }
        reasoning += event.text;
        observer?.onReasoningToken?.(event.text);
      } else if (event.type === "token_delta" && event.text) {
        if (thinking) {
          observer?.onThinkingEnd?.("agent");
          thinking = false;
        }
        content += event.text;
        if (!answerStarted) {
          observer?.onAnswerStart?.();
          answerStarted = true;
        }
        observer?.onAnswerToken?.(event.text);
        observer?.onToken?.(event.text);
      } else if (event.type === "tool_calls" && event.toolCalls) {
        toolCalls = event.toolCalls;
      } else if (event.type === "error") {
        error = event.error || "Model stream failed.";
      } else if (event.type === "usage" && event.usage) {
        usage = event.usage;
      } else if (event.type === "done") {
        if (event.reasoningContent) reasoning = event.reasoningContent;
        if (event.stopReason) stopReason = event.stopReason;
      }
    }
  } catch (streamError) {
    if (answerStarted) observer?.onAnswerAbort?.();
    throw streamError;
  } finally {
    if (thinking) observer?.onThinkingEnd?.("agent");
  }
  return {
    response: {
      content: error || content,
      toolCalls,
      stopReason: error ? "error" : toolCalls.length ? "tool_call" : stopReason,
      reasoningContent: reasoning || undefined,
      usage,
    },
    answerStarted,
  };
}

async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry | undefined,
  permissions: PermissionManager,
  workspace: WorkspaceContext,
  currentUserInput: string,
  sessionId?: string,
  turnIndex?: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  throwIfAborted(signal);
  const tool = registry?.get(call.name);
  if (!tool) return { toolCallId: call.id, name: call.name, ok: false, content: `Tool "${call.name}" is not available.`, error: "tool_not_found" };
  const decision = permissions.check(tool, call.input);
  if (decision.level === "deny") {
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: `Tool "${call.name}" was blocked. ${decision.reason}`,
      error: "permission_denied",
      permission: { level: decision.level, category: decision.category, allowed: false },
    };
  }
  let confirmed: boolean | undefined;
  if (decision.level === "ask") {
    confirmed = await permissions.confirmIfNeeded(decision, {
      toolName: call.name,
      permission: decision.category,
      input: call.input,
      reason: decision.reason,
    });
    if (!confirmed) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        content: `Tool "${call.name}" was not approved.`,
        error: "permission_rejected",
        permission: { level: decision.level, category: decision.category, allowed: false, confirmed: false },
      };
    }
  }
  throwIfAborted(signal);
  try {
    const executed = await tool.execute(call.input, { workspace, currentUserInput, sessionId, turnIndex, signal });
    throwIfAborted(signal);
    return {
      toolCallId: call.id,
      name: call.name,
      ok: executed.ok,
      content: executed.content,
      error: executed.error,
      permission: { level: decision.level, category: decision.category, allowed: true, confirmed },
    };
  } catch (error: any) {
    if (error?.name === "AbortError") throw error;
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: "",
      error: `Tool execution error: ${error?.message || String(error)}`,
      permission: { level: decision.level, category: decision.category, allowed: true, confirmed },
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("生成已停止。");
  error.name = "AbortError";
  throw error;
}

function result(
  messages: AgentMessage[],
  steps: AgentStep[],
  finalText: string,
  stopReason: AgentRunResult["stopReason"],
  start: number,
  workingSet?: TaskWorkingSet,
): AgentRunResult {
  return {
    messages,
    steps,
    finalText,
    stopReason,
    newMessages: persistable(messages.slice(start)),
    workingSet,
  };
}

function persistable(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((item) => item.name !== "__runtime");
}

function msg(
  role: AgentMessage["role"],
  content: string,
  extras?: Partial<Pick<AgentMessage, "toolCalls" | "toolCallId" | "name" | "reasoningContent" | "attachments" | "modelProvider">>,
): AgentMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString(), ...extras };
}

function toolResultMessage(toolResult: ToolResult): AgentMessage {
  return msg("tool", toolResult.content || toolResult.error || "", { toolCallId: toolResult.toolCallId, name: toolResult.name });
}

function emitAnswer(observer: AgentObserver | undefined, text: string): void {
  observer?.onAnswerStart?.();
  observer?.onAnswerToken?.(text);
  observer?.onToken?.(text);
  observer?.onAnswerEnd?.(text);
}

export { sanitizeSessionMessages } from "./context-assembler.js";
