import type {
  AgentSession,
  ConfirmationRequest,
  ConversationAnnotation,
  Project,
  ProjectStatus,
  ProjectFile,
  ProjectAttachmentReference,
  ProjectProgress,
  ProviderName,
  ApiKeyVendor,
  ModelCatalog,
  ImageAttachmentRef,
  AttachmentRef,
  SessionSummary,
  SkillSummary,
  StreamEvent,
} from "./types";

type ApiEnvelope<T> = { ok: boolean; error?: string } & T;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败（${response.status}）`);
  return data as T;
}

const withProject = (url: string, projectId: string) =>
  `${url}${url.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;

export const api = {
  listProjects: ({ signal }: { signal?: AbortSignal } = {}) =>
    requestJson<ApiEnvelope<{ projects: Project[] }>>("/api/projects", { signal }).then((data) => data.projects),

  createProject: (name: string, description?: string) =>
    requestJson<ApiEnvelope<{ project: Project }>>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    }).then((data) => data.project),

  updateProject: (projectId: string, name: string, description?: string, status?: ProjectStatus) =>
    requestJson<ApiEnvelope<{ project: Project }>>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, status }),
    }).then((data) => data.project),

  deleteProject: (projectId: string) =>
    requestJson<ApiEnvelope<Record<string, never>>>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),

  listProjectFiles: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ files: ProjectFile[] }>>(`/api/projects/${encodeURIComponent(projectId)}/files`, { signal })
      .then((data) => data.files),

  listProjectAttachmentReferences: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ attachments: ProjectAttachmentReference[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/attachment-references`,
      { signal },
    ).then((data) => data.attachments),

  openProjectFile: (projectId: string, file: ProjectFile, mode: "open" | "reveal") =>
    requestJson<ApiEnvelope<{ path: string }>>(`/api/projects/${encodeURIComponent(projectId)}/files/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: file.fileId, mode }),
    }),

  listModels: (signal?: AbortSignal) =>
    requestJson<ApiEnvelope<ModelCatalog>>("/api/models", { signal }),

  getApiKeyStatus: (vendor: ApiKeyVendor, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ configured: boolean }>>(`/api/settings/api-key?vendor=${encodeURIComponent(vendor)}`, { signal }),

  saveApiKey: (vendor: ApiKeyVendor, key: string) =>
    requestJson<ApiEnvelope<{ configured: boolean }>>("/api/settings/api-key", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendor, key }),
    }),

  deleteApiKey: (vendor: ApiKeyVendor) =>
    requestJson<ApiEnvelope<{ configured: boolean }>>(`/api/settings/api-key?vendor=${encodeURIComponent(vendor)}`, { method: "DELETE" }),

  uploadAttachment: (projectId: string, file: File) =>
    requestJson<ApiEnvelope<{ attachment: AttachmentRef }>>(`/api/projects/${encodeURIComponent(projectId)}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Lazy-Filename": encodeURIComponent(file.name || "file"),
      },
      body: file,
    }).then((data) => data.attachment),

  listSkills: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ skills: SkillSummary[] }>>(withProject("/api/skills", projectId), { signal })
      .then((data) => data.skills),

  listSessions: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ sessions: SessionSummary[] }>>(withProject("/api/sessions", projectId), { signal })
      .then((data) => data.sessions),

  getSession: (projectId: string, sessionId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ session: AgentSession }>>(
      withProject(`/api/session?id=${encodeURIComponent(sessionId)}`, projectId),
      { signal },
    ).then((data) => data.session),

  deleteSession: (projectId: string, sessionId: string) =>
    requestJson<ApiEnvelope<Record<string, never>>>(
      withProject(`/api/session?id=${encodeURIComponent(sessionId)}`, projectId),
      { method: "DELETE" },
    ),

  forkSession: (projectId: string, sessionId: string, turnIndex: number) =>
    requestJson<ApiEnvelope<{ session: SessionSummary }>>("/api/session/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sessionId, turnIndex }),
    }).then((data) => data.session),

  getProgress: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ progress: ProjectProgress | null }>>(withProject("/api/project/progress", projectId), { signal })
      .then((data) => data.progress),

  updateProgress: (projectId: string, provider: ProviderName) =>
    requestJson<ApiEnvelope<{ progress: ProjectProgress }>>("/api/project/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, provider }),
    }).then((data) => data.progress),

  listRetrospectives: (projectId: string, signal?: AbortSignal) =>
    requestJson<ApiEnvelope<{ sessions: SessionSummary[] }>>(withProject("/api/project/retrospectives", projectId), { signal })
      .then((data) => data.sessions),

  startRetrospective: (projectId: string) =>
    requestJson<ApiEnvelope<{ session: SessionSummary; prompt: string }>>("/api/project/retrospective", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    }),

  stopGeneration: (projectId: string, sessionId: string, turnIndex: number, partialAnswerText: string) =>
    requestJson<ApiEnvelope<Record<string, never>>>("/api/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sessionId, turnIndex, partialAnswerText }),
      keepalive: true,
    }),

  resolveConfirmation: (id: string, decision: "allow" | "deny") =>
    requestJson<ApiEnvelope<{ result?: { content?: string; ok?: boolean }; session?: { id: string; title?: string } }>>(
      "/api/confirmation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      },
    ),
};

export async function streamChat(
  input: {
    projectId: string;
    sessionId?: string;
    message: string;
    annotations?: ConversationAnnotation[];
    attachments?: AttachmentRef[];
    provider: ProviderName;
    resumeTurnIndex?: number;
  },
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, maxSteps: 64 }),
    signal,
  });
  if (!response.ok || !response.body) {
    const message = await response.text();
    throw new Error(message || `请求失败（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const rawData = lines.filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (type) {
        let data: Record<string, unknown> = {};
        try { data = rawData ? JSON.parse(rawData) : {}; } catch { data = { raw: rawData }; }
        onEvent({ type, data });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function isConfirmation(value: unknown): value is ConfirmationRequest {
  return Boolean(value && typeof value === "object" && "id" in value && "toolName" in value);
}
