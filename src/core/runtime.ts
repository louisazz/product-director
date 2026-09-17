import type { WorkspaceContext } from "./types.js";
import type { ModelProvider } from "../model/provider.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PermissionManager } from "../permissions/index.js";
import { MockModelProvider } from "../model/mock-provider.js";
import { createDefaultToolRegistry } from "../tools/builtins.js";
import { createPermissionManagerFromSettings, AutoDenyConfirmationProvider } from "../permissions/index.js";
import { runAgentLoop, runAgentLoopStream } from "./agent-loop.js";
import type { AgentObserver, AgentRunResult, AgentMessage, ImageAttachmentRef, SessionContextState, SessionTaskState } from "./agent-types.js";
import { assembleContext, compactConversation, contextNeedsCompaction } from "./context-assembler.js";

export interface RuntimeState {
  workspace: WorkspaceContext;
  modelProvider: ModelProvider;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
}

export interface RuntimeRunOptions {
  historyMessages?: AgentMessage[];
  observer?: AgentObserver;
  taskState?: SessionTaskState;
  maxSteps?: number;
  resumeContext?: string;
  resumeIntent?: boolean;
  contextState?: SessionContextState;
  sessionId?: string;
  turnIndex?: number;
  signal?: AbortSignal;
  userAttachments?: ImageAttachmentRef[];
}

export interface RuntimeRunResult {
  outputText: string;
  agentRun: AgentRunResult;
  workspace: WorkspaceContext;
  contextState: SessionContextState;
}

export function createRuntime(
  workspace: WorkspaceContext,
  modelProvider?: ModelProvider,
  toolRegistry?: ToolRegistry,
  permissionManager?: PermissionManager,
): RuntimeState {
  return {
    workspace,
    modelProvider: modelProvider ?? new MockModelProvider(),
    toolRegistry: toolRegistry ?? createDefaultToolRegistry(workspace),
    permissionManager: permissionManager ?? createPermissionManagerFromSettings(
      workspace.settings,
      new AutoDenyConfirmationProvider(),
    ),
  };
}

export async function runRuntime(
  runtime: RuntimeState,
  userInput: string,
  options?: RuntimeRunOptions,
): Promise<RuntimeRunResult> {
  const maxSteps = options?.maxSteps ?? 64;
  const taskState = options?.taskState;
  const resume = options?.resumeIntent ?? false;
  const allHistory = options?.historyMessages || [];
  let contextState = normalizeContextState(options?.contextState, taskState);
  let history = messagesAfterBoundary(allHistory, contextState.compactedThroughMessageId);
  const inspectContext = /^\/context(?:\s|$)/i.test(userInput.trim());
  const compactMatch = userInput.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  const toolNames = runtime.toolRegistry.list().map((tool) => tool.name);
  const preflight = assembleContext({
    workspace: runtime.workspace,
    historyMessages: history,
    conversationSummary: contextState.summary,
    actualPromptTokens: contextState.lastPromptTokens,
    compactionCount: contextState.compactionCount,
    toolNames,
    contextWindowTokens: runtime.modelProvider.contextWindowTokens,
  });

  // Automatic compaction only runs when there is a meaningful un-compacted tail.
  // This mirrors Claude Code's anti-thrashing behavior: a large but fresh summary
  // must not be summarized again on every turn before any new work has accumulated.
  const shouldAutoCompact = contextNeedsCompaction(preflight.report) && history.length >= 2;
  if (!inspectContext && (Boolean(compactMatch) || shouldAutoCompact)) {
    if (!history.length && !contextState.summary) {
      if (compactMatch) return compactCommandResult(runtime.workspace, contextState, userInput, "当前没有足够的会话内容可以压缩。");
    } else {
      options?.observer?.onStatus?.(compactMatch ? "正在按你的要求压缩会话…" : "上下文接近容量，正在压缩旧对话…");
      const summary = await compactConversation({
        historyMessages: history,
        previousSummary: contextState.summary,
        modelProvider: runtime.modelProvider,
        workspace: runtime.workspace,
        toolNames,
        focus: compactMatch?.[1],
        signal: options?.signal,
      });
      contextState = {
        version: 1,
        summary,
        compactedThroughMessageId: history.at(-1)?.id || contextState.compactedThroughMessageId,
        compactionCount: contextState.compactionCount + 1,
        lastPromptTokens: undefined,
        updatedAt: new Date().toISOString(),
      };
      history = [];
      if (compactMatch) {
        return compactCommandResult(runtime.workspace, contextState, userInput, `会话已压缩（第 ${contextState.compactionCount} 次）。后续对话会继续使用这份摘要。`);
      }
    }
  }

  const loop = runtime.modelProvider.generateStream && (options?.observer?.onAnswerToken || options?.observer?.onToken)
    ? runAgentLoopStream
    : runAgentLoop;
  const agentRun = await loop({
    userInput,
    workspace: runtime.workspace,
    modelProvider: runtime.modelProvider,
    toolRegistry: runtime.toolRegistry,
    permissionManager: runtime.permissionManager,
    historyMessages: history,
    observer: options?.observer,
    maxSteps,
    resumeContext: options?.resumeContext,
    resumeIntent: resume,
    sessionId: options?.sessionId,
    turnIndex: options?.turnIndex,
    conversationSummary: contextState.summary,
    actualPromptTokens: contextState.lastPromptTokens,
    compactionCount: contextState.compactionCount,
    signal: options?.signal,
    userAttachments: options?.userAttachments,
  });

  const promptUsages = agentRun.steps.flatMap((step) => step.modelResponse.usage?.promptTokens ? [step.modelResponse.usage.promptTokens] : []);
  if (promptUsages.length) contextState = { ...contextState, lastPromptTokens: Math.max(...promptUsages), updatedAt: new Date().toISOString() };
  return { outputText: agentRun.finalText, agentRun, workspace: runtime.workspace, contextState };
}

function normalizeContextState(value?: SessionContextState, taskState?: SessionTaskState): SessionContextState {
  if (value?.version === 1) return { ...value, summary: String(value.summary || ""), compactionCount: Number(value.compactionCount || 0) };
  const legacySummary = taskState?.workingSet?.summary || "";
  return { version: 1, summary: legacySummary, compactionCount: legacySummary ? 1 : 0, updatedAt: new Date().toISOString() };
}

function messagesAfterBoundary(messages: AgentMessage[], boundary?: string): AgentMessage[] {
  if (!boundary) return messages;
  const index = messages.findIndex((message) => message.id === boundary);
  return index >= 0 ? messages.slice(index + 1) : messages;
}

function compactCommandResult(workspace: WorkspaceContext, contextState: SessionContextState, input: string, text: string): RuntimeRunResult {
  const now = new Date().toISOString();
  const user: AgentMessage = { id: `compact-user-${Date.now()}`, role: "user", content: input, createdAt: now };
  const assistant: AgentMessage = { id: `compact-assistant-${Date.now()}`, role: "assistant", content: text, createdAt: now };
  const agentRun: AgentRunResult = { messages: [user, assistant], steps: [], finalText: text, stopReason: "final", newMessages: [user, assistant] };
  return { outputText: text, agentRun, workspace, contextState };
}
