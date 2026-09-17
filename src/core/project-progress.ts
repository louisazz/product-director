import * as fs from "node:fs";
import type { ModelProvider } from "../model/provider.js";
import { loadSkillContent } from "../skills/index.js";
import type { WorkspaceContext } from "./types.js";
import { SessionStore, type AgentSession } from "./session.js";

export interface ProgressSource {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ProjectProgress {
  version: 1;
  projectId: string;
  content: string;
  generatedAt: string;
  coveredSessions: ProgressSource[];
}

export function loadProjectProgress(workspace: WorkspaceContext): ProjectProgress | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspace.paths.projectProgress, "utf-8"));
    if (parsed?.version !== 1 || parsed.projectId !== workspace.project.id || typeof parsed.content !== "string") return null;
    return parsed as ProjectProgress;
  } catch {
    return null;
  }
}

export async function generateProjectProgress(workspace: WorkspaceContext, provider: ModelProvider): Promise<ProjectProgress> {
  const store = new SessionStore(workspace);
  const summaries = store.listSessions().filter((item) => item.kind === "chat");
  const previous = loadProjectProgress(workspace);
  const previousMap = new Map((previous?.coveredSessions || []).map((item) => [item.id, item.updatedAt]));
  const changed = summaries.filter((item) => previousMap.get(item.id) !== item.updatedAt);
  const removed = (previous?.coveredSessions || []).some((item) => !summaries.some((current) => current.id === item.id));
  if (previous && changed.length === 0 && !removed) return previous;

  const changedSessions = changed.flatMap((item) => {
    const session = store.loadSession(item.id);
    return session ? [session] : [];
  });
  const skill = loadSkillContent(workspace, "project-progress") || "根据项目会话如实总结当前进展，区分已经完成、正在推进和待处理事项，不推测。";
  const prompt = [
    `项目：${workspace.project.name}`,
    workspace.project.description ? `项目说明：${workspace.project.description}` : "",
    previous ? `上一次自动生成的进度快照（仅供参考，不是项目事实基线）：\n${previous.content}` : "此前没有进度总结。",
    "以下是首次纳入或发生变化的会话。请更新为一份可直接给用户阅读的项目进度。进度是一份可重新生成的当前快照：用户在新会话中的修正或否定优先于旧快照，不要为了维持叙事连续性而保留过时判断。自然地区分用户已确认的内容、助手的阶段性建议和仍未解决的问题，不必套用固定栏目。不要描述生成过程，不要虚构不存在的计划。",
    ...changedSessions.map(formatSessionForProgress),
    removed ? "注意：已有会话被删除，请不要继续保留只能由已删除会话支持的结论。" : "",
  ].filter(Boolean).join("\n\n").slice(0, 180_000);

  const response = await provider.generate({
    messages: [
      { id: "progress-system", role: "system", content: `你正在执行 project-progress Skill。\n\n${skill}`, createdAt: new Date().toISOString() },
      { id: "progress-user", role: "user", content: prompt, createdAt: new Date().toISOString() },
    ],
  });
  const content = response.content?.trim();
  if (!content) throw new Error("模型没有生成可用的项目进度。");
  const result: ProjectProgress = {
    version: 1,
    projectId: workspace.project.id,
    content,
    generatedAt: new Date().toISOString(),
    coveredSessions: summaries.map((item) => ({ id: item.id, title: item.title || "未命名会话", updatedAt: item.updatedAt })),
  };
  saveProjectProgress(workspace, result);
  return result;
}

export function buildProjectSessionDigest(workspace: WorkspaceContext, maxChars: number = 160_000): string {
  const store = new SessionStore(workspace);
  const sessions = store.listSessions()
    .filter((item) => item.kind === "chat")
    .flatMap((item) => {
      const session = store.loadSession(item.id);
      return session ? [formatSessionForProgress(session)] : [];
    });
  return sessions.join("\n\n").slice(0, maxChars);
}

function formatSessionForProgress(session: AgentSession): string {
  const turns = session.turns.length
    ? session.turns.map((turn) => `用户：${clip(turn.userContent, 4000)}\n结果：${clip(turn.finalAnswer || turn.partialAnswerText || "（未形成最终回答）", 8000)}`)
    : session.messages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => `${item.role === "user" ? "用户" : "助手"}：${clip(item.content, 6000)}`);
  return `## 会话：${session.title || session.id}\nID：${session.id}\n更新时间：${session.updatedAt}\n${turns.join("\n\n")}`;
}

function clip(value: string, limit: number): string {
  const normalized = String(value || "").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…（内容已截断）` : normalized;
}

function saveProjectProgress(workspace: WorkspaceContext, progress: ProjectProgress): void {
  fs.mkdirSync(workspace.paths.progressDir, { recursive: true });
  const temp = `${workspace.paths.projectProgress}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(progress, null, 2), "utf-8");
  fs.renameSync(temp, workspace.paths.projectProgress);
}
