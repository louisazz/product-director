import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assignAttachmentLabels, buildWorkspaceContext, createRuntime, hydrateAttachment, isImageAttachment, listStoredProjectFiles, resolveAttachmentOriginal, runRuntime, SessionStore, listProjects, createProject, updateProject, deleteProject, loadProjectProgress, generateProjectProgress, buildProjectSessionDigest, storeProjectAttachment } from "../core/index.js";
import { buildSkillIndex } from "../skills/index.js";
import {
  exceedsSideLimit,
  MAX_IMAGE_SIDE,
  MAX_IMAGE_SIDE_MANY,
  maxSideForImageCount,
  readImageDimensions,
} from "../core/image-dimensions.js";
import { createModelProviderFromSettings, DEFAULT_CHAT_MODEL, getPublicModelCatalog, isModelVendor, modelAcceptsImages, normalizeChatModel, renderAttachmentDirectives, VENDOR_META, type ModelVendor, type RequestedChatModel } from "../model/index.js";
import { createPermissionManagerFromSettings } from "../permissions/index.js";
import { WebConfirmationProvider, WebConfirmationRequiredError } from "./confirmation.js";
import type { AttachmentRef, ChatModelId, ConversationAnnotation, ImageAttachmentRef, SessionTaskState } from "../core/agent-types.js";
import type { AgentSession } from "../core/session.js";
import type { ProjectStatus } from "../core/types.js";

const PORT = parseInt(process.env.WEB_PORT || "7878", 10);
const HOST = process.env.WEB_HOST || "127.0.0.1";
type RequestedProvider = RequestedChatModel;
type IncomingAttachment = Partial<AttachmentRef> & { dataUrl?: string };

export function resolveSessionProvider(session: { modelProvider?: ChatModelId }, requested?: RequestedProvider): RequestedProvider {
  if (session.modelProvider) return session.modelProvider;
  if (requested === "mock") return "mock";
  const selected = normalizeChatModel(requested) ?? DEFAULT_CHAT_MODEL;
  session.modelProvider = selected;
  return selected;
}

// Tracks user-initiated stops for currently running streaming turns.
// Disk state alone is insufficient — streamChat holds an older in-memory
// session object that would otherwise keep appending events after stop.
const runningStops = new Map<string, { runId: string; stopped: boolean; controller: AbortController }>();

function turnRunKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}:${turnIndex}`;
}

// ─── Health handler ──────────────────────────────────────────────────────────

export async function handleHealth(projectId?: string): Promise<{
  ok: boolean;
  workspace: string;
  modelProvider: string;
  toolsAvailable: number;
  skillsAvailable: number;
}> {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const runtime = createRuntime(workspace);
  const skills = buildSkillIndex(workspace);
  return {
    ok: true,
    workspace: workspace.paths.root,
    modelProvider: workspace.settings?.modelProvider ?? "unknown",
    toolsAvailable: runtime.toolRegistry.list().length,
    skillsAvailable: skills.skills.length,
  };
}

// ─── Skills handler ──────────────────────────────────────────────────────────

/**
 * The composer's slash panel needs the same catalog the model sees, so it reads
 * from `buildSkillIndex` rather than keeping a second hardcoded list.
 */
export function handleListSkills(projectId?: string): {
  ok: boolean;
  skills: Array<{ id: string; title: string; description?: string }>;
} {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const skills = buildSkillIndex(workspace).skills.map((skill) => ({
    id: skill.id,
    title: skill.title,
    description: skill.description,
  }));
  return { ok: true, skills };
}

// ─── Sessions handlers ───────────────────────────────────────────────────────

export function handleListSessions(projectId?: string): {
  ok: boolean;
  sessions: Array<{ id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number; modelProvider?: ChatModelId }>;
} {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const sessions = store.listSessions();
  return { ok: true, sessions };
}

export function handleGetSession(id: string, projectId?: string): {
  ok: boolean;
  session?: any;
  error?: string;
} {
  if (!id || id.trim().length === 0) return { ok: false, error: "缺少 id 参数。" };
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const session = store.loadSession(id.trim());
  if (!session) return { ok: false, error: `会话 "${id}" 不存在。` };
  // Older runs could save the final assistant message successfully while a
  // stale in-memory turn object remained "running" without finalAnswer. Recover
  // the already-durable answer before deciding whether the run was interrupted.
  let repaired = repairMissingTurnAnswers(session);
  // A live server run owns every genuinely running turn. If the process was
  // restarted, an old persisted "running" flag must not lock the composer.
  session.turns.forEach((turn, index) => {
    if (turn.status === "running" && !runningStops.has(turnRunKey(session.id, index))) {
      if (turn.finalAnswer || turn.partialAnswerText) {
        turn.status = "completed";
        turn.stoppedAt = undefined;
        turn.resumeSnapshot = undefined;
      } else {
        turn.status = "stopped";
        turn.stoppedAt = new Date().toISOString();
      }
      repaired = true;
    }
  });
  if (repaired) store.saveSession(session);
  // Turns are the WebUI source of truth. Avoid sending the duplicate raw model
  // transcript on long sessions; keep it only for legacy sessions without turns.
  return { ok: true, session: session.turns.length ? { ...session, messages: [] } : session };
}

/** Recover answers saved in the model transcript by older/stale turn writers. */
export function repairMissingTurnAnswers(session: AgentSession): boolean {
  const answers: string[] = [];
  let turnIndex = -1;
  for (const message of session.messages) {
    if (message.role === "user") {
      turnIndex += 1;
      continue;
    }
    if (turnIndex < 0 || message.role !== "assistant" || message.toolCalls?.length) continue;
    const content = message.content?.trim();
    if (content) answers[turnIndex] = content;
  }

  let repaired = false;
  session.turns.forEach((turn, index) => {
    if (turn.finalAnswer || turn.partialAnswerText || !answers[index]) return;
    turn.finalAnswer = answers[index];
    // A transcript answer without a turn answer only occurs after the model has
    // already delivered visible content. Treat it as complete so reload cannot
    // expose a misleading empty "continue" state.
    turn.status = "completed";
    turn.stoppedAt = undefined;
    turn.resumeSnapshot = undefined;
    repaired = true;
  });
  return repaired;
}

export function handleDeleteSession(id: string, projectId?: string): { ok: boolean; error?: string } {
  if (!id || id.trim().length === 0) return { ok: false, error: "缺少 id 参数。" };
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const ok = store.deleteSession(id.trim());
  if (!ok) return { ok: false, error: `会话 "${id}" 不存在或无法删除。` };
  return { ok: true };
}

export async function handleUploadAttachment(
  projectId: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
): Promise<{ ok: true; attachment: AttachmentRef } | { ok: false; error: string }> {
  try {
    const workspace = buildWorkspaceContext(process.cwd(), projectId);
    const attachment = await storeProjectAttachment(workspace, { name, mimeType, bytes });
    return { ok: true, attachment };
  } catch (error: any) {
    return { ok: false, error: error?.message || "附件上传失败。" };
  }
}

export function handleForkSession(
  id: string,
  throughTurnIndex: number,
  projectId?: string,
): {
  ok: boolean;
  session?: { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number; modelProvider?: ChatModelId };
  error?: string;
} {
  if (!id || id.trim().length === 0) return { ok: false, error: "缺少 sessionId。" };
  if (!Number.isInteger(throughTurnIndex) || throughTurnIndex < 0) return { ok: false, error: "分支位置无效。" };

  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const source = store.loadSession(id.trim());
  if (!source) return { ok: false, error: `会话 "${id}" 不存在。` };
  repairMissingTurnAnswers(source);
  if (throughTurnIndex >= source.turns.length) return { ok: false, error: "分支位置超出会话范围。" };

  const selectedTurn = source.turns[throughTurnIndex];
  if (selectedTurn.status === "running") return { ok: false, error: "当前回答仍在生成，完成或停止后才能创建分支。" };
  if (!selectedTurn.finalAnswer && !selectedTurn.partialAnswerText) return { ok: false, error: "这一轮还没有可用于分支的回答。" };

  const sourceTitle = source.title?.trim() || source.turns[0]?.userContent.trim().slice(0, 32) || "新对话";
  const branch = store.createSession(randomUUID(), `${sourceTitle.replace(/（分支(?: \d+)?）$/, "")}（分支）`, "chat");
  branch.modelProvider = source.modelProvider || selectedTurn.modelProvider || DEFAULT_CHAT_MODEL;

  const copiedAttachments = new Map<string, ImageAttachmentRef>();
  const copyAttachment = (attachment: ImageAttachmentRef): ImageAttachmentRef => {
    const key = `${attachment.id}|${attachment.relativePath}`;
    const existing = copiedAttachments.get(key);
    if (existing) return existing;
    const copy = { ...attachment };
    copiedAttachments.set(key, copy);
    return copy;
  };

  try {
    branch.turns = source.turns.slice(0, throughTurnIndex + 1).map((turn) => ({
      ...turn,
      userAnnotations: turn.userAnnotations?.map((annotation) => ({ ...annotation })),
      userAttachments: turn.userAttachments?.map(copyAttachment),
      events: turn.events.map((event) => ({ ...event, data: { ...event.data } })),
      resumeSnapshot: turn.resumeSnapshot ? { ...turn.resumeSnapshot } : undefined,
    }));

    // A branch starts with a clean, valid model transcript. Tool-call internals
    // are intentionally omitted: the visible user input and final answer retain
    // the conversational context without carrying half-completed tool protocol.
    branch.messages = branch.turns.flatMap((turn) => {
      const createdAt = turn.events[0]?.at || source.createdAt || new Date().toISOString();
      const answer = turn.finalAnswer || turn.partialAnswerText || "";
      return [
        {
          id: randomUUID(),
          role: "user" as const,
          content: formatAnnotatedUserMessage(turn.userContent, turn.userAnnotations || []),
          createdAt,
          attachments: turn.userAttachments,
        },
        {
          id: randomUUID(),
          role: "assistant" as const,
          content: answer,
          createdAt,
          modelProvider: turn.modelProvider || source.modelProvider,
        },
      ];
    });
    store.saveSession(branch);
  } catch (error: any) {
    return { ok: false, error: error?.message || "创建分支失败。" };
  }

  return {
    ok: true,
    session: {
      id: branch.id,
      title: branch.title,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      messageCount: branch.turns.length,
      modelProvider: branch.modelProvider,
    },
  };
}

export function handleListProjects() {
  return { ok: true, projects: listProjects(process.cwd()) };
}

export function handleCreateProject(body: { name?: string; description?: string }) {
  if (!body.name?.trim()) return { ok: false, error: "项目名称不能为空。" };
  try {
    return { ok: true, project: createProject(process.cwd(), body.name, body.description) };
  } catch (error: any) {
    return { ok: false, error: error.message || "创建项目失败。" };
  }
}

export function handleUpdateProject(projectId: string, body: { name?: string; description?: string; status?: ProjectStatus }) {
  if (!body.name?.trim()) return { ok: false, error: "项目名称不能为空。" };
  try {
    return { ok: true, project: updateProject(process.cwd(), projectId, body.name, body.description, body.status) };
  } catch (error: any) {
    return { ok: false, error: error.message || "重命名项目失败。" };
  }
}

export function handleDeleteProject(projectId: string) {
  try {
    deleteProject(process.cwd(), projectId);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message || "删除项目失败。" };
  }
}

export type ProjectFileItem = {
  fileId: string;
  name: string;
  mimeType: string;
  absolutePath: string;
  size: number;
  updatedAt: string;
  pageCount?: number;
};

export type ProjectAttachmentReference = AttachmentRef & {
  referenceScope: "project";
  sourceSessionId: string;
  sourceSessionTitle: string;
  sourceTurnIndex: number;
  sourceCreatedAt: string;
};

export function handleListProjectFiles(projectId: string): { ok: true; files: ProjectFileItem[] } {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const files = listStoredProjectFiles(workspace).map((file) => ({
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    absolutePath: file.originalPath,
    size: file.size,
    updatedAt: file.createdAt,
    pageCount: file.pageCount,
  }));
  return { ok: true, files };
}

/** One stable, human-addressable origin for each physical file in this Project. */
export function handleListProjectAttachmentReferences(projectId: string): { ok: true; attachments: ProjectAttachmentReference[] } {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const firstByFileId = new Map<string, ProjectAttachmentReference>();

  for (const summary of store.listSessions()) {
    const session = store.loadSession(summary.id);
    if (!session) continue;
    const sessionTitle = sessionDisplayTitle(session);
    const turns = session.turns.length
      ? session.turns.map((turn, sourceTurnIndex) => ({ attachments: turn.userAttachments || [], sourceTurnIndex, at: turn.events[0]?.at || session.createdAt }))
      : legacyUserAttachmentTurns(session);
    for (const turn of turns) {
      for (const attachment of turn.attachments) {
        if (!attachment.fileId || !attachment.label) continue;
        const candidate: ProjectAttachmentReference = {
          ...stripTransientAttachment(attachment),
          id: referenceAttachmentId("project", session.id, turn.sourceTurnIndex, attachment.fileId),
          referenceScope: "project",
          sourceSessionId: session.id,
          sourceSessionTitle: sessionTitle,
          sourceTurnIndex: turn.sourceTurnIndex,
          sourceCreatedAt: turn.at,
        };
        const current = firstByFileId.get(attachment.fileId);
        if (!current || candidate.sourceCreatedAt < current.sourceCreatedAt) firstByFileId.set(attachment.fileId, candidate);
      }
    }
  }

  return {
    ok: true,
    attachments: [...firstByFileId.values()].sort((left, right) => right.sourceCreatedAt.localeCompare(left.sourceCreatedAt)),
  };
}

function legacyUserAttachmentTurns(session: AgentSession) {
  let sourceTurnIndex = -1;
  return session.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    sourceTurnIndex += 1;
    return [{ attachments: message.attachments || [], sourceTurnIndex, at: message.createdAt || session.createdAt }];
  });
}

function sessionDisplayTitle(session: AgentSession): string {
  return session.title?.trim() || session.turns[0]?.userContent.trim().slice(0, 40) || "未命名对话";
}

function stripTransientAttachment(attachment: AttachmentRef): AttachmentRef {
  const { dataUrl: _dataUrl, extractedText: _extractedText, pages: _pages, oversized: _oversized, ...durable } = attachment;
  return durable;
}

function referenceAttachmentId(scope: "session" | "project", sessionId: string, turnIndex: number, fileId: string): string {
  return `lazyref-${scope}-${sessionId}-${turnIndex}-${fileId}`;
}

export async function handleOpenProjectFile(projectId: string, fileId: string, mode: "open" | "reveal") {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const file = listStoredProjectFiles(workspace).find((item) => item.fileId === fileId);
  if (!file) return { ok: false, error: "文件不存在。" };
  const filePath = file.originalPath;
  const target = mode === "reveal" ? path.dirname(filePath) : filePath;
  if (process.platform === "win32") await launchDetached("explorer.exe", [target], true);
  else await launchDetached(process.platform === "darwin" ? "open" : "xdg-open", [target], false);
  return { ok: true, path: target };
}

async function launchDetached(command: string, args: string[], windowsHide: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function resolveKeyVendor(value: unknown): ModelVendor {
  return isModelVendor(value) ? value : "deepseek";
}

function apiKeyStatus(vendor: ModelVendor) {
  const envName = VENDOR_META[vendor].apiKeyEnv;
  return { ok: true, vendor, configured: Boolean(process.env[envName]?.trim()) };
}

function saveApiKey(vendor: ModelVendor, value?: string) {
  const envName = VENDOR_META[vendor].apiKeyEnv;
  const envPath = path.resolve(process.cwd(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const pattern = new RegExp(`^\\s*${envName}\\s*=`);
  const lines = existing.split(/\r?\n/).filter((line) => !pattern.test(line));
  const key = value?.trim() || "";
  if (key) lines.push(`${envName}=${key}`);
  const next = lines.filter((line, index, values) => line || index < values.length - 1).join("\n").replace(/\n*$/, "\n");
  const tempPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, next, "utf-8");
  fs.renameSync(tempPath, envPath);
  if (key) process.env[envName] = key;
  else delete process.env[envName];
  return apiKeyStatus(vendor);
}

export function handleGetProjectProgress(projectId?: string) {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  return { ok: true, progress: loadProjectProgress(workspace) };
}

export async function handleUpdateProjectProgress(body: { projectId?: string; provider?: RequestedProvider }) {
  const workspace = buildWorkspaceContext(process.cwd(), body.projectId);
  try {
    const provider = createModelProviderFromSettings(workspace.settings, { forceProvider: body.provider });
    const progress = await generateProjectProgress(workspace, provider);
    return { ok: true, progress };
  } catch (error: any) {
    return { ok: false, error: error.message || "生成项目进度失败。" };
  }
}

export function handleListRetrospectives(projectId?: string) {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const sessions = new SessionStore(workspace).listSessions().filter((item) => item.kind === "retrospective");
  return { ok: true, sessions };
}

export function handleStartRetrospective(projectId?: string) {
  const workspace = buildWorkspaceContext(process.cwd(), projectId);
  const store = new SessionStore(workspace);
  const today = new Date().toLocaleDateString("zh-CN");
  const session = store.createSession(`retrospective-${Date.now()}`, `项目复盘 ${today}`, "retrospective");
  store.saveSession(session);
  return {
    ok: true,
    session: { id: session.id, title: session.title, updatedAt: session.updatedAt },
    prompt: "请使用 project-retrospective Skill，对当前项目做一次复盘。先根据需要查找项目资料；结合已有项目进度与相关会话事实，和我一起总结关键转折、有效判断、问题与可迁移经验。信息不足的地方请直接指出。",
  };
}

const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const IMAGE_TOTAL_LIMIT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_COUNT_LIMIT = 60;
export async function persistIncomingAttachments(
  workspace: ReturnType<typeof buildWorkspaceContext>,
  sessionId: string,
  incoming: IncomingAttachment[] | undefined,
  sessionAttachments: AttachmentRef[] = [],
): Promise<AttachmentRef[]> {
  if (!incoming?.length) return [];
  if (incoming.length > ATTACHMENT_COUNT_LIMIT) throw new Error(`每条消息最多发送 ${ATTACHMENT_COUNT_LIMIT} 个附件。`);
  const prepared: AttachmentRef[] = [];
  for (const item of incoming) {
    if (item.referenceScope === "session" || item.referenceScope === "project") {
      prepared.push(resolveRecalledAttachment(workspace, sessionId, item, sessionAttachments));
      continue;
    }
    if (item.fileId && item.relativePath && item.name && item.mimeType && typeof item.size === "number") {
      const existing = { ...item, id: item.id || randomUUID() } as AttachmentRef;
      const filePath = resolveAttachmentOriginal(workspace, existing);
      if (!filePath || !fs.existsSync(filePath)) throw new Error(`找不到附件“${item.name}”。`);
      prepared.push(existing);
      continue;
    }
    const match = String(item.dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error("附件数据无效。");
    const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("单个附件不能超过 64 MB。");
    if (match[1].startsWith("image/")) {
      const detected = detectImageType(bytes);
      if (!detected || detected.mimeType !== match[1]) throw new Error("图片格式与文件内容不一致。");
      const size = readImageDimensions(bytes);
      const imageCount = incoming.filter((candidate) => String(candidate.mimeType || candidate.dataUrl || "").includes("image/")).length;
      const maxSide = maxSideForImageCount(imageCount);
      if (size && exceedsSideLimit(size, maxSide)) {
        throw new Error(
          `图片尺寸 ${size.width}×${size.height} 超出上限：单边最多 ${maxSide} px` +
            `${maxSide === MAX_IMAGE_SIDE_MANY ? `（本条消息含较多图片，上限降为 ${MAX_IMAGE_SIDE_MANY} px）` : ""}。` +
            `长截图请分段裁切后重新发送。`,
        );
      }
    }
    prepared.push(await storeProjectAttachment(workspace, {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType || match[1],
      bytes,
    }));
  }
  const total = prepared.reduce((sum, item) => sum + item.size, 0);
  if (total > 200 * 1024 * 1024) throw new Error("一条消息中的附件合计不能超过 200 MB。");
  return assignAttachmentLabels(prepared, sessionAttachments);
}

function resolveRecalledAttachment(
  workspace: ReturnType<typeof buildWorkspaceContext>,
  currentSessionId: string,
  requested: IncomingAttachment,
  currentSessionAttachments: AttachmentRef[],
): AttachmentRef {
  const fileId = String(requested.fileId || "");
  const sourceSessionId = String(requested.sourceSessionId || "");
  const sourceTurnIndex = Number(requested.sourceTurnIndex);
  if (!fileId || !sourceSessionId || !Number.isInteger(sourceTurnIndex) || sourceTurnIndex < 0) {
    throw new Error("附件来源无效，请重新选择。");
  }
  if (requested.referenceScope === "session" && !currentSessionAttachments.some((attachment) => attachment.fileId === fileId)) {
    throw new Error("这个附件不在当前对话中，请改用 @@@ 调取。");
  }

  const store = new SessionStore(workspace);
  const sourceSession = store.loadSession(sourceSessionId);
  const sourceAttachment = sourceSession ? attachmentAtTurn(sourceSession, sourceTurnIndex, fileId) : undefined;
  if (!sourceSession || !sourceAttachment) throw new Error("附件来源对话已不存在，请重新选择。");
  const filePath = resolveAttachmentOriginal(workspace, sourceAttachment);
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`找不到附件“${sourceAttachment.name}”。`);

  return {
    ...stripTransientAttachment(sourceAttachment),
    id: requested.id || randomUUID(),
    referenceScope: requested.referenceScope,
    sourceSessionId,
    sourceSessionTitle: sessionDisplayTitle(sourceSession),
    sourceTurnIndex,
    sourceCreatedAt: sourceSession.turns[sourceTurnIndex]?.events[0]?.at || sourceSession.createdAt,
  };
}

function attachmentAtTurn(session: AgentSession, turnIndex: number, fileId: string): AttachmentRef | undefined {
  if (session.turns.length) return session.turns[turnIndex]?.userAttachments?.find((attachment) => attachment.fileId === fileId);
  let userIndex = -1;
  for (const message of session.messages) {
    if (message.role !== "user") continue;
    userIndex += 1;
    if (userIndex === turnIndex) return message.attachments?.find((attachment) => attachment.fileId === fileId);
  }
  return undefined;
}

function collectSessionAttachments(session: import("../core/session.js").AgentSession): AttachmentRef[] {
  return [
    ...session.turns.flatMap((turn) => turn.userAttachments || []),
    ...session.messages.flatMap((message) => message.attachments || []),
  ];
}

function detectImageType(bytes: Buffer): { mimeType: ImageAttachmentRef["mimeType"]; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return { mimeType: "image/gif", extension: "gif" };
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  return null;
}

function extensionForMimeType(mimeType: ImageAttachmentRef["mimeType"]): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function safeAttachmentSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/^\./, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "session";
}

export function hydrateAttachments(
  workspace: ReturnType<typeof buildWorkspaceContext>,
  attachments: ImageAttachmentRef[] | undefined,
): ImageAttachmentRef[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => {
    const filePath = resolveStoredAttachment(workspace, attachment);
    if (!filePath || !fs.existsSync(filePath)) return { ...attachment };
    if (!isImageAttachment(attachment)) {
      return hydrateAttachment(workspace, attachment);
    }
    const bytes = fs.readFileSync(filePath);
    // Attachments stored before the dimension check existed may exceed the
    // API's per-side limit. Replaying one poisons every later turn with the
    // same 400, so drop the payload and keep the reference for the UI.
    const size = readImageDimensions(bytes);
    if (size && exceedsSideLimit(size, MAX_IMAGE_SIDE)) return { ...attachment, oversized: true };
    return { ...attachment, dataUrl: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
  });
}

function describeLoadedAttachments(attachments: ImageAttachmentRef[]) {
  return attachments.map((attachment) => {
    const image = isImageAttachment(attachment);
    const base = {
      label: attachment.label || (image ? "图片" : "文件"),
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: image ? "image" : "file",
    };
    if (image) {
      if (attachment.dataUrl) return { ...base, ok: true, detail: "原图已进入上下文" };
      if (attachment.oversized) return { ...base, ok: false, detail: "图片尺寸超出接口上限，未能进入上下文" };
      return { ...base, ok: false, detail: "图片内容未能载入" };
    }
    if (attachment.mimeType === "application/pdf") {
      const pagesLoaded = attachment.pages?.length || 0;
      const hasText = Boolean(attachment.extractedText);
      const parts = [hasText ? "全文文字" : "", pagesLoaded ? `${pagesLoaded} 页页面图` : ""].filter(Boolean);
      if (parts.length) {
        const pageLimit = attachment.pageCount && pagesLoaded < attachment.pageCount
          ? `（共 ${attachment.pageCount} 页）`
          : "";
        return { ...base, ok: true, detail: `${parts.join(" + ")}已进入上下文${pageLimit}` };
      }
      return { ...base, ok: false, detail: "PDF 内容未能载入" };
    }
    if (attachment.extractedText) return { ...base, ok: true, detail: "全文文字已进入上下文" };
    return { ...base, ok: false, detail: "当前暂不支持读取这种文件" };
  });
}

function hydrateMessageAttachments(
  workspace: ReturnType<typeof buildWorkspaceContext>,
  messages: import("../core/agent-types.js").AgentMessage[],
) {
  return messages.map((message) => ({
    ...message,
    attachments: hydrateAttachments(workspace, message.attachments),
  }));
}

function resolveStoredAttachment(
  workspace: ReturnType<typeof buildWorkspaceContext>,
  attachment: ImageAttachmentRef,
): string | null {
  return resolveAttachmentOriginal(workspace, attachment);
}

function findSessionAttachment(session: ReturnType<SessionStore["loadSession"]>, id: string): ImageAttachmentRef | undefined {
  if (!session) return undefined;
  for (const turn of session.turns) {
    const match = turn.userAttachments?.find((item) => item.id === id);
    if (match) return match;
  }
  for (const message of session.messages) {
    const match = message.attachments?.find((item) => item.id === id);
    if (match) return match;
  }
  return undefined;
}

// ─── Chat handler ────────────────────────────────────────────────────────────

export async function handleChat(body: {
  message: string;
  provider?: RequestedProvider;
  sessionId?: string;
  confirmationOverride?: { id: string; decision: "allow" | "deny" };
  maxSteps?: number;
  projectId?: string;
}): Promise<{
  ok: boolean;
  text?: string;
  session?: { id: string; title?: string; messageCount: number; updatedAt: string };
  trace?: { steps: number; stopReason: string; modelProvider: string; toolCallsExecuted: number };
  error?: string;
  needsConfirmation?: boolean;
  confirmation?: { id: string; toolName: string; category: string; inputPreview: string; message: string };
}> {
  if (!body.message || body.message.trim().length === 0) {
    return { ok: false, error: "消息不能为空。" };
  }

  const workspace = buildWorkspaceContext(process.cwd(), body.projectId);

  // Handle deny upfront
  if (body.confirmationOverride?.decision === "deny") {
    return { ok: false, error: "操作已被用户拒绝。" };
  }

  const confirmationProvider = new WebConfirmationProvider({
    approvedConfirmationId: body.confirmationOverride?.decision === "allow"
      ? body.confirmationOverride.id
      : undefined,
  });

  const permissionManager = createPermissionManagerFromSettings(
    workspace.settings,
    confirmationProvider
  );

  // Session handling
  let session: ReturnType<typeof SessionStore.prototype.createSession> | null = null;
  let historyMessages;
  const store = new SessionStore(workspace);

  if (body.sessionId) {
    session = store.loadSession(body.sessionId);
    if (!session) {
      session = store.createSession(body.sessionId, body.message.slice(0, 40));
    }
    historyMessages = session.messages;
  }

  const selectedProvider = session ? resolveSessionProvider(session, body.provider) : (body.provider ?? DEFAULT_CHAT_MODEL);
  if (session) store.saveSession(session);
  let modelProvider;
  try {
    modelProvider = createModelProviderFromSettings(workspace.settings, { forceProvider: selectedProvider });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
  const runtime = createRuntime(workspace, modelProvider, undefined, permissionManager);

  let result;
  try {
    const maxStepsClamped = clampMaxSteps(body.maxSteps);
    result = await runRuntime(runtime, body.message, { historyMessages: historyMessages ? hydrateMessageAttachments(workspace, historyMessages) : undefined, taskState: session?.taskState, contextState: session?.contextState, maxSteps: maxStepsClamped || undefined, sessionId: session?.id, turnIndex: session?.turns.length });
  } catch (err: any) {
    if (err instanceof WebConfirmationRequiredError) {
      // Build display messages from pending new messages (before confirmation)
      const pnm = (err as any).pendingNewMessages as any[] | undefined;
      const displayMsgs: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (pnm) {
        for (const m of pnm) {
          if ((m.role === "user" || m.role === "assistant") && m.content) {
            displayMsgs.push({ role: m.role, content: m.content });
          }
        }
      }
      pendingConfirmations.set(err.confirmationId, {
        id: err.confirmationId,
        toolName: err.toolName,
        category: err.category,
        rawInput: err.rawInput,
        sessionId: body.sessionId,
        projectId: body.projectId,
        sessionTitle: body.message.slice(0, 40),
        displayMessagesBeforeConfirmation: displayMsgs.length > 0 ? displayMsgs : undefined,
        toolCallId: (err as any).toolCallId,
        createdAt: new Date().toISOString(),
      });
      return {
        ok: false,
        error: `需要确认：${err.message}`,
        needsConfirmation: true,
        confirmation: {
          id: err.confirmationId,
          toolName: err.toolName,
          category: err.category,
          inputPreview: err.inputPreview,
          message: err.message,
        },
      };
    }
    return { ok: false, error: `模型调用失败：${err.message}` };
  }

  // Save session only on successful completion
  if (session && result.agentRun.newMessages.length > 0) {
    session.messages.push(...result.agentRun.newMessages.map((message) => message.role === "assistant" && session?.modelProvider
      ? { ...message, modelProvider: session.modelProvider }
      : message));
    session.contextState = result.contextState;
    session.taskState = makeTaskState(body.message);
    store.saveSession(session);

  }

  const totalToolCalls = result.agentRun.steps.reduce(
    (sum, step) => sum + step.toolResults.length, 0
  );

  return {
    ok: true,
    text: result.outputText,
    session: session ? {
      id: session.id,
      title: session.title,
      messageCount: session.messages.length,
      updatedAt: session.updatedAt,
    } : undefined,
    trace: {
      steps: result.agentRun.steps.length,
      stopReason: result.agentRun.stopReason,
      modelProvider: runtime.modelProvider.name,
      toolCallsExecuted: totalToolCalls,
    },
  };
}

// ─── Confirmation store ────────────────────────────────────────────────────────

interface PendingConfirmation {
  id: string;
  toolName: string;
  category: string;
  rawInput: Record<string, unknown>;
  sessionId?: string;
  projectId?: string;
  sessionTitle?: string;
  displayMessagesBeforeConfirmation?: Array<{ role: "user" | "assistant"; content: string }>;
  toolCallId?: string;
  createdAt: string;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();


const CONFIRMATION_TTL_MS = 20 * 60 * 1000; // 20 minutes

function cleanExpiredConfirmations() {
  const now = Date.now();
  for (const [id, entry] of pendingConfirmations) {
    if (now - new Date(entry.createdAt).getTime() > CONFIRMATION_TTL_MS) {
      pendingConfirmations.delete(id);
    }
  }
}
export async function handleConfirmation(body: {
  id: string;
  decision: "allow" | "deny";
}): Promise<{ ok: boolean; error?: string; result?: { content: string; ok: boolean; error?: string }; session?: { id: string; title?: string; messageCount: number; updatedAt: string } }> {
  cleanExpiredConfirmations();
  const pending = pendingConfirmations.get(body.id);
  if (!pending) return { ok: false, error: "确认请求不存在或已过期。" };

  if (body.decision === "deny") {
    pendingConfirmations.delete(body.id);
    return { ok: true };
  }

  const workspace = buildWorkspaceContext(process.cwd(), pending.projectId);
  const runtime = createRuntime(workspace);

  const tool = runtime.toolRegistry.get(pending.toolName);
  if (!tool) {
    pendingConfirmations.delete(body.id);
    return { ok: false, error: `工具 "${pending.toolName}" 未找到。` };
  }

  try {
    const execResult = await tool.execute(pending.rawInput, { workspace });

    // Save to session
    let sessionInfo: { id: string; title?: string; messageCount: number; updatedAt: string } | undefined;
    if (pending.sessionId) {
      const store = new SessionStore(workspace);
      let session = store.loadSession(pending.sessionId);
      if (!session) {
        session = store.createSession(pending.sessionId, pending.sessionTitle);
      }

      // Append display messages (user + assistant texts before confirmation)
      // Simple dedup: skip if last session message has same role+content
      if (pending.displayMessagesBeforeConfirmation) {
        for (const dm of pending.displayMessagesBeforeConfirmation) {
          const last = session.messages.length > 0 ? session.messages[session.messages.length - 1] : null;
          if (last && last.role === dm.role && last.content === dm.content) continue;
          session.messages.push({
            id: randomUUID(),
            role: dm.role,
            content: dm.content,
            createdAt: new Date().toISOString(),
          });
        }
      }

      // Append confirmation result with full execResult content
      const resultText = execResult.ok
        ? execResult.content
        : `操作失败：${execResult.error || "未知错误"}`;
      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: `已执行确认操作。\n\n工具：${pending.toolName}\n\n${resultText}`,
        createdAt: new Date().toISOString(),
      });

      store.saveSession(session);
      sessionInfo = { id: session.id, title: session.title, messageCount: session.messages.length, updatedAt: session.updatedAt };
    }

    pendingConfirmations.delete(body.id);
    return { ok: true, result: { content: execResult.content, ok: execResult.ok, error: execResult.error }, session: sessionInfo };
  } catch (err: any) {
    pendingConfirmations.delete(body.id);
    return { ok: false, error: `工具执行失败：${err.message}` };
  }
}

// ─── Static file helpers ──────────────────────────────────────────────────────

const STATIC_DIR = (() => {
  // Always resolve to src/web/static, even when running from dist/
  const fromDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "static");
  if (fs.existsSync(fromDist)) return fromDist;
  // Fallback: running from dist/, find source static files
  const fromSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "web", "static");
  if (fs.existsSync(fromSrc)) return fromSrc;
  return fromDist;
})();

function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// ─── SSE streaming handler ────────────────────────────────────────────────────

type SSEWriter = (event: string, data: unknown) => void;

function clampMaxSteps(raw: unknown): number {
  if (raw === undefined || raw === null) return 0; // 0 means "use default"
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(Math.round(n), 96);
}

function makeTaskState(lastUserInput: string): SessionTaskState {
  return {
    schemaVersion: 4,
    lastUserInput,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeConversationAnnotations(value: unknown): ConversationAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConversationAnnotation[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const selectedText = typeof raw.selectedText === "string" ? raw.selectedText.trim() : "";
    const comment = typeof raw.comment === "string" ? raw.comment.trim() : "";
    const sourceTurnIndex = Number(raw.sourceTurnIndex);
    const sourceKind = raw.sourceKind === "answer" ? "answer" : undefined;
    if (!selectedText || !Number.isInteger(sourceTurnIndex) || sourceTurnIndex < 0 || !sourceKind) return [];
    return [{
      id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
      sourceTurnIndex,
      sourceKind,
      selectedText,
      comment,
    }];
  });
}

/** Turn precise UI comments into one ordinary, transparent user message. */
export function formatAnnotatedUserMessage(message: string, annotations: ConversationAnnotation[]): string {
  const blocks = annotations.map((annotation, index) => [
    `${index + 1}. 关于第 ${annotation.sourceTurnIndex + 1} 轮正式回答中的内容：`,
    annotation.selectedText.split("\n").map((line) => `> ${line}`).join("\n"),
    annotation.comment ? `批注：${annotation.comment}` : "（用户将这段内容添加为本轮关注上下文）",
  ].join("\n"));
  const text = message.trim();
  if (!blocks.length) return text;
  return ["[用户对既有内容的批注]", blocks.join("\n\n"), text ? `[用户补充]\n${text}` : ""].filter(Boolean).join("\n\n");
}

async function streamChat(
  body: { message: string; annotations?: ConversationAnnotation[]; attachments?: IncomingAttachment[]; provider?: RequestedProvider; sessionId?: string; maxSteps?: number; projectId?: string; resumeTurnIndex?: number },
  write: SSEWriter,
): Promise<{ session?: { id: string; title?: string; messageCount: number } }> {
  const workspace = buildWorkspaceContext(process.cwd(), body.projectId);
  const store = new SessionStore(workspace);
  const annotations = normalizeConversationAnnotations(body.annotations);
  const titleSeed = renderAttachmentDirectives(body.message).trim() || annotations[0]?.comment || annotations[0]?.selectedText || body.attachments?.[0]?.name || "图片对话";
  let session = body.sessionId
    ? (store.loadSession(body.sessionId) || store.createSession(body.sessionId, titleSeed.slice(0, 40)))
    : store.createSession(randomUUID(), titleSeed.slice(0, 40));
  const selectedProvider = resolveSessionProvider(session, body.provider);
  if (selectedProvider !== "mock" && !modelAcceptsImages(selectedProvider) && body.attachments?.length) {
    throw new Error("这个会话锁定的模型不能读取附件。请新建会话并选择支持图片的模型。");
  }
  const modelProvider = createModelProviderFromSettings(workspace.settings, { forceProvider: selectedProvider });
  const permissionManager = createPermissionManagerFromSettings(
    workspace.settings,
    new WebConfirmationProvider(),
  );
  const resumeIndex = Number.isInteger(body.resumeTurnIndex) ? Number(body.resumeTurnIndex) : -1;
  const resumingTurn = resumeIndex >= 0 ? session.turns[resumeIndex] : undefined;
  if (resumeIndex >= 0 && (!resumingTurn || resumingTurn.status !== "stopped")) {
    throw new Error("只能继续一个已经停止的生成。请刷新会话后重试。");
  }
  const rawUserMessage = body.message;
  const attachmentRefs = resumingTurn?.userAttachments
    || await persistIncomingAttachments(workspace, session.id, body.attachments, collectSessionAttachments(session));
  const effectiveMessage = resumingTurn
    ? formatAnnotatedUserMessage(resumingTurn.userContent, resumingTurn.userAnnotations || [])
    : formatAnnotatedUserMessage(rawUserMessage, annotations);
  const resumedPrefix = resumingTurn?.partialAnswerText?.trimEnd() || "";
  let historyMessages = hydrateMessageAttachments(workspace, session.messages.slice());
  if (!resumingTurn) {
    // Persist user input before generation so refresh and explicit stop cannot lose it.
    const userMsgForSession = {
      id: randomUUID(),
      role: "user" as const,
      content: effectiveMessage,
      createdAt: new Date().toISOString(),
      attachments: attachmentRefs,
    };
    session.messages.push(userMsgForSession);
    historyMessages = hydrateMessageAttachments(workspace, session.messages.filter((message) => message.id !== userMsgForSession.id));
  } else {
    // The stopped turn's user message is supplied afresh to the model. Remove only
    // its latest persisted occurrence from history to avoid a duplicate prompt.
    let originalIndex = -1;
    for (let index = historyMessages.length - 1; index >= 0; index--) {
      if (historyMessages[index].role === "user" && historyMessages[index].content === effectiveMessage) {
        originalIndex = index;
        break;
      }
    }
    if (originalIndex >= 0) historyMessages.splice(originalIndex, 1);
  }
  store.saveSession(session);

  const runtime = createRuntime(workspace, modelProvider, undefined, permissionManager);

  write("start", {});
  if (session) {
    write("session", { id: session.id, title: session.title, messageCount: session.messages.length, modelProvider: session.modelProvider });
  }

  // Create the turn upfront so events are persisted incrementally.
  // This ensures stop+refresh retains all timeline events collected so far.
  const currentTurnEvents: import("../core/agent-types.js").TurnEvent[] = resumingTurn ? [...resumingTurn.events] : [];
  let activeTurnIndex = -1;
  let activeRunKey: string | null = null;
  const activeRunId = randomUUID();
  const runAbortController = new AbortController();
  // User stop must stop persisted timeline; browser refresh/close must not.
  const isTurnStopped = () => {
    if (!activeRunKey) return false;
    const active = runningStops.get(activeRunKey);
    return !active || active.runId !== activeRunId || active.stopped;
  };

  const turn: import("../core/agent-types.js").AgentTurn = resumingTurn || {
    userContent: body.message,
    userAnnotations: annotations,
    userAttachments: attachmentRefs,
    modelProvider: session.modelProvider,
    events: currentTurnEvents,
    status: "running",
  };
  turn.events = currentTurnEvents;
  turn.status = "running";
  turn.modelProvider = session.modelProvider;
  turn.stoppedAt = undefined;
  if (session) {
    if (!resumingTurn) session.turns.push(turn);
    activeTurnIndex = resumingTurn ? resumeIndex : session.turns.length - 1;
    activeRunKey = turnRunKey(session.id, activeTurnIndex);
    runningStops.set(activeRunKey, { runId: activeRunId, stopped: false, controller: runAbortController });
    store.saveSession(session);
    // Send turnIndex to client so stopGeneration() can target this exact turn
    write("turn_info", { turnIndex: activeTurnIndex, status: "running" });
  }

  // Keep only the minimal durable task state. After stop, runRuntime may keep
  // running but we must not save its post-stop results.

  const pushEvent = (type: string, data: Record<string, unknown>) => {
    // User stop must stop persisted timeline, not just browser close
    if (isTurnStopped()) return;
    currentTurnEvents.push({ type, data, at: new Date().toISOString() });
  };

  // Save the turn incrementally (not on every event, but at key milestones)
  let saveCount = 0;
  const saveTurnIncremental = () => {
    if (session && !isTurnStopped()) {
      try { store.saveSession(session); } catch {}
    }
  };

  // Accumulate token text between thinking_start/thinking_end for replay
  let currentThinkingText = '';

  const observer = {
    onStart() {},
    onStatus(message: string) {
      write("status", { message });
    },
    onAnswerStart() {
      if (!isTurnStopped()) write("answer_start", { preserveExisting: Boolean(resumedPrefix) });
    },
    onAnswerToken(text: string) {
      if (!isTurnStopped()) write("answer_delta", { text });
    },
    onAnswerEnd(text: string) {
      if (!isTurnStopped()) write("answer_end", { textLength: text.length });
    },
    onAnswerAbort() {
      if (!isTurnStopped()) write("answer_abort", {});
    },
    onAssistantText(text: string) {
      if (isTurnStopped() || !text) return;
      const data = { text };
      write("assistant_text", data);
      const previous = currentTurnEvents.at(-1);
      if (previous?.type === "assistant_text") {
        previous.data = { ...previous.data, text: String(previous.data.text || "") + text };
      } else {
        pushEvent("assistant_text", data);
      }
    },
    onReasoningToken(text: string) {
      write("reasoning_token", { text });
      currentThinkingText += text;
    },
    onModelStep(stepIndex: number, stopReason: string, contentPreview: string) {
      write("model_step", { index: stepIndex, stopReason, contentPreview });
    },
    onToolCall(toolCall: { id?: string; name: string; input: Record<string, unknown> }) {
      const data = {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
        inputPreview: JSON.stringify(toolCall.input).slice(0, 300),
      };
      write("tool_call", data);
      pushEvent("tool_call", data);
    },
    onToolResult(result: { toolCallId?: string; name: string; ok: boolean; contentPreview: string }) {
      const data = { toolCallId: result.toolCallId, toolName: result.name, ok: result.ok, contentPreview: result.contentPreview };
      write("tool_result", data);
      pushEvent("tool_result", data);
      saveTurnIncremental();
    },
    onFinal(text: string) {
      if (!isTurnStopped()) {
        const finalText = resumedPrefix ? `${resumedPrefix}\n\n${text}` : text;
        write("final", { text: finalText });
      }
    },
    onThinkingStart(phase: string) {
      currentThinkingText = '';
      const td = { phase, startTime: Date.now() };
      write("thinking_start", { phase });
      pushEvent("thinking_start", td);
    },
    onThinkingEnd(phase: string) {
      // Compute duration from the matching thinking_start
      const bodyText = currentThinkingText;
      currentThinkingText = '';
      const td2: Record<string, unknown> = { phase, duration: 0 };
      if (bodyText) td2.bodyText = bodyText;
      for (let ei = currentTurnEvents.length - 1; ei >= 0; ei--) {
        if (currentTurnEvents[ei].type === "thinking_start" && (currentTurnEvents[ei].data as any).phase === phase) {
          const startTime = (currentTurnEvents[ei].data as any).startTime as number;
          if (startTime) td2.duration = Math.round((Date.now() - startTime) / 100) / 10;
          break;
        }
      }
      write("thinking_end", { phase });
      pushEvent("thinking_end", td2);
      saveTurnIncremental();
    },
    onThinkingDiscard(phase: string) {
      for (let index = currentTurnEvents.length - 1; index >= 0; index--) {
        const event = currentTurnEvents[index];
        if (event.type === "thinking_start" && (event.data as any).phase === phase) {
          currentTurnEvents.splice(index);
          break;
        }
      }
      currentThinkingText = "";
      write("thinking_discard", { phase });
      saveTurnIncremental();
    },
  };

  let resumeContext: string | undefined;
  if (resumingTurn) {
    resumeContext = [
        "[继续上次任务]",
        "",
        "这是用户通过界面明确要求续跑的上一轮任务。请从停止处继续，不要从头重新开始。",
        "",
        "上一轮用户目标：",
        resumingTurn.userContent,
        "",
        "上一轮已经输出的部分回答：",
        resumingTurn.partialAnswerText || "(无)",
        "",
        "继续要求：",
        "- 不要重新生成开头部分。",
        "- 不要重复已经输出过的分析。",
        "- 如果已经包含完整段落，请从后续未完成部分继续。",
        "- 如确实缺少必要资料，可以读取缺失资料；但不要无意义地重复读取上一轮已经处理过的全部文件。",
      ].join("\n");
  } else if (session?.kind === "retrospective" && session.turns.length === 1) {
    const progress = loadProjectProgress(workspace);
    const digest = buildProjectSessionDigest(workspace);
    resumeContext = [
      "[项目复盘的确定性资料]",
      progress ? `当前项目进度：\n${progress.content}` : "当前项目尚未生成进度总结。",
      digest ? `项目会话摘要：\n${digest}` : "当前项目没有可用于复盘的普通会话。",
      "这些内容只作为复盘材料。仍需根据用户问题决定是否读取项目文档，不要把摘要中没有的信息补成事实。",
    ].join("\n\n");
  }

  try {
    const maxStepsClamped = clampMaxSteps(body.maxSteps);
    const hydratedUserAttachments = hydrateAttachments(workspace, attachmentRefs);
    if (!resumingTurn && hydratedUserAttachments?.length) {
      const data = { items: describeLoadedAttachments(hydratedUserAttachments) };
      write("attachments_loaded", data);
      pushEvent("attachments_loaded", data);
      saveTurnIncremental();
    }
    const result = await runRuntime(runtime, effectiveMessage, {
      historyMessages, observer,
      taskState: session?.taskState,
      contextState: session?.contextState,
      maxSteps: maxStepsClamped || undefined,
      resumeContext,
      resumeIntent: Boolean(resumingTurn) || undefined,
      sessionId: session?.id,
      turnIndex: activeTurnIndex,
      signal: runAbortController.signal,
      userAttachments: hydratedUserAttachments,
    });

    // Save messages and task state only if not stopped. Incremental saves own
    // the pre-stop state; post-stop results from a stale run must be discarded.
    if (session && result.agentRun.newMessages.length > 0 && !isTurnStopped()) {
      const newMsgs = result.agentRun.newMessages
        .filter((m: any) => !(m.role === "user" && m.content === effectiveMessage))
        .map((message: any) => resumedPrefix && message.role === "assistant" && !message.toolCalls?.length && message.content === result.agentRun.finalText
          ? { ...message, content: `${resumedPrefix}\n\n${message.content}` }
          : message)
        .map((message: any) => message.role === "assistant" && session?.modelProvider
          ? { ...message, modelProvider: session.modelProvider }
          : message);
      session.messages.push(...newMsgs);
      session.contextState = result.contextState;
      session.taskState = makeTaskState(effectiveMessage);
      store.saveSession(session);

      write("session", { id: session.id, title: session.title, messageCount: session.messages.length, modelProvider: session.modelProvider });
    }

    // Update the turn with final data only if this exact run was not stopped.
    // The stop API updates runningStops while this streamChat still holds
    // an older in-memory session object, so we check runningStops here.
    if (session && !isTurnStopped()) {
      const freshSession = store.loadSession(session.id);
      const freshTurn = activeTurnIndex >= 0 ? freshSession?.turns?.[activeTurnIndex] : undefined;
      if (!freshTurn || freshTurn.status !== "stopped") {
        const turnStatus = (result.agentRun.stopReason === "length" || result.agentRun.stopReason === "max_steps") ? "stopped" : "completed";
        // saveSession() sanitizes and replaces nested arrays, so the original
        // `turn` reference may be stale after incremental saves. Always update
        // the turn currently owned by the Session snapshot.
        const durableTurn = session.turns[activeTurnIndex] || turn;
        durableTurn.status = turnStatus;
        durableTurn.finalAnswer = result.agentRun.finalText
          ? (resumedPrefix ? `${resumedPrefix}\n\n${result.agentRun.finalText}` : result.agentRun.finalText)
          : undefined;
        if (turnStatus === "stopped") {
          durableTurn.partialAnswerText = durableTurn.finalAnswer;
          durableTurn.stoppedAt = new Date().toISOString();
          durableTurn.resumeSnapshot = {
            stoppedAt: durableTurn.stoppedAt,
            previousUserGoal: durableTurn.userContent,
            partialAnswerText: durableTurn.partialAnswerText,
          };
        } else {
          durableTurn.partialAnswerText = undefined;
          durableTurn.stoppedAt = undefined;
          durableTurn.resumeSnapshot = undefined;
        }
        store.saveSession(session);
        write("turn_info", { turnIndex: activeTurnIndex, status: turnStatus });
      }
    }

    write("done", {});
    if (activeRunKey && runningStops.get(activeRunKey)?.runId === activeRunId) runningStops.delete(activeRunKey);
    return {
      session: session ? { id: session.id, title: session.title, messageCount: session.messages.length } : undefined,
    };
  } catch (err: any) {
    if (isTurnStopped()) {
      write("done", {});
      if (activeRunKey && runningStops.get(activeRunKey)?.runId === activeRunId) runningStops.delete(activeRunKey);
      return {};
    }
    if (err instanceof WebConfirmationRequiredError) {
      const pnm2 = (err as any).pendingNewMessages as any[] | undefined;
      const displayMsgs2: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (pnm2) {
        for (const m of pnm2) {
          if ((m.role === "user" || m.role === "assistant") && m.content) {
            displayMsgs2.push({ role: m.role, content: m.content });
          }
        }
      }
      pendingConfirmations.set(err.confirmationId, {
        id: err.confirmationId,
        toolName: err.toolName,
        category: err.category,
        rawInput: err.rawInput,
        sessionId: body.sessionId,
        projectId: body.projectId,
        sessionTitle: body.message.slice(0, 40),
        displayMessagesBeforeConfirmation: displayMsgs2.length > 0 ? displayMsgs2 : undefined,
        toolCallId: (err as any).toolCallId,
        createdAt: new Date().toISOString(),
      });
      write("confirmation", {
        id: err.confirmationId,
        toolName: err.toolName,
        category: err.category,
        inputPreview: err.inputPreview,
        message: err.message,
      });
    } else {
      console.error("[streamChat error]", err.message || err, err.stack || "");
      write("error", { message: err.message || "Unknown error" });
      // Mark turn as error — unless the user already stopped it
      if (session && !isTurnStopped()) {
        const freshSession = store.loadSession(session.id);
        const freshTurn = activeTurnIndex >= 0 ? freshSession?.turns?.[activeTurnIndex] : undefined;
        if (!freshTurn || freshTurn.status !== "stopped") {
          const durableTurn = session.turns[activeTurnIndex] || turn;
          durableTurn.status = "error";
        }
      }
    }
    // Persist latest state only if this run was not stopped
    if (session && !isTurnStopped()) store.saveSession(session);
    write("done", {});
    if (activeRunKey && runningStops.get(activeRunKey)?.runId === activeRunId) runningStops.delete(activeRunKey);
    return {};
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    try {
      // GET /
      if (req.method === "GET" && url.pathname === "/") {
        serveStaticFile(res, path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8");
        return;
      }

      // GET /static/*
      if (req.method === "GET" && url.pathname.startsWith("/static/")) {
        const relative = decodeURIComponent(url.pathname.slice("/static/".length));
        const filePath = path.resolve(STATIC_DIR, relative);
        const staticRoot = path.resolve(STATIC_DIR);
        if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Forbidden");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes: Record<string, string> = {
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".map": "application/json; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".woff2": "font/woff2",
        };
        const ct = contentTypes[ext] || "application/octet-stream";
        serveStaticFile(res, filePath, ct);
        return;
      }

      // GET /api/health
      if (req.method === "GET" && url.pathname === "/api/health") {
        const result = await handleHealth(url.searchParams.get("projectId") || undefined);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // Project navigation and project-level views.
      if (req.method === "GET" && url.pathname === "/api/projects") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(handleListProjects()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/projects") {
        const raw = await readBody(req);
        let body: { name?: string; description?: string; status?: ProjectStatus };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = handleCreateProject(body);
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      const projectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute && req.method === "PATCH") {
        const projectId = decodeURIComponent(projectRoute[1]);
        const raw = await readBody(req);
        let body: { name?: string; description?: string; status?: ProjectStatus };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = handleUpdateProject(projectId, body);
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (projectRoute && req.method === "DELETE") {
        const result = handleDeleteProject(decodeURIComponent(projectRoute[1]));
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      const projectAttachmentRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/attachments$/);
      if (projectAttachmentRoute && req.method === "POST") {
        const projectId = decodeURIComponent(projectAttachmentRoute[1]);
        let name = "file";
        try { name = decodeURIComponent(String(req.headers["x-lazy-filename"] || "file")); } catch {}
        const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";", 1)[0];
        const result = await handleUploadAttachment(projectId, name, mimeType, await readBuffer(req, 64 * 1024 * 1024));
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      const projectFilesRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/files$/);
      if (projectFilesRoute && req.method === "GET") {
        const result = handleListProjectFiles(decodeURIComponent(projectFilesRoute[1]));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      const projectAttachmentReferencesRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/attachment-references$/);
      if (projectAttachmentReferencesRoute && req.method === "GET") {
        const result = handleListProjectAttachmentReferences(decodeURIComponent(projectAttachmentReferencesRoute[1]));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      const projectFileContentRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/);
      if (projectFileContentRoute && req.method === "GET") {
        const projectId = decodeURIComponent(projectFileContentRoute[1]);
        const fileId = decodeURIComponent(projectFileContentRoute[2]);
        const fileWorkspace = buildWorkspaceContext(process.cwd(), projectId);
        const file = listStoredProjectFiles(fileWorkspace).find((item) => item.fileId === fileId);
        if (!file || !fs.existsSync(file.originalPath)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("File not found");
          return;
        }
        res.setHeader("Cache-Control", "private, max-age=3600");
        res.setHeader("X-Content-Type-Options", "nosniff");
        serveStaticFile(res, file.originalPath, file.mimeType);
        return;
      }

      const projectFileOpenRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/open$/);
      if (projectFileOpenRoute && req.method === "POST") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}");
        const result = await handleOpenProjectFile(
          decodeURIComponent(projectFileOpenRoute[1]),
          String(body.fileId || ""),
          body.mode === "reveal" ? "reveal" : "open",
        );
        res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...getPublicModelCatalog() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/settings/api-key") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiKeyStatus(resolveKeyVendor(url.searchParams.get("vendor")))));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/settings/api-key") {
        const body = JSON.parse(await readBody(req) || "{}");
        if (!String(body.key || "").trim()) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "API Key 不能为空。" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saveApiKey(resolveKeyVendor(body.vendor), String(body.key))));
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/settings/api-key") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saveApiKey(resolveKeyVendor(url.searchParams.get("vendor")))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/project/progress") {
        const result = handleGetProjectProgress(url.searchParams.get("projectId") || undefined);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/project/progress") {
        const raw = await readBody(req);
        let body: { projectId?: string; provider?: RequestedProvider };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = await handleUpdateProjectProgress(body);
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/project/retrospectives") {
        const result = handleListRetrospectives(url.searchParams.get("projectId") || undefined);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/project/retrospective") {
        const raw = await readBody(req);
        let body: { projectId?: string };
        try { body = JSON.parse(raw || "{}"); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = handleStartRetrospective(body.projectId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // GET /api/skills
      if (req.method === "GET" && url.pathname === "/api/skills") {
        const result = handleListSkills(url.searchParams.get("projectId") || undefined);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // GET /api/sessions
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const result = handleListSessions(url.searchParams.get("projectId") || undefined);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // GET /api/session?id=...
      if (req.method === "GET" && url.pathname === "/api/session") {
        const id = url.searchParams.get("id") || "";
        const result = handleGetSession(id, url.searchParams.get("projectId") || undefined);
        const code = !id ? 400 : result.ok ? 200 : 404;
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // DELETE /api/session?id=...
      if (req.method === "DELETE" && url.pathname === "/api/session") {
        const id = url.searchParams.get("id") || "";
        const result = handleDeleteSession(id, url.searchParams.get("projectId") || undefined);
        const code = !id ? 400 : result.ok ? 200 : 404;
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // POST /api/session/fork — copy the conversation through one completed answer
      // into an independent chat, including independent copies of image files.
      if (req.method === "POST" && url.pathname === "/api/session/fork") {
        const raw = await readBody(req);
        let body: { projectId?: string; sessionId?: string; turnIndex?: number };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = handleForkSession(body.sessionId || "", Number(body.turnIndex), body.projectId);
        res.writeHead(result.ok ? 201 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/session/attachment") {
        const projectId = url.searchParams.get("projectId") || undefined;
        const sessionId = url.searchParams.get("sessionId") || "";
        const attachmentId = url.searchParams.get("id") || "";
        const attachmentWorkspace = buildWorkspaceContext(process.cwd(), projectId);
        const attachmentSession = new SessionStore(attachmentWorkspace).loadSession(sessionId);
        const attachment = findSessionAttachment(attachmentSession, attachmentId);
        const filePath = attachment ? resolveStoredAttachment(attachmentWorkspace, attachment) : null;
        if (!attachment || !filePath || !fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Image not found");
          return;
        }
        res.setHeader("Cache-Control", "private, max-age=3600");
        serveStaticFile(res, filePath, attachment.mimeType);
        return;
      }

      // POST /api/session/turn — update last turn's answerHtml for exact replay
      if (req.method === "POST" && url.pathname === "/api/session/turn") {
        const raw = await readBody(req);
        let body: { sessionId: string; answerHtml?: string; projectId?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        if (!body.sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Missing sessionId." }));
          return;
        }
        const turnWorkspace = buildWorkspaceContext(process.cwd(), body.projectId);
        const turnStore = new SessionStore(turnWorkspace);
        const session2 = turnStore.loadSession(body.sessionId);
        if (!session2) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Session not found." }));
          return;
        }
        // Update the last turn's answerHtml, or create a placeholder turn if none exists yet
        // (happens when client stops before server has saved the turn)
        if (body.answerHtml) {
          if (session2.turns.length > 0) {
            var lastTurn = session2.turns[session2.turns.length - 1];
            // Guard: if turn was already stopped, only accept stopped-state HTML.
            // A late-arriving normal answerHtml must not overwrite the stopped display.
            if (lastTurn.status === "stopped" && body.answerHtml.indexOf('已停止') === -1) {
              // silently ignore — turn already stopped, don't overwrite
            } else {
              lastTurn.answerHtml = body.answerHtml;
            }
          } else {
            // Create a minimal turn so the answerHtml isn't lost.
            // The server will populate events/finalAnswer later if runRuntime completes.
            session2.turns.push({
              userContent: session2.messages.filter((m: any) => m.role === 'user').pop()?.content || '',
              events: [],
              status: "running",
              answerHtml: body.answerHtml,
            });
          }
          turnStore.saveSession(session2);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/session/stop — mark the running turn as user-stopped
      if (req.method === "POST" && url.pathname === "/api/session/stop") {
        const raw = await readBody(req);
        let body: { sessionId: string; turnIndex?: number; partialAnswerText?: string; projectId?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        if (!body.sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Missing sessionId." }));
          return;
        }
        const stopWorkspace = buildWorkspaceContext(process.cwd(), body.projectId);
        const stopStore = new SessionStore(stopWorkspace);
        const stopSession = stopStore.loadSession(body.sessionId);
        if (stopSession && stopSession.turns.length > 0) {
          let targetTurnIndex = -1;
          // If caller provided a turnIndex, target that specific turn
          if (typeof body.turnIndex === 'number' && body.turnIndex >= 0 && body.turnIndex < stopSession.turns.length) {
            targetTurnIndex = body.turnIndex;
          } else {
            // Fallback: mark the last running turn as stopped
            for (let ti = stopSession.turns.length - 1; ti >= 0; ti--) {
              if (stopSession.turns[ti].status === 'running') {
                targetTurnIndex = ti;
                break;
              }
            }
          }
          if (targetTurnIndex >= 0) {
            const t = stopSession.turns[targetTurnIndex];
            // Notify the in-memory streamChat loop to stop collecting events
            const key = turnRunKey(stopSession.id, targetTurnIndex);
            const active = runningStops.get(key);
            if (active) {
              active.stopped = true;
              active.controller.abort();
            }
            if (t.status === 'running') {
              t.status = 'stopped';
              t.stoppedAt = new Date().toISOString();
              if (body.partialAnswerText && body.partialAnswerText.trim()) {
                t.partialAnswerText = body.partialAnswerText.trim();
              }
              t.resumeSnapshot = {
                stoppedAt: t.stoppedAt,
                previousUserGoal: t.userContent,
                partialAnswerText: t.partialAnswerText,
              };
              stopStore.saveSession(stopSession);
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/session/trace — save timeline traceEvents to last assistant message
      if (req.method === "POST" && url.pathname === "/api/session/trace") {
        const raw = await readBody(req);
        let body: { sessionId: string; traceEvents: any[]; projectId?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        if (!body.sessionId || !Array.isArray(body.traceEvents)) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Missing sessionId or traceEvents." }));
          return;
        }
        const traceWorkspace = buildWorkspaceContext(process.cwd(), body.projectId);
        const traceStore = new SessionStore(traceWorkspace);
        const session = traceStore.loadSession(body.sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Session not found." }));
          return;
        }
        // Find last assistant message and attach traceEvents
        const lastAsst = [...session.messages].reverse().find((m: any) => m.role === "assistant");
        if (lastAsst) {
          (lastAsst as any).traceEvents = body.traceEvents.slice(0, 100);
          traceStore.saveSession(session);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/session/content — persist expandable thinking content for replay
      if (req.method === "POST" && url.pathname === "/api/session/content") {
        const raw = await readBody(req);
        let body: { sessionId: string; turnContent: Record<string, string>; projectId?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        if (!body.sessionId || !body.turnContent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Missing sessionId or turnContent." }));
          return;
        }
        const ctWorkspace = buildWorkspaceContext(process.cwd(), body.projectId);
        const ctStore = new SessionStore(ctWorkspace);
        const session = ctStore.loadSession(body.sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Session not found." }));
          return;
        }
        const lastAsst2 = [...session.messages].reverse().find((m: any) => m.role === "assistant");
        if (lastAsst2) {
          (lastAsst2 as any).turnContent = body.turnContent;
          ctStore.saveSession(session);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/chat
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const raw = await readBody(req);
        let body: { message: string; provider?: string; sessionId?: string; confirmationOverride?: { id: string; decision: "allow" | "deny" }; maxSteps?: number; projectId?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = await handleChat({
          message: body.message,
          provider: body.provider as RequestedProvider | undefined,
          sessionId: body.sessionId,
          confirmationOverride: body.confirmationOverride,
          maxSteps: body.maxSteps,
          projectId: body.projectId,
        });
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // POST /api/confirmation
      if (req.method === "POST" && url.pathname === "/api/confirmation") {
        const raw = await readBody(req);
        let body: { id: string; decision: "allow" | "deny" };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        const result = await handleConfirmation(body);
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      // POST /api/client-error
      if (req.method === "POST" && url.pathname === "/api/client-error") {
        const raw = await readBody(req);
        let body: { type?: string; message?: string; stack?: string; source?: string };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        console.error("[client-error]", body.type || "unknown");
        console.error(body.message || "(no message)");
        if (body.stack) console.error(body.stack);
        if (body.source) console.error("source:", body.source);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/chat/stream
      if (req.method === "POST" && url.pathname === "/api/chat/stream") {
        const raw = await readBody(req, 32 * 1024 * 1024);
        let body: { message: string; annotations?: import("../core/agent-types.js").ConversationAnnotation[]; attachments?: IncomingAttachment[]; provider?: string; sessionId?: string; maxSteps?: number; projectId?: string; resumeTurnIndex?: number };
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        if ((!body.message || body.message.trim().length === 0)
          && (!Array.isArray(body.annotations) || body.annotations.length === 0)
          && (!Array.isArray(body.attachments) || body.attachments.length === 0)) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "消息不能为空。" }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        let clientClosed = false;
        req.on("close", () => { clientClosed = true; });

        try {
          await streamChat(
            { message: body.message || "", annotations: body.annotations, attachments: body.attachments, provider: body.provider as RequestedProvider | undefined, sessionId: body.sessionId, maxSteps: body.maxSteps, projectId: body.projectId, resumeTurnIndex: body.resumeTurnIndex },
            (event, data) => {
              if (clientClosed) return;
              try {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
              } catch {
                clientClosed = true;
              }
            },
          );
        } catch (error: any) {
          if (!clientClosed) {
            res.write("event: error\n");
            res.write(`data: ${JSON.stringify({ message: error?.message || "请求失败。" })}\n\n`);
            res.write("event: done\n");
            res.write("data: {}\n\n");
          }
        }

        if (!clientClosed) res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err: any) {
      if (err && err.message === "PayloadTooLarge") {
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "请求内容过大。单次对话请求上限为 32 MB。" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function readBody(req: http.IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("PayloadTooLarge"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("单个附件不能超过 64 MB。"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const selfPath = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] ? path.resolve(process.argv[1]) === selfPath : false;
if (isMainModule) {
  const workspaceRoot = (await import("../core/index.js")).buildWorkspaceContext(process.cwd()).paths.root;
  const server = createServer();
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("");
      console.error(`[ERROR] Port ${PORT} is already in use.`);
      console.error("Please stop the old service first:");
      console.error("  - Double-click stop-web.bat");
      console.error(`  - Or manually close the process using port ${PORT}`);
      console.error("");
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    console.log("Product Director Agent WebUI");
    console.log(`Workspace: ${workspaceRoot}`);
    console.log(`Open: http://${HOST}:${PORT}`);
    console.log();
    console.log("按 Ctrl+C 停止服务。");
  });
}
