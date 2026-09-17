import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceContext } from "./types.js";
import type { AgentMessage, AgentTurn, ChatModelId, ImageAttachmentRef, SessionContextState, SessionTaskState } from "./agent-types.js";
import { normalizeChatModel } from "../model/model-catalog.js";

export interface AgentSession {
  schemaVersion: 2;
  revision: number;
  id: string;
  projectId: string;
  kind: "chat" | "retrospective";
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  turns: AgentTurn[];
  taskState?: SessionTaskState;
  contextState?: SessionContextState;
  modelProvider?: ChatModelId;
}

export interface SessionSummary {
  id: string;
  kind: "chat" | "retrospective";
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  modelProvider?: ChatModelId;
}

export class SessionStore {
  private sessionsDir: string;
  private projectId: string;

  constructor(workspace: WorkspaceContext) {
    this.sessionsDir = workspace.paths.sessionsDir;
    this.projectId = workspace.project.id;
  }

  createSession(id?: string, title?: string, kind: "chat" | "retrospective" = "chat"): AgentSession {
    const safeId = id ? safeSessionId(id) : safeSessionId(`session-${Date.now()}`);
    const now = new Date().toISOString();
    return {
      schemaVersion: 2,
      revision: 0,
      id: safeId,
      projectId: this.projectId,
      kind,
      title: title ?? undefined,
      createdAt: now,
      updatedAt: now,
      messages: [],
      turns: [],
    };
  }

  loadSession(id: string): AgentSession | null {
    const safeId = safeSessionId(id);
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    // Security: ensure path is inside sessionsDir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.sessionsDir))) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
      return normalizeSessionAttachmentLabels({
        schemaVersion: 2,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        id: parsed.id ?? safeId,
        projectId: this.projectId,
        kind: parsed.kind === "retrospective" ? "retrospective" : "chat",
        title: parsed.title,
        createdAt: parsed.createdAt ?? "",
        updatedAt: parsed.updatedAt ?? "",
        messages,
        turns,
        taskState: normalizeTaskState(parsed.taskState),
        contextState: parsed.contextState && typeof parsed.contextState === "object" ? parsed.contextState as SessionContextState : undefined,
        modelProvider: normalizeModelProvider(parsed.modelProvider) ?? (messages.length || turns.length ? "deepseek-pro" : undefined),
      });
    } catch {
      return null;
    }
  }

  saveSession(session: AgentSession): void {
    const safeId = safeSessionId(session.id);
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);

    // Security: ensure path inside sessionsDir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.sessionsDir))) {
      throw new Error(`Session path escapes sessionsDir: ${session.id}`);
    }

    // A stream, stop request and replay update can all hold snapshots of the
    // same session. Merge a stale snapshot with the latest disk state before
    // replacing the file so a late "running" save cannot undo a stop.
    const durableSession = stripTransientAttachmentData(session);
    const current = this.loadSession(session.id);
    const merged = current && current.revision > session.revision
      ? mergeSessionSnapshots(current, durableSession)
      : durableSession;
    merged.schemaVersion = 2;
    merged.projectId = this.projectId;
    merged.revision = Math.max(current?.revision ?? 0, session.revision) + 1;
    merged.updatedAt = new Date().toISOString();

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), "utf-8");
      fs.renameSync(tempPath, filePath);
      Object.assign(session, merged);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup after a failed atomic replace.
      }
    }
  }

  listSessions(): SessionSummary[] {
    const result: SessionSummary[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      // Legacy evidence files can remain on disk after upgrading. They are not sessions.
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith("_evidence.json")) continue;

      const filePath = path.join(this.sessionsDir, entry.name);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        result.push({
          id: parsed.id ?? entry.name.replace(".json", ""),
          kind: parsed.kind === "retrospective" ? "retrospective" : "chat",
          title: parsed.title,
          createdAt: parsed.createdAt ?? "",
          updatedAt: parsed.updatedAt ?? "",
          messageCount: Array.isArray(parsed.turns) ? parsed.turns.length : (Array.isArray(parsed.messages) ? parsed.messages.filter((m: any) => m.role === 'user').length : 0),
          modelProvider: normalizeModelProvider(parsed.modelProvider)
            ?? ((Array.isArray(parsed.turns) && parsed.turns.length) || (Array.isArray(parsed.messages) && parsed.messages.length) ? "deepseek-pro" : undefined),
        });
      } catch {
        // skip bad files
      }
    }

    result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return result;
  }

  deleteSession(id: string): boolean {
    const safeId = safeSessionId(id);
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.sessionsDir))) {
      return false;
    }
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

function mergeSessionSnapshots(current: AgentSession, incoming: AgentSession): AgentSession {
  const messages = [...current.messages];
  const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
  for (const message of incoming.messages) {
    const index = messageIndex.get(message.id);
    if (index === undefined) {
      messageIndex.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[index] = { ...messages[index], ...message };
    }
  }

  const turnCount = Math.max(current.turns.length, incoming.turns.length);
  const turns: AgentTurn[] = [];
  for (let index = 0; index < turnCount; index++) {
    const existing = current.turns[index];
    const next = incoming.turns[index];
    if (!existing) {
      if (next) turns.push(next);
      continue;
    }
    if (!next) {
      turns.push(existing);
      continue;
    }
    const events = mergeTurnEvents(existing.events, next.events);
    if ((existing.status === "stopped" && next.status !== "stopped") ||
        (existing.status !== "running" && next.status === "running")) {
      turns.push({ ...existing, events });
      continue;
    }
    turns.push({ ...existing, ...next, events });
  }

  const currentTaskTime = current.taskState?.updatedAt || "";
  const incomingTaskTime = incoming.taskState?.updatedAt || "";
  const taskState = incomingTaskTime > currentTaskTime ? incoming.taskState : current.taskState;
  const currentContextTime = current.contextState?.updatedAt || "";
  const incomingContextTime = incoming.contextState?.updatedAt || "";
  const contextState = incomingContextTime > currentContextTime ? incoming.contextState : current.contextState;

  return {
    ...current,
    ...incoming,
    modelProvider: incoming.modelProvider || current.modelProvider,
    messages,
    turns,
    taskState,
    contextState,
    revision: current.revision,
  };
}

function mergeTurnEvents(current: AgentTurn["events"], incoming: AgentTurn["events"]): AgentTurn["events"] {
  const merged = [...current];
  const seen = new Set(current.map((event) => `${event.at}|${event.type}|${JSON.stringify(event.data)}`));
  for (const event of incoming) {
    const key = `${event.at}|${event.type}|${JSON.stringify(event.data)}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Native attachment labels stay unique for the lifetime of a Session. Recalled
 * attachments keep their source Session label; source text disambiguates an
 * intentional 图1/图1 collision.
 */
function normalizeSessionAttachmentLabels(session: AgentSession): AgentSession {
  const labelsByFile = new Map<string, string>();
  const labelsByAttachment = new Map<string, string>();
  const claimed = { image: new Set<number>(), file: new Set<number>() };
  const next = { image: 1, file: 1 };

  const normalize = (attachments: ImageAttachmentRef[] | undefined): ImageAttachmentRef[] | undefined => {
    if (!attachments?.length) return attachments;
    return attachments.map((attachment) => {
      const image = attachment.kind === "image" || attachment.mimeType.startsWith("image/");
      const kind = image ? "image" : "file";
      const pattern = image ? /^图(\d+)$/ : /^文件(\d+)$/;
      const sourceKey = attachment.referenceScope
        ? `source:${attachment.sourceSessionId || "unknown"}`
        : "local";
      const fileKey = attachment.fileId ? `${kind}:${attachment.fileId}:${sourceKey}` : "";
      const known = (fileKey && labelsByFile.get(fileKey)) || labelsByAttachment.get(attachment.id);
      let label = known;
      if (!label) {
        const requested = attachment.label?.match(pattern);
        const requestedNumber = requested ? Number(requested[1]) : 0;
        if (attachment.referenceScope && requestedNumber > 0) {
          label = attachment.label;
        } else if (requestedNumber > 0 && !claimed[kind].has(requestedNumber)) {
          label = attachment.label;
          claimed[kind].add(requestedNumber);
          next[kind] = Math.max(next[kind], requestedNumber + 1);
        } else {
          while (claimed[kind].has(next[kind])) next[kind]++;
          label = image ? `图${next[kind]}` : `文件${next[kind]}`;
          claimed[kind].add(next[kind]);
          next[kind]++;
        }
      }
      const resolvedLabel = label || (image ? `图${next.image++}` : `文件${next.file++}`);
      if (fileKey) labelsByFile.set(fileKey, resolvedLabel);
      labelsByAttachment.set(attachment.id, resolvedLabel);
      return { ...attachment, kind: image ? "image" : "file", label: resolvedLabel };
    });
  };

  const rewriteDirectives = (content: string, attachments: ImageAttachmentRef[] | undefined): string => {
    if (!content || !attachments?.length) return content;
    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    return content.replace(/:(attachment|session-attachment|project-attachment)\[[^\]]+\](\{name=([^}]+)\})?/g, (match, type: string, suffix: string | undefined, id: string | undefined) => {
      const attachment = id ? byId.get(id) : undefined;
      if (!attachment?.label) return match;
      const source = type === "attachment"
        ? ""
        : attachment.sourceSessionId === session.id
          ? " · 来自本对话"
          : ` · 来自「${safeDirectiveText(attachment.sourceSessionTitle || "已删除的对话")}」`;
      return `:${type}[${attachment.label}${source}]${suffix || ""}`;
    });
  };

  const turns = session.turns.map((turn) => {
    const userAttachments = normalize(turn.userAttachments);
    return { ...turn, userAttachments, userContent: rewriteDirectives(turn.userContent, userAttachments) };
  });
  const messages = session.messages.map((message) => {
    const attachments = normalize(message.attachments);
    return { ...message, attachments, content: rewriteDirectives(message.content, attachments) };
  });
  return { ...session, turns, messages };
}

function safeDirectiveText(value: string): string {
  return value.replace(/[\]\[{}\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function safeSessionId(raw: string): string {
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/^\./, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "session";
}

function normalizeTaskState(value: unknown): SessionTaskState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const workingSet = raw.workingSet && typeof raw.workingSet === "object"
    ? raw.workingSet as SessionTaskState["workingSet"]
    : undefined;
  return {
    schemaVersion: 4,
    lastUserInput: typeof raw.lastUserInput === "string" ? raw.lastUserInput : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    workingSet,
  };
}

function normalizeModelProvider(value: unknown): ChatModelId | undefined {
  return normalizeChatModel(value);
}

function stripTransientAttachmentData(session: AgentSession): AgentSession {
  const strip = (items?: ImageAttachmentRef[]) => items?.map(({ dataUrl: _dataUrl, extractedText: _extractedText, pages: _pages, ...item }) => item);
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message, attachments: strip(message.attachments) })),
    turns: session.turns.map((turn) => ({ ...turn, userAttachments: strip(turn.userAttachments) })),
  };
}
