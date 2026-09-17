import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../model/provider.js";
import type { AgentMessage, TaskWorkingSet } from "./agent-types.js";
import type { WorkspaceContext } from "./types.js";
import { BASE_SYSTEM_PROMPT } from "./prompts.js";
import { buildSkillBrief } from "../skills/index.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const AUTO_COMPACT_RATIO = 0.9;
export const TOOL_RESULT_PRUNE_TARGET_RATIO = 0.82;

export interface ContextReport {
  projectId: string;
  projectName: string;
  totalChars: number;
  estimatedTokens: number;
  contextWindowTokens: number;
  autoCompactAtTokens: number;
  actualPromptTokens?: number;
  compactionCount: number;
  systemChars: number;
  directorChars: number;
  memoryChars: number;
  skillCatalogChars: number;
  workingNoteChars: number;
  historyChars: number;
  historyMessages: number;
  clearedToolResults: number;
  compacted: boolean;
  toolNames: string[];
}

export interface AssembledContext {
  messages: AgentMessage[];
  report: ContextReport;
}

export function assembleContext(args: {
  workspace: WorkspaceContext;
  historyMessages?: AgentMessage[];
  workingSet?: TaskWorkingSet;
  conversationSummary?: string;
  actualPromptTokens?: number;
  compactionCount?: number;
  contextWindowTokens?: number;
  toolNames: string[];
}): AssembledContext {
  const messages: AgentMessage[] = [];
  const system = BASE_SYSTEM_PROMPT;
  messages.push(message("system", system));

  const director = args.workspace.directorContent?.trim() || "";
  if (director) messages.push(message("system", `[DIRECTOR.md]\n${director}`));

  messages.push(message("system", `[当前项目]\n名称：${args.workspace.project.name}\nID：${args.workspace.project.id}${args.workspace.project.description ? `\n说明：${args.workspace.project.description}` : ""}\n普通查找工具只检索通用 Memory。项目附件只通过当前会话的附件上下文提供，不会主动遍历本项目或其他项目的附件库。`));

  const memory = loadMemoryIndex(args.workspace);
  if (memory) messages.push(message("system", `[MEMORY.md — 长期工作语境]\n${memory}\n\n这里只是长期记忆索引。根据当前任务按需 read 对应原文；不要把记忆当成不可修正的事实，新资料和用户当前表达优先。`));

  const skills = buildSkillBrief(args.workspace);
  if (skills && !skills.startsWith("(当前没有")) {
    messages.push(message("system", `[可用 Skills — 只包含名称和简介，使用时调用 skill]\n${skills}`));
  }

  const conversationSummary = args.conversationSummary?.trim() || "";
  if (conversationSummary) messages.push(message("system", `[压缩后的会话历史]\n${conversationSummary}\n\n这是对旧对话的有损摘要，只用于续接，不是不可修正的事实记录。其中的判断仍需结合用户当前表达理解；它不替代原会话或当前项目文件，需要精确内容时再定向 read 核对。`));

  const history = sanitizeSessionMessages(args.historyMessages || []);
  messages.push(...history);

  const totalChars = messages.reduce((sum, item) => sum + item.content.length, 0);
  const contextWindowTokens = args.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  const report: ContextReport = {
    projectId: args.workspace.project.id,
    projectName: args.workspace.project.name,
    totalChars,
    estimatedTokens: estimateMessageTokens(messages),
    contextWindowTokens,
    autoCompactAtTokens: Math.floor(contextWindowTokens * AUTO_COMPACT_RATIO),
    actualPromptTokens: args.actualPromptTokens,
    compactionCount: args.compactionCount || 0,
    systemChars: system.length,
    directorChars: director.length,
    memoryChars: memory.length,
    skillCatalogChars: skills.startsWith("(当前没有") ? 0 : skills.length,
    workingNoteChars: 0,
    historyChars: history.reduce((sum, item) => sum + item.content.length, 0),
    historyMessages: history.length,
    clearedToolResults: 0,
    compacted: Boolean(conversationSummary),
    toolNames: args.toolNames,
  };
  return { messages, report };
}

export function contextNeedsCompaction(report: ContextReport): boolean {
  return Math.max(report.estimatedTokens, report.actualPromptTokens || 0) >= report.autoCompactAtTokens;
}

export async function compactConversation(args: {
  historyMessages: AgentMessage[];
  previousSummary?: string;
  modelProvider: ModelProvider;
  workspace: WorkspaceContext;
  toolNames: string[];
  focus?: string;
  onThinkingStart?: () => void;
  onThinkingEnd?: () => void;
  onReasoningToken?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const sanitized = pruneToolResultsToFit(
    sanitizeSessionMessages(args.historyMessages),
    Math.floor((args.modelProvider.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS) * TOOL_RESULT_PRUNE_TARGET_RATIO),
  ).messages;
  if (sanitized.length === 0 && !args.previousSummary) return "";
  const focus = args.focus?.trim();
  const prompt = `请把此前会话压缩成一份供同一个 Agent 继续工作的自由文本摘要。
优先保留：用户明确表达的目标、约束、偏好、修正和否定；问题在互动中如何被重新理解；仍然并存的解释、矛盾和不确定性；已经确认的阶段性决定；尚未解决的问题；确实使用过的资料路径。
明确区分用户已经确认的内容与助手提出但尚未确认的解释。不要把助手的提案升级成用户立场，也不要把阶段性判断写成不可修正的事实。后来放弃的方向如果能解释当前选择或仍可能被重新打开，应简短保留其原因，而不是仅因已放弃就删除。
删除寒暄、无信息量的重复、纯机械失败过程和可以重新读取的冗长工具原文。不要为了简洁消除真实分歧，不要推测，也不要把工具输出直接当成事实。
${focus ? `本次压缩重点：${focus}\n` : ""}语言简洁，最多 6000 个中文字符。只输出摘要正文。`;
  const compactMessages: AgentMessage[] = [
    message("system", "你负责压缩一段长会话，使同一个助手能在下一轮继续工作。只依据提供的旧摘要与会话内容，不补充常识或项目资料。"),
    ...(args.previousSummary ? [message("system", `[上一次压缩摘要]\n${args.previousSummary}`)] : []),
    ...sanitized,
    message("user", prompt),
  ];
  args.onThinkingStart?.();
  try {
    if (args.modelProvider.generateStream) {
      let content = "";
      for await (const event of args.modelProvider.generateStream({
        messages: compactMessages,
        signal: args.signal,
      })) {
        if (event.type === "reasoning_delta" && event.text) args.onReasoningToken?.(event.text);
        if (event.type === "token_delta" && event.text) content += event.text;
      }
      const summary = content.trim().slice(0, 12_000);
      if (!summary) throw new Error("上下文压缩没有生成可用摘要，原会话历史已保留。");
      return summary;
    }
    const response = await args.modelProvider.generate({
      messages: compactMessages,
      signal: args.signal,
    });
    const summary = (response.content || "").trim().slice(0, 12_000);
    if (!summary) throw new Error("上下文压缩没有生成可用摘要，原会话历史已保留。");
    return summary;
  } finally {
    args.onThinkingEnd?.();
  }
}

export function formatContextReport(report: ContextReport): string {
  const percent = (part: number) => report.totalChars ? `${Math.round(part / report.totalChars * 100)}%` : "0%";
  return [
    "当前上下文检查",
    "",
    `当前项目：${report.projectName}（${report.projectId}）`,
    `总量（近似字符）：${report.totalChars.toLocaleString()}`,
    `估算 Token：${report.estimatedTokens.toLocaleString()} / ${report.contextWindowTokens.toLocaleString()}（自动压缩阈值 ${report.autoCompactAtTokens.toLocaleString()}）`,
    ...(report.actualPromptTokens ? [`上一次模型实际输入 Token：${report.actualPromptTokens.toLocaleString()}`] : []),
    `- 基础提示：${report.systemChars.toLocaleString()}（${percent(report.systemChars)}）`,
    `- DIRECTOR.md：${report.directorChars.toLocaleString()}（${percent(report.directorChars)}）`,
    `- MEMORY.md：${report.memoryChars.toLocaleString()}（${percent(report.memoryChars)}）`,
    `- Skill 目录：${report.skillCatalogChars.toLocaleString()}（${percent(report.skillCatalogChars)}）`,
    `- 任务便签：${report.workingNoteChars.toLocaleString()}（${percent(report.workingNoteChars)}）`,
    `- 会话历史：${report.historyChars.toLocaleString()}（${report.historyMessages} 条，${percent(report.historyChars)}）`,
    `- 已清理的旧工具结果：${report.clearedToolResults} 条`,
    `- 已有会话压缩：${report.compacted ? `是（${report.compactionCount} 次）` : "否"}`,
    `- 模型可见工具：${report.toolNames.join(", ") || "无"}`,
    "",
    "说明：Token 为发送前估算；实际调用后优先使用供应商 usage。旧工具原文会优先被清理，接近模型容量后才会生成会话摘要。",
  ].join("\n");
}

/**
 * Measured against this deployment's DeepSeek V4 endpoint: 200,000 CJK
 * characters reported prompt_tokens=200,093, i.e. ~1.0 token per CJK char
 * rather than the 0.6 documented for earlier DeepSeek models. Latin text is
 * left at the conventional ~0.32 ratio.
 */
const CJK_TOKENS_PER_CHAR = 1.0;
const LATIN_TOKENS_PER_CHAR = 0.32;

export function estimateMessageTokens(messages: AgentMessage[]): number {
  let tokens = 0;
  for (const item of messages) {
    const text = item.content || "";
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const other = text.length - cjk;
    tokens += Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * LATIN_TOKENS_PER_CHAR + 12);
    if (item.toolCalls?.length) tokens += Math.ceil(JSON.stringify(item.toolCalls).length * LATIN_TOKENS_PER_CHAR);
    if (item.reasoningContent) tokens += estimateTextTokens(item.reasoningContent);
  }
  return tokens;
}

export function estimateTextTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (text.length - cjk) * LATIN_TOKENS_PER_CHAR);
}

function loadMemoryIndex(workspace: WorkspaceContext): string {
  const filePath = path.join(workspace.paths.memoryDir, "MEMORY.md");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split(/\r?\n/).slice(0, 200).join("\n").slice(0, 25_000).trim();
  } catch {
    return "";
  }
}

/**
 * Claude Code-style pressure relief: preserve every tool result during normal
 * work and only clear the oldest outputs when the request would otherwise
 * exceed an explicit token budget.
 */
export function pruneToolResultsToFit(messages: AgentMessage[], maxTokens: number): { messages: AgentMessage[]; cleared: number } {
  const prepared = messages.map((item) => ({ ...item }));
  if (maxTokens <= 0 || estimateMessageTokens(prepared) <= maxTokens) return { messages: prepared, cleared: 0 };

  let cleared = 0;
  for (let index = 0; index < prepared.length && estimateMessageTokens(prepared) > maxTokens; index++) {
    const item = prepared[index];
    if (item.role !== "tool") continue;
    item.content = `[旧工具结果因上下文接近容量而清理：${item.name || "tool"}。需要时可重新调用工具。]`;
    cleared++;
  }
  return { messages: prepared, cleared };
}

export function sanitizeSessionMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index];
    if (item.role === "assistant" && item.toolCalls?.length) {
      const expected = new Set(item.toolCalls.map((call) => call.id));
      const toolMessages: AgentMessage[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === "tool") {
        const toolMessage = messages[cursor];
        if (toolMessage.toolCallId && expected.has(toolMessage.toolCallId)) toolMessages.push({ ...toolMessage });
        cursor++;
      }
      const received = new Set(toolMessages.map((message) => message.toolCallId));
      const complete = expected.size === received.size && [...expected].every((id) => received.has(id));
      if (complete) {
        result.push({ ...item, reasoningContent: item.reasoningContent }, ...toolMessages);
      } else if (item.content) {
        result.push({ ...item, toolCalls: undefined, reasoningContent: undefined });
      }
      index = cursor - 1;
    } else if (item.role === "tool") {
      continue;
    } else {
      result.push(item.role === "assistant" ? { ...item, reasoningContent: undefined } : { ...item });
    }
  }
  return result;
}

function message(role: AgentMessage["role"], content: string): AgentMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString() };
}
